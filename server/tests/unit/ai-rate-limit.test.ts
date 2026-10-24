/**
 * Provider rate limits (utils/aiRateLimit.ts): reading Groq's 429s, deciding
 * whether a short wait is worth it, the user's message, and the in-process
 * tokens-per-minute pacer. All with fake errors and a fake clock — no
 * provider is called (real Groq limits are simulated, not hit).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProviderDuration, readRateLimit, rateLimitRetryDecision, rateLimitMessage, rateLimitResponse,
  TokenPacer, tpmLimitFor, estimateTokens, type RateLimitInfo,
} from '../../src/utils/aiRateLimit';

/** A Groq-shaped 429, as the OpenAI SDK (v4) surfaces it. */
function groq429(kind: 'TPM' | 'TPD' | 'RPD', wait: string, headers: Record<string, string> = {}) {
  const label = { TPM: 'tokens per minute (TPM)', TPD: 'tokens per day (TPD)', RPD: 'requests per day (RPD)' }[kind];
  const limit = kind === 'TPM' ? 8000 : kind === 'TPD' ? 200000 : 1000;
  const message = `429 Rate limit reached for model \`openai/gpt-oss-20b\` in organization \`org_x\` service tier \`on_demand\` on ${label}: Limit ${limit}, Used 6100, Requested 2600. Please try again in ${wait}. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing`;
  return Object.assign(new Error(message), { status: 429, headers, error: { message, type: 'tokens', code: 'rate_limit_exceeded' }, providerKey: 'groq' });
}

test('durations: Groq formats, bare seconds, junk', () => {
  assert.equal(parseProviderDuration('7.66s'), 7.66);
  assert.equal(parseProviderDuration('2m59.56s'), 179.56);
  assert.equal(parseProviderDuration('7h12m0s'), 25920);
  assert.equal(parseProviderDuration('250ms'), 0.25);
  assert.equal(parseProviderDuration('7'), 7);
  assert.equal(parseProviderDuration(' 12 '), 12);
  assert.equal(parseProviderDuration(''), null);
  assert.equal(parseProviderDuration(null), null);
  assert.equal(parseProviderDuration('soon'), null);
  assert.equal(parseProviderDuration('5 minutes'), null);
});

test('read: per-minute token limit — wait from the message, limit from the message', () => {
  const info = readRateLimit(groq429('TPM', '6.322s', { 'retry-after': '7', 'x-ratelimit-reset-tokens': '6.32s', 'x-ratelimit-limit-tokens': '8000' }))!;
  assert.deepEqual(info, { window: 'minute', unit: 'tokens', waitSec: 6.32, limit: 8000, provider: 'groq' });
});

test('read: per-day limits (TPD by message, RPD by message) are never "minute"', () => {
  const tpd = readRateLimit(groq429('TPD', '7h12m30s'))!;
  assert.equal(tpd.window, 'day'); assert.equal(tpd.unit, 'tokens'); assert.equal(tpd.waitSec, 25950);
  const rpd = readRateLimit(groq429('RPD', '2m59.56s'))!;
  assert.equal(rpd.window, 'day'); assert.equal(rpd.unit, 'requests'); assert.equal(rpd.waitSec, 179.56);
});

