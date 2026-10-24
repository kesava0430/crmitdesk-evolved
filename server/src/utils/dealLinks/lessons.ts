/**
 * "Lessons from related deals" — prompt building and answer checking.
 * Pure functions; service.ts gathers the data and calls the model.
 *
 * The no-illusions rules (tools/ai-claims-spec.md) shape everything here:
 *  - The model only sees what people actually wrote on the related deals
 *    (comments, call/meeting/email/task notes, lead notes, quote notes) plus
 *    recorded facts (status, value, dates, stage path, quote discount).
 *  - Every reason it gives must quote the note it came from. The server then
 *    checks that quote really appears in that deal's notes and DROPS any
 *    reason whose quote can't be found — an invented reason never reaches the
 *    screen, however plausible it sounds.
 *  - A lost deal whose notes don't explain the loss is reported as
 *    "unexplained", computed here from what survived the check (not from the
 *    model's say-so).
 *
 * Budget: Groq's free tier allows 8,000 tokens/minute per account and counts
 * max_tokens against it, so one request is kept to ~3.5k tokens in the worst
 * case (8 deals with long notes): the notes share a fixed character budget.
 */
import crypto from 'node:crypto';
import { z } from 'zod';

export const PROMPT_VERSION = 'deal-lessons-v1';
/** Most related deals sent to the model (lost first, then won). */
export const MAX_LESSON_DEALS = 8;
/** Characters of note text shared by all deals in one prompt. */
export const NOTES_CHAR_BUDGET = 6000;
/** No single note may take more than this many characters. */
export const NOTE_CHAR_CAP = 600;
/** Floor per deal, so a deal never gets squeezed to nothing. */
export const MIN_DEAL_CHARS = 300;
/** Model reply cap. Counted by Groq against the per-minute token limit. */
export const LESSONS_MAX_TOKENS = 900;

export type NoteKind = 'comment' | 'call' | 'email' | 'meeting' | 'task' | 'lead note' | 'quote note';

export interface NoteSource {
  kind: NoteKind;
  date: Date;
  text: string;
}

export interface LessonDeal {
  id: string;
  title: string;
  status: 'OPEN' | 'WON' | 'LOST';
  value: number;
  createdAt: Date;
  closeDate: Date | null;
  updatedAt: Date;
  stagePath: string[];
  quote?: { title: string; total: number; maxDiscountPct: number; status: string } | null;
  notes: NoteSource[];
}

export interface CurrentDealSummary {
  title: string;
  status: string;
  stage: string;
  value: number;
  /** e.g. ['Flat / Unit = "Tower B - 502"'] */
  sharedOn: string[];
}

// ─── Text cleaning ───────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Comments are rich text (HTML). The model and the citation check want plain text. */
export function stripHtml(s: string): string {
  return s
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e.toLowerCase()] ?? (e[0] === '#' ? safeChar(e.slice(1)) : m));
}

function safeChar(code: string): string {
  const n = code[0] === 'x' || code[0] === 'X' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
  return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
}

/** Lines that start an email signature / boilerplate footer. */
const SIGNATURE = /^(--\s*|_{3,}|regards,?|best regards,?|kind regards,?|warm regards,?|thanks( and|\s*&)? regards,?|sent from my .*|get outlook for .*)$/i;

