/**
 * AI request errors, read once for every screen that calls the AI.
 *
 * The server answers a provider rate limit (Groq's free tier: tokens per
 * minute / per day for the whole account) with HTTP 429, code
 * AI_RATE_LIMITED, a sentence that already says when to try again, and
 * `retryAfterSec` — so a screen can offer "Try again" at the right moment
 * instead of a generic failure.
 */
export interface AiErrorInfo {
  message: string;
  rateLimited: boolean;
  /** 'minute' → wait seconds; 'day' → wait hours (don't offer a quick retry). */
  window: 'minute' | 'day' | 'unknown' | null;
  retryAfterSec: number | null;
}

export function aiErrorInfo(err: unknown, fallback = 'AI request failed.'): AiErrorInfo {
  const res = (err as any)?.response;
  const data = res?.data ?? {};
  const message: string = data.error || data.message || (err as any)?.message || fallback;
  if (res?.status === 429 && data.code === 'AI_RATE_LIMITED') {
    const sec = Number(data.retryAfterSec ?? res.headers?.['retry-after']);
    return { message, rateLimited: true, window: data.limitWindow ?? 'unknown', retryAfterSec: Number.isFinite(sec) && sec > 0 ? sec : null };
  }
  return { message, rateLimited: false, window: null, retryAfterSec: null };
}

/** A plain message (no rate limit) in the same shape — for "the AI couldn't do that" answers. */
export const aiMessage = (message: string): AiErrorInfo => ({ message, rateLimited: false, window: null, retryAfterSec: null });
