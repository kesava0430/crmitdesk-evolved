// ─── Attendance day corrections (single and bulk) ────────────────────────────
//
// The two writes HR makes to a day's status — "set it manually" and "drop the
// manual override so the engine decides again" — live here so the register's
// single-cell modal (markDay / resetDay) and the bulk edit
// (POST /hr/attendance/days/bulk) run exactly the same code: same MANUAL row,
// same paid fraction, same audit shape. A bulk change only adds a batch id to
// its audit rows.

import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { logAction } from './auditLog';
import { sseManager, SSEEvent } from './sse';
import { computeDays, audit, auditData, dateKey, holidayKeysForUser, type ComputedDay } from './attendanceRegister';
import { keyToDate } from './attendanceEngine';
import { classifyCell, groupByUser, chunk, SKIP_REASON, type BulkCell, type BulkOptions, type SkipCode } from './attendanceBulk';

/** Paid fraction a manual status carries into payroll. */
export const PAID: Record<string, number> = { PRESENT: 1, LATE: 1, WFH: 1, LEAVE: 1, HOLIDAY: 1, WEEK_OFF: 1, HALF_DAY: 0.5, ABSENT: 0, UNPAID_LEAVE: 0, LOP: 0 };

type Db = Prisma.TransactionClient | typeof prisma;

/** How the audit log names a status change, given what the day was before. */
export function correctionAction(before: { status: string; source: string } | null | undefined): 'REGULARISE' | 'CORRECT' | 'MARK' {
  return !before || before.status === 'ABSENT' ? 'REGULARISE' : before.source === 'MANUAL' ? 'CORRECT' : 'MARK';
}

export interface ManualStatusInput {
  orgId: string; actorId: string; actorEmail: string;
  userId: string; date: Date; status: string; notes?: string; reason: string;
  /** The day as it was (computed or stored) — for the audit "before" and the action name */
  before?: ComputedDay | null;
  batchId?: string | null;
}

/**
 * Store a MANUAL status for one day and audit it. computeDays never
 * recomputes a MANUAL row (ATT-1), so this is final until reset. The caller
 * has already checked org membership and that the day isn't frozen.
 */
export async function writeManualStatus(db: Db, input: ManualStatusInput) {
  const { orgId, actorId, userId, date, status, notes, before } = input;
  const action = correctionAction(before);
  const reasonText = `Set by ${input.actorEmail}: ${input.reason}`;
  const row = await db.attendanceDay.upsert({
    where: { userId_date: { userId, date } },
    create: { orgId, userId, date, status: status as any, source: 'MANUAL', paidFraction: PAID[status], notes, reason: reasonText, updatedBy: actorId, policyGroupId: null },
    update: { orgId, status: status as any, source: 'MANUAL', paidFraction: PAID[status], notes, reason: reasonText, updatedBy: actorId },
  });
  await audit(orgId, actorId, {
    userId, date, entityType: 'ATTENDANCE_DAY', entityId: row.id, action,
    before: before ? { status: before.status, source: before.source, paidFraction: before.paidFraction, notes: before.notes ?? null } : null,
    after: { status: row.status, source: 'MANUAL', paidFraction: row.paidFraction, notes: row.notes },
    reason: input.reason, batchId: input.batchId ?? null,
  }, db);
  return { row, action };
}

/**
 * Drop the MANUAL rows of `dateKeys` for one user, let the engine recompute
 * those days, and audit each reverted day (before = the manual status, after =
 * the computed one). Days without a manual row are left alone; returns the
 * days actually reverted. The caller has checked the days aren't frozen.
 *
 * The delete runs in its own transaction and the recompute after it — the
 * recompute upserts the same (user, date) rows, so doing it inside the
 * transaction would wait on its own row locks.
 */
export async function resetManualDays(orgId: string, actorId: string, userId: string, dateKeys: string[], reason: string, batchId: string | null = null) {
  if (!dateKeys.length) return [];
  const removed = await prisma.$transaction(async tx => {
    const rows = await tx.attendanceDay.findMany({ where: { orgId, userId, source: 'MANUAL', date: { in: dateKeys.map(keyToDate) } } });
    if (rows.length) await tx.attendanceDay.deleteMany({ where: { id: { in: rows.map(r => r.id) }, source: 'MANUAL' } });
    return rows;
  });
  if (!removed.length) return [];
  const keys = removed.map(r => dateKey(r.date)).sort();
  const { days } = await computeDays(orgId, userId, keyToDate(keys[0]), keyToDate(keys[keys.length - 1]));
  const byKey = new Map(days.map(d => [dateKey(d.date), d]));
  const out = removed.map(b => ({ date: dateKey(b.date), before: b, after: byKey.get(dateKey(b.date)) ?? null }));
  await prisma.attendanceAudit.createMany({
    data: out.map(o => auditData(orgId, actorId, {
      userId, date: o.before.date, entityType: 'ATTENDANCE_DAY', entityId: o.after?.id ?? null, action: 'CORRECT',
      before: { status: o.before.status, source: 'MANUAL' }, after: { status: o.after?.status, source: 'COMPUTED' }, reason, batchId,
    })),
  });
  return out;
}

