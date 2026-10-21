// ─── Work from home: pure rules (unit-tested) ────────────────────────────────
//
// What a policy group allows (WfhSettings), how WFH days are counted against
// the monthly / weekly limits, notice rules, recurring schedule expansion and
// the check-in exemption. No database access here — utils/wfh.ts loads the
// data and calls these; attendanceRegister.ts uses the schedule helpers.
//
// Counting rules (owner-approved spec, item 5):
//   - only WORKING days count (the person's weekly offs and holidays don't);
//   - a half day counts 0.5;
//   - approved AND pending requests count; recurring WFH days (a schedule HR
//     set for a team, the whole org or a person) do NOT — the limit is about
//     what a person asks for, and a team-wide "every Friday" in a month with
//     five Fridays used to leave nobody in the team able to request a single
//     day (owner decision, full regression follow-up). The same rule feeds
//     "2 of 4 used" on screen and the check at request time;
//   - the month is the calendar month and the week the ISO week (Mon–Sun) of
//     each requested day — a request spanning two months is checked per month.

import { addDaysKey, dateKey, keyToDate, weekdayOf } from './attendanceEngine';
import type { VerificationRule } from './attendanceRules';

export type WfhApprovalMode = 'MANAGER' | 'AUTO';

export interface WfhSettings {
  enabled: boolean;
  approvalMode: WfhApprovalMode;
  /** null = unlimited */
  maxPerMonth: number | null;
  maxPerWeek: number | null;
  minNoticeDays: number;
  allowSameDay: boolean;
  allowHalfDay: boolean;
  requireCheckIn: boolean;
}

/** Defaults = the migration defaults (owner decisions: manager approval, 4 a month, check-in required). */
export const DEFAULT_WFH: WfhSettings = {
  enabled: true, approvalMode: 'MANAGER', maxPerMonth: 4, maxPerWeek: null, minNoticeDays: 0, allowSameDay: true, allowHalfDay: true, requireCheckIn: true,
};

/** Settings of a policy group row (missing fields fall back to the defaults, e.g. an un-migrated stub). */
export function wfhSettingsOf(g: any): WfhSettings {
  if (!g) return { ...DEFAULT_WFH };
  return {
    enabled: g.wfhEnabled ?? DEFAULT_WFH.enabled,
    approvalMode: g.wfhApprovalMode === 'AUTO' ? 'AUTO' : 'MANAGER',
    maxPerMonth: g.wfhMaxPerMonth === undefined ? DEFAULT_WFH.maxPerMonth : g.wfhMaxPerMonth,
    maxPerWeek: g.wfhMaxPerWeek ?? null,
    minNoticeDays: g.wfhMinNoticeDays ?? 0,
    allowSameDay: g.wfhAllowSameDay ?? true,
    allowHalfDay: g.wfhAllowHalfDay ?? true,
    requireCheckIn: g.wfhRequireCheckIn ?? DEFAULT_WFH.requireCheckIn,
  };
}

// ─── Calendar helpers ────────────────────────────────────────────────────────

export interface DayWeight { day: string; weight: number }

export const monthOf = (dayKey: string) => dayKey.slice(0, 7);

/** Monday of the ISO week containing `dayKey`. */
export function weekStartOf(dayKey: string): string {
  const wd = weekdayOf(keyToDate(dayKey)); // 0 = Sunday
  return addDaysKey(dayKey, -((wd + 6) % 7));
}

/** Range covering every calendar month and ISO week the given days touch — what has to be loaded to count usage. */
export function usageWindow(days: string[]): { from: string; to: string } {
  const sorted = [...days].sort();
  const first = sorted[0], last = sorted[sorted.length - 1];
  const monthStart = `${monthOf(first)}-01`;
  const [y, m] = monthOf(last).split('-').map(Number);
  const monthEnd = dateKey(new Date(Date.UTC(y, m, 0)));
  const weekStart = weekStartOf(first), weekEnd = addDaysKey(weekStartOf(last), 6);
  return { from: weekStart < monthStart ? weekStart : monthStart, to: weekEnd > monthEnd ? weekEnd : monthEnd };
}

