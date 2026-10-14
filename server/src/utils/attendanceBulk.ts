// ─── Bulk attendance corrections: the pure parts ─────────────────────────────
//
// POST /hr/attendance/days/bulk lets HR mark (or reset) many people × many days
// in one go. Everything that decides WHICH cells a request touches lives here,
// free of the database, so it can be unit-tested: expanding userIds × dates /
// a range / explicit cells into a de-duplicated list, the size caps, and the
// per-cell skip rules (frozen, weekly off, holiday, existing manual
// correction…). The writes themselves reuse the single-day correction code in
// attendanceCorrections.ts, so a bulk change is indistinguishable from the same
// change made one cell at a time (plus a batch id on its audit rows).

import { AppError } from '../middleware/errorHandler';
import { addDaysKey, keyToDate, weekdayOf } from './attendanceEngine';

/** Hard ceiling per request. A month for ~100 people; larger jobs are split. */
export const BULK_MAX_CELLS = 3000;
export const BULK_MAX_USERS = 500;
/** First to last date of one request — one year is plenty and keeps per-user recomputes bounded. */
export const BULK_MAX_SPAN_DAYS = 366;

export interface BulkCell { userId: string; date: string }

export interface BulkSelection {
  cells?: BulkCell[];
  userIds?: string[];
  dates?: string[];
  range?: { from: string; to: string };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30, which Date would roll over). */
