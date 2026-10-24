/**
 * "Is AI working on this server, and if not, why?"
 *
 * Every AI feature used to fail quietly when the provider wasn't set up or
 * couldn't be reached: utils/ai.ts returns an empty answer when no key is
 * configured, and a network failure surfaced as a generic 500. After the move
 * from Render to EC2 that made "all AI is broken" impossible to diagnose from
 * inside the app. This module gives one honest answer — configured or not,
 * and the result of a real (tiny) call to the provider with a plain-language
 * fix — for the AI Governance page and for the per-request guard.
 */
import OpenAI from 'openai';
import { readRateLimit, rateLimitMessage } from './aiRateLimit';
import { prisma } from './prisma';
import { resolveModels, isGatewayConfigured, openAiTarget } from './aiGateway';

export type AiConfigSource = 'env' | 'database' | 'none';

let dbProviderCache: { at: number; has: boolean } | null = null;

/** Whether an active provider with a key exists in the AiProvider table.
    Cached for a minute — this runs in front of every AI request. */
async function hasDbProvider(): Promise<boolean> {
  if (dbProviderCache && Date.now() - dbProviderCache.at < 60_000) return dbProviderCache.has;
  let has = false;
  try {
    has = (await prisma.aiProvider.count({ where: { isActive: true, apiKeyEncrypted: { not: null } } })) > 0;
  } catch { /* table missing or DB hiccup: treat as none */ }
  dbProviderCache = { at: Date.now(), has };
  return has;
}

export async function aiConfigSource(): Promise<AiConfigSource> {
  if (isGatewayConfigured()) return 'env';
  return (await hasDbProvider()) ? 'database' : 'none';
}

/** The message shown when no provider is configured at all. */
export const AI_NOT_CONFIGURED_MESSAGE =
  'AI is not set up on this server: no GROQ_API_KEY (or OPENAI_API_KEY) is configured. ' +
  'An administrator needs to add it to the server environment and restart the API.';

export interface AiConnectionTest {
  ok: boolean;
  source: AiConfigSource;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  /** HTTP status from the provider, when it answered. */
  httpStatus: number | null;
  error: string | null;
  /** Plain-language next step for an administrator. */
  hint: string | null;
}

/** Classifies a provider/network error into a short explanation + fix. */
export function explainAiError(err: any, provider: string | null): { error: string; hint: string } {
  const where = provider === 'groq' ? 'api.groq.com' : 'the AI provider';
  const keyVar = provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
  const status = err?.status;
  const name = String(err?.name || err?.constructor?.name || '');
  const code = String(err?.code || err?.cause?.code || '');

  if (/Timeout/i.test(name) || code === 'ETIMEDOUT') {
    return { error: `Timed out connecting to ${where}.`, hint: `The server could not reach ${where} in time. Check that the EC2 instance has outbound internet access on port 443 (security group / network ACL / NAT) and that DNS works.` };
  }
  if (/Connection/i.test(name) || ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN'].includes(code)) {
    return { error: `Could not connect to ${where}${code ? ` (${code})` : ''}.`, hint: `The server has no route to ${where}. Check outbound internet access from the EC2 instance (security group egress, NAT gateway for a private subnet, any proxy) and DNS resolution.` };
  }
  if (status === 401 || status === 403) {
    return { error: `${where} rejected the API key (HTTP ${status}).`, hint: `${keyVar} is wrong, revoked or has stray spaces/quotes. Create a new key${provider === 'groq' ? ' at console.groq.com/keys' : ''}, put it in the server .env, and restart the API.` };
  }
  if (status === 404) {
    return { error: `The model was not found (HTTP 404).`, hint: 'The configured model name is retired or misspelled. Set AI_MODEL_FAST / AI_MODEL_SMART to current model names (Groq: openai/gpt-oss-20b and openai/gpt-oss-120b) and restart the API.' };
  }
  if (status === 429) {
    // Name the window (per minute vs per day) and the reset time the provider gave.
    const info = readRateLimit({ ...err, status: 429, message: err?.message, error: err?.error, headers: err?.headers, providerKey: err?.providerKey ?? provider });
    if (info && info.window !== 'unknown') return { error: `Rate limit reached (HTTP 429, ${info.window === 'day' ? 'daily' : 'per-minute'} limit).`, hint: rateLimitMessage(info) };
    return { error: 'Rate limit or usage cap reached (HTTP 429).', hint: 'Usually clears within a minute. If it persists, check usage and plan limits in the provider console.' };
  }
  if (typeof status === 'number' && status >= 500) {
    return { error: `${where} had a server error (HTTP ${status}).`, hint: 'A temporary problem on the provider side — try again shortly.' };
  }
  return { error: String(err?.message || err || 'Unknown error').slice(0, 300), hint: 'Check the API logs: sudo journalctl -u zenkara-crm-api -n 200' };
}

/**
 * Makes one tiny completion against the provider this org would actually
 * use (its own key first, then the platform's), with a short timeout.
 * Not logged or budgeted — it is a health check, not a feature.
 */
export async function testAiConnection(orgId: string): Promise<AiConnectionTest> {
  const source = await aiConfigSource();
  if (source === 'none') {
    return {
      ok: false, source, provider: null, model: null, latencyMs: null, httpStatus: null,
      error: 'No AI provider is configured on this server.',
      hint: 'Add GROQ_API_KEY=<your key> to /opt/zenkara-crm/server/.env on the EC2 instance, then run: sudo systemctl restart zenkara-crm-api',
    };
  }

  const candidates = await resolveModels(orgId, 'FAST').catch(() => []);
  const m = candidates[0];
  if (!m) {
    return {
      ok: false, source, provider: null, model: null, latencyMs: null, httpStatus: null,
      error: 'A provider is configured, but none of its keys could be read.',
      hint: 'If the key was saved in AI settings, the server ENCRYPTION_KEY may have changed since then (for example after a server move). Re-enter the key, or set GROQ_API_KEY in the server .env.',
    };
  }

  const started = Date.now();
  try {
    const client = new OpenAI({ apiKey: m.apiKey, ...openAiTarget(m), timeout: 15_000, maxRetries: 0 });
    await client.chat.completions.create({
      model: m.model,
      messages: [{ role: 'user', content: 'Reply with the word ok.' }],
      max_tokens: 20,
      temperature: 0,
    });
    return { ok: true, source, provider: m.providerKey, model: m.model, latencyMs: Date.now() - started, httpStatus: 200, error: null, hint: null };
  } catch (err: any) {
    const { error, hint } = explainAiError(err, m.providerKey);
    return {
      ok: false, source, provider: m.providerKey, model: m.model, latencyMs: Date.now() - started,
      httpStatus: typeof err?.status === 'number' ? err.status : null, error, hint,
    };
  }
}
