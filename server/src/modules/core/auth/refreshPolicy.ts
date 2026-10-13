/**
 * Pure decision logic for POST /auth/refresh — no Prisma, no Express, so the
 * rules that decide whether someone stays signed in are unit-testable
 * (tests/unit/refresh-policy.test.ts).
 *
 * Why this exists: rotation used to delete the presented token before the
 * client had stored its replacement. Any lost response — the Android app
 * frozen mid-request, a mobile data drop, axios timing out and retrying with
 * the old token — left the client holding a dead token, and its next refresh
 * logged the user out. Two mechanisms close that gap:
 *
 *  1. Client-proposed successor (idempotent rotation). New clients generate
 *     the next refresh token themselves, persist it as "pending" BEFORE
 *     sending, and send it as `next`. The server stores only its hash as the
 *     successor. A retry with the same (refresh, next) pair — seconds or days
 *     later — gets the same answer instead of a 401, because the requester
 *     proves it is the client that started the rotation. No time limit is
 *     needed: knowing `next` is the same as holding the successor token.
 *
 *  2. Short grace window for everything else (older app builds that don't
 *     send `next`, two tabs racing with different proposals). A rotated
 *     token presented within GRACE_MS of its rotation gets a fresh sibling
 *     token, at most MAX_GRACE_USES times. After that it is dead, so a
 *     rotated token that leaks is only useful for ~2 minutes.
 */

export type ClientType = 'web' | 'native';

export interface StoredRefreshToken {
  expiresAt: Date;
  rotatedAt: Date | null;
  replacedByHash: string | null;
  graceUses: number;
}

export interface SuccessorState {
  expiresAt: Date;
  rotatedAt: Date | null;
}

export type RefreshDecision =
  /** Live token: rotate it to a new successor. */
  | { action: 'rotate' }
  /** Retry of a rotation that already happened with this same `next`: hand back that successor. */
  | { action: 'replay' }
  /** Rotated recently: issue one more successor (bounded). */
  | { action: 'grace' }
  | { action: 'reject'; reason: 'Invalid refresh token' | 'Refresh token expired'; deleteRow?: boolean };

export const DEFAULT_GRACE_MS = 120_000;
export const DEFAULT_MAX_GRACE_USES = 5;

export function decideRefresh(
  stored: StoredRefreshToken | null,
  opts: {
    now: Date;
    /** sha256 of the client-proposed successor, when the client sent one */
    nextHash?: string | null;
    /** state of the row stored.replacedByHash points at (only looked up when nextHash matches) */
    successor?: SuccessorState | null;
    graceMs?: number;
    maxGraceUses?: number;
  },
): RefreshDecision {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const maxGraceUses = opts.maxGraceUses ?? DEFAULT_MAX_GRACE_USES;
  const now = opts.now.getTime();

  if (!stored) return { action: 'reject', reason: 'Invalid refresh token' };

  if (!stored.rotatedAt) {
    if (stored.expiresAt.getTime() < now) return { action: 'reject', reason: 'Refresh token expired', deleteRow: true };
    return { action: 'rotate' };
  }

  // Already rotated. Same proposal as the rotation that happened → the
  // client simply never saw the response. Valid while that successor is
  // itself still live (if it has since been rotated, the client DID move
  // on and this is a stale copy — fall through to the grace rules).
  if (
    opts.nextHash &&
    stored.replacedByHash === opts.nextHash &&
    opts.successor &&
    !opts.successor.rotatedAt &&
    opts.successor.expiresAt.getTime() > now
  ) {
    return { action: 'replay' };
  }

  if (now - stored.rotatedAt.getTime() <= graceMs && stored.graceUses < maxGraceUses) {
    return { action: 'grace' };
  }
  return { action: 'reject', reason: 'Invalid refresh token' };
}

/** X-Client request header → stored client type. Anything unrecognised is web. */
export function clientTypeFromHeader(value: unknown): ClientType {
  const v = String(Array.isArray(value) ? value[0] : value ?? '').toLowerCase();
  return v.startsWith('native') ? 'native' : 'web';
}

/**
 * Sliding refresh lifetime. The phone app is something people open a few
 * times a week — a 7-day window meant anyone who didn't open it for a week
 * had to sign in again, which reads as "the app keeps logging me out".
 */
export function refreshTtlDays(clientType: ClientType, env: Record<string, string | undefined> = process.env): number {
  const parse = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= 3650 ? n : fallback;
  };
  const web = parse(env.REFRESH_TTL_DAYS, 7);
  return clientType === 'native' ? parse(env.REFRESH_TTL_DAYS_NATIVE, 90) : web;
}

export function refreshExpiry(clientType: ClientType, now = new Date(), env: Record<string, string | undefined> = process.env): Date {
  return new Date(now.getTime() + refreshTtlDays(clientType, env) * 24 * 60 * 60 * 1000);
}

/**
 * A client-proposed successor must look like one we would have generated
 * ourselves: 64–256 hex chars (≥ 256 bits). Anything else is ignored and the
 * server generates the token, so a malformed client can never weaken it.
 */
export function isValidProposedToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64,256}$/i.test(value);
}

/** Rotated rows are kept this long for replay before the hourly purge drops them. */
export function rotatedRetentionMs(env: Record<string, string | undefined> = process.env): number {
  const hours = Number(env.REFRESH_ROTATED_RETENTION_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 72) * 60 * 60 * 1000;
}
