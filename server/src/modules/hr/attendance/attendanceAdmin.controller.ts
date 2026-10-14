// Attendance policy groups, holidays, the day register and admin corrections.
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { logAction } from '../../../utils/auditLog';
import { sseManager, SSEEvent } from '../../../utils/sse';
import {
  computeDays, ensureDefaultGroup, parseDateOnly, dateKey, policyForUser, registerSummary, recordsForDays,
  RECORD_PUBLIC_SELECT, frozenUntil, type ComputedDay,
} from '../../../utils/attendanceRegister';
import { DEFAULT_LATE_BANDS, isValidTimeZone, isScoped, todayKeyFor } from '../../../utils/attendanceEngine';
import { createManualSession, editSession } from '../../../utils/attendanceSessions';
import { isHrManager } from '../../../utils/hrAccess';
import { writeManualStatus, resetManualDays, runBulkCorrection } from '../../../utils/attendanceCorrections';
import { expandCells } from '../../../utils/attendanceBulk';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Policy groups ───────────────────────────────────────────────────────────

const GroupSchema = z.object({
  name: z.string().min(1).max(80),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  shiftStart: z.string().regex(HHMM).optional(),
  shiftEnd: z.string().regex(HHMM).optional(),
  // An invalid zone used to be stored as-is and then 500 every register,
  // summary and payroll read through Intl.DateTimeFormat (ATT-14).
  timezone: z.string().trim().max(64).refine(v => v === '' || isValidTimeZone(v), 'Not a recognised time zone (e.g. Asia/Kolkata)').nullable().optional(),
  graceMinutes: z.coerce.number().int().min(0).max(240).optional(),
  lateBands: z.array(z.object({ untilMinutes: z.number().int().min(1).nullable(), status: z.enum(['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT']) })).min(1).max(6).optional(),
  minFullDayMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  minHalfDayMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  earlyDepartureGraceMinutes: z.coerce.number().int().min(0).max(240).optional(),
  earlyDepartureStatus: z.enum(['NONE', 'HALF_DAY']).optional(),
  overtimeAfterMinutes: z.coerce.number().int().min(0).max(240).optional(),
  overtimeMinMinutes: z.coerce.number().int().min(0).max(480).optional(),
  lateAllowedPerMonth: z.coerce.number().int().min(0).max(31).optional(),
  lateConversionEvery: z.coerce.number().int().min(1).max(31).optional(),
  lateConversionUnit: z.enum(['HALF_DAY', 'LOP', 'NONE']).optional(),
  weeklyOffs: z.array(z.number().int().min(0).max(6)).optional(),
  assumeShiftEndOnMissingCheckout: z.boolean().optional(),
  optionalHolidaysAllowed: z.coerce.number().int().min(0).max(31).optional(),
  applicability: z.object({ departmentIds: z.array(z.string()).optional(), locationIds: z.array(z.string()).optional(), employmentTypes: z.array(z.string()).optional(), userIds: z.array(z.string()).optional() }).nullable().optional(),
});