export function isValidDateKey(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = keyToDate(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const daysBetween = (a: string, b: string) => Math.round((keyToDate(b).getTime() - keyToDate(a).getTime()) / 86_400_000);
const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * The request's cells, de-duplicated and sorted by user then date. Throws a
 * 400 AppError with a message the UI can show as-is for anything malformed or
 * over the caps — before materialising a huge list.
 */
export function expandCells(sel: BulkSelection): BulkCell[] {
  const hasCells = !!sel.cells?.length;
  const hasGrid = !!sel.userIds?.length;
  if (hasCells === hasGrid) throw new AppError(400, 'Send either cells, or userIds with dates or a range.');

  let out: BulkCell[];
  if (hasCells) {
    if (sel.cells!.length > BULK_MAX_CELLS) throw tooMany(sel.cells!.length);
    for (const c of sel.cells!) if (!isValidDateKey(c.date)) throw new AppError(400, `Invalid date: ${c.date}`);
    out = sel.cells!.map(c => ({ userId: c.userId, date: c.date }));
  } else {
    const hasDates = !!sel.dates?.length, hasRange = !!sel.range;
    if (hasDates === hasRange) throw new AppError(400, 'Send either dates or a range (not both).');
    let dates: string[];
    if (hasRange) {
      const { from, to } = sel.range!;
      if (!isValidDateKey(from) || !isValidDateKey(to)) throw new AppError(400, 'The range needs valid from and to dates (YYYY-MM-DD).');
      if (to < from) throw new AppError(400, 'The range ends before it starts.');
      const span = daysBetween(from, to) + 1;
      if (span > BULK_MAX_SPAN_DAYS) throw new AppError(400, `The range is ${fmt(span)} days long; the limit is ${BULK_MAX_SPAN_DAYS}.`);
      const users = new Set(sel.userIds).size;
      if (users * span > BULK_MAX_CELLS) throw tooMany(users * span);
      dates = [];
      for (let k = from; k <= to; k = addDaysKey(k, 1)) dates.push(k);
    } else {
      for (const d of sel.dates!) if (!isValidDateKey(d)) throw new AppError(400, `Invalid date: ${d}`);
      dates = [...new Set(sel.dates)];
    }
    const users = [...new Set(sel.userIds)];
    if (users.length * dates.length > BULK_MAX_CELLS) throw tooMany(users.length * dates.length);
    out = users.flatMap(userId => dates.map(date => ({ userId, date })));
  }

  const seen = new Set<string>();
  out = out.filter(c => { const k = `${c.userId}|${c.date}`; if (seen.has(k)) return false; seen.add(k); return true; });
  out.sort((a, b) => (a.userId === b.userId ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.userId < b.userId ? -1 : 1));

  const userCount = new Set(out.map(c => c.userId)).size;
  if (userCount > BULK_MAX_USERS) throw new AppError(400, `That's ${fmt(userCount)} people; the limit is ${BULK_MAX_USERS} per request.`);
  const keys = out.map(c => c.date).sort();
  if (keys.length && daysBetween(keys[0], keys[keys.length - 1]) + 1 > BULK_MAX_SPAN_DAYS) {
    throw new AppError(400, `The dates span more than ${BULK_MAX_SPAN_DAYS} days — split the change into smaller ranges.`);
  }
  return out;
}

function tooMany(n: number) {
  return new AppError(400, `This would touch ${fmt(n)} days; the limit is ${fmt(BULK_MAX_CELLS)} per request. Pick fewer people or a shorter range.`);
}

/** Cells grouped by user (input order kept), so each user's days are read and written together. */
export function groupByUser(cells: BulkCell[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const c of cells) { const l = m.get(c.userId) ?? []; l.push(c.date); m.set(c.userId, l); }
  return m;
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ─── Skip rules ──────────────────────────────────────────────────────────────

export type SkipCode = 'FROZEN' | 'NOT_EMPLOYED' | 'WEEK_OFF' | 'HOLIDAY' | 'MANUAL_KEPT' | 'ALREADY' | 'NOT_MANUAL' | 'ERROR';

export const SKIP_REASON: Record<SkipCode, string> = {
  FROZEN: 'locked — payroll finalised',
  NOT_EMPLOYED: 'not employed on this date',
  WEEK_OFF: 'weekly off',
  HOLIDAY: 'holiday',
  MANUAL_KEPT: 'already manually corrected (kept)',
  ALREADY: 'already set to this status',
  NOT_MANUAL: 'no manual correction to reset',
  ERROR: 'could not be saved — try again',
};

export interface BulkOptions {
  action: 'mark' | 'reset';
  status?: string;
  notes?: string;
  skipWeeklyOffs: boolean;
  skipHolidays: boolean;
  overwriteManual: boolean;
}

/** What is known about one cell before the change. */
export interface CellFacts {
  date: string;
  /** Inside a finalised payroll period for this user */
  frozen: boolean;
  /** Before joining / after the last working day (computed status NOT_EMPLOYED) */
  notEmployed: boolean;
  /** The user's policy group weekly-off weekdays (0 = Sunday) */
  weeklyOffs: number[];
  /** The date is a holiday for this user (location-scoped, or an optional one they opted into) */
  holiday: boolean;
  /** The stored day, if any */
  existing?: { source: string; status: string; notes?: string | null } | null;
}

/**
 * Should this cell change? Order matters: a frozen day is reported as locked
 * whatever else is true of it, and the skip-weekly-off / skip-holiday filters
 * describe which dates of the selection to touch, so they come before the
 * manual-correction rules.
 *
 * Reset only ever touches MANUAL days, so the weekly-off / holiday filters
 * don't apply to it: "reset these days" means undo every correction in them.
 */
export function classifyCell(opts: BulkOptions, f: CellFacts): { apply: true } | { apply: false; code: SkipCode } {
  if (f.frozen) return { apply: false, code: 'FROZEN' };
  const manual = f.existing?.source === 'MANUAL';
  if (opts.action === 'reset') return manual ? { apply: true } : { apply: false, code: 'NOT_MANUAL' };

  if (f.notEmployed && !manual) return { apply: false, code: 'NOT_EMPLOYED' };
  if (opts.skipWeeklyOffs && f.weeklyOffs.includes(weekdayOf(keyToDate(f.date)))) return { apply: false, code: 'WEEK_OFF' };
  if (opts.skipHolidays && f.holiday) return { apply: false, code: 'HOLIDAY' };
  if (manual) {
    // Re-running the same batch must change nothing new.
    const sameNotes = opts.notes === undefined || (opts.notes || null) === (f.existing!.notes ?? null);
    if (f.existing!.status === opts.status && sameNotes) return { apply: false, code: 'ALREADY' };
    if (!opts.overwriteManual) return { apply: false, code: 'MANUAL_KEPT' };
  }
  return { apply: true };
}
