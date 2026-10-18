/**
 * The messaging assistant's one core — the same pipeline as the in-app chat
 * copilot (modules/ai/ai.controller.ts chatCopilotHandler), driven by text
 * replies instead of a card:
 *
 *   routeChatTurn → 'action' → planCommand (planner.ts) → numbered choices /
 *                               "reply YES" → executePlan (executor.ts)
 *                 → 'query'  → answerQuestion (analytics/ask.ts)
 *                 → 'reply'  → the router's own short answer
 *
 * Every gate the app has applies, because these ARE the app's functions,
 * called as the identified user: role + permission engine + record scope +
 * areas in the planner and again in the executor (which never trusts the
 * stored plan), field redaction and areas in the query layer, AI budget in
 * the gateway. On top: the org's per-channel switch (checked by the caller),
 * the ai_advanced licence, a per-user rate limit and a message length limit.
 * Every AI call made here is logged with the channel (AiInteractionLog.channel);
 * executions are audited AI-initiated with the channel; questions get a READ
 * audit row.
 */
import crypto from 'node:crypto';
import { routeChatTurn } from '../ai';
import { runWithAiContext } from '../aiContext';
import { getEffectiveLicense, featureNotIncludedMessage } from '../licensing';
import { planCommand, reviewPlan, type ActionPlan, type PlanUser } from '../aiActions/planner';
import { executePlan } from '../aiActions/executor';
import { answerQuestion } from '../analytics/ask';
import { logAction } from '../auditLog';
import { frontendLink } from '../frontendUrl';
import { decide, highRiskPhrase, setParam, type Pending, type PendingChoose, type PendingConfirm } from './state';
import { loadSession, saveSession, claimPending, type Session } from './session';
import {
  formatAnswer, formatPlanPrompt, formatSecondConfirm, formatChoices, formatBlocked, formatReport, HELP_TEXT, clip, MAX_REPLY_CHARS,
  type Channel,
} from './format';
import { SlidingWindowLimiter, MAX_INBOUND_CHARS, USER_LIMIT, PENDING_TTL_MS } from './limits';
import type { StaffUser } from './identity';

const userLimiter = new SlidingWindowLimiter(USER_LIMIT.count, USER_LIMIT.windowMs);

export interface StaffMessage {
  channel: Channel;
  user: StaffUser;
  text: string;
  now?: Date;
}

const appLink = (path: string) => frontendLink(path);

/** Handles one message from an identified staff user; returns the reply text. Never throws. */
export async function handleStaffMessage(msg: StaffMessage): Promise<string> {
  const { channel, user } = msg;
  const text = String(msg.text ?? '').trim();
  try {
    if (!text || /^(help|\?|hi|hello|menu)$/i.test(text)) return HELP_TEXT(channel);
    if (text.length > MAX_INBOUND_CHARS) return `That message is too long for me (${text.length} characters). Keep it under ${MAX_INBOUND_CHARS} — or do this one in the app.`;
    if (!userLimiter.hit(`${channel}:${user.id}`)) {
      const wait = Math.max(1, Math.ceil(userLimiter.retryAfter(`${channel}:${user.id}`) / 60));
      return `You’re sending messages faster than I can handle — try again in about ${wait} min.`;
    }
    const lic = await getEffectiveLicense(user.orgId);
    if (!lic.features.includes('ai_advanced')) return featureNotIncludedMessage(lic, 'ai_advanced');

    return await runWithAiContext({ orgId: user.orgId, userId: user.id, channel }, () => converse(channel, user, text, msg.now ?? new Date()));
  } catch (err: any) {
    console.error(`[assistant:${channel}] failed for user ${user.id}:`, err?.status ?? '', err?.message ?? err);
    if (err?.status === 402) return String(err.message || 'The AI allowance for this month is used up.');
    return 'Sorry — something went wrong on my side and nothing was changed. Please try again in a moment.';
  }
}

