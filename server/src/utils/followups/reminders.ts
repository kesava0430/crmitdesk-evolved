/**
 * Follow-up reminders and the morning digest.
 *
 * Same in-process setInterval poller shape as scheduler.ts / slaMonitor.ts,
 * and the same delivery rules learned there:
 *  - Claim before send. A reminder row is stamped `remindedAt` with a
 *    conditional update (`WHERE reminded_at IS NULL AND due_at = <seen>`)
 *    before anything is sent, so a restart, a second instance or an
 *    overlapping tick can never send it twice. A crash between claim and send
 *    costs one missed reminder — the safer direction.
 *  - No replay storms. Only items whose reminder time fell within the last
 *    REMINDER_GRACE_MS fire; anything older (downtime, or the first deploy
 *    where every historic row has remindedAt = NULL) is left to the digest
 *    and the overdue icons.
 *  - Mark done / delete / reschedule stop it: the query only looks at open
 *    rows, and changing dueAt clears remindedAt so the new time gets its own.
 *
 * Delivery goes through createNotification (in-app bell + web/FCM push) and,
 * only if the user opted in AND the org already has WhatsApp connected AND
 * the user verified their number with the WhatsApp assistant, sendWhatsApp.
 * Orgs with CRM switched off are skipped entirely.
 */
import { prisma } from '../prisma';
import { orgsWithModuleBlocked } from '../licensing';
import { getPermCtx } from '../permissions';
import { sendWhatsApp } from '../whatsapp';
import { createNotification } from '../../modules/notifications/notifications.controller';
import { localDateKey } from '../attendanceEngine';
import {
  candidateDueWindow, shouldRemind, digestWindowOpen, classifyDue, dueThroughTodayBound, shortDue, isDateOnly,
} from './time';
import { orgTimeZone, visibleRecords, activityRecord, FollowUpRecordKind, OPEN_TASK, FOLLOWUP_TASK_ENTITIES } from './collect';

const POLL_INTERVAL_MS = 60 * 1000;
const TYPE_WORD: Record<string, string> = { CALL: 'Call', EMAIL: 'Email', MEETING: 'Meeting', TASK: 'Task' };

export interface DueCandidate {
  id: string;
  source: 'ACTIVITY' | 'TASK';
  orgId: string;
  type: string;
  title: string;
  dueAt: Date;
  userId: string;
  rec: { kind: FollowUpRecordKind; id: string };
}

/** Pure: which candidates should be reminded now (org timezones given). */
export function selectDue(cands: DueCandidate[], tzByOrg: Map<string, string>, blockedOrgs: Set<string>, now: Date): DueCandidate[] {
  return cands.filter(c => !blockedOrgs.has(c.orgId) && shouldRemind(c.dueAt, now, tzByOrg.get(c.orgId) ?? 'UTC'));
}

async function loadCandidates(now: Date): Promise<DueCandidate[]> {
  const { from, to } = candidateDueWindow(now);
  const [acts, tasks] = await Promise.all([
    prisma.activity.findMany({
      where: {
        done: false, remindedAt: null, dueAt: { gte: from, lte: to },
        OR: [{ leadId: { not: null } }, { dealId: { not: null } }, { contactId: { not: null } }],
      },
      select: { id: true, orgId: true, type: true, title: true, dueAt: true, assignedTo: true, createdBy: true, leadId: true, dealId: true, contactId: true },
      take: 5000,
    }),
    prisma.task.findMany({
      where: { status: OPEN_TASK, remindedAt: null, dueAt: { gte: from, lte: to }, entityType: { in: FOLLOWUP_TASK_ENTITIES as any }, entityId: { not: null } },
      select: { id: true, orgId: true, title: true, dueAt: true, assigneeUserId: true, createdBy: true, entityType: true, entityId: true },
      take: 5000,
    }),
  ]);
  const out: DueCandidate[] = [];
  for (const a of acts) {
    const rec = activityRecord(a);
    if (rec && a.dueAt) out.push({ id: a.id, source: 'ACTIVITY', orgId: a.orgId, type: a.type, title: a.title, dueAt: a.dueAt, userId: a.assignedTo ?? a.createdBy, rec });
  }
  for (const t of tasks) {
    if (t.dueAt && t.entityId) out.push({ id: t.id, source: 'TASK', orgId: t.orgId, type: 'TASK', title: t.title, dueAt: t.dueAt, userId: t.assigneeUserId ?? t.createdBy, rec: { kind: t.entityType as FollowUpRecordKind, id: t.entityId } });
  }
  return out;
}