/** Plain text, signature cut off, whitespace collapsed to one line. */
export function cleanNote(raw: string): string {
  const lines = stripHtml(raw).split(/\r?\n/).map(l => l.trim());
  const sig = lines.findIndex((l, i) => i > 0 && SIGNATURE.test(l));
  const kept = sig > 0 ? lines.slice(0, sig) : lines;
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

/** Rough token estimate (≈3.5 chars/token: conservative for English + numbers/names). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

// ─── Selection & prompt ──────────────────────────────────────────────────────

const closedAt = (d: LessonDeal) => (d.closeDate ?? d.updatedAt ?? d.createdAt).getTime();

/** Lost deals first, then won, most recent first; open deals carry no lesson yet. */
export function selectLessonDeals(deals: LessonDeal[], cap = MAX_LESSON_DEALS): LessonDeal[] {
  const by = (s: string) => deals.filter(d => d.status === s).sort((a, b) => closedAt(b) - closedAt(a));
  return [...by('LOST'), ...by('WON')].slice(0, cap);
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '—');

function money(n: number, currency: string): string {
  return `${currency} ${Math.round(n).toLocaleString('en-US')}`;
}

/** One note per entry, newest first, fitted into `budget` characters. */
export function fitNotes(notes: NoteSource[], budget: number): Array<NoteSource & { id: number; shown: string }> {
  const out: Array<NoteSource & { id: number; shown: string }> = [];
  let left = budget;
  const sorted = [...notes]
    .map(n => ({ ...n, text: cleanNote(n.text) }))
    .filter(n => n.text)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  for (const n of sorted) {
    if (left < 60) break;
    let shown = n.text.length > NOTE_CHAR_CAP ? `${n.text.slice(0, NOTE_CHAR_CAP)}…` : n.text;
    if (shown.length > left) shown = `${shown.slice(0, left)}…`;
    out.push({ ...n, id: out.length + 1, shown });
    left -= shown.length + 24; // + the "(N1 2026-01-01 comment) " prefix
  }
  return out;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Ref ("D1") → deal + exactly the note text the model was shown. */
  refs: Map<string, { deal: LessonDeal; notes: Array<NoteSource & { id: number; shown: string }> }>;
  estPromptTokens: number;
  /** Prompt + reply cap — what Groq counts against the per-minute limit. */
  estRequestTokens: number;
  cacheKey: string;
}

export const LESSONS_SYSTEM = `You review a company's past deals that are related to a new deal (same unit/product/customer) and tell the salesperson what to learn from them.

Strict rules:
- Use ONLY the notes and facts given. Never guess, never use outside knowledge.
- Every reason must include "quote": words copied EXACTLY from one note (max 20 words), and "note": that note's id (e.g. "D1.N2").
- If a lost deal's notes do not say why it was lost, do NOT invent a reason: list its id in "unexplained".
- "whatWorked" only from WON deals; "lossReasons" only from LOST deals.
- "checklist": concrete things to check or do on the NEW deal before proceeding, each tied to the deals whose reasons it comes from.
- Keep each reason and checklist item under 25 words.

Reply with one JSON object only:
{"lossReasons":[{"reason":"…","deals":["D1"],"quote":"exact words from the note","note":"D1.N1"}],
 "whatWorked":[{"reason":"…","deals":["D3"],"quote":"…","note":"D3.N1"}],
 "checklist":[{"item":"…","deals":["D1"]}],
 "unexplained":["D2"],
 "confidence":"low|medium|high",
 "caveats":["…"]}`;

export function buildLessonsPrompt(current: CurrentDealSummary, deals: LessonDeal[], currency: string): BuiltPrompt {
  const chosen = deals.slice(0, MAX_LESSON_DEALS);
  const perDeal = Math.max(MIN_DEAL_CHARS, Math.floor(NOTES_CHAR_BUDGET / Math.max(1, chosen.length)));
  const refs: BuiltPrompt['refs'] = new Map();
  const blocks: string[] = [];

  chosen.forEach((d, i) => {
    const ref = `D${i + 1}`;
    const notes = fitNotes(d.notes, perDeal);
    refs.set(ref, { deal: d, notes });
    const lines = [
      `[${ref}] ${d.status} · "${d.title.slice(0, 120)}" · value ${money(d.value, currency)} · created ${day(d.createdAt)} · close date ${day(d.closeDate)}`,
    ];
    if (d.stagePath.length) lines.push(`  stages: ${d.stagePath.slice(-6).join(' → ')}`);
    if (d.quote) {
      lines.push(`  quote: "${d.quote.title.slice(0, 80)}" total ${money(d.quote.total, currency)}, max line discount ${d.quote.maxDiscountPct}% (${d.quote.status})`);
    }
    if (notes.length) {
      lines.push('  notes (newest first):');
      for (const n of notes) lines.push(`  (${ref}.N${n.id} ${day(n.date)} ${n.kind}) ${n.shown}`);
    } else {
      lines.push('  notes: none recorded');
    }
    blocks.push(lines.join('\n'));
  });

  const user = [
    `NEW deal: "${current.title.slice(0, 120)}" · ${current.status.toLowerCase()} · stage ${current.stage} · value ${money(current.value, currency)}`,
    `Related because they share: ${current.sharedOn.join('; ') || '—'}`,
    '',
    'PAST RELATED DEALS:',
    blocks.join('\n\n'),
  ].join('\n');

  const estPromptTokens = estimateTokens(LESSONS_SYSTEM.length + user.length) + 12;
  return {
    system: LESSONS_SYSTEM,
    user,
    refs,
    estPromptTokens,
    estRequestTokens: estPromptTokens + LESSONS_MAX_TOKENS,
    cacheKey: crypto.createHash('sha256').update(`${PROMPT_VERSION}|${LESSONS_SYSTEM}|${user}`).digest('hex'),
  };
}

// ─── Reply schema ────────────────────────────────────────────────────────────

const refList = z.preprocess(
  v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []),
  z.array(z.string()).max(8),
);
const shortText = (cap: number) => z.preprocess(v => (typeof v === 'string' ? v.trim().slice(0, cap) : v), z.string().min(1));