export async function listGroups(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    await ensureDefaultGroup(orgId);
    const groups = await prisma.attendancePolicyGroup.findMany({ where: { orgId }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    res.json({ groups, defaultLateBands: DEFAULT_LATE_BANDS });
  } catch (err) { next(err); }
}

export async function saveGroup(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = GroupSchema.parse(req.body);
    if (data.lateBands) {
      const ordered = data.lateBands.every((b, i) => i === data.lateBands!.length - 1 ? true : b.untilMinutes != null && (i === 0 || b.untilMinutes > (data.lateBands![i - 1].untilMinutes ?? 0)));
      if (!ordered || data.lateBands[data.lateBands.length - 1].untilMinutes !== null) throw new AppError(400, 'Late bands must be in increasing order and the last band must be "and after"');
    }
    const id = req.params.id;
    // Ownership is checked BEFORE any write (ATT-2): the old code updated by id
    // and only then compared orgId, so a foreign id was already modified.
    const existing = id ? await prisma.attendancePolicyGroup.findFirst({ where: { id, orgId } }) : null;
    if (id && !existing) throw new AppError(404, 'Policy group not found');

    // userIds aren't editable on older clients; keep them unless explicitly sent.
    let applicability: any = data.applicability;
    if (applicability && existing && applicability.userIds === undefined && Array.isArray((existing.applicability as any)?.userIds)) {
      applicability = { ...applicability, userIds: (existing.applicability as any).userIds };
    }
    if (applicability) {
      const users = applicability.userIds as string[] | undefined;
      if (users?.length) {
        const n = await prisma.user.count({ where: { orgId, id: { in: users } } });
        if (n !== new Set(users).size) throw new AppError(400, 'One or more selected people are not in your organisation');
      }
    }
    const scoped = applicability === undefined ? isScoped(existing?.applicability) : isScoped(applicability);
    const willBeDefault = data.isDefault ?? existing?.isDefault ?? false;
    // Exactly one default, and it must apply to everyone (ATT-16)
    if (willBeDefault && scoped) throw new AppError(400, 'The default policy applies to everyone who isn\'t matched by another policy — clear its "Applies to" filters, or make a different policy the default.');
    if (existing?.isDefault && data.isDefault === false) throw new AppError(400, 'Make another policy the default first (edit it and tick "Default policy").');
    if (willBeDefault && data.isActive === false) throw new AppError(400, 'The default policy can\'t be inactive.');

    const payload: any = {
      ...data,
      timezone: data.timezone === '' ? null : data.timezone,
      // null clears the scope; Prisma needs DbNull for a JSON column (plain
      // null/undefined left the old scope in place).
      applicability: applicability === null ? Prisma.DbNull : applicability,
    };
    const group = await prisma.$transaction(async tx => {
      if (willBeDefault && data.isDefault) await tx.attendancePolicyGroup.updateMany({ where: { orgId, isDefault: true, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false } });
      return id
        ? tx.attendancePolicyGroup.update({ where: { id: existing!.id }, data: payload })
        : tx.attendancePolicyGroup.create({ data: { orgId, ...payload } });
    });
    logAction(req.user!.id, id ? 'UPDATE' : 'CREATE', 'AttendancePolicyGroup', group.id, data);
    res.json(group);
  } catch (err) { next(err); }
}

export async function deleteGroup(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const g = await prisma.attendancePolicyGroup.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!g) throw new AppError(404, 'Policy group not found');
    if (g.isDefault) throw new AppError(400, 'Make another group the default first');
    await prisma.attendancePolicyGroup.update({ where: { id: g.id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** GET /hr/attendance/my-policy — the caller's effective policy (for the Attendance page hints) */
export async function myPolicy(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { policy, group } = await policyForUser(req.user!.orgId, req.user!.id);
    res.json({ ...policy, groupName: group.name, optionalHolidaysAllowed: group.optionalHolidaysAllowed ?? 2, today: todayKeyFor(policy) });
  } catch (err) { next(err); }
}

// ─── Holidays ────────────────────────────────────────────────────────────────

const HolidaySchema = z.object({
  date: z.string().regex(DATE_RE),
  name: z.string().trim().min(1).max(80),
  locationIds: z.array(z.string()).optional(),
  isOptional: z.boolean().optional(),
});

export async function listHolidays(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const rows = await prisma.holiday.findMany({ where: { orgId: req.user!.orgId, date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } }, orderBy: { date: 'asc' } });
    res.json(rows);
  } catch (err) { next(err); }
}

export async function saveHoliday(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = HolidaySchema.parse(req.body);
    const payload = { date: parseDateOnly(data.date), name: data.name, locationIds: data.locationIds ?? [], isOptional: data.isOptional ?? false };
    if (req.params.id) {
      // Check ownership before writing (ATT-2)
      const existing = await prisma.holiday.findFirst({ where: { id: req.params.id, orgId } });
      if (!existing) throw new AppError(404, 'Holiday not found');
      res.json(await prisma.holiday.update({ where: { id: existing.id }, data: payload }));
    } else {
      res.json(await prisma.holiday.create({ data: { orgId, ...payload } }));
    }
  } catch (err: any) {
    if (err?.code === 'P2002') return next(new AppError(400, 'A holiday with that name already exists on that date'));
    next(err);
  }
}

