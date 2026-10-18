/**
 * Natural-language dates for AI actions — pure, timezone-aware, unit-tested.
 *
 * The planner model (gpt-oss-20b in production) is told to copy the user's
 * own date words ("Friday 11am", "tomorrow", "next Monday") into date params
 * instead of doing calendar arithmetic itself: small models get weekday maths
 * and timezones wrong often enough that a wrong reminder time would be a
 * routine occurrence. The server resolves the words here, in the org's
 * timezone, and the confirmation card shows the resolved date ("Fri 23 Oct
 * 2026, 11:00") so the person checks the interpretation before anything runs.
 *
 * Conventions (shown back to the user, so they can always correct them):
 *  - a bare weekday ("Friday") is the next one AFTER today (1–7 days ahead);
 *  - "this Friday" is the Friday of the current Monday-to-Sunday week;
 *  - "next Friday" is the Friday of next week; "last Friday" the most recent past one;
 *  - a date-time with no time of day gets 09:00 (flagged as assumed);
 *  - numeric dates are day-first (23/10/2026), ISO (2026-10-23) always works.
 */

export type DateKind = 'date' | 'datetime' | 'month';

export interface ResolvedDate {
  ok: true;
  /** date → "YYYY-MM-DD"; datetime → ISO instant in UTC ("…Z"); month → "YYYY-MM". */
  value: string;
  /** Human reading in the org's timezone, for the confirmation card. */
  label: string;
  /** True when the input carried no time of day and 09:00 was used. */
  assumedTime?: boolean;
  /** True when the resolved moment is already in the past. */
  past?: boolean;
}
export interface DateError { ok: false; error: string }
export type DateResult = ResolvedDate | DateError;

export interface DateContext { now: Date; timeZone: string }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface YMD { y: number; m: number; d: number }
interface HM { h: number; min: number }

// ─── Timezone arithmetic (Intl only, no dependency) ──────────────────────────

/** A timezone Intl accepts, else UTC — a bad org setting must not crash planning. */
export function validTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

function partsIn(instant: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(instant)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, min: p.minute, s: p.second };
}

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(instant: Date, tz: string): number {
  const p = partsIn(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** The UTC instant of a wall-clock time in `tz` (two passes settle DST edges). */
export function zonedToUtc(ymd: YMD, hm: HM, tz: string): Date {
  const naive = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hm.h, hm.min);
  let guess = naive - offsetMinutes(new Date(naive), tz) * 60000;
  guess = naive - offsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess);
}

/** Today's calendar date in `tz`. */
export function todayIn(now: Date, tz: string): YMD {
  const p = partsIn(now, tz);
  return { y: p.y, m: p.m, d: p.d };
}

function addDays(a: YMD, n: number): YMD {
  const t = new Date(Date.UTC(a.y, a.m - 1, a.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function weekday(a: YMD): number { return new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay(); }
function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function validYmd(a: YMD): boolean { return a.m >= 1 && a.m <= 12 && a.d >= 1 && a.d <= daysInMonth(a.y, a.m); }
function cmp(a: YMD, b: YMD): number { return (a.y - b.y) || (a.m - b.m) || (a.d - b.d); }
const pad = (n: number) => String(n).padStart(2, '0');
export const ymdKey = (a: YMD) => `${a.y}-${pad(a.m)}-${pad(a.d)}`;

function dateLabel(a: YMD) { return `${DAY_NAMES[weekday(a)]} ${a.d} ${MONTH_NAMES[a.m - 1]} ${a.y}`; }

// ─── Parsing pieces ──────────────────────────────────────────────────────────

/** Pulls a time of day out of the text; returns it and the text without it. */
function extractTime(text: string): { hm: HM | null; rest: string } {
  let t = text;
  const named: Array<[RegExp, HM]> = [
    [/\b(at\s+)?noon\b/, { h: 12, min: 0 }],
    [/\b(at\s+)?midnight\b/, { h: 0, min: 0 }],
    [/\b(end of (the )?day|eod|cob|close of business)\b/, { h: 17, min: 0 }],
    [/\btonight\b/, { h: 20, min: 0 }],
    [/\b(in the )?morning\b/, { h: 9, min: 0 }],
    [/\b(in the )?afternoon\b/, { h: 14, min: 0 }],
    [/\b(in the )?evening\b/, { h: 18, min: 0 }],
  ];
  // "11am", "11:30 pm", "at 3pm", "3 p.m."
  const ampm = t.match(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\s|$|[,;]|\.(?!\w))/);
  if (ampm) {
    let h = Number(ampm[1]); const min = Number(ampm[2] ?? 0);
    const pm = ampm[3].startsWith('p');
    if (h < 1 || h > 12 || min > 59) return { hm: null, rest: t };
    if (h === 12) h = 0;
    if (pm) h += 12;
    return { hm: { h, min }, rest: t.replace(ampm[0], ' ') };
  }
  // "14:00", "at 9:30" — colon only, so "23.10" stays a (day-first) date
  const hhmm = t.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (hhmm) return { hm: { h: Number(hhmm[1]), min: Number(hhmm[2]) }, rest: t.replace(hhmm[0], ' ') };
  // "at 3" (no am/pm): business hours guess — 1..7 means afternoon
  const bare = t.match(/\bat\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th|\/|-|\.))/);
  if (bare) {
    let h = Number(bare[1]);
    if (h >= 0 && h <= 23) {
      if (h >= 1 && h <= 7) h += 12;
      return { hm: { h, min: 0 }, rest: t.replace(bare[0], ' ') };
    }
  }
  for (const [re, hm] of named) {
    if (re.test(t)) { t = t.replace(re, ' '); return { hm, rest: t }; }
  }
  return { hm: null, rest: t };
}

