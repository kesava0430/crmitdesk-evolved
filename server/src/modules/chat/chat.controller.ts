/**
 * Team Chat — human-to-human messaging inside the org.
 *
 * Two thread kinds:
 *   DM     — a private conversation between exactly two org members. dmKey is
 *            the two user ids sorted and joined with ':', which makes
 *            find-or-create race-safe via the (orgId, dmKey) unique index.
 *   RECORD — a live thread pinned to a record (ticket/deal/lead/...), open to
 *            any staff member who opens that record; joining is implicit.
 *
 * Real-time delivery rides the existing SSE stream. DM events are sent ONLY
 * to the two participants (sseManager.sendToUsers) — an org-wide broadcast
 * would leak private messages to every connected employee. Record-thread
 * events carry no message body at all; clients refetch, and the fetch
 * endpoint enforces access, so nothing leaks through the event channel.
 *
 * The @ai assistant lives in every thread: a message starting with "@ai" is
 * routed through the same router/planner as the chat copilot. Questions get
 * answered inline; actions become a pending plan stored on the thread that
 * anyone in the thread can run by replying "@ai confirm" (executed with the
 * CONFIRMING user's role — the whitelist re-checks it) or drop with
 * "@ai cancel".
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { sanitizeRichText } from '../../utils/sanitizeHtml';
import { sseManager, SSEEvent } from '../../utils/sse';
import { routeChatTurn } from '../../utils/ai';
import { buildActionPlanForOrg } from '../ai/ai.controller';
import { executePlan } from '../../utils/aiActions/executor';
import { planAsText } from '../../utils/aiActions/text';
import { hasFeature, getEffectiveLicense } from '../../utils/licensing';
import { entityTypeModule } from '../../utils/modules';

const RECORD_TYPES = ['TICKET', 'DEAL', 'LEAD', 'CONTACT', 'ACCOUNT', 'CUSTOM_MODULE_RECORD'] as const;

const threadInclude = {
  participants: { include: { user: { select: { id: true, name: true, role: true } } } },
} as const;

function dmKeyFor(a: string, b: string) {
  return [a, b].sort().join(':');
}

async function assertParticipant(threadId: string, orgId: string, userId: string) {
  const thread = await prisma.chatThread.findFirst({
    where: { id: threadId, orgId },
    include: threadInclude,
  });
  if (!thread) throw new AppError(404, 'Thread not found');
  const isMember = thread.participants.some(p => p.userId === userId);
  if (thread.kind === 'DM' && !isMember) throw new AppError(403, 'Not your conversation');
  /* RECORD threads: implicit join on first touch — anyone who can open the
     record can join its chat. (Record-level permissions already gated the
     page they clicked through.) */
  if (!isMember) {
    await prisma.chatParticipant.create({ data: { threadId, userId } }).catch(() => {});
  }
  return thread;
}

/** GET /chat/threads — my conversations, newest activity first, with unread counts. */
export async function listThreads(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const memberships = await prisma.chatParticipant.findMany({
      where: { userId, thread: { orgId } },
      include: {
        thread: {
          include: {
            ...threadInclude,
            messages: { orderBy: { createdAt: 'desc' }, take: 1, include: { author: { select: { id: true, name: true } } } },
          },
        },
      },
    });
    const rows = await Promise.all(memberships.map(async m => {
      const unread = await prisma.chatMessage.count({
        where: {
          threadId: m.threadId,
          createdAt: m.lastReadAt ? { gt: m.lastReadAt } : undefined,
          NOT: { authorId: userId },
        },
      });
      const t = m.thread;
      return {
        id: t.id, kind: t.kind, entityType: t.entityType, entityId: t.entityId,
        lastMessageAt: t.lastMessageAt,
        participants: t.participants.map(p => p.user),
        lastMessage: t.messages[0] ? { body: t.messages[0].body, authorName: t.messages[0].isAssistant ? 'AI' : t.messages[0].author?.name } : null,
        unread,
      };
    }));
    rows.sort((a, b) => (b.lastMessageAt?.getTime?.() ?? 0) - (a.lastMessageAt?.getTime?.() ?? 0));
    // Record threads about an area switched off for the org (Platform Admin →
    // Areas) aren't listed — the record itself is out of reach. Kept, and
    // back with the area.
    const { blockedModules } = await getEffectiveLicense(orgId);
    res.json(rows.filter(r => { const m = entityTypeModule(r.entityType); return !m || !(blockedModules as string[]).includes(m); }));
  } catch (err) { next(err); }
}

