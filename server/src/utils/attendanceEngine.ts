// ─── Attendance policy engine ────────────────────────────────────────────────
//
// Pure functions (unit-testable) that turn an employee's raw check-in/out
// sessions for a day into a status + metrics under a policy group, plus the
// month-level late-arrival conversion and a period summary that payroll uses.
// Database access lives in attendanceRegister.ts.
//
// Time model. Every calendar day is a key "YYYY-MM-DD" in the POLICY timezone
// (group → employee's location → organisation, see attendanceRegister.ts).
// All clock arithmetic is done as "minutes since the start of that local day",
// so a night shift (22:00 → 06:00) simply has its end at 30:00 (1800 min) and a
// 00:30 arrival on such a shift belongs to the previous day at minute 1470.

/** Statuses the engine can produce. PENDING and NOT_EMPLOYED are never persisted
 *  (they are not in the AttendanceStatus DB enum): PENDING = the day has not
 *  happened yet / is still in progress with no punches; NOT_EMPLOYED = before
 *  the joining date or after the last working date. */
export type DayStatus = 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' | 'LEAVE' | 'UNPAID_LEAVE' | 'WFH' | 'HOLIDAY' | 'WEEK_OFF' | 'LOP' | 'PENDING' | 'NOT_EMPLOYED';
export const NON_PERSISTED_STATUSES: DayStatus[] = ['PENDING', 'NOT_EMPLOYED'];