/** The calendar date the (time-free, lower-cased) text names, relative to `today`. */
function extractDate(text: string, today: YMD): YMD | null | 'none' {
  const t = text.replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'none';

  // ISO date
  let m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) { const a = { y: +m[1], m: +m[2], d: +m[3] }; return validYmd(a) ? a : null; }
  // Day-first numeric: 23/10/2026, 23-10-26, 23.10.2026, 23/10
  m = t.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
  if (m) {
    let y = m[3] ? +m[3] : today.y; if (y < 100) y += 2000;
    const a = { y, m: +m[2], d: +m[1] };
    if (!validYmd(a)) return null;
    if (!m[3] && cmp(a, today) < 0) return { ...a, y: a.y + 1 }; // "23/10" already passed → next year
    return a;
  }
  // "23 Oct [2026]", "23rd of October", "Oct 23[, 2026]", "October 23rd"
  const monthAlt = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlt})\\b(?:\\s+(\\d{4}))?`));
  const m2 = m ? null : t.match(new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s+(\\d{4}))?`));
  if (m || m2) {
    const day = m ? +m[1] : +m2![2];
    const mon = MONTHS[m ? m[2] : m2![1]];
    const yearGiven = m ? m[3] : m2![3];
    const a = { y: yearGiven ? +yearGiven : today.y, m: mon, d: day };
    if (!validYmd(a)) return null;
    if (!yearGiven && cmp(a, today) < 0) return { ...a, y: a.y + 1 };
    return a;
  }

  if (/\b(day after tomorrow|overmorrow)\b/.test(t)) return addDays(today, 2);
  if (/\b(tomorrow|tmrw|tmr)\b/.test(t)) return addDays(today, 1);
  if (/\b(today|now|asap|right away|immediately|tonight)\b/.test(t)) return today;
  if (/\byesterday\b/.test(t)) return addDays(today, -1);

  // in N days/weeks/months, N days from now
  m = t.match(/\b(?:in\s+)?(\d+|a|an|one|two|three|four|five|six|seven)\s+(day|days|week|weeks|month|months)(?:\s+from\s+(?:now|today))?\b/);
  if (m && (/\bin\b/.test(t) || /from\s+(now|today)/.test(t))) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = /^\d+$/.test(m[1]) ? +m[1] : words[m[1]];
    if (m[2].startsWith('day')) return addDays(today, n);
    if (m[2].startsWith('week')) return addDays(today, 7 * n);
    const tm = today.m - 1 + n;
    const y = today.y + Math.floor(tm / 12), mon = (tm % 12) + 1;
    return { y, m: mon, d: Math.min(today.d, daysInMonth(y, mon)) };
  }

  const mondayThisWeek = addDays(today, -((weekday(today) + 6) % 7));
  if (/\b(next week)\b/.test(t)) return addDays(mondayThisWeek, 7);
  if (/\b(end of (the )?week|this weekend|weekend)\b/.test(t)) return addDays(mondayThisWeek, /weekend/.test(t) ? 5 : 4);
  if (/\b(end of (the )?month|month end|eom)\b/.test(t)) return { y: today.y, m: today.m, d: daysInMonth(today.y, today.m) };
  if (/\bnext month\b/.test(t)) return today.m === 12 ? { y: today.y + 1, m: 1, d: 1 } : { y: today.y, m: today.m + 1, d: 1 };

  // Weekdays with optional this/next/coming/last
  const wd = t.match(/\b(this|next|coming|last|previous)?\s*(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/);
  if (wd) {
    const target = WEEKDAY_ABBR[wd[2]];
    if (target === undefined) return null;
    const mod = wd[1];
    const idx = (target + 6) % 7; // Monday = 0
    if (mod === 'this') return addDays(mondayThisWeek, idx);
    if (mod === 'next') return addDays(mondayThisWeek, 7 + idx);
    if (mod === 'last' || mod === 'previous') {
      let back = (weekday(today) - target + 7) % 7; if (back === 0) back = 7;
      return addDays(today, -back);
    }
    let ahead = (target - weekday(today) + 7) % 7; if (ahead === 0) ahead = 7;
    return addDays(today, ahead);
  }
  return null;
}

