/**
 * In-memory limits for the messaging assistant (the API runs as one process,
 * like the executor's idempotency map). Pure apart from the clock, which is
 * injectable for the tests.
 */

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number, private clock: () => number = Date.now) {}

  /** Records a hit; false when the key is over its limit (the hit is not counted). */
  hit(key: string): boolean {
    const now = this.clock();
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.sweep(now);
    return true;
  }

  /** Seconds until the key may send again (0 when it may now). */
  retryAfter(key: string): number {
    const now = this.clock();
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (recent.length < this.limit) return 0;
    return Math.ceil((recent[0] + this.windowMs - now) / 1000);
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (!v.some(t => now - t < this.windowMs)) this.hits.delete(k);
  }
}

/** Remembers ids for a while — webhook retries / replays (Twilio MessageSid, Slack event_id). */
export class SeenIds {
  private seen = new Map<string, number>();
  constructor(private ttlMs: number, private clock: () => number = Date.now) {}

  /** True the first time an id is seen within the TTL; false for a repeat. */
  first(id: string): boolean {
    const now = this.clock();
    const at = this.seen.get(id);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.seen.set(id, now);
    if (this.seen.size > 10000) for (const [k, t] of this.seen) if (now - t >= this.ttlMs) this.seen.delete(k);
    return true;
  }
}

/** Longest message the assistant reads (a command or question, not a document). */
export const MAX_INBOUND_CHARS = 1000;
/** Per staff user, per channel. */
export const USER_LIMIT = { count: 20, windowMs: 10 * 60 * 1000 };
/** Per sender before identity is known (unknown numbers, bad link codes). */
export const SENDER_LIMIT = { count: 10, windowMs: 10 * 60 * 1000 };
/** How long a plan waits for "yes". */
export const PENDING_TTL_MS = 15 * 60 * 1000;
/** Turns of history kept per (channel, user) for the router. */
export const MAX_TURNS = 10;
