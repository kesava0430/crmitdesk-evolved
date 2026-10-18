/**
 * WhatsApp → assistant routing, called by the Inbox's Twilio webhook
 * (modules/inbox/inbox.controller.ts) AFTER its signature check and BEFORE
 * anything is written to the Inbox.
 *
 * The rule (safest that leaves the customer Inbox untouched):
 *  1. The org's switch "Allow staff to use the assistant over WhatsApp" is off
 *     → nothing changes, every message goes to the Inbox as before.
 *  2. A message whose first word is "zen" from a VERIFIED staff number of this
 *     org → the assistant. Also any message from that staff member while a
 *     plan/choice is waiting for their reply (so "yes", "2", "CONFIRM PAYROLL"
 *     work without the keyword; it expires after 15 minutes).
 *  3. "zen link 123456" → number verification (never stored in the Inbox,
 *     since it carries a code).
 *  4. Everything else — every customer, unverified numbers, staff writing
 *     without "zen" — goes to the Inbox exactly as before. An unknown number
 *     that writes "zen …" still lands in the Inbox; it also gets one polite
 *     refusal (at most every 10 minutes) and no data.
 * Assistant conversations are deliberately NOT put in the Inbox: every staff
 * member can read the Inbox, and answers can carry data only the asker may see.
 */
import { prisma } from '../prisma';
import { logAction } from '../auditLog';
import { handleStaffMessage } from './core';
import { resolveWhatsAppSender, hashCode, parseLinkCommand } from './identity';
import { hasLivePending } from './session';
import { parseAddressed } from './state';
import { phoneMatches, toE164, maskPhone } from './phone';
import { sendWhatsAppReply } from './transport';
import { SeenIds, SlidingWindowLimiter, SENDER_LIMIT } from './limits';

const seenSids = new SeenIds(24 * 60 * 60 * 1000);
const senderLimiter = new SlidingWindowLimiter(SENDER_LIMIT.count, SENDER_LIMIT.windowMs);
const refusalLimiter = new SlidingWindowLimiter(1, 10 * 60 * 1000);

export interface WhatsAppInbound { orgId: string; from: string; body: string; messageSid?: string }

/** Background work (replies) — tests can await it. */
let lastWork: Promise<void> = Promise.resolve();
export function whatsappWorkSettled(): Promise<void> { return lastWork; }

function background(fn: () => Promise<void>) {
  lastWork = fn().catch(err => console.error('[assistant:whatsapp] reply failed:', err?.message ?? err));
}

async function reply(orgId: string, to: string, text: string) {
  await sendWhatsAppReply(orgId, to, text);
}

/**
 * Returns true when the message was for the assistant (the caller must then
 * NOT write it to the Inbox); false to continue with the normal Inbox flow.
 */
export async function routeWhatsAppInbound(m: WhatsAppInbound): Promise<boolean> {
  const cfg = await prisma.assistantChannelConfig.findUnique({ where: { orgId: m.orgId }, select: { whatsappEnabled: true } }).catch(() => null);
  if (!cfg?.whatsappEnabled) return false;
  const sender = toE164(m.from);
  if (!sender) return false;

  const { addressed, rest } = parseAddressed(m.body);
  const who = await resolveWhatsAppSender(m.orgId, sender);

  if (!addressed) {
    // Only a verified staff member who owes the assistant a reply.
    if (!who.ok || !(await hasLivePending('whatsapp', who.user.id))) return false;
  }

  // Replays / Twilio retries: the Inbox de-dups by MessageSid; so do we.
  if (m.messageSid && !seenSids.first(`${m.orgId}:${m.messageSid}`)) return who.ok || !!parseLinkCommand(rest);

  const code = parseLinkCommand(rest);
  if (addressed && code) {
    if (!senderLimiter.hit(sender)) return true; // silently drop code-guessing floods
    background(async () => reply(m.orgId, sender, await verifyWhatsAppCode(m.orgId, sender, code)));
    return true;
  }

  if (!who.ok) {
    // Never reaches org data. Still the Inbox's message (could be a customer).
    if (refusalLimiter.hit(`${m.orgId}:${sender}`)) {
      const text = who.reason === 'unverified'
        ? 'To use the Zenkara 360 assistant from this number, verify it first: open the app → My Profile → Connections → WhatsApp assistant → Get code, then send “zen link <code>” here.'
        : who.reason === 'ambiguous'
          ? 'This number is linked to more than one account, so the assistant can’t tell who you are. Ask your administrator to fix the phone numbers on the accounts.'
          : 'Sorry — this number isn’t linked to a staff account, so the assistant can’t help here. Your message has been passed to the team.';
      background(() => reply(m.orgId, sender, text));
    }
    console.warn(`[assistant:whatsapp] refused ${maskPhone(sender)} for org ${m.orgId}: ${who.reason}`);
    return false;
  }

  const user = who.user;
  background(async () => {
    const text = await handleStaffMessage({ channel: 'whatsapp', user, text: addressed ? rest : m.body.trim() });
    await reply(m.orgId, sender, text);
  });
  return true;
}

/** "zen link 123456" from a phone: proves the sender holds the number on the code's user's profile. */
export async function verifyWhatsAppCode(orgId: string, sender: string, code: string): Promise<string> {
  const row = await prisma.assistantLinkCode.findFirst({
    where: { orgId, channel: 'whatsapp', codeHash: hashCode(code), usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  const user = row?.userId ? await prisma.user.findFirst({ where: { id: row.userId, orgId, isActive: true }, select: { id: true, name: true, phone: true } }) : null;
  if (!row || !user) return 'That code is wrong or has expired. Get a new one in the app: My Profile → Connections → WhatsApp assistant.';
  if (!phoneMatches(user.phone, sender)) {
    return 'This number doesn’t match the phone on your profile. Update your phone in the app (My Profile → Work & contact), then get a new code.';
  }
  // One verified number ↔ one active user: never make a sender ambiguous.
  const taken = await prisma.assistantWhatsAppLink.findFirst({
    where: { orgId, phoneE164: sender, userId: { not: user.id }, user: { isActive: true } }, select: { id: true },
  });
  if (taken) return 'This number is already verified for another account in your organisation. Ask your administrator.';
  const claimed = await prisma.assistantLinkCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) return 'That code was already used. Get a new one in the app.';
  await prisma.assistantWhatsAppLink.upsert({
    where: { userId: user.id },
    create: { orgId, userId: user.id, phoneE164: sender },
    update: { orgId, phoneE164: sender, verifiedAt: new Date() },
  });
  logAction(user.id, 'CREATE', 'ASSISTANT:WHATSAPP_LINK', user.id, { channel: 'whatsapp', phone: maskPhone(sender) });
  return `Verified, ${user.name.split(' ')[0]}. You can now message me here — start with “zen”, e.g. “zen how many tickets are open?”. I’ll always ask before changing anything.`;
}

