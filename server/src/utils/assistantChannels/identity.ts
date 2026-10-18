/**
 * Who sent this message? — maps a WhatsApp number or a Slack user to exactly
 * one active staff user of exactly one org, or to nobody.
 *
 * Rules (the pure pickers below are unit-tested):
 *  - WhatsApp: the org is the one whose Twilio number was messaged (the
 *    Inbox's own routing). The sender must have a VERIFIED link in that org
 *    (they sent a one-time code from this phone), the user must be active,
 *    and their profile phone must still be this number (changing the phone
 *    on the profile silently voids the link). Two verified users on one
 *    number → ambiguous → refused. Nothing from another org is ever looked at.
 *  - Slack: the org is the one whose Slack app signed the request (per-org
 *    signing secret + pinned workspace). The Slack user must be linked
 *    (code shown in Slack, confirmed in the app's Profile), or — only when
 *    the owner turned on email matching for their verified workspace — have
 *    a Slack email equal to exactly one active staff user's email.
 * Anything else gets a polite refusal and no data.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma';
import { phoneMatches, toE164 } from './phone';

export interface StaffUser { id: string; orgId: string; role: string; email: string; name: string }

export type SenderResult =
  | { ok: true; user: StaffUser }
  | { ok: false; reason: 'none' | 'ambiguous' | 'inactive' | 'unverified' | 'phone_changed' };

interface LinkCandidate {
  userId: string;
  orgId: string;
  phoneE164: string;
  user: { id: string; orgId: string | null; role: string; email: string; name: string; isActive: boolean; phone: string | null };
}

/** Pure: picks the one user a verified WhatsApp sender belongs to in `orgId`. */
export function pickWhatsAppSender(orgId: string, senderE164: string, links: LinkCandidate[], unverifiedStaff: Array<{ isActive: boolean }> = []): SenderResult {
  const sender = toE164(senderE164);
  if (!sender) return { ok: false, reason: 'none' };
  const mine = links.filter(l => l.orgId === orgId && l.user.orgId === orgId && l.phoneE164 === sender);
  const active = mine.filter(l => l.user.isActive);
  const valid = active.filter(l => phoneMatches(l.user.phone, sender));
  const ids = [...new Set(valid.map(l => l.userId))];
  if (ids.length === 1) {
    const u = valid[0].user;
    return { ok: true, user: { id: u.id, orgId, role: u.role, email: u.email, name: u.name } };
  }
  if (ids.length > 1) return { ok: false, reason: 'ambiguous' };
  if (active.length) return { ok: false, reason: 'phone_changed' };
  if (mine.length) return { ok: false, reason: 'inactive' };
  if (unverifiedStaff.some(u => u.isActive)) return { ok: false, reason: 'unverified' };
  return { ok: false, reason: 'none' };
}

export async function resolveWhatsAppSender(orgId: string, from: string): Promise<SenderResult> {
  const sender = toE164(from);
  if (!sender) return { ok: false, reason: 'none' };
  const links = await prisma.assistantWhatsAppLink.findMany({
    where: { orgId, phoneE164: sender },
    select: { userId: true, orgId: true, phoneE164: true, user: { select: { id: true, orgId: true, role: true, email: true, name: true, isActive: true, phone: true } } },
    take: 5,
  });
  let unverified: Array<{ isActive: boolean }> = [];
  if (!links.length) unverified = await staffWithPhone(orgId, sender);
  return pickWhatsAppSender(orgId, sender, links as LinkCandidate[], unverified);
}

/** Active users of the org whose profile phone is this number (for the "verify your number" hint and link codes). */
export async function staffWithPhone(orgId: string, senderE164: string): Promise<Array<{ id: string; isActive: boolean; phone: string | null }>> {
  // Profile phones are free text ("98765 43210", "+91-98765-43210"), so the
  // match is decided in phoneMatches, not SQL. Orgs are seat-sized; bounded.
  const rows = await prisma.user.findMany({
    where: { orgId, isActive: true, phone: { not: null } },
    select: { id: true, isActive: true, phone: true },
    take: 5000,
  });
  return rows.filter(r => phoneMatches(r.phone, senderE164));
}

interface SlackLinkCandidate {
  orgId: string;
  slackTeamId: string;
  slackUserId: string;
  user: { id: string; orgId: string | null; role: string; email: string; name: string; isActive: boolean };
}

/** Pure: a Slack identity → user, given the link row (if any) and email matches (if allowed). */
export function pickSlackSender(
  orgId: string, teamId: string, slackUserId: string,
  link: SlackLinkCandidate | null,
  emailMatches: Array<{ id: string; orgId: string | null; role: string; email: string; name: string; isActive: boolean }> | null,
): SenderResult {
  if (link) {
    if (link.orgId !== orgId || link.slackTeamId !== teamId || link.slackUserId !== slackUserId || link.user.orgId !== orgId) return { ok: false, reason: 'none' };
    if (!link.user.isActive) return { ok: false, reason: 'inactive' };
    const u = link.user;
    return { ok: true, user: { id: u.id, orgId, role: u.role, email: u.email, name: u.name } };
  }
  if (emailMatches) {
    const active = emailMatches.filter(u => u.isActive && u.orgId === orgId);
    if (active.length === 1) {
      const u = active[0];
      return { ok: true, user: { id: u.id, orgId, role: u.role, email: u.email, name: u.name } };
    }
    if (active.length > 1) return { ok: false, reason: 'ambiguous' };
  }
  return { ok: false, reason: 'unverified' };
}

export async function resolveSlackSender(
  cfg: { orgId: string; slackEmailMatch: boolean },
  teamId: string, slackUserId: string,
  lookupEmail: () => Promise<string | null>,
): Promise<SenderResult> {
  const link = await prisma.slackUserLink.findUnique({
    where: { slackTeamId_slackUserId: { slackTeamId: teamId, slackUserId } },
    select: { orgId: true, slackTeamId: true, slackUserId: true, user: { select: { id: true, orgId: true, role: true, email: true, name: true, isActive: true } } },
  });
  let emailMatches: SlackLinkCandidate['user'][] | null = null;
  if (!link && cfg.slackEmailMatch) {
    const email = (await lookupEmail().catch(() => null))?.trim().toLowerCase();
    if (email) {
      emailMatches = await prisma.user.findMany({
        where: { orgId: cfg.orgId, email: { equals: email, mode: 'insensitive' } },
        select: { id: true, orgId: true, role: true, email: true, name: true, isActive: true },
        take: 3,
      });
    }
  }
  return pickSlackSender(cfg.orgId, teamId, slackUserId, link as SlackLinkCandidate | null, emailMatches);
}

// ─── One-time link codes ─────────────────────────────────────────────────────

export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

/** 6 digits for WhatsApp (typed on a phone, and bound to one user + one number); 8 letters/digits for Slack. */
export function newLinkCode(channel: 'whatsapp' | 'slack'): string {
  if (channel === 'whatsapp') return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** "zen link 123456" / "link 123456" → "123456". */
export function parseLinkCommand(text: string): string | null {
  const m = String(text ?? '').trim().match(/^link\s+([A-Za-z0-9-]{6,12})$/i);
  return m ? m[1] : null;
}
