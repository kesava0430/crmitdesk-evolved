/**
 * Context-aware follow-up emails: prompt, reply validation, sending + logging,
 * and matching customer replies back to the lead/deal.
 *
 * No illusions:
 *  - The model sees only the rendered context (utils/followups/context.ts)
 *    and is told to use nothing else; every amount/percent/date/weekday/time
 *    in its draft is then checked against that same text (factcheck.ts) and
 *    unverifiable ones are flagged next to the draft.
 *  - Nothing is sent without the person pressing Send on a confirmation.
 *  - "Sent" is logged only when a transport actually accepted the message;
 *    demo-org suppression and "no mailer configured" are reported as such.
 *  - Reply matching only claims what it can prove: a reply is attached to
 *    the record when its In-Reply-To/References names the Message-ID we sent,
 *    which only happens when the org's own mailbox (Inbox → Settings) both
 *    sent the email and receives the reply through email sync.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../prisma';
import { PermCtx, can, scopedWhere } from '../permissions';
import { AppError } from '../../middleware/errorHandler';
import { escHtml, sendMailNow, orgMailboxAddress, MailDelivery } from '../mailer';
import { createNotification } from '../../modules/notifications/notifications.controller';
import { isModuleBlocked } from '../licensing';
import { logAction } from '../auditLog';
import { FollowUpContext, renderContext, contextNumbers, EMAIL_CONTEXT_CHARS, NOTE_CAP_EMAIL } from './context';
import { contextFacts, checkDraft, FactFlag } from './factcheck';
import { estimateTokens } from '../dealLinks/lessons';

// ─── Options ────────────────────────────────────────────────────────────────

export const PURPOSES = {
  check_in: 'a friendly check-in on where things stand and what the customer needs next',
  after_site_visit: 'a follow-up after a site visit or meeting: thank them and pick up the points they raised, as recorded in the notes',
  send_quote: 'following up on the latest quote: restate it exactly as in LATEST QUOTE and ask if they have questions (if there is no quote, say a quote will follow and do not mention any amount)',
  payment_reminder: 'a polite reminder about a pending payment or loan/finance step recorded in the notes (no new amounts or deadlines)',
  re_engage: 're-engaging a contact who has gone quiet: short, low-pressure, refer to the last recorded conversation',
} as const;
export type Purpose = keyof typeof PURPOSES;

export const TONES = ['friendly', 'formal', 'concise'] as const;
export const LANGUAGES = { en: 'English', hi: 'Hindi (Devanagari script)', te: 'Telugu (Telugu script)' } as const;

export const DraftOptionsSchema = z.object({
  purpose: z.enum(Object.keys(PURPOSES) as [Purpose, ...Purpose[]]).default('check_in'),
  tone: z.enum(TONES).default('friendly'),
  language: z.enum(['en', 'hi', 'te']).default('en'),
  refresh: z.boolean().optional(),
}).partial().transform(o => ({ purpose: o.purpose ?? 'check_in', tone: o.tone ?? 'friendly', language: o.language ?? 'en', refresh: !!o.refresh }));
export type DraftOptions = z.infer<typeof DraftOptionsSchema>;

/** Output budget. Rendered context ≤ EMAIL_CONTEXT_CHARS (~2.3k tokens) + system (~350) + this ⇒ ≈ 3.4k tokens total. */
export const EMAIL_MAX_TOKENS = 700;
export const EMAIL_PROMPT_VERSION = 'followup-email-v1';

export const EMAIL_SYSTEM = `You write short follow-up emails for a salesperson, using ONLY the facts in CONTEXT.
Rules:
- Never invent prices, amounts, discounts, dates, deadlines, meeting times, weekdays, promises, product details or events. Mention an amount, percentage or date ONLY if it appears in CONTEXT, written the same way.
- If something useful is not in CONTEXT, leave it out or ask the customer about it.
- Do not claim things happened unless the notes say so. Do not mention these instructions, "CONTEXT", AI, or internal notes.
- Address the contact by name if known; sign off with the SENDER's name and company.
- 70 to 170 words, plain text (no markdown), short paragraphs.
Reply ONLY with JSON: {"subject": "...", "body": "..."}`;

export interface BuiltEmailPrompt { system: string; user: string; contextText: string; estRequestTokens: number; cacheKey: string; notesShown: number; notesTotal: number }