const isWorkingDay = (k: string, weeklyOffs: number[], holidays: Set<string>) => !weeklyOffs.includes(weekdayOf(keyToDate(k))) && !holidays.has(k);

/** The working days of a request (half day = one day weighing 0.5). Same rule as countWorkingDays. */
export function requestDays(startKey: string, endKey: string, halfDay: boolean, weeklyOffs: number[], holidays: Set<string>): DayWeight[] {
  const out: DayWeight[] = [];
  for (let k = startKey; k <= endKey; k = addDaysKey(k, 1)) {
    if (!isWorkingDay(k, weeklyOffs, holidays)) continue;
    out.push({ day: k, weight: halfDay ? 0.5 : 1 });
    if (halfDay) break;
  }
  return out;
}

/** One entry per day; when two sources cover the same day the larger weight wins (a day never counts twice). */
export function mergeDays(...lists: DayWeight[][]): DayWeight[] {
  const m = new Map<string, number>();
  for (const l of lists) for (const d of l) m.set(d.day, Math.max(m.get(d.day) ?? 0, d.weight));
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, weight]) => ({ day, weight }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** WFH days used in the month and ISO week of `refDay`. */
export function usageFor(entries: DayWeight[], refDay: string): { month: number; week: number } {
  const mo = monthOf(refDay), wk = weekStartOf(refDay);
  let month = 0, week = 0;
  for (const e of entries) {
    if (monthOf(e.day) === mo) month += e.weight;
    if (weekStartOf(e.day) === wk) week += e.weight;
  }
  return { month: round1(month), week: round1(week) };
}

const fmtDay = (k: string) => keyToDate(k).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtMonth = (k: string) => keyToDate(`${monthOf(k)}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * null when `requested` fits the limits on top of `existing` (approved +
 * pending + recurring, excluding the request being modified); otherwise the
 * reason, naming the first month/week that would go over.
 */
export function checkLimits(settings: Pick<WfhSettings, 'maxPerMonth' | 'maxPerWeek'>, existing: DayWeight[], requested: DayWeight[]): string | null {
  const reqDays = new Set(requested.map(r => r.day));
  const base = existing.filter(e => !reqDays.has(e.day));
  const sum = (list: DayWeight[], key: (d: string) => string, k: string) => round1(list.filter(d => key(d.day) === k).reduce((s, d) => s + d.weight, 0));
  if (settings.maxPerMonth != null) {
    for (const mo of [...new Set(requested.map(r => monthOf(r.day)))].sort()) {
      const used = sum(base, monthOf, mo), asked = sum(requested, monthOf, mo);
      if (used + asked > settings.maxPerMonth) {
        return `That would be ${plural(round1(used + asked))} of work from home in ${fmtMonth(`${mo}-01`)} — the limit is ${plural(settings.maxPerMonth)} a month (${plural(used)} already used or requested).`;
      }
    }
  }
  if (settings.maxPerWeek != null) {
    for (const wk of [...new Set(requested.map(r => weekStartOf(r.day)))].sort()) {
      const used = sum(base, weekStartOf, wk), asked = sum(requested, weekStartOf, wk);
      if (used + asked > settings.maxPerWeek) {
        return `That would be ${plural(round1(used + asked))} of work from home in the week of ${fmtDay(wk)} — the limit is ${plural(settings.maxPerWeek)} a week (${plural(used)} already used or requested).`;
      }
    }
  }
  return null;
}

/** null when a self-service request starting `startKey` respects the notice rules on `todayKey`. */
export function checkNotice(settings: Pick<WfhSettings, 'minNoticeDays' | 'allowSameDay'>, startKey: string, todayKey: string): string | null {
  if (startKey < todayKey) return 'Work from home can\'t be requested for a past date — ask HR to record it for you.';
  if (startKey === todayKey && !settings.allowSameDay) return 'Same-day work-from-home requests aren\'t allowed for your policy — request it at least a day ahead.';
  const notice = Math.max(settings.minNoticeDays, settings.allowSameDay ? 0 : 1);
  if (notice > 0) {
    const earliest = addDaysKey(todayKey, notice);
    if (startKey < earliest) return `Work from home needs ${plural(notice)} notice — the earliest date you can request now is ${fmtDay(earliest)}.`;
  }
  return null;
}

/**
 * What happens to a request that got this far: AUTO approval applies only to
 * the employee's own request that broke no rule; anything else (manager mode,
 * or a manager's override let it through) follows the normal path — pending,
 * or approved by the manager applying it.
 */
export function approvalOutcome(settings: Pick<WfhSettings, 'approvalMode'>, actor: 'self' | 'manager', overridden: boolean): 'AUTO_APPROVED' | 'NORMAL' {
  return settings.approvalMode === 'AUTO' && actor === 'self' && !overridden ? 'AUTO_APPROVED' : 'NORMAL';
}

/**
 * The WFH days that count towards a person's monthly / weekly limit: only
 * their own requests. Recurring days are listed so callers can show them, but
 * never counted.
 */
export function limitEntries(requested: DayWeight[], _recurring: DayWeight[] = []): DayWeight[] {
  return mergeDays(requested);
}

// ─── Recurring schedules ─────────────────────────────────────────────────────

export interface ScheduleLike {
  id: string;
  userId: string | null;
  policyGroupId: string | null;
  weekdays: number[];
  startDate: Date | string;
  endDate: Date | string | null;
  note?: string | null;
  exceptions?: { userId: string | null; date: Date | string }[];
}

const keyOf = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : dateKey(d));

/** Does the schedule make `dayKey` a WFH day for `userId`? (Weekly offs / holidays are the caller's concern.) */
export function scheduleCovers(s: ScheduleLike, userId: string, dayKey: string): boolean {
  if (dayKey < keyOf(s.startDate)) return false;
  if (s.endDate && dayKey > keyOf(s.endDate)) return false;
  if (!s.weekdays.includes(weekdayOf(keyToDate(dayKey)))) return false;
  return !(s.exceptions ?? []).some(e => keyOf(e.date) === dayKey && (e.userId == null || e.userId === userId));
}

/** The first schedule covering the day, if any. */
export function scheduleFor(schedules: ScheduleLike[], userId: string, dayKey: string): ScheduleLike | null {
  return schedules.find(s => scheduleCovers(s, userId, dayKey)) ?? null;
}

/** Recurring WFH working days of [fromKey, toKey] for one person (weight 1 each). */
export function scheduleDays(schedules: ScheduleLike[], userId: string, fromKey: string, toKey: string, weeklyOffs: number[], holidays: Set<string>): DayWeight[] {
  const out: DayWeight[] = [];
  if (!schedules.length) return out;
  for (let k = fromKey; k <= toKey; k = addDaysKey(k, 1)) {
    if (isWorkingDay(k, weeklyOffs, holidays) && scheduleFor(schedules, userId, k)) out.push({ day: k, weight: 1 });
  }
  return out;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Every Fri", "Every Mon, Wed" — for reasons and lists. */
export function describeWeekdays(weekdays: number[]): string {
  const sorted = [...new Set(weekdays)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return sorted.length ? `Every ${sorted.map(d => WD[d]).join(', ')}` : 'No days';
}

// ─── Check-in on a WFH day ───────────────────────────────────────────────────

/**
 * On an approved WFH day the office checks (location geofence, office
 * network) don't apply; face verification still does when the rule has it.
 * With nothing left to verify the rule passes (evaluateRule: no checked signals).
 */
export function exemptRule(rule: VerificationRule, wfhDay: boolean): VerificationRule {
  return wfhDay ? { ...rule, location: false, network: false } : rule;
}
