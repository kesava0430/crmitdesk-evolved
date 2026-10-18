/**
 * Conversation state machine for the messaging assistant — pure and
 * unit-tested. The DB side (load/save per (channel, user)) is in session.ts.
 *
 * One thing can be waiting per person and channel, and it expires
 * (PENDING_TTL_MS):
 *   confirm/first  — a ready plan: "yes" runs it (or moves to the second
 *                    confirmation when it has a high-risk step), "no" drops it;
 *   confirm/second — a high-risk plan after "yes": only the exact phrase
 *                    ("CONFIRM PAYROLL") runs it — never a one-tap reply;
 *   choose         — a name matched several records: reply with a number.
 * Anything else the person writes is a new request and replaces what was
 * waiting (they are told it was dropped).
 */

export interface RawStep { action: string; params: Record<string, any> }

interface PendingBase {
  planId: string;
  interactionLogId: string | null;
  steps: RawStep[];
  command: string;
  explanation: string;
  /** ISO time after which a reply no longer acts on it. */
  expiresAt: string;
}

export interface PendingConfirm extends PendingBase {
  kind: 'confirm';
  stage: 'first' | 'second';
  highRisk: boolean;
  /** The exact words the second confirmation needs, e.g. "CONFIRM PAYROLL". */
  phrase: string;
}

export interface PendingChoose extends PendingBase {
  kind: 'choose';
  /** 0-based index into steps, and the param path ("contactId", "ids.1"). */
  stepIndex: number;
  param: string;
  noun: string;
  query: string;
  candidates: Array<{ id: string; label: string; hint?: string }>;
}

export type Pending = PendingConfirm | PendingChoose;

export type Decision =
  | { do: 'new'; text: string; dropped?: boolean }
  | { do: 'execute'; pending: PendingConfirm; confirmHighRisk: boolean }
  | { do: 'second'; pending: PendingConfirm }
  | { do: 'cancel'; pending: Pending }
  | { do: 'pick'; pending: PendingChoose; candidate: { id: string; label: string } }
  | { do: 'reprompt'; pending: Pending; reason: 'need_phrase' | 'out_of_range' }
  | { do: 'expired' }
  | { do: 'nothing_pending' };

export type ReplyKind = { kind: 'yes' } | { kind: 'no' } | { kind: 'number'; n: number } | { kind: 'other' };