test('read: headers alone (no helpful message), plain record or fetch Headers', () => {
  const bare = (headers: any) => Object.assign(new Error('429 Too Many Requests'), { status: 429, headers });
  const day = readRateLimit(bare({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1h5m', 'retry-after': '3900' }))!;
  assert.equal(day.window, 'day'); assert.equal(day.waitSec, 3900);
  const minute = readRateLimit(bare(new Headers({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '12.5s', 'x-ratelimit-limit-tokens': '8000' })))!;
  assert.deepEqual([minute.window, minute.waitSec, minute.limit], ['minute', 12.5, 8000]);
  // Only retry-after: a long wait reads as a daily-type limit, a short one as per-minute.
  assert.equal(readRateLimit(bare({ 'retry-after': '600' }))!.window, 'day');
  assert.equal(readRateLimit(bare({ 'Retry-After': '4' }))!.window, 'minute');
  // Nothing at all: still a rate limit, nothing known.
  assert.deepEqual(readRateLimit(bare({})), { window: 'unknown', unit: null, waitSec: null, limit: null, provider: null });
});

test('read: not a rate limit → null (other statuses, OpenAI insufficient_quota)', () => {
  assert.equal(readRateLimit({ status: 500 }), null);
  assert.equal(readRateLimit(null), null);
  assert.equal(readRateLimit({ status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota' }), null);
  assert.equal(readRateLimit({ status: 429, error: { code: 'insufficient_quota' } }), null);
  // Already read by the gateway → reused as is.
  const pre: RateLimitInfo = { window: 'minute', unit: 'tokens', waitSec: 3, limit: 8000, provider: 'groq' };
  assert.equal(readRateLimit({ status: 429, rateLimit: pre }), pre);
});

test('decide: short per-minute wait → wait that long (+ jitter) and retry once', () => {
  const info = readRateLimit(groq429('TPM', '6.3s'));
  const d = rateLimitRetryDecision(info, { rateLimitRetries: 0, waitedMs: 0, jitterMs: 400 });
  assert.deepEqual(d, { retry: true, waitMs: 6700, reason: 'short wait' });
  assert.equal(rateLimitRetryDecision(info, { rateLimitRetries: 1, waitedMs: 6700 }).retry, false, 'only one retry');
});

test('decide: long waits, daily limits and a spent wait budget fail fast', () => {
  assert.equal(rateLimitRetryDecision(readRateLimit(groq429('TPM', '45s')), { rateLimitRetries: 0, waitedMs: 0 }).reason, 'wait too long');
  assert.equal(rateLimitRetryDecision(readRateLimit(groq429('TPD', '3.2s')), { rateLimitRetries: 0, waitedMs: 0 }).reason, 'daily limit');
  assert.equal(rateLimitRetryDecision(readRateLimit(groq429('TPM', '15s')), { rateLimitRetries: 0, waitedMs: 12_000, jitterMs: 0 }).reason, 'total wait budget spent');
  assert.equal(rateLimitRetryDecision(null, { rateLimitRetries: 0, waitedMs: 0 }).retry, false);
  // No reset time at all (some OpenAI-compatible servers): one short retry, as before.
  const unknown = rateLimitRetryDecision({ window: 'unknown', unit: null, waitSec: null, limit: null, provider: null }, { rateLimitRetries: 0, waitedMs: 0 });
  assert.deepEqual([unknown.retry, unknown.waitMs], [true, 2000]);
});

test('message: per-minute names the plan limit and the wait; per-day the reset time and the upgrade', () => {
  assert.equal(rateLimitMessage(readRateLimit(groq429('TPM', '6.3s'))!),
    'The AI is busy right now (your Groq plan allows 8,000 tokens per minute). Try again in ~7 seconds.');
  assert.equal(rateLimitMessage(readRateLimit(groq429('TPD', '7h12m30s'))!),
    'Today’s AI allowance on your Groq plan is used up. It resets in ~7 h 13 min. Upgrading the Groq plan (Developer tier) removes this limit.');
  assert.equal(rateLimitMessage(readRateLimit(groq429('RPD', '42m10s'))!),
    'Today’s AI allowance on your Groq plan is used up. It resets in ~43 min. Upgrading the Groq plan (Developer tier) removes this limit.');
  // Unknown provider / nothing known: generic, still useful, no internals.
  assert.equal(rateLimitMessage({ window: 'unknown', unit: null, waitSec: null, limit: null, provider: 'my-proxy' }), 'The AI is busy right now. Try again in a minute.');
  assert.equal(rateLimitMessage({ window: 'day', unit: 'tokens', waitSec: null, limit: null, provider: null }),
    'Today’s AI allowance on the AI provider’s plan is used up. It resets within a day. Upgrading the AI provider plan raises this limit.');
  const r = rateLimitResponse(readRateLimit(groq429('TPM', '6.3s'))!);
  assert.deepEqual([r.status, r.retryAfter, r.body.code, r.body.limitWindow, r.body.retryAfterSec], [429, 7, 'AI_RATE_LIMITED', 'minute', 7]);
  assert.ok(!/console\.groq|org_|gpt-oss/.test(r.body.error), 'no provider internals leak');
});

test('pacer: spaces calls to stay under the tokens-per-minute window, bounded and settle-able', () => {
  let now = 1_000_000;
  const p = new TokenPacer(8000, () => now);
  assert.equal(p.waitFor(3000), 0);
  const a = p.reserve(3000);
  now += 1000;
  assert.equal(p.waitFor(3000), 0);
  p.reserve(3000);
  now += 1000;
  // 6000 used; another 3000 must wait until the first reservation leaves the window.
  assert.equal(p.waitFor(3000), 58_000);
  // The first call really used only 1500 → room now.
  p.settle(a, 1500);
  assert.equal(p.waitFor(3000), 0);
  // A scheduled (future) reservation already counts for the next caller.
  const q = new TokenPacer(8000, () => now);
  q.reserve(5000); q.reserve(3000, 10_000);
  assert.ok(q.waitFor(3000) > 0);
  // The provider said "full for 9s": everyone waits that long.
  const b = new TokenPacer(8000, () => now);
  b.blockFor(9000);
  assert.equal(b.waitFor(10), 9000);
  // A request bigger than the whole limit only waits for an empty window.
  const c = new TokenPacer(8000, () => now);
  assert.equal(c.waitFor(9000), 0);
  // A rejected request (settled with null) frees its slot.
  const id = c.reserve(8000); assert.ok(c.waitFor(100) > 0); c.settle(id, null); assert.equal(c.waitFor(100), 0);
});

test('pacer limit: platform Groq key paced at 8000 by default, env overrides, tenant keys never', () => {
  const prev = process.env.AI_TPM_LIMIT;
  try {
    delete process.env.AI_TPM_LIMIT;
    assert.equal(tpmLimitFor({ providerKey: 'groq' }), 8000);
    assert.equal(tpmLimitFor({ providerKey: 'x', baseUrl: 'https://api.groq.com/openai/v1' }), 8000);
    assert.equal(tpmLimitFor({ providerKey: 'openai' }), 0);
    assert.equal(tpmLimitFor({ providerKey: 'groq', tenantSupplied: true }), 0);
    process.env.AI_TPM_LIMIT = '0';
    assert.equal(tpmLimitFor({ providerKey: 'groq' }), 0);
    process.env.AI_TPM_LIMIT = '30000';
    assert.equal(tpmLimitFor({ providerKey: 'openai' }), 30000);
  } finally {
    if (prev === undefined) delete process.env.AI_TPM_LIMIT; else process.env.AI_TPM_LIMIT = prev;
  }
  assert.equal(estimateTokens('x'.repeat(350)), 100);
  assert.equal(estimateTokens(700), 200);
});
