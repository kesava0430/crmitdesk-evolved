/**
 * Calendar maths for the query layer — pure, time-zone aware, unit-tested.
 *
 * Everything is done on local calendar DATES ("YYYY-MM-DD") in the org's time
 * zone (Organization.timezone). "Today", "this month", "last 12 weeks" are
 * decided in that zone, so an org in Asia/Kolkata gets the same answer at
 * 00:30 IST as the people in the office expect, not UTC's yesterday. The SQL
 * side converts these local boundaries back to UTC instants for TIMESTAMP
 * columns (see compiler.ts dateBoundSql) and compares DATE columns directly.
 *
 * Weeks start on Monday (ISO, and what Postgres date_trunc('week') uses).
 */
import type { Bucket } from './types';

export type Preset =
  | 'today' | 'yesterday'
  | 'this_week' | 'last_week'
  | 'this_month' | 'last_month'
  | 'this_quarter' | 'last_quarter'
  | 'this_year' | 'last_year'
  | 'last_7_days' | 'last_30_days' | 'last_90_days' | 'last_365_days'
  | 'next_7_days' | 'next_30_days'
  | 'all_time';

export const PRESETS: Preset[] = [
  'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'last_quarter',
  'this_year', 'last_year', 'last_7_days', 'last_30_days', 'last_90_days', 'last_365_days', 'next_7_days', 'next_30_days', 'all_time',
];

export interface DateRangeInput {
  preset?: Preset;
  /** "the last N units" — e.g. { n: 12, unit: 'week' }. */
  last?: { n: number; unit: Bucket };
  /** For `last`: include the current (partial) unit. Default true; false = N complete units before it. */
  includeCurrent?: boolean;
  from?: string; // YYYY-MM-DD inclusive
  to?: string;   // YYYY-MM-DD inclusive
}

export interface ResolvedRange {
  /** Inclusive local start date, or null for unbounded. */
  from: string | null;
  /** Exclusive local end date, or null for unbounded. */
  toExclusive: string | null;
  /** "last 12 weeks" */
  label: string;
  /** "28 Jul – 18 Oct 2026" */
  human: string;
  /** The calendar unit the range is aligned to (for previous-period shifting). */
  unit: Bucket | null;
  /** The range ends in the future of today's date (e.g. this_month): the last bucket is partial. */
  partial: boolean;
}

// ─── Plain date helpers ("YYYY-MM-DD" ↔ UTC-midnight Date) ──────────────────

const DAY_MS = 86_400_000;

export function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date "${s}" (expected YYYY-MM-DD)`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.toISOString().slice(0, 10) !== s) throw new Error(`Invalid date "${s}"`);
  return d;
}

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: string, n: number): string {
  return fmtDate(new Date(parseDate(s).getTime() + n * DAY_MS));
}

/** Adds calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(s: string, n: number): string {
  const d = parseDate(s);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmtDate(new Date(Date.UTC(y, m, Math.min(day, last))));
}

export function addUnits(s: string, unit: Bucket, n: number): string {
  switch (unit) {
    case 'day': return addDays(s, n);
    case 'week': return addDays(s, 7 * n);
    case 'month': return addMonths(s, n);
    case 'quarter': return addMonths(s, 3 * n);
    case 'year': return addMonths(s, 12 * n);
  }
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);
}

/** Start of the bucket containing `s` (Monday for weeks). */
export function bucketStart(s: string, unit: Bucket): string {
  const d = parseDate(s);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (unit) {
    case 'day': return s;
    case 'week': {
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      return addDays(s, -dow);
    }
    case 'month': return fmtDate(new Date(Date.UTC(y, m, 1)));
    case 'quarter': return fmtDate(new Date(Date.UTC(y, m - (m % 3), 1)));
    case 'year': return fmtDate(new Date(Date.UTC(y, 0, 1)));
  }
}

/** Every bucket start in [from, toExclusive). */
export function enumerateBuckets(from: string, toExclusive: string, unit: Bucket, max = 2000): string[] {
  const out: string[] = [];
  let cur = bucketStart(from, unit);
  while (cur < toExclusive && out.length < max) {
    out.push(cur);
    cur = addUnits(cur, unit, 1);
  }
  return out;
}

// ─── Time zones ─────────────────────────────────────────────────────────────

/** True when the runtime knows this IANA zone (Postgres uses the same database). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Local calendar date of `now` in `tz`. */
export function localToday(now: Date, tz: string): string {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ─── Human labels ───────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function humanDate(s: string, withYear = true): string {
  const d = parseDate(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ''}`;
}