const CitedItem = z.object({
  reason: shortText(240),
  deals: refList,
  quote: shortText(400),
  note: z.string().max(20).optional().nullable(),
});

/** Over-long lists are cut, not rejected: a chatty model shouldn't cost a repair call. */
const capped = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.preprocess(v => (Array.isArray(v) ? v.slice(0, max) : v), z.array(item)).default([]);

export const LessonsReplySchema = z.object({
  lossReasons: capped(CitedItem, 12),
  whatWorked: capped(CitedItem, 8),
  checklist: capped(z.object({ item: shortText(240), deals: refList }), 10),
  unexplained: refList.default([]),
  confidence: z.preprocess(v => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['low', 'medium', 'high'])).catch('low'),
  caveats: capped(z.preprocess(v => (typeof v === 'string' ? v.slice(0, 300) : v), z.string()), 5),
});
export type LessonsReply = z.infer<typeof LessonsReplySchema>;

// ─── Citation check ──────────────────────────────────────────────────────────

/** Lower-case words only — punctuation, quotes and spacing never decide a match. */
export function words(s: string): string[] {
  return s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}%]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Longest run of consecutive quote words that appears consecutively in the source. */
function longestRun(q: string[], src: string[]): number {
  let best = 0;
  const prev = new Array(src.length + 1).fill(0);
  for (let i = 1; i <= q.length; i++) {
    let diag = 0;
    for (let j = 1; j <= src.length; j++) {
      const tmp = prev[j];
      prev[j] = q[i - 1] === src[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

/**
 * Whether `quote` really comes from `source`. Exact after normalising, or —
 * for quotes of 5+ words, to tolerate a dropped/changed word — at least 80%
 * of the quote found in order (one consecutive run, or aligned word-for-word).
 * One- and two-word "quotes" ("price") prove nothing and never pass.
 */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const q = words(quote);
  if (q.length < 2) return false;
  const s = words(source);
  const qs = ` ${q.join(' ')} `;
  if (` ${s.join(' ')} `.includes(qs)) return true;
  if (q.length < 5) return false;
  const need = Math.ceil(q.length * 0.8);
  return longestRun(q, s) >= need || bestAlignedHits(q, s) >= need;
}

/** Most quote words equal to the source word at the same offset — tolerates a substituted word. */
function bestAlignedHits(q: string[], src: string[]): number {
  let best = 0;
  for (let k = -q.length + 1; k < src.length; k++) {
    let hits = 0;
    for (let i = 0; i < q.length; i++) if (q[i] === src[i + k]) hits++;
    if (hits > best) best = hits;
  }
  return best;
}

/** First 20 words of a quote, for display. */
export function clipQuote(q: string, max = 20): string {
  const parts = q.trim().replace(/^["“']|["”']$/g, '').split(/\s+/);
  return parts.length > max ? `${parts.slice(0, max).join(' ')}…` : parts.join(' ');
}

export interface CitedDeal { id: string; title: string; status: string }
export interface CheckedReason {
  reason: string;
  quote: string;
  /** The deal and note the quote was found in (checked server-side). */
  source: { dealId: string; dealTitle: string; noteDate: string; noteKind: NoteKind };
  deals: CitedDeal[];
}
export interface LessonsResult {
  lossReasons: CheckedReason[];
  whatWorked: CheckedReason[];
  checklist: Array<{ item: string; deals: CitedDeal[] }>;
  unexplained: CitedDeal[];
  confidence: 'low' | 'medium' | 'high';
  caveats: string[];
  /** Points the model gave that were removed because their quote isn't in the notes. */
  droppedUnsupported: number;
}

const cite = (d: LessonDeal): CitedDeal => ({ id: d.id, title: d.title, status: d.status });

/**
 * Turns a parsed model reply into what the user sees, keeping only what the
 * notes support. A reason survives only if its quote is found in the notes of
 * a deal it cites (of the right outcome); the date and kind of note shown are
 * taken from where the quote was actually found, not from the model.
 */
export function checkLessons(reply: LessonsReply, refs: BuiltPrompt['refs']): LessonsResult {
  let dropped = 0;
  const supportedRefs = new Set<string>();

  const checkList = (items: LessonsReply['lossReasons'], want: 'LOST' | 'WON'): CheckedReason[] => {
    const out: CheckedReason[] = [];
    for (const it of items) {
      const cited = [...new Set(it.deals.map(r => r.trim().toUpperCase()))]
        .filter(r => refs.get(r)?.deal.status === want);
      // A note id like "D2.N1" implies its deal even if "deals" forgot it.
      const noteRef = it.note?.toUpperCase().match(/^(D\d+)\.N(\d+)$/);
      if (noteRef && refs.get(noteRef[1])?.deal.status === want && !cited.includes(noteRef[1])) cited.unshift(noteRef[1]);

      let found: { ref: string; note: NoteSource & { id: number; shown: string } } | null = null;
      // Look in the cited note first, then every note of every cited deal.
      const order = noteRef ? [noteRef[1], ...cited.filter(r => r !== noteRef[1])] : cited;
      for (const r of order) {
        const notes = refs.get(r)?.notes ?? [];
        const first = noteRef && r === noteRef[1] ? notes.filter(n => n.id === Number(noteRef[2])) : [];
        const hit = [...first, ...notes].find(n => quoteAppearsIn(it.quote, n.shown));
        if (hit) { found = { ref: r, note: hit }; break; }
      }
      if (!found) { dropped++; continue; }
      const src = refs.get(found.ref)!.deal;
      // Only deals whose own notes back the quote are credited, plus the
      // source — a reason quoted from D1 doesn't explain D2 by association.
      const backing = cited.filter(r => r === found!.ref || (refs.get(r)?.notes ?? []).some(n => quoteAppearsIn(it.quote, n.shown)));
      backing.forEach(r => supportedRefs.add(r));
      out.push({
        reason: it.reason,
        quote: clipQuote(it.quote),
        source: { dealId: src.id, dealTitle: src.title, noteDate: found.note.date.toISOString().slice(0, 10), noteKind: found.note.kind },
        deals: backing.map(r => cite(refs.get(r)!.deal)),
      });
    }
    return out;
  };

  const lossReasons = checkList(reply.lossReasons, 'LOST');
  const whatWorked = checkList(reply.whatWorked, 'WON');

  const checklist = reply.checklist
    .map(c => ({ item: c.item, refs: [...new Set(c.deals.map(r => r.trim().toUpperCase()))].filter(r => supportedRefs.has(r)) }))
    .filter(c => {
      if (c.refs.length) return true;
      dropped++;
      return false;
    })
    .map(c => ({ item: c.item, deals: c.refs.map(r => cite(refs.get(r)!.deal)) }));

  // Unexplained = every lost deal sent to the model that no surviving reason
  // is backed by — whatever the model claimed.
  const unexplained = [...refs.entries()]
    .filter(([r, v]) => v.deal.status === 'LOST' && !supportedRefs.has(r))
    .map(([, v]) => cite(v.deal));

  let confidence = reply.confidence;
  if (!lossReasons.length && !whatWorked.length) confidence = 'low';
  else if (dropped && confidence === 'high') confidence = 'medium';

  const caveats = reply.caveats.map(c => c.trim()).filter(Boolean).slice(0, 3);
  if (dropped) caveats.push(`${dropped} point${dropped === 1 ? ' was' : 's were'} removed because ${dropped === 1 ? 'it' : 'they'} could not be matched to the recorded notes.`);

  return { lossReasons, whatWorked, checklist, unexplained, confidence, caveats, droppedUnsupported: dropped };
}

/** Problems worth one repair call (the reply parsed but is unusable). */
export function replyProblems(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return ['The reply was not a JSON object.'];
  const p = LessonsReplySchema.safeParse(raw);
  if (!p.success) return p.error.issues.slice(0, 5).map(i => `${i.path.join('.') || 'reply'}: ${i.message}`);
  const missingQuote = [...p.data.lossReasons, ...p.data.whatWorked].filter(r => words(r.quote).length < 2).length;
  return missingQuote ? [`${missingQuote} reason(s) have no real quote — copy exact words from a note.`] : [];
}