async function converse(channel: Channel, user: StaffUser, text: string, now: Date): Promise<string> {
  const session = await loadSession(channel, user.id);
  const d = decide(session.pending, text, now);
  const planUser: PlanUser = { id: user.id, orgId: user.orgId, role: user.role, email: user.email, name: user.name };
  let reply: string;
  let next: Pending | null = session.pending;

  switch (d.do) {
    case 'nothing_pending':
      reply = 'There’s nothing waiting for a reply. Tell me what you need — e.g. “how many tickets are open?” or “create a ticket: printer offline”.';
      break;
    case 'expired':
      next = null;
      reply = `That request expired (plans wait ${Math.round(PENDING_TTL_MS / 60000)} minutes) and nothing was changed. Send it again if you still need it.`;
      break;
    case 'cancel':
      next = null;
      reply = 'Cancelled — nothing was changed.';
      break;
    case 'reprompt':
      if (d.pending.kind === 'confirm' && d.reason === 'need_phrase') reply = formatSecondConfirm(d.pending);
      else if (d.pending.kind === 'choose') reply = `Please reply with a number from 1 to ${Math.min(9, d.pending.candidates.length)}, or NO to cancel.\n\n${formatChoices(d.pending, channel)}`;
      else reply = 'Reply YES to run it or NO to cancel.';
      break;
    case 'second':
      next = { ...d.pending, stage: 'second' };
      reply = formatSecondConfirm(d.pending);
      break;
    case 'execute': {
      next = null;
      // Exactly one "yes" runs a plan, however often it is delivered.
      if (!(await claimPending(channel, user.id, d.pending.planId))) {
        return 'That plan was already handled.';
      }
      try {
        const report = await executePlan({
          user: planUser, steps: d.pending.steps, command: d.pending.command, planId: d.pending.planId,
          interactionLogId: d.pending.interactionLogId, confirmHighRisk: d.confirmHighRisk,
          idempotencyKey: `${channel}:${d.pending.planId}`, channel,
        });
        reply = formatReport(report, channel, appLink);
      } catch (err: any) {
        // Refused before anything ran (re-validation: permission, scope, area, high-risk gate).
        reply = `I didn’t run it: ${err?.message ?? 'it could not be validated'}. Nothing was changed.`;
      }
      break;
    }
    case 'pick': {
      const steps = setParam(d.pending.steps, d.pending.stepIndex, d.pending.param, d.candidate.id);
      const plan = await reviewPlan(planUser, steps, { planId: d.pending.planId, interactionLogId: d.pending.interactionLogId, explanation: d.pending.explanation });
      ({ reply, next } = present(plan, d.pending.command, channel, now));
      break;
    }
    case 'new': {
      next = null;
      const r = await answerNew(channel, user, planUser, session, text, now);
      reply = (d.dropped ? '(Your earlier request was cancelled.)\n\n' : '') + r.reply;
      next = r.next;
      break;
    }
  }

  const turns = [...session.turns, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: reply.slice(0, 400) }];
  await saveSession(channel, user, { turns, pending: next });
  return clip(reply, MAX_REPLY_CHARS[channel]);
}

async function answerNew(channel: Channel, user: StaffUser, planUser: PlanUser, session: Session, text: string, now: Date): Promise<{ reply: string; next: Pending | null }> {
  const messages = [...session.turns, { role: 'user' as const, content: text }].slice(-12).map(t => ({ role: t.role, content: t.content.slice(0, 2000) }));
  const route = await routeChatTurn(messages);

  if (route.mode === 'action' && route.command) {
    const command = route.command.slice(0, 500);
    const plan = await planCommand(planUser, command, { now });
    return present(plan, command, channel, now);
  }

  if (route.mode === 'query' && route.command) {
    const question = route.command.slice(0, 500);
    const answer = await answerQuestion({ id: user.id, orgId: user.orgId, role: user.role }, question, { now });
    logAction(user.id, 'READ', 'ASSISTANT:QUESTION', channel, { channel, question, status: answer.status, title: answer.title, cached: answer.cached });
    const link = answer.status === 'answered' ? appLink(`/dashboard?ask=${encodeURIComponent(question)}`) : undefined;
    return { reply: formatAnswer(answer, { channel, link }), next: null };
  }

  return { reply: route.reply || HELP_TEXT(channel), next: null };
}

/** A plan from the planner → the next message and what waits for the reply. */
export function present(plan: ActionPlan, command: string, channel: Channel, now: Date): { reply: string; next: Pending | null } {
  if (!plan.steps.length) {
    return { reply: plan.explanation ? `I couldn’t set that up: ${plan.explanation}` : 'I couldn’t match that to something I can do. Try including the specifics — who, what, when.', next: null };
  }
  const base = {
    planId: plan.planId || crypto.randomUUID(),
    interactionLogId: plan.interactionLogId,
    steps: plan.steps.map(s => ({ action: s.action, params: s.params })),
    command,
    explanation: plan.explanation,
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
  };
  const ambiguousStep = plan.steps.find(s => s.allowed && s.needs.length);
  if (ambiguousStep) {
    const need = ambiguousStep.needs[0];
    const pending: PendingChoose = {
      ...base, kind: 'choose', stepIndex: ambiguousStep.index - 1, param: need.param, noun: need.noun, query: need.query,
      candidates: need.candidates.slice(0, 9).map(c => ({ id: c.id, label: c.label, ...(c.hint ? { hint: c.hint } : {}) })),
    };
    return { reply: formatChoices(pending, channel), next: pending };
  }
  if (!plan.ready) return { reply: formatBlocked(plan, channel), next: null };
  const pending: PendingConfirm = {
    ...base, kind: 'confirm', stage: 'first', highRisk: plan.requiresSecondConfirmation,
    phrase: plan.requiresSecondConfirmation ? highRiskPhrase(plan.steps) : '',
  };
  return { reply: formatPlanPrompt(plan, pending, channel, Math.round(PENDING_TTL_MS / 60000)), next: pending };
}
