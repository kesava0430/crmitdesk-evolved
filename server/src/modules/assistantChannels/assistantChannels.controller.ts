/**
 * Staff assistant over WhatsApp / Slack — HTTP side.
 *  - Public, signature-verified Slack endpoints (events, /zen command).
 *    (WhatsApp arrives on the Inbox's existing Twilio webhook.)
 *  - Org settings: per-channel switches, Slack app credentials (encrypted).
 *  - "Me": the phone used for WhatsApp + verification code, Slack linking.
 * The assistant itself is utils/assistantChannels/core.ts.
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { encryptSecret } from '../../utils/crypto';
import { logAction } from '../../utils/auditLog';
import { getEffectiveLicense } from '../../utils/licensing';
import { loadSlackCfg, handleSlackEvents, handleSlackCommand, confirmSlackLink, type HttpReply } from '../../utils/assistantChannels/slack';
import { newLinkCode, hashCode, LINK_CODE_TTL_MS } from '../../utils/assistantChannels/identity';
import { toE164, phoneMatches, maskPhone } from '../../utils/assistantChannels/phone';
import { SlidingWindowLimiter } from '../../utils/assistantChannels/limits';

const linkLimiter = new SlidingWindowLimiter(5, 15 * 60 * 1000);

function headersOf(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

function rawBody(req: Request): Buffer {
  // index.ts mounts express.raw() for /api/channels/slack so the exact signed bytes arrive here.
  return Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
}

function send(res: Response, r: HttpReply) {
  res.status(r.status).json(r.body ?? {});
}

export async function slackEvents(req: Request, res: Response, next: NextFunction) {
  try { send(res, await handleSlackEvents(await loadSlackCfg(req.params.key), headersOf(req), rawBody(req))); } catch (err) { next(err); }
}

export async function slackCommand(req: Request, res: Response, next: NextFunction) {
  try { send(res, await handleSlackCommand(await loadSlackCfg(req.params.key), headersOf(req), rawBody(req))); } catch (err) { next(err); }
}

// ─── Settings (org) ─────────────────────────────────────────────────────────

/** Public API base for the request URLs shown to the owner — APP_URL, like the OAuth callbacks. */
function apiBase(): string {
  return `${(process.env.APP_URL || 'http://localhost:4000').replace(/\/+$/, '')}/api`;
}

async function ensureConfig(orgId: string) {
  const existing = await prisma.assistantChannelConfig.findUnique({ where: { orgId } });
  if (existing) return existing;
  return prisma.assistantChannelConfig.upsert({
    where: { orgId },
    create: { orgId, slackKey: crypto.randomBytes(18).toString('base64url') },
    update: {},
  });
}

function settingsView(cfg: Awaited<ReturnType<typeof ensureConfig>>, extra: Record<string, unknown>) {
  const base = apiBase();
  return {
    whatsappEnabled: cfg.whatsappEnabled,
    slackEnabled: cfg.slackEnabled,
    slackEmailMatch: cfg.slackEmailMatch,
    slackTeamId: cfg.slackTeamId,
    hasSlackBotToken: !!cfg.slackBotToken,
    hasSlackSigningSecret: !!cfg.slackSigningSecret,
    urls: {
      slackEvents: `${base}/channels/slack/${cfg.slackKey}/events`,
      slackCommands: `${base}/channels/slack/${cfg.slackKey}/commands`,
      whatsappWebhook: `${base}/inbox/whatsapp/webhook`,
    },
    ...extra,
  };
}

async function settingsExtra(orgId: string) {
  const [wa, lic, waLinks, slackLinks] = await Promise.all([
    prisma.whatsAppConfig.findUnique({ where: { orgId }, select: { phoneNumber: true } }),
    getEffectiveLicense(orgId),
    prisma.assistantWhatsAppLink.count({ where: { orgId, user: { isActive: true } } }),
    prisma.slackUserLink.count({ where: { orgId, user: { isActive: true } } }),
  ]);
  return {
    whatsappNumber: wa?.phoneNumber?.replace(/^whatsapp:/, '') ?? null,
    aiLicensed: lic.features.includes('ai_advanced'),
    linkedUsers: { whatsapp: waLinks, slack: slackLinks },
  };
}

