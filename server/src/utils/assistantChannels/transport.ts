/**
 * Outbound replies of the messaging assistant.
 *
 *  - WhatsApp: the existing utils/whatsapp.ts sendWhatsApp() — the org's own
 *    Twilio number from Inbox → Settings (the number the staff member wrote
 *    to). No second WhatsApp integration.
 *  - Slack: Web API chat.postMessage with the org's bot token (DMs), or the
 *    slash command's response_url (ephemeral, only the sender sees it).
 *
 * For local/end-to-end testing, ASSISTANT_OUTBOUND_CAPTURE=<file> (ignored in
 * production) appends every outbound message to a JSONL file instead of
 * calling Twilio/Slack, and tests can swap the transport entirely.
 */
import fs from 'node:fs';
import { sendWhatsApp } from '../whatsapp';

export interface OutboundMessage {
  channel: 'whatsapp' | 'slack';
  via: 'twilio' | 'slack.chat.postMessage' | 'slack.response_url';
  orgId: string;
  to: string;
  text: string;
  ephemeral?: boolean;
}

type Transport = (m: OutboundMessage & { botToken?: string }) => Promise<void>;
let override: Transport | null = null;

/** Tests: capture sends in memory. Pass null to restore the real transport. */
export function setOutboundTransport(fn: Transport | null) { override = fn; }

function captureFile(): string | null {
  if (process.env.NODE_ENV === 'production') return null;
  return process.env.ASSISTANT_OUTBOUND_CAPTURE || null;
}

function capture(m: OutboundMessage): boolean {
  const file = captureFile();
  if (!file) return false;
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...m }) + '\n');
  return true;
}

export async function sendWhatsAppReply(orgId: string, to: string, text: string): Promise<void> {
  const m: OutboundMessage = { channel: 'whatsapp', via: 'twilio', orgId, to, text };
  if (override) return override(m);
  if (capture(m)) return;
  await sendWhatsApp(orgId, to, text);
}

async function slackApi(botToken: string, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error ?? res.status}`);
  return json;
}

export async function slackPostMessage(orgId: string, botToken: string, channel: string, text: string): Promise<void> {
  const m: OutboundMessage = { channel: 'slack', via: 'slack.chat.postMessage', orgId, to: channel, text };
  if (override) return override({ ...m, botToken });
  if (capture(m)) return;
  await slackApi(botToken, 'chat.postMessage', { channel, text, mrkdwn: true, unfurl_links: false });
}

/** Only Slack's own hooks host — response_url comes in the (signed) request, but never let it point anywhere else. */
export function isSlackResponseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch { return false; }
}

export async function slackRespond(orgId: string, responseUrl: string, text: string): Promise<void> {
  if (!isSlackResponseUrl(responseUrl)) throw new Error('Refusing a response_url outside hooks.slack.com');
  const m: OutboundMessage = { channel: 'slack', via: 'slack.response_url', orgId, to: responseUrl, text, ephemeral: true };
  if (override) return override(m);
  if (capture(m)) return;
  const res = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text, mrkdwn: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Slack response_url failed: ${res.status}`);
}

/** users.info → the Slack profile email (needs users:read.email). Only used when the owner enabled email matching. */
export async function slackUserEmail(botToken: string, slackUserId: string): Promise<string | null> {
  if (captureFile()) {
    try { return JSON.parse(process.env.ASSISTANT_CAPTURE_SLACK_EMAILS || '{}')[slackUserId] ?? null; } catch { return null; }
  }
  const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await res.json().catch(() => ({}));
  return json?.ok ? (json.user?.profile?.email ?? null) : null;
}
