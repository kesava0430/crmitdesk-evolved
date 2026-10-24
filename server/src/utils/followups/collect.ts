/**
 * Follow-up queries — the database side of utils/followups/time.ts.
 *
 * Everything here is "one grouped query per source, never one per record":
 * a list page of 200 leads costs two queries (activities + tasks) whatever
 * the page size, and classification happens in memory in the org's timezone.
 *
 * Responsible person (who is reminded, whose My Work shows it):
 *   Activity → assignedTo, else the creator.
 *   Task     → assigneeUserId, else the creator.
 * Every row has a creator, so there is always exactly one person.
 */
import { prisma } from '../prisma';
import { PermCtx, can, scopedWhere, canAccessRecord } from '../permissions';
import { validTimeZone } from '../aiActions/dates';
import {
  OpenItem, RecordFollowUpSummary, summarise, EMPTY_SUMMARY, ListFilter, matchesFilter,
  classifyDue, dueThroughTodayBound, isDateOnly, describeItem, daysBetween, dueDayKey, compareSummaries,
} from './time';
import { localDateKey } from '../attendanceEngine';

export type FollowUpRecordKind = 'LEAD' | 'DEAL' | 'CONTACT';
export const OPEN_TASK = { notIn: ['DONE', 'CANCELLED'] as any[] };

const tzCache = new Map<string, { tz: string; at: number }>();
/** The org's timezone (validated; legacy aliases are fine for Intl). Cached 5 minutes. */
export async function orgTimeZone(orgId: string): Promise<string> {
  const hit = tzCache.get(orgId);
  if (hit && Date.now() - hit.at < 300_000) return hit.tz;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const tz = validTimeZone(org?.timezone);
  tzCache.set(orgId, { tz, at: Date.now() });
  return tz;
}

const ACTIVITY_FK: Record<FollowUpRecordKind, 'leadId' | 'dealId' | 'contactId'> = { LEAD: 'leadId', DEAL: 'dealId', CONTACT: 'contactId' };

/**
 * Open follow-ups per record. `ids` limits to those records; `dueBefore`
 * limits to dated items due before that instant (for overdue/today filters).
 */
export async function loadOpenItems(
  orgId: string, kind: FollowUpRecordKind, ids: string[] | null,
  opts: { dueBefore?: Date } = {},
): Promise<Map<string, OpenItem[]>> {
  const out = new Map<string, OpenItem[]>();
  if (ids && !ids.length) return out;
  const fk = ACTIVITY_FK[kind];
  const due = opts.dueBefore ? { dueAt: { lt: opts.dueBefore } } : {};
  const [acts, tasks] = await Promise.all([
    prisma.activity.findMany({
      where: { orgId, done: false, ...(ids ? { [fk]: { in: ids } } : { [fk]: { not: null } }), ...due },
      select: { id: true, type: true, title: true, dueAt: true, leadId: true, dealId: true, contactId: true },
      take: 20_000,
    }),
    prisma.task.findMany({
      where: { orgId, entityType: kind as any, status: OPEN_TASK, ...(ids ? { entityId: { in: ids } } : {}), ...due },
      select: { id: true, title: true, dueAt: true, entityId: true },
      take: 20_000,
    }),
  ]);
  const push = (rec: string | null | undefined, item: OpenItem) => {
    if (!rec) return;
    const list = out.get(rec);
    if (list) list.push(item); else out.set(rec, [item]);
  };
  for (const a of acts) push((a as any)[fk], { id: a.id, source: 'ACTIVITY', type: a.type, title: a.title, dueAt: a.dueAt });
  for (const t of tasks) push(t.entityId, { id: t.id, source: 'TASK', type: 'TASK', title: t.title, dueAt: t.dueAt });
  return out;
}