/** POST /chat/dm { userId } — open (or create) my DM with another member. */
export async function openDm(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId: otherId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    const orgId = req.user!.orgId;
    const me = req.user!.id;
    if (otherId === me) throw new AppError(400, 'That would be a very quiet conversation — pick a teammate.');
    const other = await prisma.user.findFirst({ where: { id: otherId, orgId, isActive: true }, select: { id: true } });
    if (!other) throw new AppError(404, 'User not found in your organization');

    const dmKey = dmKeyFor(me, otherId);
    let thread = await prisma.chatThread.findFirst({ where: { orgId, dmKey }, include: threadInclude });
    if (!thread) {
      thread = await prisma.chatThread.create({
        data: {
          orgId, kind: 'DM', dmKey,
          participants: { create: [{ userId: me }, { userId: otherId }] },
        },
        include: threadInclude,
      });
    }
    res.json(thread);
  } catch (err) { next(err); }
}

/** GET /chat/record/:entityType/:entityId — open (or create) a record's thread. */
export async function openRecordThread(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const entityType = String(req.params.entityType).toUpperCase();
    const entityId = req.params.entityId;
    if (!RECORD_TYPES.includes(entityType as any)) throw new AppError(400, `Unsupported record type ${entityType}`);
    const orgId = req.user!.orgId;

    let thread = await prisma.chatThread.findFirst({ where: { orgId, entityType, entityId }, include: threadInclude });
    if (!thread) {
      thread = await prisma.chatThread.create({
        data: { orgId, kind: 'RECORD', entityType, entityId, participants: { create: [{ userId: req.user!.id }] } },
        include: threadInclude,
      });
    } else {
      await prisma.chatParticipant.create({ data: { threadId: thread.id, userId: req.user!.id } }).catch(() => {});
    }
    res.json(thread);
  } catch (err) { next(err); }
}

/** GET /chat/threads/:id/messages — read (and mark read). */
export async function listMessages(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const thread = await assertParticipant(req.params.id, req.user!.orgId, req.user!.id);
    const messages = await prisma.chatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { author: { select: { id: true, name: true } } },
    });
    await prisma.chatParticipant.updateMany({
      where: { threadId: thread.id, userId: req.user!.id },
      data: { lastReadAt: new Date() },
    });
    res.json({ threadId: thread.id, kind: thread.kind, participants: thread.participants.map(p => p.user), messages, pendingPlan: thread.pendingPlan ?? null });
  } catch (err) { next(err); }
}

/* Strip tags to inspect what a human actually typed ("@ai ..." detection
   must work whether the editor sent plain text or "<p>@ai ...</p>"). */
function plainText(html: string) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function notifyThread(orgId: string, thread: { id: string; kind: string; participants: Array<{ userId: string }> }, payload: any) {
  if (thread.kind === 'DM') {
    sseManager.sendToUsers(orgId, thread.participants.map(p => p.userId), SSEEvent.CHAT_MESSAGE, payload);
  } else {
    /* Record threads: event carries ids only — anyone interested refetches
       through the access-checked endpoint, so nothing leaks. */
    sseManager.broadcastAll(orgId, SSEEvent.CHAT_MESSAGE, { threadId: payload.threadId });
  }
}

/** POST /chat/threads/:id/messages { body } */
export async function postMessage(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { body } = z.object({ body: z.string().min(1).max(20000) }).parse(req.body);
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const thread = await assertParticipant(req.params.id, orgId, userId);

    const clean = sanitizeRichText(body);
    const message = await prisma.chatMessage.create({
      data: { threadId: thread.id, authorId: userId, body: clean },
      include: { author: { select: { id: true, name: true } } },
    });
    await prisma.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } });
    notifyThread(orgId, thread as any, { threadId: thread.id, message });

    /* ── @ai in-thread assistant ── */
    const text = plainText(clean);
    if (/^@ai\b/i.test(text)) {
      // Answer asynchronously; the human message is already delivered.
      handleAiMention(orgId, req.user!, thread as any, text.replace(/^@ai\b[:,]?\s*/i, '')).catch(() => {});
    }

    res.status(201).json(message);
  } catch (err) { next(err); }
}

async function postAssistantMessage(orgId: string, thread: { id: string; kind: string; participants: Array<{ userId: string }> }, body: string) {
  const message = await prisma.chatMessage.create({ data: { threadId: thread.id, isAssistant: true, body } });
  await prisma.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } });
  notifyThread(orgId, thread, { threadId: thread.id, message: { ...message, author: null } });
}

