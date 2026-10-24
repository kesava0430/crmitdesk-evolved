/**
 * Fact check for AI-drafted follow-up emails — pure, unit-tested.
 *
 * The prompt tells the model to use only facts from the record's context, but
 * a small model will still sometimes "round" a price, invent a validity date
 * or promise a meeting on Friday. So every amount, percentage, date, weekday
 * and clock time in the draft is extracted and looked up in the exact context
 * text that was sent. Anything not found is flagged in the UI next to the
 * draft ("check: ₹80,00,000 not found in the deal") — the person sees what to
 * verify before pressing Send. Nothing is silently rewritten.
 *
 * Conservative by design: numbers that are not money/percentages/dates (e.g.
 * "3 BHK", "2 options") are ignored, and Indian digit grouping (85,00,000),
 * lakh/crore words, k/thousand/million, ₹/Rs/INR/$/€/£ all normalise to one
 * numeric value so "₹85 lakh" matches a context value of 8500000.
 */

export type FlagKind = 'amount' | 'percent' | 'date' | 'weekday' | 'time';
export interface FactFlag { kind: FlagKind; text: string; message: string }

const CURRENCY = String.raw`(?:₹|rs\.?|inr|usd|us\$|\$|eur|€|gbp|£|aed|sgd)`;
const NUM = String.raw`\d{1,3}(?:[,\s]\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SCALE = String.raw`(?:lakhs?|lacs?|lakh|crores?|cr|k|thousand|million|mn|m|l)\b`;

const SCALE_MULT: Record<string, number> = {
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5,
  crore: 1e7, crores: 1e7, cr: 1e7,
  k: 1e3, thousand: 1e3,
  million: 1e6, mn: 1e6, m: 1e6,
};

function toNumber(raw: string): number {
  return Number(raw.replace(/[,\s]/g, ''));
}

/** Every number in a text, with lakh/crore/k scaling applied (and also unscaled). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const re = new RegExp(String.raw`(${NUM})\s*(${SCALE})?`, 'gi');
  for (const m of text.matchAll(re)) {
    const n = toNumber(m[1]);
    if (!Number.isFinite(n)) continue;
    out.add(round2(n));
    const s = m[2]?.toLowerCase();
    if (s && SCALE_MULT[s]) out.add(round2(n * SCALE_MULT[s]));
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface Mention { kind: FlagKind; text: string; value?: number; md?: string; year?: number; weekday?: number; time?: string }

/** Money amounts: currency-marked, scale-marked, or grouped (≥ 1,000) numbers. */
export function amountMentions(text: string): Mention[] {
  const out: Array<Mention & { at: number; end: number }> = [];
  const overlaps = (a: number, b: number) => out.some(o => a < o.end && b > o.at);
  const take = (m: RegExpMatchArray, value: number, shown = m[0].trim()) => {
    const at = m.index!, end = at + m[0].length;
    if (!overlaps(at, end)) out.push({ kind: 'amount', text: shown, value: round2(value), at, end });
  };
  const withCur = new RegExp(String.raw`${CURRENCY}\s*(${NUM})\s*(${SCALE})?`, 'gi');
  for (const m of text.matchAll(withCur)) {
    const base = toNumber(m[1]); const s = m[2]?.toLowerCase();
    take(m, s && SCALE_MULT[s] ? base * SCALE_MULT[s] : base);
  }
  const withScale = new RegExp(String.raw`(?<![\w.,])(${NUM})\s*(lakhs?|lacs?|crores?|cr)\b`, 'gi');
  for (const m of text.matchAll(withScale)) take(m, toNumber(m[1]) * SCALE_MULT[m[2].toLowerCase()]);
  const grouped = /(?<![\w.,])(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?)(?![\d%])/g;
  for (const m of text.matchAll(grouped)) take(m, toNumber(m[1]), m[1]);
  return out.sort((a, b) => a.at - b.at).map(({ at: _a, end: _e, ...m }) => m);
}

export function percentMentions(text: string): Mention[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*(%|percent\b|per cent\b)/gi)].map(m => ({ kind: 'percent' as const, text: m[0].trim(), value: round2(Number(m[1])) }));
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const md = (m: number, d: number) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Calendar dates written in common English forms (ISO, d/m/y, "25 Oct", "Oct 25th, 2026"). Day-first for numeric dates. */
export function dateMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const valid = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (valid(mo, d)) out.push({ kind: 'date', text: m[0], md: md(mo, d), year: y });
  }
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g)) {
    const [d, mo] = [Number(m[1]), Number(m[2])];
    let y = Number(m[3]); if (y < 100) y += 2000;
    if (valid(mo, d)) out.push({ kind: 'date', text: m[0], md: md(mo, d), year: y });
  }
  const dm = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(${MONTH_RE})\.?(?:,?\s+(\d{4}))?\b`, 'gi');
  for (const m of text.matchAll(dm)) {
    const d = Number(m[1]); const mo = MONTHS[m[2].toLowerCase()];
    if (valid(mo, d)) out.push({ kind: 'date', text: m[0].trim(), md: md(mo, d), year: m[3] ? Number(m[3]) : undefined });
  }
  const mdRe = new RegExp(String.raw`\b(${MONTH_RE})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, 'gi');
  for (const m of text.matchAll(mdRe)) {
    const mo = MONTHS[m[1].toLowerCase()]; const d = Number(m[2]);
    if (valid(mo, d)) out.push({ kind: 'date', text: m[0].trim(), md: md(mo, d), year: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function weekdayMentions(text: string): Mention[] {
  return [...text.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)]
    .map(m => ({ kind: 'weekday' as const, text: m[0], weekday: WEEKDAYS.indexOf(m[1].toLowerCase()) }));
}

const normTime = (h: number, min: number, ap?: string) => {
  let hh = h % 12; if (ap?.toLowerCase().startsWith('p')) hh += 12; if (!ap && h > 12) hh = h;
  return `${String(hh).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};
export function timeMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])/gi)) {
    out.push({ kind: 'time', text: m[0].trim(), time: normTime(Number(m[1]), Number(m[2] ?? 0), m[3]) });
  }
  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s?(?:a\.?m|p\.?m))/gi)) {
    out.push({ kind: 'time', text: m[0], time: normTime(Number(m[1]), Number(m[2])) });
  }
  return out;
}