export async function deleteHoliday(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const h = await prisma.holiday.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!h) throw new AppError(404, 'Holiday not found');
    await prisma.holiday.delete({ where: { id: h.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** POST /hr/attendance/holidays/bulk — [{date,name,isOptional?,locationIds?}]; existing (same date + name) are skipped */
export async function bulkHolidays(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rows = z.array(HolidaySchema).min(1).max(100).parse(req.body);
    const orgId = req.user!.orgId;
    const result = await prisma.holiday.createMany({ data: rows.map(r => ({ orgId, date: parseDateOnly(r.date), name: r.name, locationIds: r.locationIds ?? [], isOptional: r.isOptional ?? false })), skipDuplicates: true });
    res.json({ ok: true, count: result.count, skipped: rows.length - result.count });
  } catch (err) { next(err); }
}

// ─── Optional holidays (employee opt-in, ATT-26) ─────────────────────────────

async function optionalContext(orgId: string, userId: string, year: number) {
  const { policy, group, locationId } = await policyForUser(orgId, userId);
  const from = new Date(Date.UTC(year, 0, 1)), to = new Date(Date.UTC(year, 11, 31));
  const [holidays, choices] = await Promise.all([
    prisma.holiday.findMany({ where: { orgId, isOptional: true, date: { gte: from, lte: to } }, orderBy: { date: 'asc' } }),
    prisma.optionalHolidayChoice.findMany({ where: { userId, holiday: { orgId, date: { gte: from, lte: to } } }, select: { holidayId: true } }),
  ]);
  const chosen = new Set(choices.map(c => c.holidayId));
  const mine = holidays.filter(h => h.locationIds.length === 0 || (locationId && h.locationIds.includes(locationId)));
  return { policy, allowed: group.optionalHolidaysAllowed ?? 2, holidays: mine.map(h => ({ ...h, optedIn: chosen.has(h.id) })), used: mine.filter(h => chosen.has(h.id)).length };
}

/** GET /hr/attendance/optional-holidays?year — the caller's optional holidays and allowance */
export async function listOptionalHolidays(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const ctx = await optionalContext(req.user!.orgId, req.user!.id, year);
    res.json({ year, allowed: ctx.allowed, used: ctx.used, today: todayKeyFor(ctx.policy), holidays: ctx.holidays });
  } catch (err) { next(err); }
}

/** POST/DELETE /hr/attendance/optional-holidays/:id — opt in / out (only for today or later) */
export async function setOptionalHoliday(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId, userId = req.user!.id;
    const optIn = req.method === 'POST';
    const holiday = await prisma.holiday.findFirst({ where: { id: req.params.id, orgId, isOptional: true } });
    if (!holiday) throw new AppError(404, 'Optional holiday not found');
    const ctx = await optionalContext(orgId, userId, holiday.date.getUTCFullYear());
    const entry = ctx.holidays.find(h => h.id === holiday.id);
    if (!entry) throw new AppError(403, 'That optional holiday doesn\'t apply to your location');
    if (dateKey(holiday.date) < todayKeyFor(ctx.policy)) throw new AppError(400, 'That date has passed — ask HR to correct past days.');
    if (optIn) {
      if (entry.optedIn) return res.json({ ok: true });
      if (ctx.used >= ctx.allowed) throw new AppError(400, `You've already chosen ${ctx.used} of ${ctx.allowed} optional holidays this year.`);
      await prisma.optionalHolidayChoice.create({ data: { orgId, userId, holidayId: holiday.id } }).catch((e: any) => { if (e?.code !== 'P2002') throw e; });
    } else {
      await prisma.optionalHolidayChoice.deleteMany({ where: { userId, holidayId: holiday.id } });
    }
    logAction(userId, 'UPDATE', 'OptionalHolidayChoice', holiday.id, { optIn });
    await computeDays(orgId, userId, holiday.date, holiday.date).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ─── Register (days) ─────────────────────────────────────────────────────────

function rangeFromQuery(q: Record<string, string>) {
  if (q.from && q.to && DATE_RE.test(q.from) && DATE_RE.test(q.to)) return { from: parseDateOnly(q.from), to: parseDateOnly(q.to) };
  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 0)) };
}

