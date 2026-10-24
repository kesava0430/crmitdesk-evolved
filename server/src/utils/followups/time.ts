/**
 * Follow-up timing — pure, timezone-aware, unit-tested.
 *
 * A "follow-up" is any open, dated piece of planned work on a CRM record:
 *  - an Activity (CALL / EMAIL / MEETING / TASK) with done = false, or
 *  - a Task linked to the record (entityType LEAD / DEAL …) that isn't DONE or CANCELLED.
 * Leads schedule Activities (Follow-up Activities modal) and Tasks (record
 * sidebar); deals use Tasks (RecordTasks) and older Activities. Both count.
 *
 * Date-only vs date-time. Every date picker in the CRM (`<input type="date">`
 * on the lead follow-ups modal and RecordTasks) posts "YYYY-MM-DD", which the
 * server stores as `new Date('YYYY-MM-DD')` — midnight UTC of that calendar
 * date. So a due instant of exactly 00:00:00.000 UTC means "due on that date,
 * no time": the date is read in UTC (not shifted into the org's zone, which
 * would turn 25 Oct into 24 Oct for an org west of Greenwich), and its
 * reminder goes out at the start of the org's working day. Any other instant
 * is a real time, compared as an instant and dated in the org's timezone.
 * Trade-off (documented, not hidden): a time picked at exactly midnight UTC —
 * 05:30 in India — would read as date-only, so the activities API nudges such
 * a value one minute later (parseDueInput below).
 *
 * "Today" is always the org's local calendar day, never the server's or UTC's.
 */
import { localDateKey, addDaysKey, keyToDate } from '../attendanceEngine';
import { zonedToUtc } from '../aiActions/dates';

export type FollowUpStatus = 'OVERDUE' | 'TODAY' | 'UPCOMING' | 'UNDATED' | 'NONE';
export type FollowUpSource = 'ACTIVITY' | 'TASK';

/** Working-day start used for date-only reminders and the morning digest ("HH:mm", org-local). */
export function dayStartSetting(env: Record<string, string | undefined> = process.env): { h: number; min: number } {
  const m = String(env.FOLLOWUP_DAY_START ?? '09:00').match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Number(m[1]) : 9;
  const min = m ? Number(m[2]) : 0;
  return h <= 23 && min <= 59 ? { h, min } : { h: 9, min: 0 };
}

export function isDateOnly(dueAt: Date): boolean {
  return dueAt.getUTCHours() === 0 && dueAt.getUTCMinutes() === 0 && dueAt.getUTCSeconds() === 0 && dueAt.getUTCMilliseconds() === 0;
}

/**
 * Due value from an API body: "YYYY-MM-DD" → that date (UTC midnight, the
 * date-only convention); anything with a time → that instant, moved one
 * minute later if it happens to land exactly on UTC midnight so it isn't
 * mistaken for a date-only value. Invalid → null.
 */
export function parseDueInput(v: string | null | undefined): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return isDateOnly(d) ? new Date(d.getTime() + 60_000) : d;
}

/** The calendar day ("YYYY-MM-DD") a follow-up is due on, as the org reads it. */
export function dueDayKey(dueAt: Date, tz: string): string {
  return isDateOnly(dueAt) ? dueAt.toISOString().slice(0, 10) : localDateKey(dueAt, tz);
}

/** Whole days from `fromKey` to `toKey` (both "YYYY-MM-DD"). */
export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((keyToDate(toKey).getTime() - keyToDate(fromKey).getTime()) / 86_400_000);
}

/**
 * OVERDUE / TODAY / UPCOMING for one dated follow-up.
 *  - date-only: compared by calendar day (due today stays "today" all day);
 *  - date-time: overdue the moment its time has passed, "today" while still
 *    ahead of us on the org's current day.
 */
export function classifyDue(dueAt: Date, now: Date, tz: string): Exclude<FollowUpStatus, 'UNDATED' | 'NONE'> {
  const today = localDateKey(now, tz);
  const day = dueDayKey(dueAt, tz);
  if (isDateOnly(dueAt)) return day < today ? 'OVERDUE' : day === today ? 'TODAY' : 'UPCOMING';
  if (dueAt.getTime() < now.getTime()) return 'OVERDUE';
  return day === today ? 'TODAY' : 'UPCOMING';
}