/** Atomically mark one row reminded; false if someone else got there first or it moved. */
export async function claim(c: DueCandidate, now: Date): Promise<boolean> {
  const where = { id: c.id, remindedAt: null, dueAt: c.dueAt };
  const r = c.source === 'ACTIVITY'
    ? await prisma.activity.updateMany({ where: { ...where, done: false }, data: { remindedAt: now } })
    : await prisma.task.updateMany({ where: { ...where, status: OPEN_TASK }, data: { remindedAt: now } });
  return r.count === 1;
}

/** WhatsApp only when: user opted in, org has WhatsApp connected, number verified with the assistant and still on the profile. */
export async function whatsappTarget(orgId: string, userId: string): Promise<string | null> {
  const [prefs, wa, user, link] = await Promise.all([
    prisma.followUpPrefs.findUnique({ where: { userId }, select: { whatsapp: true } }),
    prisma.whatsAppConfig.findUnique({ where: { orgId }, select: { id: true } }),
    prisma.user.findFirst({ where: { id: userId, orgId }, select: { phone: true } }),
    prisma.assistantWhatsAppLink.findUnique({ where: { userId }, select: { phoneE164: true, orgId: true } }),
  ]);
  if (!prefs?.whatsapp || !wa || !user?.phone || !link || link.orgId !== orgId) return null;
  const norm = (p: string) => p.replace(/^whatsapp:/, '').replace(/[^\d+]/g, '');
  return norm(link.phoneE164) === norm(user.phone) ? user.phone : null;
}

const RECORD_WORD: Record<FollowUpRecordKind, string> = { LEAD: 'lead', DEAL: 'deal', CONTACT: 'contact' };

export async function checkDueFollowUps(now = new Date()): Promise<{ sent: number; skipped: number }> {
  const cands = await loadCandidates(now);
  if (!cands.length) return { sent: 0, skipped: 0 };
  const orgIds = [...new Set(cands.map(c => c.orgId))];
  const tzByOrg = new Map<string, string>();
  for (const o of orgIds) tzByOrg.set(o, await orgTimeZone(o));
  const blocked = await orgsWithModuleBlocked(orgIds, 'crm');
  const due = selectDue(cands, tzByOrg, blocked, now);

  let sent = 0, skipped = 0;
  for (const c of due) {
    try {
      if (!(await claim(c, now))) { skipped++; continue; }
      const user = await prisma.user.findFirst({ where: { id: c.userId, orgId: c.orgId, isActive: true }, select: { id: true, orgId: true, role: true } });
      if (!user) { skipped++; continue; }
      // The reminder names the record, so the recipient must still be allowed to see it.
      const ctx = await getPermCtx({ id: user.id, orgId: c.orgId, role: user.role });
      const names = await visibleRecords(ctx, [c.rec]);
      const name = names.get(`${c.rec.kind}:${c.rec.id}`);
      if (name === undefined) { skipped++; continue; }
      const tz = tzByOrg.get(c.orgId) ?? 'UTC';
      const when = isDateOnly(c.dueAt) ? 'due today' : `due ${shortDue(c.dueAt, tz)}`;
      const title = `Follow-up ${when}: ${c.title}`.slice(0, 200);
      const body = `${TYPE_WORD[c.type] ?? 'Follow-up'} · ${RECORD_WORD[c.rec.kind]} “${name}”`;
      await createNotification({
        orgId: c.orgId, userId: user.id, type: 'FOLLOWUP_DUE', title, body,
        entityType: c.rec.kind, entityId: c.rec.id, url: '/my-work',
      });
      sent++;
      const phone = await whatsappTarget(c.orgId, user.id).catch(() => null);
      if (phone) await sendWhatsApp(c.orgId, phone, `Reminder: ${title}\n${body}`).catch(err => console.warn(`[followups] WhatsApp reminder failed for ${c.id}:`, err?.message || err));
    } catch (err: any) {
      console.error(`[followups] reminder ${c.source} ${c.id} failed:`, err?.message || err);
    }
  }
  return { sent, skipped };
}

// ─── Morning digest ─────────────────────────────────────────────────────────

export interface DigestCounts { overdue: number; today: number }

export function digestText(c: DigestCounts): string {
  const parts: string[] = [];
  if (c.today) parts.push(`${c.today} follow-up${c.today === 1 ? '' : 's'} today`);
  if (c.overdue) parts.push(`${c.overdue} overdue`);
  return `You have ${parts.join(', ')}`;
}

