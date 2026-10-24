/**
 * "AI suggests the next step" — one follow-up (type, title, when, reason)
 * from a record's recent context, shown as a one-click chip. Never created
 * automatically: the chip posts to the normal activities API when clicked.
 *
 * Cheap by construction: FAST model, ~0.7k-token context (NEXT_STEP_CONTEXT_CHARS),
 * 250 output tokens, cached by context hash (unchanged context → no call),
 * and at most one model call per record per NEXT_STEP_COOLDOWN_MIN minutes.
 *
 * The model writes the time in words ("tomorrow 11am", "Monday") or ISO; the
 * server resolves it in the org's timezone with the same resolver the AI
 * actions use (utils/aiActions/dates.ts), so weekday maths is never trusted
 * to a small model. Past or unparseable → the next working-day start.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { FollowUpContext, renderContext, NEXT_STEP_CONTEXT_CHARS, NOTE_CAP_NEXT } from './context';
import { resolveDate, zonedToUtc } from '../aiActions/dates';
import { estimateTokens } from '../dealLinks/lessons';
import { dayStartSetting, isDateOnly } from './time';
import { addDaysKey, localDateKey } from '../attendanceEngine';

export const NEXT_STEP_MAX_TOKENS = 250;
export const NEXT_STEP_COOLDOWN_MIN = Number(process.env.FOLLOWUP_NEXT_STEP_COOLDOWN_MIN ?? 10);
export const NEXT_STEP_PROMPT_VERSION = 'next-step-v1';

export const NEXT_STEP_SYSTEM = `You suggest ONE next follow-up for a salesperson from the CONTEXT of a lead or deal.
Pick the single most useful next action given the latest notes and what is already planned (don't duplicate a planned follow-up).
Base the reason only on CONTEXT; don't invent facts.
"when": short words relative to TODAY, e.g. "tomorrow 11am", "Monday 10:00", "in 3 days" — or an ISO date-time.
Reply ONLY with JSON: {"type": "CALL"|"EMAIL"|"MEETING"|"TASK", "title": "max 80 chars", "when": "...", "reason": "max 160 chars"}`;

export interface BuiltNextStepPrompt { system: string; user: string; estRequestTokens: number; contextHash: string }

export function buildNextStepPrompt(c: FollowUpContext): BuiltNextStepPrompt {
  const r = renderContext(c, { budget: NEXT_STEP_CONTEXT_CHARS, noteCap: NOTE_CAP_NEXT, includeLessons: false });
  const user = `CONTEXT:\n${r.text}`;
  // TODAY is in the context, so a new day is a new key — yesterday's "tomorrow" is never reused.
  const contextHash = crypto.createHash('sha256').update(`${NEXT_STEP_PROMPT_VERSION}|${NEXT_STEP_SYSTEM}|${user}`).digest('hex');
  return { system: NEXT_STEP_SYSTEM, user, estRequestTokens: estimateTokens(NEXT_STEP_SYSTEM.length + user.length) + NEXT_STEP_MAX_TOKENS, contextHash };
}

const Reply = z.object({
  type: z.string().transform(s => s.trim().toUpperCase()).pipe(z.enum(['CALL', 'EMAIL', 'MEETING', 'TASK'])),
  title: z.string().trim().min(3).max(200),
  when: z.string().trim().min(1).max(80),
  reason: z.string().trim().max(400).optional().default(''),
});

export interface NextStepSuggestion {
  type: 'CALL' | 'EMAIL' | 'MEETING' | 'TASK';
  title: string;
  /** ISO instant (never exactly UTC midnight, so it isn't read as date-only). */
  dueAt: string;
  /** e.g. "Mon 26 Oct 2026, 11:00" in the org timezone. */
  dueLabel: string;
  /** True when the model's time couldn't be used and the next working-day start was substituted. */
  defaulted: boolean;
  reason: string;
}

/** Next working-day start (org-local) after `now` — the fallback time. */
export function defaultDue(now: Date, tz: string): Date {
  const tomorrow = addDaysKey(localDateKey(now, tz), 1);
  const [y, m, d] = tomorrow.split('-').map(Number);
  return zonedToUtc({ y, m, d }, dayStartSetting(), tz);
}

/** Validates and resolves the model's JSON. Pure (given now + tz). */
export function parseNextStep(raw: string | null, now: Date, tz: string): { ok: true; suggestion: NextStepSuggestion } | { ok: false; problems: string[] } {
  let j: unknown;
  try { j = JSON.parse(raw ?? ''); } catch { return { ok: false, problems: ['reply was not valid JSON'] }; }
  const p = Reply.safeParse(j);
  if (!p.success) return { ok: false, problems: p.error.issues.map(i => `${i.path.join('.') || 'reply'}: ${i.message}`) };
  const words = p.data.when.replace(/^in (\d+) days?$/i, (_m, n) => addDaysKey(localDateKey(now, tz), Number(n)));
  const r = resolveDate(words, 'datetime', { now, timeZone: tz });
  let due: Date; let defaulted = false;
  if (r.ok && !r.past) due = new Date(r.value);
  else { due = defaultDue(now, tz); defaulted = true; }
  if (isDateOnly(due)) due = new Date(due.getTime() + 60_000);
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(due);
  return {
    ok: true,
    suggestion: {
      type: p.data.type, title: p.data.title.replace(/[\r\n]+/g, ' ').slice(0, 120),
      dueAt: due.toISOString(), dueLabel: label, defaulted, reason: p.data.reason.replace(/[\r\n]+/g, ' ').slice(0, 200),
    },
  };
}

/** Cooldown check: may we call the model for this record now? Pure. */
export function cooldownLeft(lastCallAt: number | null, now: number, minutes = NEXT_STEP_COOLDOWN_MIN): number {
  if (!lastCallAt) return 0;
  return Math.max(0, lastCallAt + minutes * 60_000 - now);
}