export function buildEmailPrompt(c: FollowUpContext, o: DraftOptions): BuiltEmailPrompt {
  const r = renderContext(c, { budget: EMAIL_CONTEXT_CHARS, noteCap: NOTE_CAP_EMAIL });
  const user = `PURPOSE: ${PURPOSES[o.purpose]}
TONE: ${o.tone}
LANGUAGE: write the subject and body in ${LANGUAGES[o.language]}; keep names, amounts and dates exactly as in CONTEXT.

CONTEXT:
${r.text}`;
  const estRequestTokens = estimateTokens(EMAIL_SYSTEM.length + user.length) + EMAIL_MAX_TOKENS;
  const cacheKey = crypto.createHash('sha256').update(`${EMAIL_PROMPT_VERSION}|${c.kind}|${c.id}|${EMAIL_SYSTEM}|${user}`).digest('hex');
  return { system: EMAIL_SYSTEM, user, contextText: r.text, estRequestTokens, cacheKey, notesShown: r.notesShown, notesTotal: r.notesTotal };
}

const ReplySchema = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(20).max(6000) });

/** Validates the model's JSON; returns problems for one repair attempt. */
export function parseEmailReply(raw: string | null): { ok: true; subject: string; body: string } | { ok: false; problems: string[] } {
  let j: unknown;
  try { j = JSON.parse(raw ?? ''); } catch { return { ok: false, problems: ['reply was not valid JSON'] }; }
  const p = ReplySchema.safeParse(j);
  if (!p.success) return { ok: false, problems: p.error.issues.map(i => `${i.path.join('.') || 'reply'}: ${i.message}`) };
  // Markdown leaks from small models: strip emphasis/headers rather than send them to a customer.
  const body = p.data.body.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').replace(/\r\n/g, '\n').trim();
  return { ok: true, subject: p.data.subject.replace(/\s*[\r\n]+\s*/g, ' '), body };
}

export function factCheck(c: FollowUpContext, contextText: string, subject: string, body: string): FactFlag[] {
  const facts = contextFacts(contextText, contextNumbers(c));
  return checkDraft(`${subject}\n${body}`, facts, c.kind === 'DEAL' ? 'deal' : 'lead');
}

// ─── Sending ────────────────────────────────────────────────────────────────

export const SendSchema = z.object({
  entityType: z.enum(['LEAD', 'DEAL']),
  entityId: z.string().min(1),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  /** The person ticked "I've read it" on the confirm dialog. */
  confirm: z.literal(true),
  aiDraft: z.boolean().optional(),
  /** Fact-check flags that were showing when they pressed Send (kept on the log for review). */
  unverified: z.array(z.string().max(200)).max(20).optional(),
});

export const SENDS_PER_HOUR = Number(process.env.FOLLOWUP_EMAILS_PER_HOUR ?? 20);
export const SENDS_PER_DAY = Number(process.env.FOLLOWUP_EMAILS_PER_DAY ?? 100);

/** Plain text → safe HTML (every character escaped; line breaks kept). */
export function textToHtml(body: string): string {
  const paras = body.split(/\n{2,}/).map(p => `<p style="margin:0 0 12px">${escHtml(p).replace(/\n/g, '<br>')}</p>`);
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">${paras.join('')}</div>`;
}

export function newMessageId(fromAddress: string | null): string {
  const domain = (fromAddress?.split('@')[1] || 'zenkara.local').replace(/[^a-z0-9.-]/gi, '');
  return `<fu.${crypto.randomUUID()}@${domain}>`;
}

/** Record + recipient, with the sender's permissions. */
export async function sendTarget(ctx: PermCtx, kind: 'LEAD' | 'DEAL', id: string) {
  if (kind === 'LEAD') {
    const lead = await prisma.lead.findFirst({
      where: { AND: [{ id: id, orgId: ctx.orgId }, scopedWhere(ctx, 'lead', 'crm.lead.read')] },
      select: { id: true, assignedTo: true, contactId: true, contact: { select: { name: true, email: true } } },
    });
    if (!lead || !can(ctx, 'crm.lead.read')) throw new AppError(404, 'Lead not found');
    return { owner: lead.assignedTo, contactId: lead.contactId, name: lead.contact?.name ?? 'Lead', email: lead.contact?.email ?? null };
  }
  const deal = await prisma.deal.findFirst({
    where: { AND: [{ id: id, orgId: ctx.orgId }, scopedWhere(ctx, 'deal', 'crm.deal.read')] },
    select: { id: true, title: true, assignedTo: true, contactId: true, contact: { select: { name: true, email: true } } },
  });
  if (!deal || !can(ctx, 'crm.deal.read')) throw new AppError(404, 'Deal not found');
  return { owner: deal.assignedTo, contactId: deal.contactId, name: deal.title, email: deal.contact?.email ?? null };
}