/** id → summary for a page of records (records without open items get NONE). */
export async function summariesFor(orgId: string, kind: FollowUpRecordKind, ids: string[], now = new Date()): Promise<Record<string, RecordFollowUpSummary>> {
  const tz = await orgTimeZone(orgId);
  const items = await loadOpenItems(orgId, kind, ids);
  const out: Record<string, RecordFollowUpSummary> = {};
  for (const id of ids) {
    const list = items.get(id);
    out[id] = list ? summarise(list, now, tz) : EMPTY_SUMMARY;
  }
  return out;
}

/** Attach `followUp` to each row of a list response. Never fails the list. */
export async function withFollowUps<T extends { id: string }>(orgId: string, kind: FollowUpRecordKind, rows: T[], now = new Date()): Promise<Array<T & { followUp: RecordFollowUpSummary }>> {
  try {
    const map = await summariesFor(orgId, kind, rows.map(r => r.id), now);
    return rows.map(r => ({ ...r, followUp: map[r.id] ?? EMPTY_SUMMARY }));
  } catch (err) {
    console.error('[followups] status lookup failed; list returned without it', err);
    return rows.map(r => ({ ...r, followUp: EMPTY_SUMMARY }));
  }
}

/**
 * Where-fragment for a list filter: overdue / due today → the records that
 * have such an item; none → records with no open follow-up at all.
 */
export async function filterWhere(orgId: string, kind: FollowUpRecordKind, filter: ListFilter, now = new Date()): Promise<Record<string, unknown>> {
  const tz = await orgTimeZone(orgId);
  if (filter === 'none') {
    const items = await loadOpenItems(orgId, kind, null);
    return { id: { notIn: [...items.keys()] } };
  }
  const items = await loadOpenItems(orgId, kind, null, { dueBefore: dueThroughTodayBound(now, tz) });
  const ids: string[] = [];
  for (const [id, list] of items) if (matchesFilter(summarise(list, now, tz), filter)) ids.push(id);
  return { id: { in: ids } };
}

export const LIST_FILTERS: ListFilter[] = ['overdue', 'today', 'none'];
export function parseListFilter(v: unknown): ListFilter | null {
  return typeof v === 'string' && (LIST_FILTERS as string[]).includes(v) ? (v as ListFilter) : null;
}

// ─── My Work: the signed-in user's overdue + today follow-ups ──────────────

export interface MyFollowUp {
  id: string;
  source: 'ACTIVITY' | 'TASK';
  type: string;
  title: string;
  dueAt: string;
  dateOnly: boolean;
  status: 'OVERDUE' | 'TODAY';
  days: number;
  label: string;
  record: { kind: FollowUpRecordKind; id: string; name: string };
}

/** Record names + who may see them, for a set of lead/deal/contact ids. */
export async function visibleRecords(ctx: PermCtx, refs: Array<{ kind: FollowUpRecordKind; id: string }>): Promise<Map<string, string>> {
  const by = (k: FollowUpRecordKind) => [...new Set(refs.filter(r => r.kind === k).map(r => r.id))];
  const leadIds = by('LEAD'), dealIds = by('DEAL'), contactIds = by('CONTACT');
  const [leads, deals, contacts] = await Promise.all([
    leadIds.length && can(ctx, 'crm.lead.read')
      ? prisma.lead.findMany({ where: { AND: [{ orgId: ctx.orgId, id: { in: leadIds } }, scopedWhere(ctx, 'lead', 'crm.lead.read')] }, select: { id: true, contact: { select: { name: true } } } })
      : Promise.resolve([] as any[]),
    dealIds.length && can(ctx, 'crm.deal.read')
      ? prisma.deal.findMany({ where: { AND: [{ orgId: ctx.orgId, id: { in: dealIds } }, scopedWhere(ctx, 'deal', 'crm.deal.read')] }, select: { id: true, title: true } })
      : Promise.resolve([] as any[]),
    contactIds.length && can(ctx, 'crm.contact.read')
      ? prisma.contact.findMany({ where: { AND: [{ orgId: ctx.orgId, id: { in: contactIds } }, scopedWhere(ctx, 'contact', 'crm.contact.read')] }, select: { id: true, name: true } })
      : Promise.resolve([] as any[]),
  ]);
  const out = new Map<string, string>();
  for (const l of leads) out.set(`LEAD:${l.id}`, l.contact?.name || 'Lead');
  for (const d of deals) out.set(`DEAL:${d.id}`, d.title);
  for (const c of contacts) out.set(`CONTACT:${c.id}`, c.name);
  return out;
}