// ─── Bulk ────────────────────────────────────────────────────────────────────

/** Cells written per transaction: big enough to be quick, small enough never to hold locks for long. */
const WRITE_CHUNK = 100;

export interface BulkSkip { userId: string; date: string; code: SkipCode; reason: string }
export interface BulkResult { batchId: string | null; dryRun: boolean; total: number; changed: number; skipped: BulkSkip[] }

/**
 * One bulk edit is applied at a time per organisation. Two overlapping batches
 * over the same people would each read "before" values the other is about to
 * change; this also stops a double-clicked Apply from running twice.
 * (Best-effort, per process — the API runs as a single process.)
 */
const running = new Set<string>();

export async function runBulkCorrection(
  actor: { orgId: string; id: string; email: string },
  cells: BulkCell[],
  opts: BulkOptions & { reason: string; dryRun?: boolean },
): Promise<BulkResult> {
  const { orgId } = actor;
  const byUser = groupByUser(cells);
  const userIds = [...byUser.keys()];
  // Every person must be in the caller's org — one query, and nothing is
  // written if any of them isn't (a foreign id is a 404, never a partial batch).
  const found = await prisma.user.findMany({ where: { orgId, id: { in: userIds } }, select: { id: true } });
  if (found.length !== userIds.length) throw new AppError(404, 'One or more selected people were not found in your organisation.');

  const dryRun = !!opts.dryRun;
  if (!dryRun) {
    if (running.has(orgId)) throw new AppError(409, 'Another bulk edit is still being applied — wait for it to finish and try again.');
    running.add(orgId);
  }
  const batchId = dryRun ? null : randomUUID();
  const skipped: BulkSkip[] = [];
  let changed = 0;
  try {
    for (const [userId, keys] of byUser) {
      keys.sort();
      const from = keyToDate(keys[0]), to = keyToDate(keys[keys.length - 1]);
      // One computation per person gives every cell's current state, the
      // frozen flag, the policy (weekly offs) and the location (holidays).
      const { days, policy, locationId } = await computeDays(orgId, userId, from, to, { persist: !dryRun });
      const holidays = await holidayKeysForUser(orgId, userId, locationId, from, to);
      const dayByKey = new Map(days.map(d => [dateKey(d.date), d]));
      const todo: string[] = [];
      for (const key of keys) {
        const d = dayByKey.get(key);
        const verdict = classifyCell(opts, {
          date: key, frozen: !!d?.frozen, notEmployed: d?.status === 'NOT_EMPLOYED', weeklyOffs: policy.weeklyOffs, holiday: holidays.has(key),
          existing: d ? { source: d.source, status: d.status, notes: d.notes ?? null } : null,
        });
        if (verdict.apply) todo.push(key);
        else skipped.push({ userId, date: key, code: verdict.code, reason: SKIP_REASON[verdict.code] });
      }
      if (dryRun) { changed += todo.length; continue; }

      for (const part of chunk(todo, WRITE_CHUNK)) {
        // Chunks already written stay written; a chunk that fails is rolled
        // back on its own and reported per cell, so the response always says
        // exactly what changed (and re-running the batch picks up the rest).
        try {
          if (opts.action === 'mark') {
            await prisma.$transaction(async tx => {
              for (const key of part) {
                await writeManualStatus(tx, {
                  orgId, actorId: actor.id, actorEmail: actor.email, userId, date: keyToDate(key), status: opts.status!,
                  notes: opts.notes, reason: opts.reason, before: dayByKey.get(key) ?? null, batchId,
                });
              }
            }, { timeout: 30_000 });
            changed += part.length;
          } else {
            const done = await resetManualDays(orgId, actor.id, userId, part, opts.reason, batchId);
            changed += done.length;
            // Removed by someone else between the read and the write: report, don't count.
            const doneKeys = new Set(done.map(d => d.date));
            for (const key of part) if (!doneKeys.has(key)) skipped.push({ userId, date: key, code: 'NOT_MANUAL', reason: SKIP_REASON.NOT_MANUAL });
          }
        } catch (err) {
          console.error('[attendance bulk] chunk failed', { orgId, userId, batchId, err });
          for (const key of part) skipped.push({ userId, date: key, code: 'ERROR', reason: SKIP_REASON.ERROR });
        }
      }
    }
  } finally {
    if (!dryRun) running.delete(orgId);
  }

  if (!dryRun && changed > 0) {
    // One summary line in the generic audit log; the per-day detail is in attendance_audits (batch_id).
    logAction(actor.id, 'UPDATE', 'AttendanceDay', batchId!, { bulk: true, action: opts.action, status: opts.status, changed, skipped: skipped.length, people: userIds.length });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { type: 'corrected', bulk: true, batchId });
  }
  return { batchId, dryRun, total: cells.length, changed, skipped };
}
