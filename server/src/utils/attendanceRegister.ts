// ─── Attendance register: DB glue around attendanceEngine ────────────────────
//
// computeDays() derives AttendanceDay rows for a user/range from check-in/out
// records, approved leave, holidays and the user's policy group, persisting
// COMPUTED rows and leaving MANUAL ones untouched. periodSummary() is what the
// register shows; payrollSummary() is what payroll consumes.
//
// Which day does a session belong to? Historically AttendanceRecord.date was
// stamped with the UTC date at check-in, which is the wrong day for anyone east
// of UTC between 00:00 and 05:30 IST (and for every night shift). New records
// are stamped with the shift day in the policy timezone, but rather than trust
// the column for old rows, the register re-derives the day from the check-in
// instant (shiftDayKey) for every record. Records without a check-in instant
// (legacy blank manual rows) fall back to the stored date.

import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import {
  evaluateDay, summarise, pickGroup, pickHoliday, shiftDayKey, safeTimeZone, dateKey, keyToDate, addDaysKey, dayPhase, todayKeyFor,
  DEFAULT_POLICY, DEFAULT_LATE_BANDS, NON_PERSISTED_STATUSES, isScoped,
  type Policy, type DayStatus, type PeriodSummary, type Session, type DayPhase, type SummaryDay,
} from './attendanceEngine';
import { wfhSettingsOf, scheduleFor, type ScheduleLike } from './wfhRules';

const DAY = 86_400_000;
export const utcDate = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
export { dateKey };
export const parseDateOnly = (s: string) => { const [y, m, d] = s.split('-').map(Number); return utcDate(y, m - 1, d); };

export function toPolicy(g: any, orgTz: string, locationTz?: string | null): Policy {
  return {
    id: g.id, shiftStart: g.shiftStart, shiftEnd: g.shiftEnd,
    // Precedence: the group's own override, then the employee's location, then the org.
    timezone: safeTimeZone(g.timezone, locationTz, orgTz),
    graceMinutes: g.graceMinutes, lateBands: g.lateBands ?? DEFAULT_LATE_BANDS,
    minFullDayMinutes: g.minFullDayMinutes, minHalfDayMinutes: g.minHalfDayMinutes,
    earlyDepartureGraceMinutes: g.earlyDepartureGraceMinutes, earlyDepartureStatus: g.earlyDepartureStatus,
    overtimeAfterMinutes: g.overtimeAfterMinutes, overtimeMinMinutes: g.overtimeMinMinutes,
    lateAllowedPerMonth: g.lateAllowedPerMonth, lateConversionEvery: g.lateConversionEvery, lateConversionUnit: g.lateConversionUnit,
    weeklyOffs: g.weeklyOffs ?? [0, 6], assumeShiftEndOnMissingCheckout: g.assumeShiftEndOnMissingCheckout,
    wfhRequireCheckIn: wfhSettingsOf(g).requireCheckIn,
  };
}

/** Every org gets a default 9–6 group. The default must apply to everyone, so a scoped group is never promoted. */
export async function ensureDefaultGroup(orgId: string) {
  const existing = await prisma.attendancePolicyGroup.findFirst({ where: { orgId, isDefault: true } });
  if (existing) return existing;
  const candidates = await prisma.attendancePolicyGroup.findMany({ where: { orgId, isActive: true }, orderBy: { createdAt: 'asc' } });
  const unscoped = candidates.find(g => !isScoped(g.applicability));
  if (unscoped) return prisma.attendancePolicyGroup.update({ where: { id: unscoped.id }, data: { isDefault: true } });
  return prisma.attendancePolicyGroup.create({ data: { orgId, name: 'Standard (9:00 – 18:00)', isDefault: true, lateBands: DEFAULT_LATE_BANDS as any } });
}

const EMP_SELECT = {
  userId: true, departmentId: true, locationId: true, employmentType: true, joiningDate: true, lastWorkingDate: true,
  location: { select: { timezone: true } },
} as const;

type EmpRow = { userId: string | null; departmentId: string | null; locationId: string | null; employmentType: string | null; joiningDate: Date | null; lastWorkingDate: Date | null; location: { timezone: string | null } | null };

function ctxFromEmployee(userId: string, emp: EmpRow | null) {
  return {
    userId, departmentId: emp?.departmentId ?? null, locationId: emp?.locationId ?? null, employmentType: emp?.employmentType ?? null,
    locationTz: emp?.location?.timezone ?? null,
    employment: emp ? { joiningDate: emp.joiningDate ?? null, lastWorkingDate: emp.lastWorkingDate ?? null } : null,
  };
}

