/**
 * Slack → assistant: Events API (direct messages to the app) and the /zen
 * slash command, for ONE org's own Slack app (its request URLs carry the
 * org's random slackKey; its signing secret verifies every request).
 *
 *  - Only direct messages (channel_type "im") and the slash command are
 *    answered — never a shared channel, where others would read the answer.
 *    Slash-command replies are ephemeral (only the sender sees them).
 *  - Slack wants a 200 within 3 seconds: events are acknowledged at once and
 *    answered with chat.postMessage; the slash command acknowledges with
 *    "Working on it…" and answers through its response_url.
 *  - Retries (X-Slack-Retry-Num) and replays are de-duplicated by event_id;
 *    requests older than 5 minutes fail the signature check.
 *  - The workspace (team_id) is pinned on the first signed request; any other
 *    workspace is refused.
 */
import { prisma } from '../prisma';
import { decryptSecretOrPlain } from '../crypto';
import { logAction } from '../auditLog';
import { handleStaffMessage } from './core';
import { resolveSlackSender, newLinkCode, hashCode, LINK_CODE_TTL_MS, type SenderResult } from './identity';
import { verifySlackRequest } from './signatures';
import { slackPostMessage, slackRespond, slackUserEmail } from './transport';
import { HELP_TEXT } from './format';
import { SeenIds, SlidingWindowLimiter, SENDER_LIMIT } from './limits';

const seenEvents = new SeenIds(60 * 60 * 1000);
const senderLimiter = new SlidingWindowLimiter(SENDER_LIMIT.count, SENDER_LIMIT.windowMs);

export interface SlackCfg {
  id: string;
  orgId: string;
  slackEnabled: boolean;
  slackBotToken: string | null;
  slackSigningSecret: string | null;
  slackTeamId: string | null;
  slackEmailMatch: boolean;
}

export interface HttpReply { status: number; body?: unknown; contentType?: string }

let lastWork: Promise<void> = Promise.resolve();
export function slackWorkSettled(): Promise<void> { return lastWork; }
function background(fn: () => Promise<void>) {
  lastWork = fn().catch(err => console.error('[assistant:slack] reply failed:', err?.message ?? err));
}

export async function loadSlackCfg(key: string): Promise<SlackCfg | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return null;
  return prisma.assistantChannelConfig.findUnique({
    where: { slackKey: key },
    select: { id: true, orgId: true, slackEnabled: true, slackBotToken: true, slackSigningSecret: true, slackTeamId: true, slackEmailMatch: true },
  });
}

function verify(cfg: SlackCfg, headers: Record<string, string | undefined>, raw: Buffer): boolean {
  const secret = cfg.slackSigningSecret ? decryptSecretOrPlain(cfg.slackSigningSecret) : null;
  const r = verifySlackRequest({ signingSecret: secret, timestamp: headers['x-slack-request-timestamp'], signature: headers['x-slack-signature'], rawBody: raw });
  if (!r.ok) console.warn(`[assistant:slack] rejected request for org ${cfg.orgId}: ${r.reason}`);
  return r.ok;
}

/** Pins the workspace on first use; false when the request is from another workspace. */
async function teamAllowed(cfg: SlackCfg, teamId: string | undefined): Promise<boolean> {
  if (!teamId) return false;
  if (cfg.slackTeamId) return cfg.slackTeamId === teamId;
  await prisma.assistantChannelConfig.updateMany({ where: { id: cfg.id, slackTeamId: null }, data: { slackTeamId: teamId } });
  const fresh = await prisma.assistantChannelConfig.findUnique({ where: { id: cfg.id }, select: { slackTeamId: true } });
  cfg.slackTeamId = fresh?.slackTeamId ?? teamId;
  return cfg.slackTeamId === teamId;
}

function refusalText(r: Exclude<SenderResult, { ok: true }>): string {
  if (r.reason === 'inactive') return 'Your Zenkara 360 account is deactivated, so the assistant can’t help.';
  if (r.reason === 'ambiguous') return 'Your Slack email matches more than one Zenkara 360 account. Link your account instead: type `link` here (or `/zen link`).';
  return 'I don’t know who you are in Zenkara 360 yet. Type `link` here (or `/zen link`) to get a code, then enter it in the app under My Profile → Connections → Slack.';
}

async function issueSlackCode(cfg: SlackCfg, teamId: string, slackUserId: string): Promise<string> {
  if (!senderLimiter.hit(`slack-code:${teamId}:${slackUserId}`)) return 'Too many link codes requested — wait a few minutes.';
  const code = newLinkCode('slack');
  await prisma.assistantLinkCode.create({
    data: { orgId: cfg.orgId, channel: 'slack', codeHash: hashCode(code), slackTeamId: teamId, slackUserId, expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS) },
  });
  return `Your link code is *${code}* (valid 15 minutes, only you can see it).\nOpen Zenkara 360 → My Profile → Connections → Slack, and enter it there.`;
}