/** What the context makes checkable: its numbers, percentages, dates, plausible weekdays, times. */
export interface ContextFacts {
  numbers: Set<number>;
  percents: Set<number>;
  dates: Array<{ md: string; year?: number }>;
  weekdays: Set<number>;
  times: Set<string>;
}

/**
 * `today` ("YYYY-MM-DD", org-local) limits which dates make a weekday
 * plausible: "see you Friday" is verified only if the context names Friday
 * or holds an upcoming date (today or later — planned follow-ups, quote
 * validity, close date) that falls on a Friday. Past note dates don't count.
 */
export function contextFacts(contextText: string, extra: { numbers?: number[]; percents?: number[]; today?: string } = {}): ContextFacts {
  const numbers = numbersIn(contextText);
  for (const n of extra.numbers ?? []) if (Number.isFinite(n)) numbers.add(round2(n));
  const percents = new Set(percentMentions(contextText).map(p => p.value!));
  for (const n of extra.percents ?? []) if (Number.isFinite(n)) percents.add(round2(n));
  const all = dateMentions(contextText);
  const dates = all.map(d => ({ md: d.md!, year: d.year }));
  const weekdays = new Set<number>();
  for (const d of all) {
    if (!d.year) continue;
    const iso = `${d.year}-${d.md}`;
    if (extra.today && iso < extra.today) continue;
    weekdays.add(new Date(`${iso}T00:00:00Z`).getUTCDay());
  }
  for (const w of weekdayMentions(contextText)) weekdays.add(w.weekday!);
  const times = new Set(timeMentions(contextText).map(t => t.time!));
  return { numbers, percents, dates, weekdays, times };
}

function numberKnown(v: number, facts: ContextFacts): boolean {
  if (facts.numbers.has(v)) return true;
  // Allow sub-1% rounding of large amounts ("₹82.5 lakh" for 8,249,500) — flag anything bigger.
  for (const n of facts.numbers) if (n >= 1000 && Math.abs(n - v) / n < 0.005) return true;
  return false;
}

/** Flags for every checkable fact in the draft that the context doesn't contain. Pure. */
export function checkDraft(draft: string, facts: ContextFacts, recordWord = 'record'): FactFlag[] {
  const flags: FactFlag[] = [];
  const seen = new Set<string>();
  const flag = (kind: FlagKind, text: string, what: string) => {
    const k = `${kind}:${text.toLowerCase()}`;
    if (seen.has(k)) return; seen.add(k);
    flags.push({ kind, text, message: `check: ${what} not found in the ${recordWord}` });
  };
  for (const a of amountMentions(draft)) if (!numberKnown(a.value!, facts)) flag('amount', a.text, a.text);
  for (const p of percentMentions(draft)) if (!facts.percents.has(p.value!)) flag('percent', p.text, p.text);
  for (const d of dateMentions(draft)) {
    const ok = facts.dates.some(c => c.md === d.md && (!d.year || !c.year || c.year === d.year));
    if (!ok) flag('date', d.text, `the date “${d.text}”`);
  }
  for (const w of weekdayMentions(draft)) if (!facts.weekdays.has(w.weekday!)) flag('weekday', w.text, `“${w.text}”`);
  for (const t of timeMentions(draft)) if (!facts.times.has(t.time!)) flag('time', t.text, `the time “${t.text}”`);
  return flags;
}