export async function policyForUser(orgId: string, userId: string): Promise<{ policy: Policy; group: any; locationId: string | null; employment: { joiningDate: Date | null; lastWorkingDate: Date | null } | null }> {
  const [org, groups, emp] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }),
    prisma.attendancePolicyGroup.findMany({ where: { orgId } }),
    prisma.employee.findFirst({ where: { orgId, userId }, select: EMP_SELECT }),
  ]);
  const ctx = ctxFromEmployee(userId, emp as EmpRow | null);
  let group = pickGroup(groups, ctx);
  if (!group) group = await ensureDefaultGroup(orgId);
  return { policy: toPolicy(group, org?.timezone ?? 'UTC', ctx.locationTz), group, locationId: ctx.locationId, employment: ctx.employment };
}

/** Policies for many users of one org with three queries (team views, background jobs). */
export async function policiesForOrg(orgId: string, userIds: string[]): Promise<Map<string, Policy>> {
  const [org, groups, emps] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }),
    prisma.attendancePolicyGroup.findMany({ where: { orgId } }),
    prisma.employee.findMany({ where: { orgId, userId: { in: userIds } }, select: EMP_SELECT }),
  ]);
  let fallback: any = groups.find(g => g.isDefault && g.isActive) ?? null;
  const byUser = new Map((emps as EmpRow[]).map(e => [e.userId!, e]));
  const out = new Map<string, Policy>();
  for (const id of userIds) {
    const ctx = ctxFromEmployee(id, byUser.get(id) ?? null);
    let g: any = pickGroup(groups, ctx);
    if (!g) g = fallback ?? (fallback = await ensureDefaultGroup(orgId));
    out.set(id, toPolicy(g, org?.timezone ?? 'UTC', ctx.locationTz));
  }
  return out;
}

/** Fields of a record the engine/register need (never the selfies — see ATT-20). */
export const SESSION_SELECT = { id: true, date: true, checkInAt: true, checkOutAt: true, source: true, checkOutSource: true, mode: true } as const;

/** Every record column except the two selfie data-URLs, for list endpoints. */
export const RECORD_PUBLIC_SELECT = {
  id: true, orgId: true, userId: true, date: true,
  checkInAt: true, checkInLat: true, checkInLng: true, checkInIp: true, checkInLocationOk: true, checkInNetworkOk: true,
  checkOutAt: true, checkOutLat: true, checkOutLng: true, checkOutIp: true, checkOutLocationOk: true, checkOutNetworkOk: true,
  source: true, notes: true, checkInFaceOk: true, checkInFaceDistance: true, checkInPassed: true,
  checkOutFaceOk: true, checkOutFaceDistance: true, checkOutPassed: true, checkOutSource: true,
  lastSeenAt: true, lastSeenLat: true, lastSeenLng: true, lastSeenInside: true, outsideSince: true, lastNudgedAt: true, backgroundedAt: true,
  mode: true, createdAt: true, updatedAt: true,
} as const;

/** The calendar day a record belongs to under `policy`. */
export function recordDayKey(r: { checkInAt: Date | null; date: Date }, policy: Policy): string {
  return r.checkInAt ? shiftDayKey(r.checkInAt, policy) : dateKey(r.date);
}

/**
 * Records of one user attributed (by check-in instant in the policy timezone)
 * to days fromKey..toKey. Queries a margin around the range so a session
 * stamped with an old UTC date or an overnight shift still lands on its day.
 */
export async function recordsForDays<S extends Record<string, any>>(orgId: string, userId: string, policy: Policy, fromKey: string, toKey: string, select: S) {
  const qFrom = new Date(keyToDate(fromKey).getTime() - 2 * DAY), qTo = new Date(keyToDate(toKey).getTime() + 3 * DAY);
  const rows: any[] = await prisma.attendanceRecord.findMany({
    where: { orgId, userId, OR: [{ checkInAt: { gte: qFrom, lt: qTo } }, { checkInAt: null, date: { gte: keyToDate(fromKey), lte: keyToDate(toKey) } }] },
    select: { ...select, checkInAt: true, date: true },
    orderBy: { checkInAt: 'asc' },
  });
  return rows
    .map(r => ({ ...r, day: recordDayKey(r, policy) }))
    .filter(r => r.day >= fromKey && r.day <= toKey) as (any & { day: string })[];
}

/**
 * End of the last FINALISED payroll period that paid this user. Days on or
 * before it are frozen: never recomputed, so a later policy edit or a late
 * punch correction can't silently rewrite a month that has been paid.
 */