async function answer(cfg: SlackCfg, teamId: string, slackUserId: string, text: string): Promise<string> {
  const trimmed = text.trim();
  if (/^link$/i.test(trimmed)) return issueSlackCode(cfg, teamId, slackUserId);
  const botToken = cfg.slackBotToken ? decryptSecretOrPlain(cfg.slackBotToken) : '';
  const who = await resolveSlackSender(cfg, teamId, slackUserId, () => (botToken ? slackUserEmail(botToken, slackUserId) : Promise.resolve(null)));
  if (!who.ok) {
    console.warn(`[assistant:slack] refused ${teamId}/${slackUserId} for org ${cfg.orgId}: ${who.reason}`);
    return refusalText(who);
  }
  return handleStaffMessage({ channel: 'slack', user: who.user, text: trimmed });
}

/** POST …/slack/:key/events — raw body (signature), JSON. */
export async function handleSlackEvents(cfg: SlackCfg | null, headers: Record<string, string | undefined>, raw: Buffer): Promise<HttpReply> {
  if (!cfg || !verify(cfg, headers, raw)) return { status: 401, body: { error: 'invalid signature' } };
  let payload: any;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { error: 'bad json' } }; }

  // Slack checks the Request URL when the owner saves it in the app config.
  if (payload?.type === 'url_verification') return { status: 200, body: { challenge: String(payload.challenge ?? '') } };
  if (payload?.type !== 'event_callback') return { status: 200, body: { ok: true } };

  if (!(await teamAllowed(cfg, payload.team_id))) return { status: 403, body: { error: 'workspace not allowed' } };
  if (payload.event_id && !seenEvents.first(`${cfg.orgId}:${payload.event_id}`)) return { status: 200, body: { ok: true, duplicate: true } };
  if (!cfg.slackEnabled || !cfg.slackBotToken) return { status: 200, body: { ok: true, disabled: true } };

  const ev = payload.event ?? {};
  // Direct messages from people only: never bots (incl. ourselves), edits, joins…
  if (ev.type !== 'message' || ev.channel_type !== 'im' || ev.bot_id || ev.subtype || !ev.user || typeof ev.text !== 'string') {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const botToken = decryptSecretOrPlain(cfg.slackBotToken);
  background(async () => {
    const text = await answer(cfg, payload.team_id, ev.user, ev.text);
    await slackPostMessage(cfg.orgId, botToken, ev.channel, text);
  });
  return { status: 200, body: { ok: true } };
}

/** POST …/slack/:key/commands — /zen <text>, form-encoded. */
export async function handleSlackCommand(cfg: SlackCfg | null, headers: Record<string, string | undefined>, raw: Buffer): Promise<HttpReply> {
  if (!cfg || !verify(cfg, headers, raw)) return { status: 401, body: { error: 'invalid signature' } };
  const form = new URLSearchParams(raw.toString('utf8'));
  const teamId = form.get('team_id') ?? undefined;
  const slackUserId = form.get('user_id') ?? '';
  const text = (form.get('text') ?? '').trim();
  const responseUrl = form.get('response_url') ?? '';
  if (!(await teamAllowed(cfg, teamId))) return { status: 403, body: { error: 'workspace not allowed' } };
  if (!cfg.slackEnabled) return { status: 200, body: { response_type: 'ephemeral', text: 'The Zenkara 360 assistant is turned off for your organisation.' } };
  if (!slackUserId) return { status: 200, body: { response_type: 'ephemeral', text: 'Missing user.' } };

  if (!text || /^help$/i.test(text)) return { status: 200, body: { response_type: 'ephemeral', text: HELP_TEXT('slack') } };
  if (/^link$/i.test(text)) return { status: 200, body: { response_type: 'ephemeral', text: await issueSlackCode(cfg, teamId!, slackUserId) } };

  background(async () => {
    const reply = await answer(cfg, teamId!, slackUserId, text);
    await slackRespond(cfg.orgId, responseUrl, reply);
  });
  return { status: 200, body: { response_type: 'ephemeral', text: 'Working on it…' } };
}

/** Profile → "Link my Slack account": the code typed in the app. */
export async function confirmSlackLink(user: { id: string; orgId: string }, code: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.assistantLinkCode.findFirst({
    where: { orgId: user.orgId, channel: 'slack', codeHash: hashCode(code), usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row?.slackTeamId || !row.slackUserId) return { ok: false, message: 'That code is wrong or has expired. Type `link` to the Zenkara 360 app in Slack for a new one.' };
  const other = await prisma.slackUserLink.findUnique({ where: { slackTeamId_slackUserId: { slackTeamId: row.slackTeamId, slackUserId: row.slackUserId } }, select: { userId: true } });
  if (other && other.userId !== user.id) return { ok: false, message: 'That Slack account is already linked to another Zenkara 360 user. They need to unlink it first.' };
  const claimed = await prisma.assistantLinkCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) return { ok: false, message: 'That code was already used.' };
  await prisma.slackUserLink.upsert({
    where: { userId: user.id },
    create: { orgId: user.orgId, userId: user.id, slackTeamId: row.slackTeamId, slackUserId: row.slackUserId },
    update: { orgId: user.orgId, slackTeamId: row.slackTeamId, slackUserId: row.slackUserId },
  });
  logAction(user.id, 'CREATE', 'ASSISTANT:SLACK_LINK', user.id, { channel: 'slack', slackTeamId: row.slackTeamId, slackUserId: row.slackUserId });
  return { ok: true, message: 'Slack account linked. Message the Zenkara 360 app in Slack, or use /zen.' };
}