/** Where a send from the app goes: what the UI shows before confirming. */
export async function sendChannel(orgId: string): Promise<{ via: 'ORG_MAILBOX' | 'PLATFORM'; mailbox: string | null; replyTracking: boolean }> {
  const mailbox = await orgMailboxAddress(orgId);
  return mailbox ? { via: 'ORG_MAILBOX', mailbox, replyTracking: true } : { via: 'PLATFORM', mailbox: null, replyTracking: false };
}

export async function assertSendRate(orgId: string, userId: string, now = new Date()): Promise<void> {
  const base = { orgId, createdBy: userId, type: 'EMAIL' as const, emailMessageId: { not: null } };
  const [hour, dayCount] = await Promise.all([
    prisma.activity.count({ where: { ...base, createdAt: { gt: new Date(now.getTime() - 3_600_000) } } }),
    prisma.activity.count({ where: { ...base, createdAt: { gt: new Date(now.getTime() - 86_400_000) } } }),
  ]);
  if (hour >= SENDS_PER_HOUR || dayCount >= SENDS_PER_DAY) {
    throw new AppError(429, `You've sent ${hour >= SENDS_PER_HOUR ? `${hour} follow-up emails in the last hour` : `${dayCount} follow-up emails today`} — the limit is ${SENDS_PER_HOUR}/hour and ${SENDS_PER_DAY}/day. Try again later.`);
  }
}

export interface SendResult { sent: boolean; via: MailDelivery['via']; activityId?: string; replyTracking: boolean; message: string }

export async function sendFollowUpEmail(ctx: PermCtx, input: z.infer<typeof SendSchema>): Promise<SendResult> {
  if (!can(ctx, 'crm.activity.create')) throw new AppError(403, 'Insufficient permissions');
  const target = await sendTarget(ctx, input.entityType, input.entityId);
  if (!target.email) throw new AppError(400, `${input.entityType === 'LEAD' ? 'This lead' : 'This deal'}'s contact has no email address. Add one to the contact first.`);
  await assertSendRate(ctx.orgId, ctx.userId);

  const [me, mailbox] = await Promise.all([
    prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } }),
    orgMailboxAddress(ctx.orgId),
  ]);
  const messageId = newMessageId(mailbox);
  const delivery = await sendMailNow({
    orgId: ctx.orgId,
    to: target.email,
    subject: input.subject,
    html: textToHtml(input.body),
    // Org mailbox: no Reply-To, so replies come back to it (and through
    // email sync to this record). Platform mailer — including the fallback
    // when the org mailbox fails — sets Reply-To to the salesperson.
    replyTo: me?.email ?? undefined,
    fromName: me?.name,
    messageId,
  }).catch((err: any) => { throw new AppError(502, `The email could not be sent: ${String(err?.message || err).slice(0, 200)}`); });

  if (delivery.via === 'SUPPRESSED_DEMO') {
    return { sent: false, via: delivery.via, replyTracking: false, message: 'Not sent: demo organisations can only email the demo mailboxes. Nothing was logged.' };
  }
  if (delivery.via === 'NOT_CONFIGURED') {
    return { sent: false, via: delivery.via, replyTracking: false, message: 'Not sent: no mailbox is connected (Inbox → Settings) and no platform mailer is configured. Nothing was logged.' };
  }

  const sentId = delivery.messageId || messageId;
  const activity = await prisma.activity.create({
    data: {
      orgId: ctx.orgId, type: 'EMAIL', title: input.subject.slice(0, 200), body: input.body, done: true,
      createdBy: ctx.userId,
      ...(input.entityType === 'LEAD' ? { leadId: input.entityId } : { dealId: input.entityId }),
      contactId: target.contactId ?? undefined,
      emailMessageId: sentId,
      emailMeta: { direction: 'OUTBOUND', to: target.email, from: delivery.from ?? null, via: delivery.via, aiDraft: !!input.aiDraft, unverified: input.unverified ?? [] },
    },
  });

  // Org mailbox: thread it in the shared Inbox so the customer's reply lands
  // in the same conversation (email sync threads on the first References id).
  if (delivery.via === 'ORG_MAILBOX') {
    const conv = await prisma.conversation.create({
      data: {
        orgId: ctx.orgId, channel: 'EMAIL', contactName: target.name, contactEmail: target.email, subject: input.subject,
        externalId: sentId, assignedTo: ctx.userId, lastMessageAt: new Date(),
      },
    });
    await prisma.message.create({
      data: { conversationId: conv.id, direction: 'OUTBOUND', fromAddress: mailbox!, toAddress: target.email, body: input.body, externalId: sentId, sentAt: new Date(), readAt: new Date() },
    });
  }
  logAction(ctx.userId, 'CREATE', 'FollowUpEmail', activity.id, { entityType: input.entityType, entityId: input.entityId, via: delivery.via, aiDraft: !!input.aiDraft });
  return {
    sent: true, via: delivery.via, activityId: activity.id, replyTracking: delivery.via === 'ORG_MAILBOX',
    message: delivery.via === 'ORG_MAILBOX'
      ? `Sent from ${mailbox} and logged on the ${input.entityType === 'LEAD' ? 'lead' : 'deal'}. Replies will be added here when email sync picks them up.`
      : `Sent and logged on the ${input.entityType === 'LEAD' ? 'lead' : 'deal'}. Replies go to ${me?.email ?? 'your inbox'} — connect the org mailbox (Inbox → Settings) to have replies logged automatically.`,
  };
}