const serializeDay = (d: ComputedDay) => ({
  date: dateKey(d.date), status: d.status, source: d.source, paidFraction: Number(d.paidFraction), workedMinutes: d.workedMinutes,
  lateMinutes: d.lateMinutes, earlyMinutes: d.earlyMinutes, overtimeMinutes: d.overtimeMinutes, firstInAt: d.firstInAt, lastOutAt: d.lastOutAt,
  reason: d.reason, notes: d.notes ?? null, leaveRequestId: d.leaveRequestId, phase: d.phase, provisional: d.provisional, frozen: d.frozen,
});

const USER_SELECT = { id: true, name: true, avatarUrl: true, department: true, isActive: true } as const;

/** GET /hr/attendance/register?month=YYYY-MM[&userId=] — managers: everyone (or one user); others: self */
export async function register(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const isManager = isHrManager(req.user!.role);
    const q = req.query as Record<string, string>;
    const { from, to } = rangeFromQuery(q);
    if (to.getTime() < from.getTime()) throw new AppError(400, 'Invalid range');
    if (to.getTime() - from.getTime() > 62 * 86_400_000) throw new AppError(400, 'Range too large (max 62 days)');
    let list;
    if (isManager && !q.userId) {
      // Everyone active now, plus anyone who was around in that month (exited
      // staff must not vanish from past months, ATT-34).
      const inRange = { gte: from, lte: to };
      list = await prisma.user.findMany({
        where: {
          orgId,
          ...(q.includeEmployees === '1' ? {} : { role: { not: 'EMPLOYEE' as any } }),
          OR: [
            { isActive: true },
            { attendanceDays: { some: { date: inRange } } },
            { attendanceRecords: { some: { checkInAt: { gte: from, lt: new Date(to.getTime() + 86_400_000) } } } },
            { employee: { lastWorkingDate: { gte: from } } },
          ],
        },
        select: USER_SELECT, orderBy: { name: 'asc' },
      });
    } else {
      list = await prisma.user.findMany({ where: { orgId, id: isManager && q.userId ? q.userId : req.user!.id }, select: USER_SELECT });
    }
    const rows = [];
    for (const u of list) {
      // One computation per user; the summary reuses it (ATT-11)
      const { days, group, policy } = await computeDays(orgId, u.id, from, to);
      rows.push({ user: u, policyGroup: group.name, timezone: policy.timezone, days: days.map(serializeDay), summary: { ...registerSummary(policy, days), policyGroupName: group.name } });
    }
    res.json({ from: dateKey(from), to: dateKey(to), rows });
  } catch (err) { next(err); }
}

/** GET /hr/attendance/summary?userId&from&to — period figures for one user */
export async function summary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, string>;
    const { from, to } = rangeFromQuery(q);
    const orgId = req.user!.orgId;
    const userId = isHrManager(req.user!.role) && q.userId ? q.userId : req.user!.id;
    // computeDays refuses a user outside the caller's org (ATT-10)
    const { days, policy, group } = await computeDays(orgId, userId, from, to);
    res.json({ ...registerSummary(policy, days), policyGroupName: group.name });
  } catch (err) { next(err); }
}

/** GET /hr/attendance/day?userId&date — one day: computed status + its sessions (managers: anyone; others: self) */
export async function dayDetail(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const q = req.query as Record<string, string>;
    if (!DATE_RE.test(q.date || '')) throw new AppError(400, 'date=YYYY-MM-DD is required');
    const userId = isHrManager(req.user!.role) && q.userId ? q.userId : req.user!.id;
    const date = parseDateOnly(q.date);
    const { days, policy } = await computeDays(orgId, userId, date, date);
    const sessions = await recordsForDays(orgId, userId, policy, q.date, q.date, RECORD_PUBLIC_SELECT);
    const ids = sessions.map(s => s.id);
    const [withIn, withOut] = ids.length ? await Promise.all([
      prisma.attendanceRecord.findMany({ where: { id: { in: ids }, checkInSelfie: { not: null } }, select: { id: true } }),
      prisma.attendanceRecord.findMany({ where: { id: { in: ids }, checkOutSelfie: { not: null } }, select: { id: true } }),
    ]) : [[], []];
    const hasIn = new Set(withIn.map(r => r.id)), hasOut = new Set(withOut.map(r => r.id));
    res.json({
      timezone: policy.timezone,
      day: days[0] ? serializeDay(days[0]) : null,
      sessions: sessions.map(s => ({ ...s, hasCheckInSelfie: hasIn.has(s.id), hasCheckOutSelfie: hasOut.has(s.id) })),
    });
  } catch (err) { next(err); }
}