/** An activity's record: the lead or deal it belongs to, else its contact. */
export function activityRecord(a: { leadId: string | null; dealId: string | null; contactId: string | null }): { kind: FollowUpRecordKind; id: string } | null {
  if (a.leadId) return { kind: 'LEAD', id: a.leadId };
  if (a.dealId) return { kind: 'DEAL', id: a.dealId };
  if (a.contactId) return { kind: 'CONTACT', id: a.contactId };
  return null;
}

export const FOLLOWUP_TASK_ENTITIES = ['LEAD', 'DEAL', 'CONTACT'] as const;

/**
 * Overdue + due-today follow-ups the user is responsible for, on records
 * they may see, overdue first (oldest first) then today (earliest first).
 */
export async function myFollowUps(ctx: PermCtx, now = new Date(), limit = 100): Promise<{ items: MyFollowUp[]; overdue: number; today: number }> {
  const tz = await orgTimeZone(ctx.orgId);
  const bound = dueThroughTodayBound(now, tz);
  const me = ctx.userId;
  const [acts, tasks] = await Promise.all([
    can(ctx, 'crm.activity.read')
      ? prisma.activity.findMany({
          where: {
            orgId: ctx.orgId, done: false, dueAt: { not: null, lt: bound },
            OR: [{ assignedTo: me }, { assignedTo: null, createdBy: me }],
          },
          select: { id: true, type: true, title: true, dueAt: true, leadId: true, dealId: true, contactId: true },
          orderBy: { dueAt: 'asc' }, take: 1000,
        })
      : Promise.resolve([] as any[]),
    prisma.task.findMany({
      where: {
        orgId: ctx.orgId, status: OPEN_TASK, entityType: { in: FOLLOWUP_TASK_ENTITIES as any }, dueAt: { not: null, lt: bound },
        OR: [{ assigneeUserId: me }, { assigneeUserId: null, createdBy: me }],
      },
      select: { id: true, title: true, dueAt: true, entityType: true, entityId: true },
      orderBy: { dueAt: 'asc' }, take: 1000,
    }),
  ]);

  const raw: Array<{ item: OpenItem; rec: { kind: FollowUpRecordKind; id: string } }> = [];
  for (const a of acts) {
    const rec = activityRecord(a);
    if (rec) raw.push({ item: { id: a.id, source: 'ACTIVITY', type: a.type, title: a.title, dueAt: a.dueAt }, rec });
  }
  for (const t of tasks) {
    if (t.entityId) raw.push({ item: { id: t.id, source: 'TASK', type: 'TASK', title: t.title, dueAt: t.dueAt }, rec: { kind: t.entityType as FollowUpRecordKind, id: t.entityId } });
  }
  const names = await visibleRecords(ctx, raw.map(r => r.rec));
  const today = localDateKey(now, tz);
  const items: MyFollowUp[] = [];
  for (const { item, rec } of raw) {
    const name = names.get(`${rec.kind}:${rec.id}`);
    if (name === undefined || !item.dueAt) continue; // record not visible to this user
    const status = classifyDue(item.dueAt, now, tz);
    if (status === 'UPCOMING') continue;
    const days = daysBetween(dueDayKey(item.dueAt, tz), today);
    const refShape = { id: item.id, source: item.source, type: item.type, title: item.title, dueAt: item.dueAt.toISOString(), dateOnly: isDateOnly(item.dueAt), days };
    items.push({ ...refShape, dueAt: refShape.dueAt, status, label: describeItem(refShape, tz), record: { ...rec, name } });
  }
  items.sort((a, b) => (a.status === b.status ? 0 : a.status === 'OVERDUE' ? -1 : 1) || a.dueAt.localeCompare(b.dueAt));
  const overdue = items.filter(i => i.status === 'OVERDUE').length;
  return { items: items.slice(0, limit), overdue, today: items.length - overdue };
}