/** Atomic once-a-day claim on the user's prefs row. Returns false when already sent today or digest turned off. */
export async function claimDigest(userId: string, orgId: string, today: string): Promise<boolean> {
  await prisma.followUpPrefs.upsert({ where: { userId }, create: { userId, orgId }, update: {} });
  const r = await prisma.followUpPrefs.updateMany({
    where: { userId, digest: true, OR: [{ lastDigestOn: null }, { lastDigestOn: { not: today } }] },
    data: { lastDigestOn: today },
  });
  return r.count === 1;
}

export async function sendDigests(now = new Date()): Promise<number> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const blocked = await orgsWithModuleBlocked(orgs.map(o => o.id), 'crm');
  let sent = 0;
  for (const { id: orgId } of orgs) {
    if (blocked.has(orgId)) continue;
    const tz = await orgTimeZone(orgId);
    if (!digestWindowOpen(now, tz)) continue;
    const today = localDateKey(now, tz);
    try {
      const bound = dueThroughTodayBound(now, tz);
      const [acts, tasks] = await Promise.all([
        prisma.activity.findMany({
          where: { orgId, done: false, dueAt: { not: null, lt: bound }, OR: [{ leadId: { not: null } }, { dealId: { not: null } }, { contactId: { not: null } }] },
          select: { dueAt: true, assignedTo: true, createdBy: true, leadId: true, dealId: true, contactId: true },
          take: 20_000,
        }),
        prisma.task.findMany({
          where: { orgId, status: OPEN_TASK, entityType: { in: FOLLOWUP_TASK_ENTITIES as any }, entityId: { not: null }, dueAt: { not: null, lt: bound } },
          select: { dueAt: true, assigneeUserId: true, createdBy: true, entityType: true, entityId: true },
          take: 20_000,
        }),
      ]);
      const byUser = new Map<string, Array<{ dueAt: Date; rec: { kind: FollowUpRecordKind; id: string } }>>();
      const add = (u: string, dueAt: Date | null, rec: { kind: FollowUpRecordKind; id: string } | null) => {
        if (!dueAt || !rec) return;
        const s = classifyDue(dueAt, now, tz);
        if (s === 'UPCOMING') return;
        const l = byUser.get(u); const row = { dueAt, rec };
        if (l) l.push(row); else byUser.set(u, [row]);
      };
      for (const a of acts) add(a.assignedTo ?? a.createdBy, a.dueAt, activityRecord(a));
      for (const t of tasks) add(t.assigneeUserId ?? t.createdBy, t.dueAt, t.entityId ? { kind: t.entityType as FollowUpRecordKind, id: t.entityId } : null);

      // Users already done for today (or who turned the digest off) cost nothing on later ticks.
      const settled = new Set((await prisma.followUpPrefs.findMany({
        where: { orgId, userId: { in: [...byUser.keys()] }, OR: [{ lastDigestOn: today }, { digest: false }] },
        select: { userId: true },
      })).map(p => p.userId));
      for (const [userId, rows] of byUser) {
        if (settled.has(userId)) continue;
        const user = await prisma.user.findFirst({ where: { id: userId, orgId, isActive: true }, select: { id: true, orgId: true, role: true } });
        if (!user) continue;
        const ctx = await getPermCtx({ id: user.id, orgId, role: user.role });
        const names = await visibleRecords(ctx, rows.map(r => r.rec));
        const counts: DigestCounts = { overdue: 0, today: 0 };
        for (const r of rows) {
          if (!names.has(`${r.rec.kind}:${r.rec.id}`)) continue;
          if (classifyDue(r.dueAt, now, tz) === 'OVERDUE') counts.overdue++; else counts.today++;
        }
        if (!counts.overdue && !counts.today) continue;
        if (!(await claimDigest(userId, orgId, today))) continue;
        await createNotification({ orgId, userId, type: 'FOLLOWUP_DIGEST', title: digestText(counts), body: 'Open My Work to call, email or snooze them.', url: '/my-work' });
        sent++;
      }
    } catch (err: any) {
      console.error(`[followups] digest for org ${orgId} failed:`, err?.message || err);
    }
  }
  return sent;
}

let running = false;
export async function followUpTick(now = new Date()): Promise<void> {
  if (running) return; // a slow tick must not overlap the next one
  running = true;
  try {
    const r = await checkDueFollowUps(now);
    if (r.sent) console.log(`[followups] sent ${r.sent} reminder(s)`);
    const d = await sendDigests(now);
    if (d) console.log(`[followups] sent ${d} morning digest(s)`);
  } finally {
    running = false;
  }
}

export function startFollowUpPoller(): NodeJS.Timeout {
  followUpTick().catch(err => console.error('[followups] tick failed', err));
  return setInterval(() => followUpTick().catch(err => console.error('[followups] tick failed', err)), POLL_INTERVAL_MS);
}