// ─── Admin corrections ───────────────────────────────────────────────────────

const STATUS_ENUM = z.enum(['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'UNPAID_LEAVE', 'WFH', 'HOLIDAY', 'WEEK_OFF', 'LOP']);
const MarkSchema = z.object({
  userId: z.string(),
  date: z.string().regex(DATE_RE),
  /** Manual status override. Omit to only fix punches and let the engine decide. */
  status: STATUS_ENUM.optional(),
  /** Edits to specific sessions — only send the fields that changed. */
  sessions: z.array(z.object({ recordId: z.string(), checkInAt: z.string().datetime().optional(), checkOutAt: z.string().datetime().nullable().optional() })).max(20).optional(),
  /** A new MANUAL session alongside the existing ones (never merged into them). */
  addSession: z.object({ checkInAt: z.string().datetime(), checkOutAt: z.string().datetime().nullable().optional() }).optional(),
  /** Legacy single-record edit: applies to `recordId`, or to the day's only session. */
  recordId: z.string().optional(),
  checkInAt: z.string().datetime().nullable().optional(),
  checkOutAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(500).optional(),
  reason: z.string().trim().min(1).max(500),
});

const toDate = (s: string | null | undefined) => (s == null ? s as null | undefined : new Date(s));

/**
 * POST /hr/attendance/days — correct one day (managers). Audited.
 * Punch edits target one session at a time and new punches become a separate
 * MANUAL session; a status, when given, is stored as a MANUAL override that the
 * engine never recomputes (ATT-1).
 */
export async function markDay(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const actor = req.user!.id;
    const data = MarkSchema.parse(req.body);
    const target = await prisma.user.findFirst({ where: { id: data.userId, orgId } });
    if (!target) throw new AppError(404, 'User not found');
    const date = parseDateOnly(data.date);
    const frozen = await frozenUntil(orgId, data.userId);
    if (frozen && data.date <= frozen) throw new AppError(409, `${data.date} is in a payroll period that has already been finalised, so it can no longer be changed. Make any adjustment in the next payroll run.`);

    const { days: beforeDays, policy } = await computeDays(orgId, data.userId, date, date);
    const before = beforeDays[0];

    const edits = [...(data.sessions ?? [])].map(e => ({ recordId: e.recordId, checkInAt: toDate(e.checkInAt) ?? undefined, checkOutAt: toDate(e.checkOutAt) }));
    let add = data.addSession ? { checkInAt: new Date(data.addSession.checkInAt), checkOutAt: data.addSession.checkOutAt ? new Date(data.addSession.checkOutAt) : null } : null;
    if (data.checkInAt !== undefined || data.checkOutAt !== undefined) {
      if (data.checkInAt === null) throw new AppError(400, 'A session needs a check-in time');
      let recordId = data.recordId;
      if (!recordId) {
        const sessions = await recordsForDays(orgId, data.userId, policy, data.date, data.date, { id: true });
        if (sessions.length > 1) throw new AppError(400, 'This day has several sessions — edit each session separately.');
        recordId = sessions[0]?.id;
      }
      if (recordId) edits.push({ recordId, checkInAt: toDate(data.checkInAt) ?? undefined, checkOutAt: toDate(data.checkOutAt) });
      else if (data.checkInAt) add = { checkInAt: new Date(data.checkInAt), checkOutAt: data.checkOutAt ? new Date(data.checkOutAt) : null };
      else throw new AppError(400, 'There is no session on this day to set a check-out on — add a session with both times.');
    }
    if (!data.status && !edits.length && !add) throw new AppError(400, 'Nothing to change — pick a status, edit a session or add one.');

    for (const e of edits) await editSession(orgId, actor, { ...e, reason: data.reason, expectedUserId: data.userId });
    if (add) await createManualSession(orgId, actor, { userId: data.userId, checkInAt: add.checkInAt, checkOutAt: add.checkOutAt, notes: data.notes ?? null, reason: data.reason });

    if (data.status) {
      // Same write as the bulk edit (utils/attendanceCorrections.ts)
      const { row: after, action } = await writeManualStatus(prisma, { orgId, actorId: actor, actorEmail: req.user!.email, userId: data.userId, date, status: data.status, notes: data.notes, reason: data.reason, before });
      logAction(actor, 'UPDATE', 'AttendanceDay', after.id, { action, userId: data.userId, date: data.date, status: data.status });
    }
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: data.userId, type: 'corrected' });
    const { days } = await computeDays(orgId, data.userId, date, date);
    res.json(days[0] ? serializeDay(days[0]) : null);
  } catch (err) { next(err); }
}