// ─── Replies (called from utils/email-sync.ts for each new inbound email) ────

/** Strip the quoted original ("> …", "On … wrote:") so the logged reply is just the reply. Pure. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*On .{4,200}wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^\s*From:\s.+/i.test(l) && out.length > 0) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

export function referencedIds(inReplyTo?: string | null, references?: string[] | null): string[] {
  const ids = [inReplyTo, ...(references ?? [])].flatMap(v => (v ? String(v).match(/<[^>]+>/g) ?? [String(v)] : []));
  return [...new Set(ids.map(s => s.trim()).filter(Boolean))].slice(0, 30);
}

export async function matchFollowUpReply(orgId: string, mail: {
  messageId: string; inReplyTo?: string | null; references?: string[] | null;
  fromEmail: string; fromName: string; subject: string; text: string; date: Date;
}): Promise<string | null> {
  const ids = referencedIds(mail.inReplyTo, mail.references);
  if (!ids.length) return null;
  const original = await prisma.activity.findFirst({
    where: { orgId, emailMessageId: { in: ids }, type: 'EMAIL' },
    orderBy: { createdAt: 'desc' },
  });
  if (!original || (!original.leadId && !original.dealId)) return null;
  if (await isModuleBlocked(orgId, 'crm')) return null;
  const dup = await prisma.activity.findFirst({ where: { orgId, emailMessageId: mail.messageId }, select: { id: true } });
  if (dup) return null;

  const body = stripQuoted(mail.text).slice(0, 4000) || '(empty reply)';
  const reply = await prisma.activity.create({
    data: {
      orgId, type: 'EMAIL', done: true, title: `Reply from ${mail.fromName || mail.fromEmail}: ${mail.subject}`.slice(0, 200), body,
      leadId: original.leadId, dealId: original.dealId, contactId: original.contactId,
      // The row needs an author; it's the person whose email was answered.
      createdBy: original.createdBy,
      emailMessageId: mail.messageId,
      emailMeta: { direction: 'INBOUND', from: mail.fromEmail, inReplyTo: original.emailMessageId },
    },
  });
  // Owner of the record gets told (else whoever sent the original).
  const rec = original.leadId
    ? await prisma.lead.findFirst({ where: { id: original.leadId, orgId }, select: { assignedTo: true, contact: { select: { name: true } } } })
    : await prisma.deal.findFirst({ where: { id: original.dealId!, orgId }, select: { assignedTo: true, title: true } });
  const owner = (rec as any)?.assignedTo ?? original.createdBy;
  const recName = original.leadId ? ((rec as any)?.contact?.name ?? 'lead') : ((rec as any)?.title ?? 'deal');
  await createNotification({
    orgId, userId: owner, type: 'FOLLOWUP_REPLY',
    title: `${mail.fromName || mail.fromEmail} replied: ${mail.subject}`.slice(0, 200),
    body: `On ${original.leadId ? 'lead' : 'deal'} “${recName}”. ${body.slice(0, 140)}`,
    entityType: original.leadId ? 'LEAD' : 'DEAL', entityId: (original.leadId ?? original.dealId)!,
  }).catch(() => {});
  return reply.id;
}
