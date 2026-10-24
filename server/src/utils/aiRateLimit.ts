/**
 * Provider rate limits (Groq first) — reading them, deciding whether waiting
 * is worth it, telling the user, and spacing our own calls.
 *
 * Why this exists: Groq's free tier allows 8,000 tokens per minute for the
 * WHOLE account, and its per-request check counts prompt + max_tokens before
 * the model runs. The gateway used to retry a 429 after 2s and 4s — useless
 * against a one-minute window — and the user then read a generic "rate limit
 * or usage cap reached" with no idea whether to wait 5 seconds or until
 * tomorrow. Groq says exactly that in its 429: `retry-after`,
 * `x-ratelimit-reset-tokens` ("7.66s"), `x-ratelimit-reset-requests`
 * ("2m59.56s") and a message naming the limit ("tokens per minute (TPM)",
 * "tokens per day (TPD)", "requests per day (RPD)"). We now use it.
 *
 * Everything here is pure except the token pacer (in-process state) and is
 * unit-tested with fake errors (tests/unit/ai-rate-limit.test.ts).
 */

/** Rough token estimate for prompts (≈3.5 chars/token — conservative for JSON-heavy prompts; o200k measured 3.7). */
export function estimateTokens(text: string | number): number {
  const n = typeof text === 'number' ? text : text.length;
  return Math.ceil(n / 3.5);
}

// ─── Reading a 429 ──────────────────────────────────────────────────────────

/**
 * Groq/OpenAI duration strings → seconds: "7.66s", "2m59.56s", "1h2m3s",
 * "250ms", or a bare number of seconds ("7"). null when unreadable.
 */
export function parseProviderDuration(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0, matched = '', m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : m[2] === 'ms' ? n / 1000 : n;
    matched += m[0];
  }
  return matched && matched === s.replace(/\s+/g, '') ? total : null;
}

/** Header lookup that works for the SDK's plain record (v4) and a fetch Headers object. */
function header(err: any, name: string): string | null {
  const h = err?.headers ?? err?.response?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name) ?? null;
  const k = Object.keys(h).find(x => x.toLowerCase() === name);
  return k ? String(h[k]) : null;
}

export type RateLimitWindow = 'minute' | 'day' | 'unknown';

export interface RateLimitInfo {
  /** Which window ran out: per-minute (wait seconds) or per-day (wait hours). */
  window: RateLimitWindow;
  /** What is counted, when known. */
  unit: 'tokens' | 'requests' | null;
  /** Seconds until the provider says a retry can succeed, when known. */
  waitSec: number | null;
  /** The plan's limit for that window (e.g. 8000 tokens per minute), when known. */
  limit: number | null;
  /** Provider that answered (for the message: "your Groq plan"). */
  provider: string | null;
}

/**
 * A provider 429 → what ran out and for how long. null for anything that is
 * not a rate limit (including OpenAI's `insufficient_quota`, which is a
 * billing problem, not a window).
 */
export function readRateLimit(err: any): RateLimitInfo | null {
  if (!err || err.status !== 429) return null;
  if (err.rateLimit && typeof err.rateLimit === 'object') return err.rateLimit as RateLimitInfo;
  const code = String(err?.code ?? err?.error?.code ?? '');
  if (code === 'insufficient_quota') return null;
  const msg = String(err?.error?.message ?? err?.message ?? '');

  let window: RateLimitWindow = 'unknown';
  let unit: RateLimitInfo['unit'] = null;
  const named = /(tokens|requests) per (minute|day)\s*\((TPM|TPD|RPM|RPD)\)/i.exec(msg) ?? /\((TPM|TPD|RPM|RPD)\)/i.exec(msg);
  if (named) {
    const abbr = (named[3] ?? named[1]).toUpperCase();
    window = abbr.endsWith('D') ? 'day' : 'minute';
    unit = abbr.startsWith('T') ? 'tokens' : 'requests';
  } else if (/per day|daily/i.test(msg)) window = 'day';
  else if (/per minute/i.test(msg)) window = 'minute';

  const limitM = /Limit\s+(\d+)/i.exec(msg);
  let limit = limitM ? Number(limitM[1]) : null;

  // "Please try again in 7m12.5s" names the wait for the limit that was hit.
  const inMsg = /try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(msg);
  let waitSec = inMsg ? parseProviderDuration(inMsg[1]) : null;
  const retryAfter = parseProviderDuration(header(err, 'retry-after'));
  const resetTokens = parseProviderDuration(header(err, 'x-ratelimit-reset-tokens'));
  const resetRequests = parseProviderDuration(header(err, 'x-ratelimit-reset-requests'));

  if (window === 'unknown') {
    // Groq: the *-requests headers track requests per DAY, *-tokens per MINUTE.
    if (header(err, 'x-ratelimit-remaining-requests') === '0') { window = 'day'; unit = 'requests'; }
    else if (header(err, 'x-ratelimit-remaining-tokens') === '0') { window = 'minute'; unit = 'tokens'; }
  }
  if (waitSec == null) waitSec = retryAfter
    ?? (window === 'day' ? resetRequests : window === 'minute' ? resetTokens : null)
    ?? null;
  if (window === 'unknown' && waitSec != null) window = waitSec > 120 ? 'day' : 'minute';
  if (limit == null && (unit === 'tokens' || window === 'minute')) {
    const h = Number(header(err, 'x-ratelimit-limit-tokens'));
    if (Number.isFinite(h) && h > 0) { limit = h; unit = unit ?? 'tokens'; }
  }
  const provider = err.providerKey ?? (/groq/i.test(msg) ? 'groq' : null);
  return { window, unit, waitSec: waitSec != null ? Math.round(waitSec * 100) / 100 : null, limit, provider };
}