export async function frozenUntil(orgId: string, userId: string): Promise<string | null> {
  const run = await prisma.payrollRun.findFirst({
    where: { orgId, status: { in: ['PROCESSED', 'PAID'] }, payslips: { some: { userId } } },
    orderBy: [{ periodEnd: 'desc' }, { year: 'desc' }, { month: 'desc' }],
    select: { periodEnd: true, year: true, month: true },
  });
  if (!run) return null;
  return dateKey(run.periodEnd ?? new Date(Date.UTC(run.year, run.month, 0)));
}

/**
 * Recurring WFH schedules that can apply to a user in [fromKey, toKey]: their
 * own, plus their policy group's while the group has WFH enabled (a disabled
 * group's schedule is ignored; one set for the person by HR still applies).
 * Exceptions in the range come along.
 */
export async function schedulesFor(orgId: string, userId: string, group: { id: string; wfhEnabled?: boolean } | null, fromKey: string, toKey: string): Promise<ScheduleLike[]> {
  const from = keyToDate(fromKey), to = keyToDate(toKey);
  const owners: any[] = [{ userId }];
  if (group?.id && wfhSettingsOf(group).enabled) owners.push({ policyGroupId: group.id });
  return prisma.wfhSchedule.findMany({
    where: { orgId, startDate: { lte: to }, AND: [{ OR: [{ endDate: null }, { endDate: { gte: from } }] }, { OR: owners }] },
    include: { exceptions: { where: { date: { gte: from, lte: to } }, select: { userId: true, date: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

export interface ComputedDay {
  id?: string; orgId: string; userId: string; date: Date; status: DayStatus; source: string; policyGroupId?: string | null;
  firstInAt: Date | null; lastOutAt: Date | null; workedMinutes: number; lateMinutes: number; earlyMinutes: number; overtimeMinutes: number;
  paidFraction: any; leaveRequestId: string | null; reason: string | null; notes?: string | null;
  /** In-memory only */
  phase: DayPhase; provisional: boolean; frozen: boolean; wouldWork?: boolean;
}

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined) => (a ? a.getTime() : null) === (b ? b.getTime() : null);
function unchanged(existing: any, row: any): boolean {
  return existing && existing.source === 'COMPUTED' && existing.orgId === row.orgId && existing.status === row.status
    && Number(existing.paidFraction) === Number(row.paidFraction) && existing.workedMinutes === row.workedMinutes
    && existing.lateMinutes === row.lateMinutes && existing.earlyMinutes === row.earlyMinutes && existing.overtimeMinutes === row.overtimeMinutes
    && sameInstant(existing.firstInAt, row.firstInAt) && sameInstant(existing.lastOutAt, row.lastOutAt)
    && (existing.reason ?? null) === (row.reason ?? null) && (existing.leaveRequestId ?? null) === (row.leaveRequestId ?? null)
    && (existing.policyGroupId ?? null) === (row.policyGroupId ?? null);
}

/**
 * Computes (and by default persists) every day of [from, to] for one user.
 * - The user must belong to `orgId` (a foreign userId is a 404, never a write).
 * - MANUAL rows are returned untouched; days covered by a finalised payroll
 *   run are frozen and returned as stored.
 * - Today/future days and NOT_EMPLOYED days are evaluated but not persisted
 *   (a stale persisted row for such a day is removed).
 * - Only rows whose figures changed are written.
 */
export async function computeDays(orgId: string, userId: string, from: Date, to: Date, opts: { persist?: boolean; now?: Date } = {}) {
  const persist = opts.persist !== false;
  const now = opts.now ?? new Date();
  const user = await prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true } });
  if (!user) throw new AppError(404, 'User not found');
  const { policy, group, locationId, employment } = await policyForUser(orgId, userId);
  const fromKey = dateKey(from), toKey = dateKey(to);
  const [records, leaves, holidays, existingRows, choices, frozenKey, schedules] = await Promise.all([
    recordsForDays(orgId, userId, policy, fromKey, toKey, SESSION_SELECT),
    prisma.leaveRequest.findMany({ where: { orgId, userId, status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } }, include: { leaveType: true } }),
    prisma.holiday.findMany({ where: { orgId, date: { gte: from, lte: to } } }),
    prisma.attendanceDay.findMany({ where: { userId, date: { gte: from, lte: to } } }),
    prisma.optionalHolidayChoice.findMany({ where: { userId, holiday: { orgId, date: { gte: from, lte: to } } }, select: { holidayId: true } }),
    frozenUntil(orgId, userId),
    schedulesFor(orgId, userId, group, fromKey, toKey),
  ]);
  const existingByKey = new Map(existingRows.map(r => [dateKey(r.date), r]));
  const chosen = new Set(choices.map(c => c.holidayId));
  const byDay = new Map<string, typeof records>();
  for (const r of records) { const l = byDay.get(r.day) ?? []; l.push(r); byDay.set(r.day, l); }
  const todayKey = todayKeyFor(policy, now);

  const out: ComputedDay[] = [];
  const staleIds: string[] = [];
  for (let key = fromKey; key <= toKey; key = addDaysKey(key, 1)) {
    const date = keyToDate(key); const t = date.getTime();
    const existing = existingByKey.get(key);
    const frozen = !!frozenKey && key <= frozenKey;
    const quickPhase: DayPhase = key > todayKey ? 'future' : key === todayKey ? 'today' : 'past';
    if (existing?.source === 'MANUAL') { out.push({ ...(existing as any), phase: quickPhase, provisional: false, frozen }); continue; }
    if (frozen && existing) { out.push({ ...(existing as any), phase: 'past', provisional: false, frozen: true }); continue; }

    const dayRecords = byDay.get(key) ?? [];
    const sessions: Session[] = dayRecords.map(r => ({ checkInAt: r.checkInAt, checkOutAt: r.checkOutAt, source: r.source, checkOutSource: r.checkOutSource }));
    const dayLeaves = leaves.filter(l => l.startDate.getTime() <= t && l.endDate.getTime() >= t);
    const wfhLeave = dayLeaves.find(l => l.leaveType.isWfh);
    const leave = dayLeaves.find(l => !l.leaveType.isWfh);
    const holiday = pickHoliday(holidays.filter(h => dateKey(h.date) === key), locationId, chosen);
    // A WFH day is an approved WFH request or a recurring schedule — nothing
    // else (the old "notes contain WFH" heuristic is gone; manual marks are MANUAL rows).
    const recurring = wfhLeave ? null : scheduleFor(schedules, userId, key);
    const res = evaluateDay(policy, {
      date, sessions,
      wfhApproved: wfhLeave ? { requestId: wfhLeave.id, name: wfhLeave.leaveType.name } : recurring ? { requestId: null, name: 'Recurring work from home' } : null,
      employment,
      holiday: holiday ? { name: holiday.name, isOptional: holiday.isOptional, optedIn: chosen.has(holiday.id) } : null,
      leave: leave ? { days: Number(leave.days), halfDay: leave.halfDay, halfDayPeriod: leave.halfDayPeriod, isPaid: leave.leaveType.isPaid, leaveTypeName: leave.leaveType.name, requestId: leave.id } : null,
    }, now);
    const row = {
      orgId, userId, date, status: res.status, source: 'COMPUTED', policyGroupId: group.id,
      firstInAt: res.firstInAt, lastOutAt: res.lastOutAt, workedMinutes: res.workedMinutes, lateMinutes: res.lateMinutes,
      earlyMinutes: res.earlyMinutes, overtimeMinutes: res.overtimeMinutes, paidFraction: res.paidFraction,
      leaveRequestId: res.leaveRequestId ?? null, reason: res.reason,
    };
    const extras = { phase: res.phase, provisional: res.provisional, frozen, wouldWork: res.wouldWork };
    const persistable = !res.provisional && !NON_PERSISTED_STATUSES.includes(res.status);
    if (!persistable) {
      if (existing && existing.source === 'COMPUTED') staleIds.push(existing.id);
      out.push({ ...row, notes: existing?.notes ?? null, ...extras });
      continue;
    }
    if (!persist || unchanged(existing, row)) { out.push({ ...(existing && persist ? existing : row) as any, ...extras }); continue; }
    const data = { ...row, status: row.status as any };
    let saved: any;
    try {
      saved = await prisma.attendanceDay.upsert({ where: { userId_date: { userId, date } }, create: data, update: { ...data, notes: undefined, updatedBy: undefined } });
    } catch (err: any) {
      // Two register loads computing the same new day race on the unique key;
      // the loser just updates what the winner created.
      if (err?.code !== 'P2002') throw err;
      saved = await prisma.attendanceDay.update({ where: { userId_date: { userId, date } }, data: { ...data, notes: undefined, updatedBy: undefined } });
    }
    out.push({ ...saved, ...extras });
  }
  if (persist && staleIds.length) await prisma.attendanceDay.deleteMany({ where: { id: { in: staleIds }, source: 'COMPUTED' } });
  return { days: out, policy, group, locationId, employment };
}

export const toSummaryDays = (days: ComputedDay[]): SummaryDay[] =>
  days.map(d => ({ status: d.status as DayStatus, paidFraction: Number(d.paidFraction), overtimeMinutes: d.overtimeMinutes, phase: d.phase, wouldWork: d.wouldWork }));

/** Register / "so far" figures: days after today are left out. */
export function registerSummary(policy: Policy, days: ComputedDay[]): PeriodSummary {
  return summarise(policy, toSummaryDays(days), { toDate: true });
}

export async function periodSummary(orgId: string, userId: string, from: Date, to: Date): Promise<PeriodSummary & { policyGroupName: string }> {
  const { days, policy, group } = await computeDays(orgId, userId, from, to);
  return { ...registerSummary(policy, days), policyGroupName: group.name };
}

/**
 * What payroll consumes. Days not decided yet (a run started before the period
 * ends) are assumed paid rather than absent; the count is returned so the
 * review screen can warn about it. Days outside the employment window count as
 * unpaid working days (so the LOP line pays only the employed part).
 */
export async function payrollSummary(orgId: string, userId: string, from: Date, to: Date, today = new Date()) {
  const { days, policy, group } = await computeDays(orgId, userId, from, to, { now: today });
  let futureDaysAssumedPaid = 0;
  const rows: SummaryDay[] = days.map(d => {
    if (d.status === 'PENDING') { futureDaysAssumedPaid++; return { status: 'PRESENT', paidFraction: 1, overtimeMinutes: 0, phase: d.phase }; }
    return { status: d.status as DayStatus, paidFraction: Number(d.paidFraction), overtimeMinutes: d.overtimeMinutes, phase: d.phase, wouldWork: d.wouldWork };
  });
  const s = summarise(policy, rows, { notEmployedAsLop: true });
  const manualCorrections = days.filter(d => d.source === 'MANUAL').length;
  const warnings: string[] = [];
  const employedPast = days.filter(d => d.phase === 'past' && d.status !== 'NOT_EMPLOYED' && d.status !== 'WEEK_OFF' && d.status !== 'HOLIDAY');
  const punched = days.some(d => d.firstInAt || (d.workedMinutes ?? 0) > 0);
  if (employedPast.length > 0 && !punched && employedPast.every(d => d.status === 'ABSENT')) {
    warnings.push('No check-ins recorded in this period — every working day counts as absent. If this person doesn\'t mark attendance, run payroll in Calendar mode or regularise the days in the register.');
  }
  if (s.notEmployedDays > 0) warnings.push(`${s.notEmployedDays} day(s) fall before the joining date or after the last working day and are unpaid.`);
  return { ...s, policyGroupName: group.name, futureDaysAssumedPaid, manualCorrections, warnings };
}

export interface AuditEntry { userId: string; date?: Date | null; entityType: string; entityId?: string | null; action: string; before?: any; after?: any; reason?: string | null; batchId?: string | null }

/** One AttendanceAudit row's data — shared by audit() and bulk writers so every row has the same shape. */
export function auditData(orgId: string, changedBy: string, entry: AuditEntry) {
  return { orgId, changedBy, userId: entry.userId, date: entry.date ?? null, entityType: entry.entityType, entityId: entry.entityId ?? null, action: entry.action, before: entry.before ?? undefined, after: entry.after ?? undefined, reason: entry.reason ?? null, batchId: entry.batchId ?? null };
}

/** `db` lets a caller write the audit row inside its own transaction. */
export async function audit(orgId: string, changedBy: string, entry: AuditEntry, db: Pick<typeof prisma, 'attendanceAudit'> = prisma) {
  return db.attendanceAudit.create({ data: auditData(orgId, changedBy, entry) });
}

/** Holidays that apply to a user (location-scoped, opted-in optional ones) as day keys — for leave length. */
export async function holidayKeysForUser(orgId: string, userId: string, locationId: string | null, from: Date, to: Date): Promise<Set<string>> {
  const [holidays, choices] = await Promise.all([
    prisma.holiday.findMany({ where: { orgId, date: { gte: from, lte: to } } }),
    prisma.optionalHolidayChoice.findMany({ where: { userId, holiday: { orgId, date: { gte: from, lte: to } } }, select: { holidayId: true } }),
  ]);
  const chosen = new Set(choices.map(c => c.holidayId));
  return new Set(holidays
    .filter(h => h.locationIds.length === 0 || (locationId && h.locationIds.includes(locationId)))
    .filter(h => !h.isOptional || chosen.has(h.id))
    .map(h => dateKey(h.date)));
}

export { DEFAULT_POLICY, dayPhase };