/** "28 Jul – 18 Oct 2026" for an inclusive span. */
export function humanSpan(from: string, toInclusive: string): string {
  if (from === toInclusive) return humanDate(from);
  const sameYear = from.slice(0, 4) === toInclusive.slice(0, 4);
  return `${humanDate(from, !sameYear)} – ${humanDate(toInclusive)}`;
}

/** Label of one bucket: "Mon 13 Oct", "w/c 13 Oct", "Oct 2026", "Q4 2026", "2026". */
export function bucketLabel(start: string, unit: Bucket): string {
  const d = parseDate(start);
  switch (unit) {
    case 'day': return humanDate(start);
    case 'week': return `w/c ${humanDate(start)}`;
    case 'month': return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case 'quarter': return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
    case 'year': return String(d.getUTCFullYear());
  }
}

const PRESET_LABEL: Record<Preset, string> = {
  today: 'today', yesterday: 'yesterday', this_week: 'this week', last_week: 'last week',
  this_month: 'this month', last_month: 'last month', this_quarter: 'this quarter', last_quarter: 'last quarter',
  this_year: 'this year', last_year: 'last year', last_7_days: 'last 7 days', last_30_days: 'last 30 days',
  last_90_days: 'last 90 days', last_365_days: 'last 365 days', next_7_days: 'next 7 days', next_30_days: 'next 30 days',
  all_time: 'all time',
};

// ─── Range resolution ───────────────────────────────────────────────────────

function mk(from: string | null, toExclusive: string | null, label: string, unit: Bucket | null, today: string): ResolvedRange {
  const human = from && toExclusive ? humanSpan(from, addDays(toExclusive, -1)) : from ? `since ${humanDate(from)}` : toExclusive ? `until ${humanDate(addDays(toExclusive, -1))}` : 'all time';
  // A range that reaches today is partial: today (and its week/month…) isn't over yet.
  return { from, toExclusive, label, human, unit, partial: !!toExclusive && toExclusive > today };
}

/**
 * Resolves a range against the org's local `today`. Ranges that reach today
 * stop at the end of today (tomorrow, exclusive) — "this month" on the 18th
 * means 1st–18th; `partial` tells the caller the period isn't over.
 */