export async function getSettings(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const cfg = await ensureConfig(orgId);
    res.json(settingsView(cfg, await settingsExtra(orgId)));
  } catch (err) { next(err); }
}

const SettingsSchema = z.object({
  whatsappEnabled: z.boolean().optional(),
  slackEnabled: z.boolean().optional(),
  slackEmailMatch: z.boolean().optional(),
  // Write-only secrets: omitted = keep, '' = clear.
  slackBotToken: z.string().trim().max(300).refine(v => v === '' || /^xoxb-[A-Za-z0-9-]+$/.test(v), 'A Slack bot token starts with xoxb-').optional(),
  slackSigningSecret: z.string().trim().max(200).refine(v => v === '' || /^[a-f0-9]{16,64}$/i.test(v), 'The signing secret is the hex string under Basic Information → App Credentials').optional(),
  // Clearing re-pins the workspace on the next signed request (moving the app to another workspace).
  resetSlackTeam: z.boolean().optional(),
});

export async function saveSettings(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const body = SettingsSchema.parse(req.body);
    const cfg = await ensureConfig(orgId);
    const data: Record<string, unknown> = {};
    if (body.whatsappEnabled !== undefined) data.whatsappEnabled = body.whatsappEnabled;
    if (body.slackEnabled !== undefined) data.slackEnabled = body.slackEnabled;
    if (body.slackEmailMatch !== undefined) data.slackEmailMatch = body.slackEmailMatch;
    if (body.slackBotToken !== undefined) data.slackBotToken = body.slackBotToken ? encryptSecret(body.slackBotToken) : null;
    if (body.slackSigningSecret !== undefined) data.slackSigningSecret = body.slackSigningSecret ? encryptSecret(body.slackSigningSecret) : null;
    if (body.resetSlackTeam) data.slackTeamId = null;

    const turningOnSlack = (body.slackEnabled ?? cfg.slackEnabled) === true;
    const willHaveToken = body.slackBotToken !== undefined ? !!body.slackBotToken : !!cfg.slackBotToken;
    const willHaveSecret = body.slackSigningSecret !== undefined ? !!body.slackSigningSecret : !!cfg.slackSigningSecret;
    if (turningOnSlack && (!willHaveToken || !willHaveSecret)) throw new AppError(400, 'Add the Slack bot token and signing secret before turning Slack on.');
    if (body.whatsappEnabled) {
      const wa = await prisma.whatsAppConfig.findUnique({ where: { orgId }, select: { id: true } });
      if (!wa) throw new AppError(400, 'Connect your WhatsApp number first (Inbox → Settings) — the assistant answers on that number.');
    }

    const updated = await prisma.assistantChannelConfig.update({ where: { id: cfg.id }, data });
    // Never put secrets in the audit row — just which settings changed.
    logAction(req.user!.id, 'UPDATE', 'ASSISTANT:CHANNEL_SETTINGS', cfg.id, {
      changed: Object.keys(data), whatsappEnabled: updated.whatsappEnabled, slackEnabled: updated.slackEnabled, slackEmailMatch: updated.slackEmailMatch,
    });
    res.json(settingsView(updated, await settingsExtra(orgId)));
  } catch (err) { next(err); }
}

// ─── Me ─────────────────────────────────────────────────────────────────────