function norm(text: string): string {
  return String(text ?? '').trim().replace(/[.!\s]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

const YES = new Set(['y', 'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'confirm', 'confirmed', 'go', 'go ahead', 'do it', 'run', 'run it', 'sure', 'approve']);
const NO = new Set(['n', 'no', 'nope', 'cancel', 'stop', 'dismiss', 'abort', 'never mind', 'nevermind', "don't", 'dont']);

/** How a short reply reads on its own. Numbers stay numbers — their meaning depends on what's waiting. */
export function classifyReply(text: string): ReplyKind {
  const t = norm(text);
  if (/^\d{1,2}$/.test(t)) return { kind: 'number', n: Number(t) };
  if (YES.has(t)) return { kind: 'yes' };
  if (NO.has(t)) return { kind: 'no' };
  return { kind: 'other' };
}

/** "confirm   payroll." ≡ "CONFIRM PAYROLL". */
export function matchesPhrase(text: string, phrase: string): boolean {
  return !!phrase && norm(text) === norm(phrase);
}

export function isExpired(p: Pending, now: Date): boolean {
  const t = Date.parse(p.expiresAt);
  return !Number.isFinite(t) || now.getTime() >= t;
}

export function decide(pending: Pending | null, text: string, now: Date): Decision {
  const reply = classifyReply(text);
  const bare = reply.kind !== 'other' || /^confirm\b/i.test(String(text ?? '').trim());

  if (pending && isExpired(pending, now)) {
    return bare ? { do: 'expired' } : { do: 'new', text };
  }
  if (!pending) return bare ? { do: 'nothing_pending' } : { do: 'new', text };

  if (pending.kind === 'confirm') {
    if (pending.stage === 'first') {
      if (reply.kind === 'yes' || (reply.kind === 'number' && reply.n === 1)) {
        return pending.highRisk ? { do: 'second', pending } : { do: 'execute', pending, confirmHighRisk: false };
      }
      if (reply.kind === 'no' || (reply.kind === 'number' && reply.n === 2)) return { do: 'cancel', pending };
      if (reply.kind === 'number') return { do: 'reprompt', pending, reason: 'out_of_range' };
      return { do: 'new', text, dropped: true };
    }
    // second stage: only the phrase runs it.
    if (matchesPhrase(text, pending.phrase)) return { do: 'execute', pending, confirmHighRisk: true };
    if (reply.kind === 'no' || (reply.kind === 'number' && reply.n === 2)) return { do: 'cancel', pending };
    if (reply.kind === 'yes' || reply.kind === 'number' || /^confirm\b/i.test(String(text ?? '').trim())) {
      return { do: 'reprompt', pending, reason: 'need_phrase' };
    }
    return { do: 'new', text, dropped: true };
  }

  // choose
  if (reply.kind === 'number') {
    const c = pending.candidates[reply.n - 1];
    return c ? { do: 'pick', pending, candidate: c } : { do: 'reprompt', pending, reason: 'out_of_range' };
  }
  if (reply.kind === 'no') return { do: 'cancel', pending };
  if (reply.kind === 'yes') return { do: 'reprompt', pending, reason: 'out_of_range' };
  return { do: 'new', text, dropped: true };
}

/** Sets `value` at a param path like "contactId" or "ids.1" (copying, never mutating the stored plan). */
export function setParam(steps: RawStep[], stepIndex: number, path: string, value: string): RawStep[] {
  const out = steps.map(s => ({ action: s.action, params: JSON.parse(JSON.stringify(s.params ?? {})) }));
  const step = out[stepIndex];
  if (!step) return out;
  const [head, idx] = path.split('.');
  if (idx !== undefined && Array.isArray(step.params[head])) step.params[head][Number(idx)] = value;
  else step.params[head] = value;
  return out;
}

/** The words a high-risk plan must be confirmed with — tied to what it does. */
export function highRiskPhrase(steps: Array<{ action: string; risk?: string }>): string {
  const high = steps.find(s => s.risk === 'high');
  if (!high) return '';
  const a = high.action.toUpperCase();
  const word = /PAYROLL|SALARY|PAYSLIP/.test(a) ? 'PAYROLL'
    : /LOAN|ADVANCE/.test(a) ? 'LOAN'
    : /USER|INVITE|ROLE|ACCESS/.test(a) ? 'ACCESS'
    : /INVOICE/.test(a) ? 'INVOICE'
    : /WHATSAPP|CAMPAIGN|SEND|EMAIL/.test(a) ? 'SEND'
    : /EMPLOYEE/.test(a) ? 'EMPLOYEE'
    : /ATTENDANCE/.test(a) ? 'ATTENDANCE'
    : 'CHANGE';
  return `CONFIRM ${word}`;
}

/**
 * WhatsApp routing keyword. A message is for the assistant only when its first
 * word is "zen" ("zen how many…", "Zen: …", "/zen …", or just "zen") —
 * "Zenith", "zenkara" etc. are not. Everything else keeps flowing to the Inbox
 * exactly as before (see whatsapp.ts for the full rule).
 */
export function parseAddressed(text: string): { addressed: boolean; rest: string } {
  const m = String(text ?? '').match(/^\s*\/?zen(?![\p{L}\p{N}_])[\s:,.\-–—]*([\s\S]*)$/iu);
  return m ? { addressed: true, rest: m[1].trim() } : { addressed: false, rest: String(text ?? '').trim() };
}
