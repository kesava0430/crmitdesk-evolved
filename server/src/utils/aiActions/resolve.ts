/**
 * Name → record resolution for AI actions — pure and unit-tested.
 *
 * The planner is allowed to name a record the way the user did ("the Acme
 * deal", "Priya") instead of copying an id out of its context list: copying
 * 25-character cuids is exactly where small models slip, and a slipped id
 * that happens to exist would act on the wrong record. The server matches the
 * name against the org's own records (already narrowed to what this user may
 * see) and decides:
 *   - one clear match  → use it;
 *   - several close    → ask the user to pick (the candidates go to the card);
 *   - nothing          → say so, never guess.
 */

export interface Candidate {
  id: string;
  label: string;
  /** Secondary text shown in the picker ("Proposal · ₹40,000", an email…). */
  hint?: string;
  /** Other names the record answers to (an invoice number, an email). */
  aliases?: string[];
}

export type MatchResult =
  | { status: 'ok'; id: string; label: string; how: 'id' | 'exact' | 'fuzzy' }
  | { status: 'ambiguous'; candidates: Candidate[] }
  | { status: 'none' };

/** Words that describe the record type rather than name it. */
const NOISE = new Set([
  'the', 'a', 'an', 'deal', 'deals', 'ticket', 'tickets', 'lead', 'leads', 'contact', 'contacts', 'account', 'accounts',
  'company', 'quote', 'quotes', 'invoice', 'invoices', 'campaign', 'campaigns', 'asset', 'assets', 'article', 'articles',
  'kb', 'request', 'requests', 'user', 'employee', 'record', 'module', 'loan', 'advance', 'change', 'approval', 'mr', 'mrs',
  'ms', 'dr', 'for', 'of', 'with', 'from', 'about', 'on', 'one', 'my', 'our', 'his', 'her', 'their',
]);

export function normalizeName(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[’']s\b/g, '') // Priya's → priya
    .replace(/[^a-z0-9@.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalizeName(s).split(' ').filter(t => t && !NOISE.has(t));
}

/**
 * 0..1 — how well `query` names `label`. Whole words count fully, a word
 * that only starts another ("pri" → "priya") counts less, so "Priya" names
 * "Priya Sharma" clearly rather than tying with "Priyanka Rao".
 */
export function nameScore(query: string, label: string): number {
  const q = normalizeName(query), l = normalizeName(label);
  if (!q || !l) return 0;
  if (q === l) return 1;
  const qt = tokens(query), lt = tokens(label);
  if (!qt.length || !lt.length) return 0;
  if (qt.join(' ') === lt.join(' ')) return 0.97;
  const whole = qt.filter(t => lt.includes(t)).length;
  if (whole === qt.length) return 0.85 + 0.1 * Math.min(1, qt.length / lt.length);
  const prefix = qt.filter(t => !lt.includes(t) && t.length >= 3 && lt.some(x => x.startsWith(t))).length;
  const coverage = (whole + 0.6 * prefix) / qt.length;
  return 0.75 * coverage * (0.7 + 0.3 * Math.min(1, qt.length / lt.length));
}

const MIN_SCORE = 0.5;
const AMBIGUITY_GAP = 0.12;

/**
 * Pick the record `query` refers to among `candidates`.
 * An exact id always wins; then exact names; then a fuzzy score with an
 * ambiguity gap — two near-equal matches are a question, not a coin toss.
 */
export function matchName(query: string, candidates: Candidate[]): MatchResult {
  const raw = String(query ?? '').trim();
  if (!raw || !candidates.length) return { status: 'none' };
  const byId = candidates.find(c => c.id === raw);
  if (byId) return { status: 'ok', id: byId.id, label: byId.label, how: 'id' };

  const q = normalizeName(raw);
  const exact = candidates.filter(c => normalizeName(c.label) === q || (c.aliases ?? []).some(a => normalizeName(a) === q));
  if (exact.length === 1) return { status: 'ok', id: exact[0].id, label: exact[0].label, how: 'exact' };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.slice(0, 6) };

  const scored = candidates
    .map(c => ({ c, s: Math.max(nameScore(raw, c.label), ...(c.aliases ?? []).map(a => nameScore(raw, a))) }))
    .filter(x => x.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { status: 'none' };
  const close = scored.filter(x => scored[0].s - x.s < AMBIGUITY_GAP);
  if (close.length === 1) return { status: 'ok', id: scored[0].c.id, label: scored[0].c.label, how: 'fuzzy' };
  return { status: 'ambiguous', candidates: close.slice(0, 6).map(x => x.c) };
}

/** Distinctive words of a name, for a bounded DB pre-filter (ILIKE any of them). */
export function searchTerms(query: string): string[] {
  const t = tokens(query).filter(x => x.length >= 2);
  return [...new Set(t)].slice(0, 5);
}