/** When the reminder for this follow-up should fire. */
export function remindAt(dueAt: Date, tz: string, dayStart = dayStartSetting()): Date {
  if (!isDateOnly(dueAt)) return dueAt;
  const [y, m, d] = dueAt.toISOString().slice(0, 10).split('-').map(Number);
  return zonedToUtc({ y, m, d }, dayStart, tz);
}

/**
 * Reminders older than this are not sent: after downtime (or on the first
 * deploy, when every historic follow-up has remindedAt = NULL) only items
 * that fell due recently fire; older ones are left to the morning digest
 * and the overdue icons rather than replayed as a storm of notifications.
 */
export const REMINDER_GRACE_MS = Number(process.env.FOLLOWUP_REMINDER_GRACE_HOURS ?? 6) * 3_600_000;

/**
 * Due-instant window that can contain every reminder firing in
 * (now - grace, now]. A date-only item's reminder is up to ~14h before its
 * stored midnight (UTC+14) or ~36h after (UTC-12 plus a late day start), so
 * the DB pre-filter is wide and the exact check is `shouldRemind`.
 */
export function candidateDueWindow(now: Date, graceMs = REMINDER_GRACE_MS): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - graceMs - 48 * 3_600_000), to: new Date(now.getTime() + 16 * 3_600_000) };
}

export function shouldRemind(dueAt: Date, now: Date, tz: string, graceMs = REMINDER_GRACE_MS, dayStart = dayStartSetting()): boolean {
  const at = remindAt(dueAt, tz, dayStart).getTime();
  return at <= now.getTime() && at > now.getTime() - graceMs;
}

/** Is it digest time for this org right now? (between the day start and 3 hours after, local) */
export function digestWindowOpen(now: Date, tz: string, dayStart = dayStartSetting(), windowHours = 3): boolean {
  const today = localDateKey(now, tz);
  const [y, m, d] = today.split('-').map(Number);
  const start = zonedToUtc({ y, m, d }, dayStart, tz).getTime();
  return now.getTime() >= start && now.getTime() < start + windowHours * 3_600_000;
}

// ─── Per-record aggregation (list icons, filters, sort) ─────────────────────

export interface OpenItem {
  id: string;
  source: FollowUpSource;
  /** CALL / EMAIL / MEETING / TASK for activities; 'TASK' for tasks. */
  type: string;
  title: string;
  dueAt: Date | null;
}

export interface ItemRef {
  id: string;
  source: FollowUpSource;
  type: string;
  title: string;
  dueAt: string | null;
  dateOnly: boolean;
  /** Days overdue (positive) or until due (negative/zero), by org calendar day. */
  days: number | null;
}

export interface RecordFollowUpSummary {
  status: FollowUpStatus;
  overdue: number;
  today: number;
  upcoming: number;
  undated: number;
  /** The item the icon's tooltip names: the OLDEST overdue, else the next due, else an undated one. */
  focus: ItemRef | null;
  /** Earliest future due (for UPCOMING "next on 28 Oct"). */
  next: ItemRef | null;
  /** Human tooltip, e.g. "Call Mr. Iyer — overdue 2 days". */
  label: string;
}

export const EMPTY_SUMMARY: RecordFollowUpSummary = { status: 'NONE', overdue: 0, today: 0, upcoming: 0, undated: 0, focus: null, next: null, label: 'No follow-up planned' };