export function resolveRange(input: DateRangeInput | undefined, today: string): ResolvedRange {
  const tomorrow = addDays(today, 1);
  if (!input) return mk(null, null, 'all time', null, today);
  if (input.from || input.to) {
    const from = input.from ? fmtDate(parseDate(input.from)) : null;
    const toEx = input.to ? addDays(input.to, 1) : null;
    if (from && toEx && toEx <= from) throw new Error('Date range "to" must not be before "from"');
    return mk(from, toEx, from && toEx ? `${humanDate(from)} to ${humanDate(addDays(toEx, -1))}` : from ? `since ${humanDate(from)}` : `until ${humanDate(addDays(toEx!, -1))}`, null, today);
  }
  if (input.last) {
    const { n, unit } = input.last;
    const includeCurrent = input.includeCurrent !== false;
    const curStart = bucketStart(today, unit);
    if (unit === 'day') {
      // "last N days" = today and the N-1 days before it (or the N days before today).
      return includeCurrent
        ? mk(addDays(today, -(n - 1)), tomorrow, `last ${n} day${n === 1 ? '' : 's'}`, 'day', today)
        : mk(addDays(today, -n), today, `previous ${n} full day${n === 1 ? '' : 's'}`, 'day', today);
    }
    return includeCurrent
      ? mk(addUnits(curStart, unit, -(n - 1)), tomorrow, `last ${n} ${unit}${n === 1 ? '' : 's'}`, unit, today)
      : mk(addUnits(curStart, unit, -n), curStart, `previous ${n} full ${unit}${n === 1 ? '' : 's'}`, unit, today);
  }
  const p = input.preset ?? 'all_time';
  const label = PRESET_LABEL[p];
  const unitRange = (unit: Bucket, offset: number): ResolvedRange => {
    const start = addUnits(bucketStart(today, unit), unit, offset);
    const end = offset === 0 ? tomorrow : addUnits(start, unit, 1);
    return mk(start, end, label, unit, today);
  };
  switch (p) {
    case 'today': return mk(today, tomorrow, label, 'day', today);
    case 'yesterday': return mk(addDays(today, -1), today, label, 'day', today);
    case 'this_week': return unitRange('week', 0);
    case 'last_week': return unitRange('week', -1);
    case 'this_month': return unitRange('month', 0);
    case 'last_month': return unitRange('month', -1);
    case 'this_quarter': return unitRange('quarter', 0);
    case 'last_quarter': return unitRange('quarter', -1);
    case 'this_year': return unitRange('year', 0);
    case 'last_year': return unitRange('year', -1);
    case 'last_7_days': return mk(addDays(today, -6), tomorrow, label, 'day', today);
    case 'last_30_days': return mk(addDays(today, -29), tomorrow, label, 'day', today);
    case 'last_90_days': return mk(addDays(today, -89), tomorrow, label, 'day', today);
    case 'last_365_days': return mk(addDays(today, -364), tomorrow, label, 'day', today);
    case 'next_7_days': return { ...mk(today, addDays(today, 7), label, 'day', today), partial: false };
    case 'next_30_days': return { ...mk(today, addDays(today, 30), label, 'day', today), partial: false };
    case 'all_time': return mk(null, null, label, null, today);
  }
}

/**
 * The period to compare against:
 *  - previous_period: calendar-aligned ranges shift by one unit (this month
 *    to date 1–18 Oct → 1–18 Sep; last month → the month before), day
 *    ranges shift by their own length (last 30 days → the 30 days before);
 *  - previous_year: the same dates a year earlier.
 * Returns null for unbounded ranges (nothing to compare).
 */
export function comparisonRange(r: ResolvedRange, kind: 'previous_period' | 'previous_year'): ResolvedRange | null {
  if (!r.from || !r.toExclusive) return null;
  let from: string, toEx: string;
  if (kind === 'previous_year') {
    from = addMonths(r.from, -12); toEx = addMonths(r.toExclusive, -12);
  } else if (r.unit && r.unit !== 'day') {
    // A range that spans several units ("previous 3 full months") shifts by its whole span.
    const span = unitsSpanned(r.from, r.toExclusive, r.unit);
    from = addUnits(r.from, r.unit, -span); toEx = addUnits(r.toExclusive, r.unit, -span);
  } else {
    const len = daysBetween(r.from, r.toExclusive);
    from = addDays(r.from, -len); toEx = r.from;
  }
  const human = humanSpan(from, addDays(toEx, -1));
  return { from, toExclusive: toEx, label: kind === 'previous_year' ? 'same period last year' : 'previous period', human, unit: r.unit, partial: false };
}

function unitsSpanned(from: string, toExclusive: string, unit: Bucket): number {
  let n = 0, cur = from;
  while (cur < toExclusive && n < 1000) { cur = addUnits(cur, unit, 1); n++; }
  return Math.max(1, n);
}