// ─── Deciding whether to wait ───────────────────────────────────────────────

/** Longest single wait worth holding an interactive request for. */
export const MAX_RETRY_WAIT_SEC = Number(process.env.AI_RATE_LIMIT_MAX_WAIT_SEC ?? 20);
/** Ceiling on all rate-limit waiting within one call. */
export const MAX_TOTAL_WAIT_MS = Number(process.env.AI_RATE_LIMIT_MAX_TOTAL_WAIT_MS ?? 25_000);

export interface RetryDecision { retry: boolean; waitMs: number; reason: string }

/**
 * After a 429: wait and retry once when the provider's window frees up soon
 * (≤ ~20s); otherwise fail fast so the user hears "try again in ~X" now
 * instead of watching a spinner for a minute. Per-day limits never retry.
 */
export function rateLimitRetryDecision(
  info: RateLimitInfo | null, opts: { rateLimitRetries: number; waitedMs: number; jitterMs?: number },
): RetryDecision {
  if (!info) return { retry: false, waitMs: 0, reason: 'not a rate limit' };
  if (info.window === 'day') return { retry: false, waitMs: 0, reason: 'daily limit' };
  if (opts.rateLimitRetries >= 1) return { retry: false, waitMs: 0, reason: 'already retried once' };
  const jitter = opts.jitterMs ?? Math.round(250 + Math.random() * 500);
  // No reset time given (some OpenAI-compatible servers): one short retry, as before.
  const waitMs = info.waitSec == null ? 2000 : Math.ceil(info.waitSec * 1000) + jitter;
  if (info.waitSec != null && info.waitSec > MAX_RETRY_WAIT_SEC) return { retry: false, waitMs: 0, reason: 'wait too long' };
  if (opts.waitedMs + waitMs > MAX_TOTAL_WAIT_MS) return { retry: false, waitMs: 0, reason: 'total wait budget spent' };
  return { retry: true, waitMs, reason: 'short wait' };
}

// ─── Telling the user ───────────────────────────────────────────────────────