/** Can this user act on (mark done / snooze) this follow-up? Responsible person, or anyone who may update the record. */
export async function loadActionableFollowUp(ctx: PermCtx, source: 'ACTIVITY' | 'TASK', id: string) {
  if (source === 'ACTIVITY') {
    const a = await prisma.activity.findFirst({ where: { id, orgId: ctx.orgId } });
    if (!a) return null;
    const rec = activityRecord(a);
    const responsible = (a.assignedTo ?? a.createdBy) === ctx.userId;
    if (!responsible && !can(ctx, 'crm.activity.update')) return null;
    if (rec) {
      const names = await visibleRecords(ctx, [rec]);
      if (!names.has(`${rec.kind}:${rec.id}`)) return null;
    }
    return { source, row: a, rec };
  }
  const t = await prisma.task.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!t) return null;
  const responsible = (t.assigneeUserId ?? t.createdBy) === ctx.userId;
  if (!responsible && !canAccessRecord(ctx, 'task', 'core.task.update', t)) return null;
  return { source, row: t, rec: t.entityId && t.entityType ? { kind: t.entityType as FollowUpRecordKind, id: t.entityId } : null };
}

// ─── List endpoints (leads / deals) ─────────────────────────────────────────

const SORT_CAP = 5000;

/**
 * Runs a paginated list query with follow-up status attached, an optional
 * ?followUp=overdue|today|none filter and ?sort=followup ordering (overdue
 * oldest-first, then due today, upcoming soonest, undated, none). Sorting by
 * follow-up needs the whole matching set, so it ranks up to SORT_CAP ids
 * (ids only) and loads just the requested page.
 */
export async function listWithFollowUps(opts: {
  orgId: string; kind: 'LEAD' | 'DEAL'; delegate: any; where: any; include: any;
  pag: { limit: number; skip: number }; filter: ListFilter | null; sort: string | undefined;
  /** Statuses that count as closed: the "none" filter only looks at open records. */
  closedStatuses: string[];
}): Promise<{ rows: any[]; total: number }> {
  const { orgId, kind, delegate, include, pag } = opts;
  const and: any[] = [opts.where];
  if (opts.filter) {
    and.push(await filterWhere(orgId, kind, opts.filter));
    if (opts.filter === 'none' && !opts.where.status) and.push({ status: { notIn: opts.closedStatuses } });
  }
  const where = and.length === 1 ? and[0] : { AND: and };
  if (opts.sort === 'followup') {
    const all: Array<{ id: string }> = await delegate.findMany({ where, select: { id: true }, orderBy: { createdAt: 'desc' }, take: SORT_CAP });
    const ids = all.map(r => r.id);
    const sums = await summariesFor(orgId, kind, ids);
    const order = ids.map((id, i) => ({ id, i })).sort((a, b) => compareSummaries(sums[a.id], sums[b.id]) || a.i - b.i);
    const page = order.slice(pag.skip, pag.skip + pag.limit).map(o => o.id);
    const rows = page.length ? await delegate.findMany({ where: { id: { in: page } }, include }) : [];
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    return { rows: page.map(id => ({ ...(byId.get(id) as any), followUp: sums[id] })).filter(r => r.id), total: ids.length };
  }
  const [rows, total] = await Promise.all([
    delegate.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: pag.limit, skip: pag.skip }),
    delegate.count({ where }),
  ]);
  return { rows: await withFollowUps(orgId, kind, rows), total };
}