export interface LateBand { untilMinutes: number | null; status: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' }

export interface Policy {
  id?: string;
  shiftStart: string;   // "HH:mm"
  shiftEnd: string;     // "HH:mm"; ≤ shiftStart means the shift ends the next morning
  timezone: string;     // IANA
  graceMinutes: number;
  lateBands: LateBand[] | null | undefined;
  minFullDayMinutes: number;
  minHalfDayMinutes: number;
  earlyDepartureGraceMinutes: number;
  earlyDepartureStatus: string; // NONE | HALF_DAY
  overtimeAfterMinutes: number;
  overtimeMinMinutes: number;
  lateAllowedPerMonth: number;
  lateConversionEvery: number;
  lateConversionUnit: string;   // HALF_DAY | LOP | NONE
  weeklyOffs: number[];
  assumeShiftEndOnMissingCheckout: boolean;
}

export const DEFAULT_LATE_BANDS: LateBand[] = [
  { untilMinutes: 60, status: 'LATE' },
  { untilMinutes: 180, status: 'HALF_DAY' },
  { untilMinutes: null, status: 'ABSENT' },
];

export const DEFAULT_POLICY: Policy = {
  shiftStart: '09:00', shiftEnd: '18:00', timezone: 'UTC', graceMinutes: 15, lateBands: DEFAULT_LATE_BANDS,
  minFullDayMinutes: 480, minHalfDayMinutes: 240, earlyDepartureGraceMinutes: 15, earlyDepartureStatus: 'NONE',
  overtimeAfterMinutes: 0, overtimeMinMinutes: 30, lateAllowedPerMonth: 3, lateConversionEvery: 3, lateConversionUnit: 'HALF_DAY',
  weeklyOffs: [0, 6], assumeShiftEndOnMissingCheckout: false,
};

/** checkOutSource AUTO_CLOSE = closed by the daily close-out job (attendanceAutoCheckout.ts), not by the person. */
export interface Session { checkInAt: Date | null; checkOutAt: Date | null; source?: string; checkOutSource?: string | null }

export interface DayContext {
  date: Date;                 // UTC midnight of the calendar day (policy timezone)
  sessions: Session[];
  /** optedIn: the employee chose this optional holiday (ATT-26) */
  holiday?: { name: string; isOptional: boolean; optedIn?: boolean } | null;
  leave?: { days: number; halfDay: boolean; halfDayPeriod: string | null; isPaid: boolean; leaveTypeName: string; requestId: string } | null;
  /** Legacy heuristic: a record's notes contained "WFH" (only applies when there are no punches) */
  wfh?: boolean;
  /** An approved work-from-home request covers this day (ATT-27) */
  wfhApproved?: { requestId: string; name: string } | null;
  /** Employment window; days outside it are NOT_EMPLOYED */
  employment?: { joiningDate: Date | null; lastWorkingDate: Date | null } | null;
}

export type DayPhase = 'past' | 'today' | 'future';

export interface DayResult {
  status: DayStatus;
  paidFraction: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  overtimeMinutes: number;
  firstInAt: Date | null;
  lastOutAt: Date | null;
  reason: string;
  leaveRequestId?: string | null;
  /** past = final; today = still in progress; future = not started. Non-past results are provisional and not persisted. */
  phase: DayPhase;
  provisional: boolean;
  /** For NOT_EMPLOYED: would this have been a working day? (payroll counts those as unpaid working days) */
  wouldWork?: boolean;
}

// ─── Time helpers ────────────────────────────────────────────────────────────

export function isValidTimeZone(tz: unknown): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** First valid IANA zone among the candidates (group → location → org), else UTC. A bad stored value must never 500 the register. */
export function safeTimeZone(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) if (isValidTimeZone(c)) return c;
  return 'UTC';
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function zoneParts(d: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(d)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, h: (p.hour ?? 0) % 24, mi: p.minute ?? 0, s: p.second ?? 0 };
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const dateKey = (d: Date) => d.toISOString().slice(0, 10);
export const keyToDate = (k: string) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const addDaysKey = (k: string, n: number) => dateKey(new Date(keyToDate(k).getTime() + n * 86_400_000));

/** Local calendar date ("YYYY-MM-DD") of an instant in a timezone. */
export function localDateKey(d: Date, tz: string): string {
  const p = zoneParts(d, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** Minutes since local midnight for an instant in a timezone. */
export function localMinutes(d: Date, tz: string): number {
  const p = zoneParts(d, tz);
  return p.h * 60 + p.mi;
}

/** UTC offset of `tz` at instant `d`, in minutes (IST → 330). */
export function tzOffsetMinutes(d: Date, tz: string): number {
  const p = zoneParts(d, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/** The instant local midnight starts on `dayKey` in `tz` (DST-safe to the hour). */
export function zonedDayStart(dayKey: string, tz: string): Date {
  const guess = keyToDate(dayKey).getTime();
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off1) t = guess - off2 * 60_000;
  return new Date(t);
}

/** Minutes from the start of local day `dayKey` to `instant` (can exceed 1440 for the next morning). */
export function minutesIntoDay(instant: Date, tz: string, dayKey: string): number {
  return Math.round((instant.getTime() - zonedDayStart(dayKey, tz).getTime()) / 60_000);
}

/** Local weekday (0 = Sunday) for a UTC-midnight calendar date. */
export function weekdayOf(date: Date): number { return date.getUTCDay(); }

export const hhmmToMinutes = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export const minutesToHhmm = (n: number) => { const t = ((n % 1440) + 1440) % 1440; return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`; };

/** Shift window in minutes since the shift day's local midnight; an end ≤ start rolls over to the next morning. */
export function shiftWindow(policy: Pick<Policy, 'shiftStart' | 'shiftEnd'>): { start: number; end: number; overnight: boolean } {
  const start = hhmmToMinutes(policy.shiftStart);
  let end = hhmmToMinutes(policy.shiftEnd);
  const overnight = end <= start;
  if (overnight) end += 1440;
  return { start, end, overnight };
}

/**
 * Which calendar day (policy timezone) a session that started at `checkIn`
 * belongs to. Normally its local date; on an overnight shift, a check-in more
 * than 12 hours before the shift start (e.g. 00:30 on a 22:00 shift) belongs to
 * the shift that started the previous evening.
 */
export function shiftDayKey(checkIn: Date, policy: Pick<Policy, 'shiftStart' | 'shiftEnd' | 'timezone'>): string {
  const tz = policy.timezone || 'UTC';
  const local = localDateKey(checkIn, tz);
  const { start, overnight } = shiftWindow(policy);
  if (overnight && localMinutes(checkIn, tz) < start - 720) return addDaysKey(local, -1);
  return local;
}

/** Calendar day "now" falls on for a policy — the shift day an arrival right now would be stamped with. */
export function todayKeyFor(policy: Pick<Policy, 'shiftStart' | 'shiftEnd' | 'timezone'>, now = new Date()): string {
  return shiftDayKey(now, policy);
}

/** Phase of a calendar day relative to `now`: the day stays "today" until local midnight, or until 4h after an overnight shift ends. */
export function dayPhase(policy: Pick<Policy, 'shiftStart' | 'shiftEnd' | 'timezone'>, dayKeyStr: string, now = new Date()): DayPhase {
  const tz = policy.timezone || 'UTC';
  const start = zonedDayStart(dayKeyStr, tz).getTime();
  if (now.getTime() < start) return 'future';
  const { end } = shiftWindow(policy);
  const until = start + Math.max(1440, end + 240) * 60_000;
  return now.getTime() < until ? 'today' : 'past';
}

/** Instant the shift of `dayKey` ends. */
export function shiftEndInstant(policy: Pick<Policy, 'shiftStart' | 'shiftEnd' | 'timezone'>, dayKeyStr: string): Date {
  return new Date(zonedDayStart(dayKeyStr, policy.timezone || 'UTC').getTime() + shiftWindow(policy).end * 60_000);
}

function fmtDur(min: number) { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`; }

// ─── Working days (leave length) ─────────────────────────────────────────────

/**
 * Number of working days between two calendar days (inclusive) — weekly offs
 * and holidays don't consume leave. A half day is 0.5 when it falls on a
 * working day, 0 otherwise.
 */
export function countWorkingDays(startKey: string, endKey: string, weeklyOffs: number[], holidayKeys: Set<string>, halfDay = false): number {
  let n = 0;
  for (let k = startKey; k <= endKey; k = addDaysKey(k, 1)) {
    if (weeklyOffs.includes(weekdayOf(keyToDate(k)))) continue;
    if (holidayKeys.has(k)) continue;
    n++;
    if (halfDay) break;
  }
  return halfDay ? (n ? 0.5 : 0) : n;
}

// ─── Day evaluation ──────────────────────────────────────────────────────────

const PAID_BY_STATUS: Partial<Record<DayStatus, number>> = { PRESENT: 1, LATE: 1, WFH: 1, LEAVE: 1, HOLIDAY: 1, WEEK_OFF: 1, HALF_DAY: 0.5, ABSENT: 0, UNPAID_LEAVE: 0, LOP: 0, PENDING: 0, NOT_EMPLOYED: 0 };

export function evaluateDay(policy: Policy, ctx: DayContext, now = new Date()): DayResult {
  const tz = policy.timezone || 'UTC';
  const key = dateKey(ctx.date);
  const phase = dayPhase(policy, key, now);
  const provisional = phase !== 'past';
  const { start: shiftStartMin, end: shiftEndMin } = shiftWindow(policy);
  const sessions = ctx.sessions.filter(s => s.checkInAt).sort((a, b) => a.checkInAt!.getTime() - b.checkInAt!.getTime());

  // Worked time across sessions. An open session counts up to now while the
  // day is in progress; in the past it counts to shift end only when the policy
  // assumes so. A session closed by the close-out job (AUTO_CLOSE) is treated
  // exactly like a missing check-out — the job closes it at shift end, which is
  // what "assume shift end" means, and is ignored otherwise.
  let worked = 0;
  let missingOut = false;
  let effectiveLastOut: Date | null = null;
  for (const s of sessions) {
    let out: Date | null = s.checkOutAt;
    const autoClosed = s.checkOutSource === 'AUTO_CLOSE';
    if (out && autoClosed && !policy.assumeShiftEndOnMissingCheckout) out = null;
    let isNow = false;
    if (!out) {
      if (phase !== 'past' && !s.checkOutAt) { out = now; isNow = true; }
      else if (policy.assumeShiftEndOnMissingCheckout) {
        const inMin = minutesIntoDay(s.checkInAt!, tz, key);
        out = new Date(s.checkInAt!.getTime() + Math.max(0, shiftEndMin - inMin) * 60_000);
      } else { out = null; missingOut = true; }
    }
    if (out) worked += Math.max(0, Math.round((out.getTime() - s.checkInAt!.getTime()) / 60_000));
    effectiveLastOut = isNow ? null : out;
  }
  const firstIn = sessions[0]?.checkInAt ?? null;
  const lastOut = sessions.length ? (sessions[sessions.length - 1].checkOutAt ?? null) : null;
  const metrics = { workedMinutes: worked, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0, firstInAt: firstIn, lastOutAt: lastOut };
  const done = (status: DayStatus, reason: string, extra: Partial<DayResult> = {}): DayResult =>
    ({ status, paidFraction: PAID_BY_STATUS[status] ?? 0, ...metrics, reason, phase, provisional, ...extra });

  const isWeekOff = policy.weeklyOffs.includes(weekdayOf(ctx.date));
  const isHoliday = !!ctx.holiday && (!ctx.holiday.isOptional || !!ctx.holiday.optedIn);

  // 0. Outside the employment window — not a working day, not an absence
  const emp = ctx.employment;
  if (emp && ((emp.joiningDate && key < dateKey(emp.joiningDate)) || (emp.lastWorkingDate && key > dateKey(emp.lastWorkingDate)))) {
    const before = !!emp.joiningDate && key < dateKey(emp.joiningDate);
    return done('NOT_EMPLOYED', before ? 'Before joining date' : 'After last working day', { wouldWork: !isWeekOff && !isHoliday });
  }

  // 1. Non-working days first — work on them is still recorded (OT-eligible in a later phase)
  if (isHoliday) return done('HOLIDAY', ctx.holiday!.isOptional ? `${ctx.holiday!.name} (optional, opted in)` : ctx.holiday!.name);
  if (isWeekOff) return done('WEEK_OFF', 'Weekly off');

  // 2. Full-day leave wins over whatever was punched
  if (ctx.leave && !ctx.leave.halfDay) {
    return ctx.leave.isPaid
      ? done('LEAVE', ctx.leave.leaveTypeName, { leaveRequestId: ctx.leave.requestId })
      : done('UNPAID_LEAVE', `${ctx.leave.leaveTypeName} (unpaid)`, { leaveRequestId: ctx.leave.requestId });
  }
  // 2b. Approved work from home — paid, whatever was or wasn't punched
  if (ctx.wfhApproved) return done('WFH', ctx.wfhApproved.name || 'Work from home', { leaveRequestId: ctx.wfhApproved.requestId });

  const halfLeave = ctx.leave?.halfDay ? ctx.leave : null;

  // 3. No punches at all
  if (sessions.length === 0) {
    if (phase !== 'past') return done('PENDING', phase === 'future' ? (halfLeave ? `Upcoming — half-day ${halfLeave.leaveTypeName} planned` : 'Upcoming') : 'Not checked in yet', { leaveRequestId: halfLeave?.requestId ?? null });
    if (ctx.wfh) return done('WFH', 'Work from home');
    if (halfLeave) {
      return done('HALF_DAY', `Half-day ${halfLeave.leaveTypeName}, no attendance for the other half`, { paidFraction: halfLeave.isPaid ? 0.5 : 0, leaveRequestId: halfLeave.requestId });
    }
    return done('ABSENT', 'No check-in');
  }

  // 4. Arrival band. With a first-half (AM) leave the employee is expected at
  // the middle of the shift, not at shift start.
  const expectedStart = halfLeave?.halfDayPeriod === 'AM' ? shiftStartMin + Math.round((shiftEndMin - shiftStartMin) / 2) : shiftStartMin;
  const inMin = minutesIntoDay(firstIn!, tz, key);
  const lateBy = Math.max(0, inMin - expectedStart);
  const lateMinutes = lateBy > policy.graceMinutes ? lateBy : 0;
  let arrival: DayStatus = 'PRESENT';
  if (lateMinutes > 0) {
    const bands = (policy.lateBands && policy.lateBands.length ? policy.lateBands : DEFAULT_LATE_BANDS);
    const band = bands.find(b => b.untilMinutes == null || lateBy <= b.untilMinutes) ?? bands[bands.length - 1];
    arrival = band.status;
  }

  // 4b. Day still in progress — provisional status from the arrival band only;
  // the hours rule can't be judged until the day is over.
  if (phase !== 'past') {
    const open = sessions.some(s => !s.checkOutAt);
    const reason = `In progress — ${open ? 'checked in' : 'arrived'} ${minutesToHhmm(localMinutes(firstIn!, tz))}${lateMinutes ? `, ${fmtDur(lateBy)} late` : ''}`;
    const paid = arrival === 'ABSENT' ? (halfLeave?.isPaid ? 0.5 : 0) : arrival === 'HALF_DAY' ? (halfLeave ? (halfLeave.isPaid ? 1 : 0.5) : 0.5) : 1;
    return done(arrival, reason, { lateMinutes, paidFraction: paid, leaveRequestId: halfLeave?.requestId ?? null });
  }

  // 5. Worked-hours rule
  const requiredFull = halfLeave ? Math.round(policy.minFullDayMinutes / 2) : policy.minFullDayMinutes;
  const requiredHalf = halfLeave ? Math.round(policy.minHalfDayMinutes / 2) : policy.minHalfDayMinutes;

  // Early departure / overtime against the (possibly next-morning) shift end
  let earlyMinutes = 0;
  let overtimeMinutes = 0;
  if (effectiveLastOut) {
    const outMin = minutesIntoDay(effectiveLastOut, tz, key);
    const earlyBy = Math.max(0, shiftEndMin - outMin);
    if (earlyBy > policy.earlyDepartureGraceMinutes && !(halfLeave && halfLeave.halfDayPeriod === 'PM')) earlyMinutes = earlyBy;
    if (policy.overtimeAfterMinutes > 0) {
      const beyond = outMin - shiftEndMin - policy.overtimeAfterMinutes;
      if (beyond >= policy.overtimeMinMinutes) overtimeMinutes = beyond;
    }
  }

  let status: DayStatus;
  let reason: string;
  if (missingOut && !policy.assumeShiftEndOnMissingCheckout) {
    status = 'ABSENT'; reason = sessions.some(s => s.checkOutSource === 'AUTO_CLOSE') ? 'Never checked out (session closed automatically)' : 'Checked in but never checked out';
  } else if (worked >= requiredFull) {
    status = arrival; reason = arrival === 'PRESENT' ? `Worked ${fmtDur(worked)}` : `Arrived ${fmtDur(lateBy)} late (${arrival.toLowerCase().replace('_', ' ')} band)`;
  } else if (worked >= requiredHalf) {
    status = arrival === 'ABSENT' ? 'ABSENT' : 'HALF_DAY';
    reason = `Worked ${fmtDur(worked)} < ${fmtDur(requiredFull)} full-day minimum`;
  } else {
    status = 'ABSENT'; reason = `Worked ${fmtDur(worked)} < ${fmtDur(requiredHalf)} half-day minimum`;
  }
  if (status !== 'ABSENT' && earlyMinutes > 0 && policy.earlyDepartureStatus === 'HALF_DAY' && status !== 'HALF_DAY') {
    status = 'HALF_DAY'; reason = `Left ${fmtDur(earlyMinutes)} early`;
  }
  if (halfLeave && status === 'PRESENT') reason = `Half-day ${halfLeave.leaveTypeName} + ${fmtDur(worked)} worked`;

  const paidFraction = status === 'ABSENT' ? (halfLeave?.isPaid ? 0.5 : 0) : status === 'HALF_DAY' ? (halfLeave ? (halfLeave.isPaid ? 1 : 0.5) : 0.5) : 1;
  return { status, paidFraction, ...metrics, lateMinutes, earlyMinutes, overtimeMinutes, reason, leaveRequestId: halfLeave?.requestId ?? null, phase, provisional };
}

// ─── Month-level late conversion ─────────────────────────────────────────────

export interface Conversion { count: number; unit: string; extraLopDays: number; halfDaysConverted: number; note: string }

/** Lates beyond the monthly allowance convert into half days / LOP. Returns the deduction to apply on top of day statuses. */
export function lateConversion(policy: Policy, lateCount: number): Conversion {
  const extra = Math.max(0, lateCount - policy.lateAllowedPerMonth);
  const every = Math.max(1, policy.lateConversionEvery);
  const units = policy.lateConversionUnit === 'NONE' ? 0 : Math.floor(extra / every);
  if (units === 0) return { count: lateCount, unit: policy.lateConversionUnit, extraLopDays: 0, halfDaysConverted: 0, note: lateCount ? `${lateCount} late arrival${lateCount === 1 ? '' : 's'} (${policy.lateAllowedPerMonth} allowed)` : '' };
  const lop = policy.lateConversionUnit === 'LOP' ? units : units * 0.5;
  return { count: lateCount, unit: policy.lateConversionUnit, extraLopDays: lop, halfDaysConverted: policy.lateConversionUnit === 'HALF_DAY' ? units : 0,
    note: `${lateCount} late arrivals; ${extra} over the ${policy.lateAllowedPerMonth} allowed → ${units} ${policy.lateConversionUnit === 'LOP' ? 'LOP day' : 'half day'}${units === 1 ? '' : 's'}` };
}

// ─── Period summary (what payroll consumes) ──────────────────────────────────

export interface PeriodSummary {
  daysInPeriod: number;
  workingDays: number;      // counted days − week offs − holidays
  presentDays: number;      // full-day presence incl. late, WFH
  halfDays: number;
  leaveDays: number;        // paid leave
  unpaidLeaveDays: number;
  absentDays: number;
  lopDays: number;          // unpaid days + late conversion (what payroll deducts)
  paidDays: number;         // workingDays − lopDays
  lateCount: number;
  lateConversion: Conversion;
  overtimeHours: number;
  /** Days not yet decided (future / today without punches) — excluded from the figures above */
  pendingDays: number;
  /** Days outside the employment window */
  notEmployedDays: number;
  byStatus: Record<string, number>;
}

export interface SummaryDay { status: DayStatus; paidFraction: number; overtimeMinutes: number; phase?: DayPhase; wouldWork?: boolean }

/**
 * opts.toDate — leave out days after today (the register's "so far" view).
 * opts.notEmployedAsLop — payroll: days outside employment that would have been
 *   working days stay in workingDays as unpaid, so the payslip's LOP formula
 *   (gross / workingDays × lopDays) pays a mid-month joiner only for the days
 *   they were employed. The register leaves them out entirely instead, so its
 *   LOP column only shows real absences.
 */
export function summarise(policy: Policy, days: SummaryDay[], opts: { toDate?: boolean; notEmployedAsLop?: boolean } = {}): PeriodSummary {
  const byStatus: Record<string, number> = {};
  for (const d of days) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
  const counted = days.filter(d => {
    if (d.status === 'PENDING') return false;
    if (opts.toDate && d.phase === 'future') return false;
    if (d.status === 'NOT_EMPLOYED') return !!opts.notEmployedAsLop && !!d.wouldWork;
    return true;
  });
  const isOff = (d: SummaryDay) => d.status === 'HOLIDAY' || d.status === 'WEEK_OFF';
  const workingList = counted.filter(d => !isOff(d));
  const workingDays = workingList.length;
  const count = (s: DayStatus) => counted.filter(d => d.status === s).length;
  const lateCount = count('LATE');
  const conv = lateConversion(policy, lateCount);
  const paidFromDays = workingList.reduce((s, d) => s + d.paidFraction, 0);
  const lopFromDays = Math.round((workingDays - paidFromDays) * 100) / 100;
  const lopDays = Math.min(workingDays, Math.round((lopFromDays + conv.extraLopDays) * 100) / 100);
  return {
    daysInPeriod: days.length, workingDays,
    presentDays: count('PRESENT') + count('LATE') + count('WFH'),
    halfDays: count('HALF_DAY'),
    leaveDays: count('LEAVE'), unpaidLeaveDays: count('UNPAID_LEAVE'), absentDays: count('ABSENT'),
    lopDays, paidDays: Math.max(0, Math.round((workingDays - lopDays) * 100) / 100),
    lateCount, lateConversion: conv,
    overtimeHours: Math.round(counted.reduce((s, d) => s + d.overtimeMinutes, 0) / 60 * 100) / 100,
    pendingDays: byStatus.PENDING ?? 0,
    notEmployedDays: byStatus.NOT_EMPLOYED ?? 0,
    byStatus,
  };
}

// ─── Applicability ───────────────────────────────────────────────────────────

export interface GroupLike { id: string; isDefault: boolean; isActive: boolean; applicability?: any }
export interface EmpCtx { userId: string; departmentId?: string | null; locationId?: string | null; employmentType?: string | null }

const hasList = (l?: unknown): l is string[] => Array.isArray(l) && l.length > 0;
/** True when a group has any "applies to" filter set. */
export function isScoped(applicability: any): boolean {
  return !!applicability && typeof applicability === 'object' && Object.values(applicability).some(v => hasList(v));
}

/** Most specific active group wins: explicit user > location > department > employment type > default. */
export function pickGroup<T extends GroupLike>(groups: T[], e: EmpCtx): T | null {
  const active = groups.filter(g => g.isActive);
  const byUser = active.find(g => hasList(g.applicability?.userIds) && g.applicability.userIds.includes(e.userId));
  if (byUser) return byUser;
  const byLoc = active.find(g => hasList(g.applicability?.locationIds) && e.locationId && g.applicability.locationIds.includes(e.locationId));
  if (byLoc) return byLoc;
  const byDept = active.find(g => hasList(g.applicability?.departmentIds) && e.departmentId && g.applicability.departmentIds.includes(e.departmentId));
  if (byDept) return byDept;
  const byType = active.find(g => hasList(g.applicability?.employmentTypes) && e.employmentType && g.applicability.employmentTypes.includes(e.employmentType));
  if (byType) return byType;
  return active.find(g => g.isDefault) ?? active.find(g => !isScoped(g.applicability)) ?? null;
}