function ref(item: OpenItem, now: Date, tz: string): ItemRef {
  const today = localDateKey(now, tz);
  return {
    id: item.id, source: item.source, type: item.type, title: item.title,
    dueAt: item.dueAt ? item.dueAt.toISOString() : null,
    dateOnly: item.dueAt ? isDateOnly(item.dueAt) : false,
    days: item.dueAt ? daysBetween(dueDayKey(item.dueAt, tz), today) : null,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "25 Oct" / "25 Oct, 14:30" in the org zone (server-side labels; the client formats its own). */
export function shortDue(dueAt: Date, tz: string): string {
  const key = dueDayKey(dueAt, tz);
  const [, m, d] = key.split('-').map(Number);
  const day = `${d} ${MONTHS[m - 1]}`;
  if (isDateOnly(dueAt)) return day;
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(dueAt);
  return `${day}, ${t}`;
}

export function describeItem(r: ItemRef, tz: string): string {
  const title = r.title.length > 60 ? `${r.title.slice(0, 59)}…` : r.title;
  if (!r.dueAt) return `${title} — no date`;
  const due = new Date(r.dueAt);
  if (r.days !== null && r.days > 0) return `${title} — overdue ${r.days} ${r.days === 1 ? 'day' : 'days'}`;
  if (r.days === 0) {
    if (!r.dateOnly && due.getTime() < Date.now()) return `${title} — overdue (was ${shortDue(due, tz)})`;
    return r.dateOnly ? `${title} — due today` : `${title} — due today ${shortDue(due, tz).split(', ')[1] ?? ''}`.trim();
  }
  return `${title} — ${shortDue(due, tz)}`;
}

/** Summarise one record's open follow-ups. Pure. */
export function summarise(items: OpenItem[], now: Date, tz: string): RecordFollowUpSummary {
  if (!items.length) return EMPTY_SUMMARY;
  let overdue = 0, today = 0, upcoming = 0, undated = 0;
  let oldestOverdue: OpenItem | null = null;
  let firstToday: OpenItem | null = null;
  let nextFuture: OpenItem | null = null;
  let anyUndated: OpenItem | null = null;
  for (const it of items) {
    if (!it.dueAt) { undated++; anyUndated ??= it; continue; }
    const c = classifyDue(it.dueAt, now, tz);
    if (c === 'OVERDUE') { overdue++; if (!oldestOverdue || it.dueAt < oldestOverdue.dueAt!) oldestOverdue = it; }
    else if (c === 'TODAY') { today++; if (!firstToday || it.dueAt < firstToday.dueAt!) firstToday = it; }
    else { upcoming++; if (!nextFuture || it.dueAt < nextFuture.dueAt!) nextFuture = it; }
  }
  const status: FollowUpStatus = overdue ? 'OVERDUE' : today ? 'TODAY' : upcoming ? 'UPCOMING' : 'UNDATED';
  const focusItem = oldestOverdue ?? firstToday ?? nextFuture ?? anyUndated;
  const focus = focusItem ? ref(focusItem, now, tz) : null;
  const next = (firstToday ?? nextFuture) ? ref((firstToday ?? nextFuture)!, now, tz) : null;
  let label = focus ? describeItem(focus, tz) : EMPTY_SUMMARY.label;
  const extra = overdue + today + upcoming + undated - 1;
  if (extra > 0) label += ` (+${extra} more)`;
  return { status, overdue, today, upcoming, undated, focus, next, label };
}

/** Sort rank for "follow-ups first" ordering: overdue (oldest first), today, upcoming (soonest), undated, none. */
export function sortKey(s: RecordFollowUpSummary): [number, number] {
  const rank = { OVERDUE: 0, TODAY: 1, UPCOMING: 2, UNDATED: 3, NONE: 4 }[s.status];
  const t = s.focus?.dueAt ? new Date(s.focus.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  return [rank, t];
}

export function compareSummaries(a: RecordFollowUpSummary, b: RecordFollowUpSummary): number {
  const [ra, ta] = sortKey(a); const [rb, tb] = sortKey(b);
  return ra - rb || ta - tb;
}

/** Upper bound (exclusive) on stored due instants that can be overdue or due today in `tz` — for DB pre-filters. */
export function dueThroughTodayBound(now: Date, tz: string): Date {
  // End of the org's local day, plus a day of slack for date-only values
  // (stored at UTC midnight of their own date, which can sit after the
  // local day's end for zones behind UTC).
  const tomorrow = addDaysKey(localDateKey(now, tz), 1);
  return new Date(keyToDate(tomorrow).getTime() + 2 * 86_400_000);
}

export type ListFilter = 'overdue' | 'today' | 'none';
export function matchesFilter(s: RecordFollowUpSummary, f: ListFilter): boolean {
  if (f === 'overdue') return s.overdue > 0;
  if (f === 'today') return s.today > 0;
  return s.status === 'NONE';
}
