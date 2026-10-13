/**
 * Minimal, dependency-free reads of an access token's own claims. Never used
 * to trust anything (the server verifies every token) — only to decide
 * locally whether a token is worth sending or should be refreshed first,
 * instead of finding out from a 401 (or, for EventSource, never finding out:
 * it can't see HTTP status codes at all).
 */
function claims(token: string | null | undefined): { exp?: number; iat?: number } | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  } catch {
    return null;
  }
}

const SKEW_KEY = 'tokenClockSkew';

/**
 * Remembers how far this device's clock is from the server's, measured from
 * a token that was issued just now. Phones with a wrong clock would
 * otherwise see every token as already expired (refresh storm) or never
 * expiring (endless 401s on the SSE stream).
 */
export function recordClockSkew(freshToken: string) {
  const iat = claims(freshToken)?.iat;
  if (!iat) return;
  try { localStorage.setItem(SKEW_KEY, String(Date.now() - iat * 1000)); } catch { /* storage off */ }
}

function skewMs(): number {
  try {
    const n = Number(localStorage.getItem(SKEW_KEY));
    // Ignore absurd values (hand-edited, or a token whose iat was minted long
    // before we stored it) — better to assume a correct clock.
    return Number.isFinite(n) && Math.abs(n) < 30 * 24 * 60 * 60 * 1000 ? n : 0;
  } catch {
    return 0;
  }
}

/** Milliseconds until the token expires (negative once expired), or null if it can't be read. */
export function tokenRemainingMs(token: string | null | undefined): number | null {
  const exp = claims(token)?.exp;
  if (!exp) return null;
  return exp * 1000 - (Date.now() - skewMs());
}

/**
 * True when the token is expired or expires within `withinMs`. A token whose
 * expiry can't be read counts as NOT expiring: refreshing on "unknown" would
 * refresh before every single request; the server's 401 still covers it.
 */
export function tokenExpiresSoon(token: string | null | undefined, withinMs = 0): boolean {
  const left = tokenRemainingMs(token);
  return left !== null && left <= withinMs;
}