/** DELETE /hr/attendance/days/:userId/:date — drop a manual override so the engine recomputes the day */
export async function resetDay(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    if (!DATE_RE.test(req.params.date)) throw new AppError(400, 'Invalid date');
    const date = parseDateOnly(req.params.date);
    const frozen = await frozenUntil(orgId, req.params.userId);
    if (frozen && req.params.date <= frozen) throw new AppError(409, `${req.params.date} is in a finalised payroll period and can no longer be changed.`);
    // Same revert as the bulk edit: drop the MANUAL row, recompute, audit.
    const done = await resetManualDays(orgId, req.user!.id, req.params.userId, [req.params.date], (req.body?.reason as string) || 'Reverted to computed');
    if (!done.length) throw new AppError(404, 'No manual entry for that day');
    const day = done[0].after;
    res.json(day ? serializeDay(day) : null);
  } catch (err) { next(err); }
}

const BulkSchema = z.object({
  /** Explicit cells (the register's "Select days" mode)… */
  cells: z.array(z.object({ userId: z.string().min(1), date: z.string() })).max(5000).optional(),
  /** …or people × (dates | range) */
  userIds: z.array(z.string().min(1)).max(1000).optional(),
  dates: z.array(z.string()).max(400).optional(),
  range: z.object({ from: z.string(), to: z.string() }).optional(),
  skipWeeklyOffs: z.boolean().optional().default(true),
  skipHolidays: z.boolean().optional().default(true),
  action: z.enum(['mark', 'reset']),
  status: STATUS_ENUM.optional(),
  reason: z.string().trim().min(1).max(500),
  notes: z.string().max(500).optional(),
  overwriteManual: z.boolean().optional().default(false),
  /** Classify only — returns what would change, writes nothing (the confirm step's preview). */
  dryRun: z.boolean().optional(),
}).refine(d => d.action !== 'mark' || !!d.status, { message: 'Pick the status to mark the days as', path: ['status'] });

/**
 * POST /hr/attendance/days/bulk — mark or reset many people × days (managers).
 * Each changed day goes through the same write as the single-day correction
 * and gets its own audit row (tagged with the batch id). Frozen days, weekly
 * offs / holidays (when asked) and existing manual corrections (unless
 * overwriteManual) are skipped and reported. Re-running a batch changes nothing new.
 */
export async function bulkDays(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = BulkSchema.parse(req.body);
    const cells = expandCells(data);
    const result = await runBulkCorrection({ orgId: req.user!.orgId, id: req.user!.id, email: req.user!.email }, cells, {
      action: data.action, status: data.status, notes: data.notes, reason: data.reason,
      skipWeeklyOffs: data.skipWeeklyOffs, skipHolidays: data.skipHolidays, overwriteManual: data.overwriteManual, dryRun: data.dryRun,
    });
    res.json(result);
  } catch (err) { next(err); }
}

/** GET /hr/attendance/audit?userId=&limit= — modification history (managers; employees see their own) */
export async function auditHistory(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, string>;
    const isManager = isHrManager(req.user!.role);
    const userId = isManager ? q.userId : req.user!.id;
    const rows = await prisma.attendanceAudit.findMany({
      where: { orgId: req.user!.orgId, ...(userId ? { userId } : {}) },
      include: { changer: { select: { id: true, name: true } }, user: { select: { id: true, name: true } } },
      orderBy: { changedAt: 'desc' }, take: Math.min(200, Number(q.limit) || 50),
    });
    res.json(rows);
  } catch (err) { next(err); }
}
