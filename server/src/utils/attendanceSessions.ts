// ─── Manual attendance sessions (manager corrections) ────────────────────────
//
// One implementation for every path that adds or edits a punch on someone's
// behalf — the register's "Correct day", POST /hr/attendance/manual and the AI
// MANUAL_ATTENDANCE_ENTRY action — so they share the same rules:
//   - a reason is mandatory and every change is written to AttendanceAudit;
//   - sessions are never merged: an edit targets one record, an addition is a
//     new MANUAL record next to whatever the employee punched themselves;
//   - a past session can't be left (or made) open; times can't overlap another
//     session of the same person, and can't be in the future;
//   - the record's `date` is re-derived from the check-in instant in the
//     employee's policy timezone, and the affected day(s) are recomputed.
import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { logAction } from './auditLog';
import { sseManager, SSEEvent } from './sse';
import { audit, computeDays, policyForUser, frozenUntil } from './attendanceRegister';
import { shiftDayKey, dayPhase, keyToDate, minutesToHhmm, localMinutes, type Policy } from './attendanceEngine';

const FUTURE_SLACK_MS = 5 * 60_000;

function fmt(policy: Policy, d: Date | null) { return d ? minutesToHhmm(localMinutes(d, policy.timezone)) : 'open'; }

async function assertNoOverlap(orgId: string, userId: string, policy: Policy, start: Date, end: Date | null, excludeId?: string) {
  const clash = await prisma.attendanceRecord.findFirst({
    where: {
      orgId, userId, checkInAt: { not: null, ...(end ? { lt: end } : {}) },
      OR: [{ checkOutAt: null }, { checkOutAt: { gt: start } }],
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { checkInAt: true, checkOutAt: true },
  });
  if (clash) throw new AppError(400, `That overlaps another session (${fmt(policy, clash.checkInAt)} – ${fmt(policy, clash.checkOutAt)}). Edit that session instead.`);
}

async function assertNotFrozen(orgId: string, userId: string, dayKey: string) {
  const frozen = await frozenUntil(orgId, userId);
  if (frozen && dayKey <= frozen) throw new AppError(409, `${dayKey} is in a payroll period that has already been finalised, so it can no longer be changed. Make any adjustment in the next payroll run.`);
}

function validateTimes(policy: Policy, checkInAt: Date, checkOutAt: Date | null, now: Date) {
  if (Number.isNaN(checkInAt.getTime()) || (checkOutAt && Number.isNaN(checkOutAt.getTime()))) throw new AppError(400, 'Invalid date/time');
  if (checkInAt.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new AppError(400, 'Check-in time is in the future');
  if (checkOutAt && checkOutAt.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new AppError(400, 'Check-out time is in the future');
  if (checkOutAt && checkOutAt.getTime() <= checkInAt.getTime()) throw new AppError(400, 'Check-out must be after check-in');
  const day = shiftDayKey(checkInAt, policy);
  if (!checkOutAt && dayPhase(policy, day, now) === 'past') throw new AppError(400, 'Add the check-out time too — a session on a past day can\'t be left open.');
  return day;
}

async function recompute(orgId: string, userId: string, keys: string[]) {
  const sorted = [...new Set(keys)].sort();
  if (!sorted.length) return;
  await computeDays(orgId, userId, keyToDate(sorted[0]), keyToDate(sorted[sorted.length - 1]));
}

export interface NewSession { userId: string; checkInAt: Date; checkOutAt: Date | null; notes?: string | null; reason: string }

export async function createManualSession(orgId: string, actorId: string, input: NewSession, now = new Date()) {
  if (!input.reason?.trim()) throw new AppError(400, 'A reason is required for a manual entry');
  const target = await prisma.user.findFirst({ where: { id: input.userId, orgId }, select: { id: true } });
  if (!target) throw new AppError(404, 'User not found');
  const { policy } = await policyForUser(orgId, input.userId);
  const day = validateTimes(policy, input.checkInAt, input.checkOutAt, now);
  await assertNotFrozen(orgId, input.userId, day);
  await assertNoOverlap(orgId, input.userId, policy, input.checkInAt, input.checkOutAt);
  let record;
  try {
    record = await prisma.attendanceRecord.create({
      data: {
        orgId, userId: input.userId, date: keyToDate(day), source: 'MANUAL', notes: input.notes ?? null,
        checkInAt: input.checkInAt, checkOutAt: input.checkOutAt, checkOutSource: input.checkOutAt ? 'MANUAL' : null,
      },
      select: { id: true, date: true, checkInAt: true, checkOutAt: true, source: true, notes: true, userId: true },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') throw new AppError(400, 'This person already has an open session — close it before adding another open one.');
    throw err;
  }
  await audit(orgId, actorId, { userId: input.userId, date: keyToDate(day), entityType: 'ATTENDANCE_RECORD', entityId: record.id, action: 'ADD_SESSION', before: null, after: { checkInAt: record.checkInAt, checkOutAt: record.checkOutAt }, reason: input.reason });
  logAction(actorId, 'CREATE', 'AttendanceRecord', record.id, { action: 'manual_entry', targetUserId: input.userId });
  await recompute(orgId, input.userId, [day]);
  sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: input.userId, type: 'manual' });
  return record;
}

export interface SessionEdit { recordId: string; checkInAt?: Date; checkOutAt?: Date | null; reason: string; expectedUserId?: string }

export async function editSession(orgId: string, actorId: string, edit: SessionEdit, now = new Date()) {
  if (!edit.reason?.trim()) throw new AppError(400, 'A reason is required for every correction');
  const rec = await prisma.attendanceRecord.findFirst({ where: { id: edit.recordId, orgId }, select: { id: true, userId: true, date: true, checkInAt: true, checkOutAt: true, checkOutSource: true } });
  if (!rec || (edit.expectedUserId && rec.userId !== edit.expectedUserId)) throw new AppError(404, 'Session not found');
  if (rec.checkOutAt && edit.checkOutAt === null) throw new AppError(400, 'A closed session can\'t be reopened — set a check-out time instead.');
  const { policy } = await policyForUser(orgId, rec.userId);
  const checkInAt = edit.checkInAt ?? rec.checkInAt;
  if (!checkInAt) throw new AppError(400, 'Set a check-in time for this session');
  const checkOutAt = edit.checkOutAt === undefined ? rec.checkOutAt : edit.checkOutAt;
  const oldDay = rec.checkInAt ? shiftDayKey(rec.checkInAt, policy) : rec.date.toISOString().slice(0, 10);
  await assertNotFrozen(orgId, rec.userId, oldDay);
  const day = validateTimes(policy, checkInAt, checkOutAt, now);
  if (day !== oldDay) await assertNotFrozen(orgId, rec.userId, day);
  await assertNoOverlap(orgId, rec.userId, policy, checkInAt, checkOutAt, rec.id);
  const outChanged = edit.checkOutAt !== undefined && (checkOutAt?.getTime() ?? null) !== (rec.checkOutAt?.getTime() ?? null);
  const saved = await prisma.attendanceRecord.update({
    where: { id: rec.id },
    data: {
      checkInAt, checkOutAt, date: keyToDate(day),
      ...(outChanged ? { checkOutSource: checkOutAt ? 'MANUAL' : null } : {}),
      ...(checkOutAt ? { outsideSince: null } : {}),
    },
    select: { id: true, date: true, checkInAt: true, checkOutAt: true, source: true, checkOutSource: true, userId: true },
  });
  await audit(orgId, actorId, { userId: rec.userId, date: keyToDate(day), entityType: 'ATTENDANCE_RECORD', entityId: rec.id, action: 'TIME_EDIT', before: { checkInAt: rec.checkInAt, checkOutAt: rec.checkOutAt }, after: { checkInAt: saved.checkInAt, checkOutAt: saved.checkOutAt }, reason: edit.reason });
  logAction(actorId, 'UPDATE', 'AttendanceRecord', rec.id, { action: 'time_edit', targetUserId: rec.userId });
  await recompute(orgId, rec.userId, [oldDay, day]);
  sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: rec.userId, type: 'corrected' });
  return saved;
}