function resolveMonth(raw: string, today: YMD): DateResult {
  const t = raw.toLowerCase().replace(/[,]/g, ' ').trim();
  let m = t.match(/\b(\d{4})-(\d{1,2})\b/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return monthResult(+m[1], +m[2]);
  m = t.match(/\b(\d{1,2})[/-](\d{4})\b/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return monthResult(+m[2], +m[1]);
  if (/\b(this|current) month\b/.test(t)) return monthResult(today.y, today.m);
  if (/\b(last|previous|past) month\b/.test(t)) return today.m === 1 ? monthResult(today.y - 1, 12) : monthResult(today.y, today.m - 1);
  if (/\bnext month\b/.test(t)) return today.m === 12 ? monthResult(today.y + 1, 1) : monthResult(today.y, today.m + 1);
  const monthAlt = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  m = t.match(new RegExp(`\\b(${monthAlt})\\b(?:\\s+(\\d{4}))?`));
  if (m) {
    const mon = MONTHS[m[1]];
    // A month named without a year is the most recent one not in the future
    // ("run October payroll" in November means last month, not next year).
    const y = m[2] ? +m[2] : (mon > today.m ? today.y - 1 : today.y);
    return monthResult(y, mon);
  }
  return { ok: false, error: `Couldn't read a month from "${raw}" — try "October 2026" or "2026-10".` };
}
function monthResult(y: number, m: number): ResolvedDate {
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1];
  return { ok: true, value: `${y}-${pad(m)}`, label: `${full} ${y}` };
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Resolves `input` (words or ISO) to a concrete date / instant / month.
 * Never throws; an unreadable input comes back as { ok: false, error }.
 */
export function resolveDate(input: unknown, kind: DateKind, ctx: DateContext): DateResult {
  const tz = validTimeZone(ctx.timeZone);
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'No date given.' };
  const raw = input.trim();
  const today = todayIn(ctx.now, tz);
  if (kind === 'month') return resolveMonth(raw, today);

  // A full ISO instant with an explicit offset is already unambiguous.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { ok: false, error: `"${raw}" is not a valid date.` };
    const p = partsIn(d, tz);
    const ymd = { y: p.y, m: p.m, d: p.d };
    if (kind === 'date') return { ok: true, value: ymdKey(ymd), label: dateLabel(ymd) };
    return { ok: true, value: d.toISOString(), label: `${dateLabel(ymd)}, ${pad(p.h)}:${pad(p.min)}`, past: d.getTime() < ctx.now.getTime() };
  }

  let text = raw.toLowerCase().replace(/^(on|by|for|due|at)\s+/, '');
  // "2026-10-23T11:00" / "2026-10-23 11:00" with no offset: wall-clock time in the org's zone.
  const localIso = text.match(/^(\d{4}-\d{2}-\d{2})[t ](\d{2}):(\d{2})/);
  if (localIso) text = `${localIso[1]} ${localIso[2]}:${localIso[3]}`;

  const { hm, rest } = extractTime(text);
  const date = extractDate(rest, today);
  if (date === null) return { ok: false, error: `Couldn't read a date from "${raw}" — try "Friday 11am", "tomorrow" or "2026-10-23".` };
  // Only a time ("at 4pm"): today, or tomorrow if that time has passed.
  let ymd: YMD;
  if (date === 'none') {
    if (!hm) return { ok: false, error: `Couldn't read a date from "${raw}".` };
    ymd = today;
    if (kind === 'datetime' && zonedToUtc(today, hm, tz).getTime() <= ctx.now.getTime()) ymd = addDays(today, 1);
  } else ymd = date;

  if (kind === 'date') return { ok: true, value: ymdKey(ymd), label: dateLabel(ymd), past: cmp(ymd, today) < 0 || undefined };

  const time = hm ?? { h: 9, min: 0 };
  const instant = zonedToUtc(ymd, time, tz);
  return {
    ok: true,
    value: instant.toISOString(),
    label: `${dateLabel(ymd)}, ${pad(time.h)}:${pad(time.min)}${tz === 'UTC' ? ' UTC' : ''}`,
    ...(hm ? {} : { assumedTime: true }),
    ...(instant.getTime() < ctx.now.getTime() ? { past: true } : {}),
  };
}

/** "Fri 23 Oct 2026, 11:00" — an instant read in the org's timezone (result summaries). */
export function formatInZone(iso: string | Date, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const z = validTimeZone(tz);
  const p = partsIn(d, z);
  return `${dateLabel({ y: p.y, m: p.m, d: p.d })}, ${pad(p.h)}:${pad(p.min)}${z === 'UTC' ? ' UTC' : ''}`;
}

/** Lower-level export for tests and for the prompt's "Today is …" line. */
export function describeToday(now: Date, tz: string): string {
  const t = todayIn(now, validTimeZone(tz));
  return `${ymdKey(t)} (${WEEKDAYS[weekday(t)][0].toUpperCase()}${WEEKDAYS[weekday(t)].slice(1)})`;
}
