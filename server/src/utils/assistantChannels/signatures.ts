/**
 * Webhook signature checks — pure and unit-tested.
 *
 *  - Twilio (WhatsApp): HMAC-SHA1 over the full request URL with every POST
 *    parameter appended in alphabetical order, keyed by the account's auth
 *    token, base64. https://www.twilio.com/docs/usage/security#validating-signatures
 *    Twilio signs no timestamp, so replays are stopped by MessageSid de-dup
 *    (the Inbox already did this; the assistant does too).
 *  - Slack: `v0=` + HMAC-SHA256 of `v0:<timestamp>:<raw body>` keyed by the
 *    app's signing secret; requests older than 5 minutes are refused (replay).
 *    https://api.slack.com/authentication/verifying-requests-from-slack
 */
import crypto from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  // Length check first: timingSafeEqual throws on a length mismatch.
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function twilioSignature(url: string, params: Record<string, unknown>, authToken: string): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + String(params[k] ?? ''), url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function verifyTwilioSignature(signature: string | undefined | null, url: string, params: Record<string, unknown>, authToken: string): boolean {
  if (!signature || !authToken) return false;
  try { return safeEqual(twilioSignature(url, params, authToken), signature); } catch { return false; }
}

export const SLACK_MAX_SKEW_SECONDS = 5 * 60;

export function slackSignature(signingSecret: string, timestamp: string | number, rawBody: string | Buffer): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  return `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

export type SlackVerify = { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'mismatch' };

export function verifySlackRequest(input: {
  signingSecret: string | null | undefined;
  timestamp: string | undefined | null;
  signature: string | undefined | null;
  rawBody: string | Buffer;
  now?: number;
}): SlackVerify {
  const { signingSecret, timestamp, signature } = input;
  if (!signingSecret || !timestamp || !signature) return { ok: false, reason: 'missing' };
  const ts = Number(timestamp);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SLACK_MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };
  try {
    return safeEqual(slackSignature(signingSecret, timestamp, input.rawBody), signature) ? { ok: true } : { ok: false, reason: 'mismatch' };
  } catch { return { ok: false, reason: 'mismatch' }; }
}