function humanWait(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.ceil(sec))} seconds`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} min`;
  const h = Math.floor(sec / 3600), m = Math.ceil((sec % 3600) / 60);
  return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h`;
}

/** Provider name for the message ("Groq"); null keeps it generic. */
function providerName(p: string | null): string | null {
  if (!p) return null;
  if (/groq/i.test(p)) return 'Groq';
  if (/openai/i.test(p)) return 'OpenAI';
  return null;
}

/**
 * The sentence the user reads. Names the plan's limit and the wait when the
 * provider told us, and nothing else about the provider's internals.
 */
export function rateLimitMessage(info: RateLimitInfo): string {
  const name = providerName(info.provider);
  const plan = name ? `your ${name} plan` : 'the AI provider’s plan';
  if (info.window === 'day') {
    const resets = info.waitSec != null ? ` It resets in ~${humanWait(info.waitSec)}.` : ' It resets within a day.';
    const upgrade = name === 'Groq' ? ' Upgrading the Groq plan (Developer tier) removes this limit.' : ' Upgrading the AI provider plan raises this limit.';
    return `Today’s AI allowance on ${plan} is used up.${resets}${upgrade}`;
  }
  const allows = info.limit ? ` (${plan} allows ${info.limit.toLocaleString('en-US')} ${info.unit === 'requests' ? 'requests' : 'tokens'} per minute)` : '';
  const when = info.waitSec != null ? `Try again in ~${humanWait(info.waitSec)}.` : 'Try again in a minute.';
  return `The AI is busy right now${allows}. ${when}`;
}

/** JSON body + Retry-After for an API response to a provider rate limit. */
export function rateLimitResponse(info: RateLimitInfo): { status: 429; retryAfter: number | null; body: { error: string; code: 'AI_RATE_LIMITED'; limitWindow: RateLimitWindow; retryAfterSec: number | null } } {
  const retryAfter = info.waitSec != null ? Math.max(1, Math.ceil(info.waitSec)) : null;
  return { status: 429, retryAfter, body: { error: rateLimitMessage(info), code: 'AI_RATE_LIMITED', limitWindow: info.window, retryAfterSec: retryAfter } };
}

// ─── Pacing our own calls (in-process) ──────────────────────────────────────

/**
 * Tokens-per-minute pacer for one provider key. Groq's limit is per ACCOUNT
 * (i.e. per API key), so the platform key is one shared window for every org
 * on this server: two dashboard builds in the same minute would otherwise
 * both be sent and the second rejected. Here the second waits a few seconds
 * for the window instead. Bounded: a call never waits longer than
 * `maxWaitMs`; past that it is sent anyway and the provider decides (and the
 * user gets the "try again in ~X" message if it says no).
 *
 * In-process only: with N API instances the account can still see N × the
 * limit. That is acceptable — the provider's 429 handling above is the real
 * guard; this only smooths bursts on one instance.
 */
export class TokenPacer {
  private entries: Array<{ at: number; tokens: number; id: number }> = [];
  private blockedUntil = 0;
  private seq = 0;
  constructor(public limitPerMinute: number, private now: () => number = Date.now) {}

  private prune(t: number) { this.entries = this.entries.filter(e => t - e.at < 60_000); }
  private used(t: number) { this.prune(t); return this.entries.reduce((s, e) => s + e.tokens, 0); }

  /** ms to wait before `tokens` fit in the rolling minute (0 = now). */
  waitFor(tokens: number): number {
    const t = this.now();
    const blocked = Math.max(0, this.blockedUntil - t);
    if (this.limitPerMinute <= 0) return blocked;
    const need = Math.min(tokens, this.limitPerMinute); // a request bigger than the limit can only wait for an empty window
    let used = this.used(t);
    if (used + need <= this.limitPerMinute) return blocked;
    for (const e of [...this.entries].sort((a, b) => a.at - b.at)) {
      used -= e.tokens;
      if (used + need <= this.limitPerMinute) return Math.max(blocked, e.at + 60_000 - t);
    }
    return Math.max(blocked, 60_000);
  }

  /**
   * Records a request `delayMs` from now (the wait waitFor() returned), so a
   * concurrent caller already sees this slot as taken; returns an id to
   * settle with the real usage later.
   */
  reserve(tokens: number, delayMs = 0): number {
    const id = ++this.seq;
    this.entries.push({ at: this.now() + Math.max(0, delayMs), tokens, id });
    return id;
  }

  /** Replace a reservation (prompt + max_tokens) by what the provider actually counted. */
  settle(id: number, actualTokens: number | null) {
    const e = this.entries.find(x => x.id === id);
    if (!e) return;
    if (actualTokens == null || !Number.isFinite(actualTokens) || actualTokens <= 0) this.entries = this.entries.filter(x => x !== e);
    else e.tokens = actualTokens;
  }

  /** The provider said the window is full: hold new calls until it resets. */
  blockFor(ms: number) { this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms); }
}

const pacers = new Map<string, TokenPacer>();

/**
 * TPM to pace a provider at: AI_TPM_LIMIT when set (0 = off), else 8000 for
 * the platform's Groq key (the free tier), else off. Never for an org's own
 * key — their plan is theirs, and the provider's 429 still protects them.
 */
export function tpmLimitFor(m: { providerKey: string; baseUrl?: string; tenantSupplied?: boolean }): number {
  if (m.tenantSupplied) return 0;
  const env = process.env.AI_TPM_LIMIT;
  if (env !== undefined && env !== '') return Math.max(0, Number(env) || 0);
  return m.providerKey === 'groq' || /groq\.com/i.test(m.baseUrl ?? '') ? 8000 : 0;
}

export function pacerFor(key: string, limit: number): TokenPacer | null {
  if (limit <= 0) return null;
  let p = pacers.get(key);
  if (!p) { p = new TokenPacer(limit); pacers.set(key, p); }
  p.limitPerMinute = limit;
  return p;
}

/** Longest we hold a call to stay under our own pacer. */
export const MAX_PACE_WAIT_MS = Number(process.env.AI_TPM_MAX_WAIT_MS ?? 15_000);