async function handleAiMention(
  orgId: string,
  user: { id: string; role: string; email: string; orgId: string },
  thread: { id: string; kind: string; participants: Array<{ userId: string }>; pendingPlan?: any },
  command: string,
) {
  // The in-thread assistant is the NL command bar / copilot under another
  // name — Advanced AI (Pro+), same as /api/ai (LIC-4).
  if (!(await hasFeature(orgId, 'ai_advanced'))) {
    return postAssistantMessage(orgId, thread, 'The @ai assistant is part of Advanced AI, which isn’t included in your current plan. An admin can upgrade under Billing to turn it on.');
  }

  const current = await prisma.chatThread.findUnique({ where: { id: thread.id }, select: { pendingPlan: true } });

  // "@ai confirm" — run the thread's pending plan as the person confirming:
  // the executor re-checks their role, permissions, the org's areas and every
  // record, and audits each step (utils/aiActions/executor.ts).
  if (/^(confirm|yes|run( it)?|go ahead|do it)\b/i.test(command)) {
    const plan = current?.pendingPlan as any;
    const steps = Array.isArray(plan?.steps) && plan.steps.length
      ? plan.steps.map((s: any) => ({ action: s.action, params: s.params }))
      : plan?.action ? [{ action: plan.action, params: plan.params }] : [];
    if (!steps.length) return postAssistantMessage(orgId, thread, 'There’s nothing pending to confirm. Ask me to do something first — e.g. "@ai create a ticket for the printer jam".');
    const highRiskOk = /high[\s-]?risk/i.test(command);
    try {
      const report = await executePlan({ user: { ...user, orgId }, steps, planId: plan.planId, interactionLogId: plan.interactionLogId, confirmHighRisk: highRiskOk, command: 'team chat @ai' });
      await prisma.chatThread.update({ where: { id: thread.id }, data: { pendingPlan: null as any, pendingPlanBy: null } });
      const lines = report.steps.map(s => `${s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : '⏭️'} ${s.index}. ${s.summary ?? s.error ?? `${s.label} — not started`}`);
      return postAssistantMessage(orgId, thread, `${report.summary}\n${report.steps.length > 1 ? lines.join('\n') : ''}`.trim());
    } catch (err: any) {
      if (err?.statusCode === 428) return postAssistantMessage(orgId, thread, 'This includes a high-risk step. Reply "@ai confirm high risk" to run it.');
      return postAssistantMessage(orgId, thread, `That didn’t run: ${err?.message || 'unknown error'}`);
    }
  }

  if (/^(cancel|no|dismiss|stop)\b/i.test(command)) {
    await prisma.chatThread.update({ where: { id: thread.id }, data: { pendingPlan: null as any, pendingPlanBy: null } });
    return postAssistantMessage(orgId, thread, 'Okay — dropped the pending action.');
  }

  // Fresh request: route it like a copilot turn.
  const route = await routeChatTurn([{ role: 'user', content: command }]);
  if (route.mode === 'action' && route.command) {
    const plan = await buildActionPlanForOrg({ ...user, orgId }, route.command.slice(0, 500));
    if (!plan.steps.length) {
      return postAssistantMessage(orgId, thread, plan.explanation ? `I couldn’t set that up: ${plan.explanation}` : 'I couldn’t match that to an action I can run.');
    }
    if (!plan.ready) {
      // Pickers live on the in-app card; here, ask for the specifics instead.
      return postAssistantMessage(orgId, thread, `${planAsText(plan)}\n\nI can’t run this yet — rephrase with the exact names, or use the assistant card in the app to pick.`);
    }
    await prisma.chatThread.update({ where: { id: thread.id }, data: { pendingPlan: plan as any, pendingPlanBy: user.id } });
    return postAssistantMessage(orgId, thread,
      `${planAsText(plan)}\n\nReply "@ai confirm${plan.requiresSecondConfirmation ? ' high risk' : ''}" to run it, or "@ai cancel".`);
  }
  if (route.mode === 'query' && route.command) {
    /* Answered from the query layer with the ASKER's permissions. Everyone in
       the thread reads the reply, so pay data (payslips, payroll runs, loans)
       is never used here — the private assistant answers those. */
    const { answerQuestion } = await import('../../utils/analytics/ask');
    const result = await answerQuestion({ id: user.id, orgId, role: user.role }, route.command.slice(0, 500), { exclude: ['payslips', 'payroll_runs', 'loans'] });
    return postAssistantMessage(orgId, thread, result.status === 'answered' && result.howCalculated[0]
      ? `${result.answer}\n\n_${result.howCalculated[0]}_`
      : result.answer);
  }
  return postAssistantMessage(orgId, thread, route.reply || 'I’m here — ask me a question or tell me what to do, e.g. "@ai create a ticket for the broken scanner".');
}

/** GET /chat/people — teammates I can DM. */
export async function listPeople(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const users = await prisma.user.findMany({
      where: { orgId: req.user!.orgId, isActive: true, NOT: { id: req.user!.id } },
      select: { id: true, name: true, role: true, department: true },
      orderBy: { name: 'asc' },
    });
    res.json(users);
  } catch (err) { next(err); }
}