export async function getMine(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id, orgId } = req.user!;
    const [user, waLink, slackLink, cfg, wa] = await Promise.all([
      prisma.user.findUnique({ where: { id }, select: { phone: true } }),
      prisma.assistantWhatsAppLink.findUnique({ where: { userId: id }, select: { phoneE164: true, verifiedAt: true } }),
      prisma.slackUserLink.findUnique({ where: { userId: id }, select: { slackTeamId: true, slackUserId: true, createdAt: true } }),
      prisma.assistantChannelConfig.findUnique({ where: { orgId }, select: { whatsappEnabled: true, slackEnabled: true } }),
      prisma.whatsAppConfig.findUnique({ where: { orgId }, select: { phoneNumber: true } }),
    ]);
    const phone = user?.phone ?? null;
    // A link only counts while the profile phone still matches it.
    const waVerified = !!waLink && phoneMatches(phone, waLink.phoneE164);
    res.json({
      whatsapp: {
        enabled: !!cfg?.whatsappEnabled && !!wa,
        profilePhone: phone,
        profilePhoneE164: toE164(phone),
        verified: waVerified,
        verifiedNumber: waVerified ? maskPhone(waLink!.phoneE164) : null,
        staleLink: !!waLink && !waVerified,
        assistantNumber: wa?.phoneNumber?.replace(/^whatsapp:/, '') ?? null,
      },
      slack: {
        enabled: !!cfg?.slackEnabled,
        linked: !!slackLink,
        slackUserId: slackLink?.slackUserId ?? null,
        linkedAt: slackLink?.createdAt ?? null,
      },
    });
  } catch (err) { next(err); }
}

export async function createWhatsAppCode(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id, orgId } = req.user!;
    const user = await prisma.user.findUnique({ where: { id }, select: { phone: true } });
    if (!user?.phone || user.phone.replace(/\D/g, '').length < 8) throw new AppError(400, 'Add your mobile number to your profile first (My Profile → Work & contact, or ask an admin).');
    if (!linkLimiter.hit(`wa-code:${id}`)) throw new AppError(429, 'Too many codes requested — wait a few minutes.');
    const code = newLinkCode('whatsapp');
    // One live code per person.
    await prisma.assistantLinkCode.updateMany({ where: { orgId, channel: 'whatsapp', userId: id, usedAt: null }, data: { usedAt: new Date() } });
    await prisma.assistantLinkCode.create({ data: { orgId, channel: 'whatsapp', userId: id, codeHash: hashCode(code), expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS) } });
    const wa = await prisma.whatsAppConfig.findUnique({ where: { orgId }, select: { phoneNumber: true } });
    res.json({ code, message: `zen link ${code}`, expiresInMinutes: Math.round(LINK_CODE_TTL_MS / 60000), sendTo: wa?.phoneNumber?.replace(/^whatsapp:/, '') ?? null });
  } catch (err) { next(err); }
}

export async function unlinkWhatsApp(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.assistantWhatsAppLink.deleteMany({ where: { userId: req.user!.id } });
    await prisma.assistantSession.deleteMany({ where: { userId: req.user!.id, channel: 'whatsapp' } });
    logAction(req.user!.id, 'DELETE', 'ASSISTANT:WHATSAPP_LINK', req.user!.id, { channel: 'whatsapp' });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

export async function confirmSlack(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { code } = z.object({ code: z.string().trim().min(6).max(12) }).parse(req.body);
    if (!linkLimiter.hit(`slack-confirm:${req.user!.id}`)) throw new AppError(429, 'Too many attempts — wait a few minutes and get a new code.');
    const r = await confirmSlackLink(req.user!, code);
    if (!r.ok) throw new AppError(400, r.message);
    res.json(r);
  } catch (err) { next(err); }
}

export async function unlinkSlack(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.slackUserLink.deleteMany({ where: { userId: req.user!.id } });
    await prisma.assistantSession.deleteMany({ where: { userId: req.user!.id, channel: 'slack' } });
    logAction(req.user!.id, 'DELETE', 'ASSISTANT:SLACK_LINK', req.user!.id, { channel: 'slack' });
    res.json({ ok: true });
  } catch (err) { next(err); }
}
