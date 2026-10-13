import axios from 'axios';
import { addToast } from '../shared/components/toastStore';
import { getAuthItem, setAuthItems, clearAuthItems } from './authStorage';
import { recordClockSkew, tokenExpiresSoon } from './jwt';
import { clientHeader } from '../native/platform';

// VITE_API_URL is where the API lives. Production builds set it to
// /zenkara/api (nginx proxies that to the Node server on the same host — see
// .github/workflows/deploy.yml); '/api' is the local dev default.
// 60s timeout: generous for slow mobile networks and large uploads, short
// enough that a genuinely hung request eventually fails instead of spinning
// forever.
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api', timeout: 60_000 });

// Extra per-request flags understood by the interceptors below.
declare module 'axios' {
  interface AxiosRequestConfig {
    /** Never try a token refresh / forced sign-out for this request (sign-out's own calls). */
    _skipAuthRefresh?: boolean;
    /** Don't raise an error toast for this request. */
    _silent?: boolean;
    _retry?: boolean;
  }
}

// Endpoints that ARE the session machinery (or are called without one). A
// 401 from these is an answer to show, not a reason to refresh or sign out.
const AUTH_ENDPOINTS = [
  '/auth/login', '/auth/refresh', '/auth/logout', '/auth/google', '/auth/demo-login',
  '/auth/accept-invite', '/auth/sso/exchange', '/auth/reset-password', '/auth/forgot-password',
];
const isAuthEndpoint = (url: string | undefined) => !!url && AUTH_ENDPOINTS.some(e => url.includes(e));

api.interceptors.request.use(async (config) => {
  // The app identifies itself so the server gives it the long-lived native
  // session (see native/platform.ts). Browsers send nothing new.
  if (clientHeader) config.headers['X-Client'] = clientHeader;

  if (!config.headers.Authorization) {
    let token = getAuthItem('accessToken');
    // Refresh BEFORE sending when the token is already expired (judged by
    // its own exp claim) — e.g. the app coming back after hours in the
    // background. Without this every screen's first wave of requests all
    // 401 together and the interceptor has to untangle them.
    if (token && !config._skipAuthRefresh && !isAuthEndpoint(config.url) && tokenExpiresSoon(token, 5_000)) {
      token = (await ensureFreshToken()) ?? getAuthItem('accessToken');
    }
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// A "transient" failure is the server being briefly unreachable — no HTTP
// response at all (network error / timeout), or a gateway status nginx
// returns while the app restarts during a deploy (502/503/504). These are NOT
// authentication failures: a login or refresh that hits one should be
// retried, and must never be reported to the user as "invalid credentials"
// or treated as an expired session.
export function isTransientError(err: any): boolean {
  if (!err?.response) return true;                       // network error / timeout
  const s = err.response.status;
  return s === 502 || s === 503 || s === 504;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * POST an auth endpoint (login / refresh) with a couple of automatic retries
 * on transient failures, so a deploy restart shows up as "took a few
 * seconds" rather than a spurious failure. Real 4xx (bad credentials,
 * invalid refresh token) are returned immediately — they are not retried.
 */
export async function authPost(url: string, body: any, retries = 2, timeout?: number): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await api.post(url, body, timeout ? { timeout } : undefined);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === retries) throw err;
      await sleep(1500 * (attempt + 1)); // 1.5s, then 3s
    }
  }
  throw lastErr;
}

// ─── Token refresh ──────────────────────────────────────────────────────────
//
// The refresh endpoint rotates the refresh token. Everything below exists so
// that a rotation can never strand the client with a dead token — which is
// what produced the "app logs me out at random" reports:
//
// * Single flight per tab. A dashboard fires many requests at once; if the
//   access token expired right then, every one of them used to start its
//   own refresh with the same token, and the losers logged the user out.
//
// * Idempotent rotation. Before sending, the client generates the successor
//   token itself and persists it as `pendingRefresh` (durably, on native).
//   The server stores only its hash as the successor. If the response is
//   lost — app frozen or killed mid-request, data drop, timeout — the retry
//   sends the same (refresh, next) pair and gets the same answer instead of
//   a 401. Other tabs that start a refresh meanwhile reuse the same pending
//   proposal, so they converge on one token.
//
// * Tokens are committed to storage BEFORE the shared promise is released,
//   so a request queued behind the refresh never reads the old token.
//
// * A refresh only ends the session on a definitive 401, after re-reading
//   storage (another tab may have rotated meanwhile) and trying the pending
//   proposal on its own (the old row may have been purged after a long
//   pause). Network errors, timeouts and 5xx keep the session.

/** Thrown inside the refresh flow when the session is definitively over. */
class SessionEndedError extends Error {}

let refreshPromise: Promise<string> | null = null;
let loggedOutFromExpiry = false;
// Set by ensureFreshToken() when the last refresh attempt proved the session
// is over. A transient failure leaves it false so the user stays signed in.
let refreshWasUnauthorized = false;

// AuthContext mirrors background refreshes into its React state through this.
let tokenListener: ((token: string) => void) | null = null;
export function onAccessTokenRefreshed(cb: (token: string) => void) {
  tokenListener = cb;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const REFRESH_TIMEOUT_MS = 20_000;

// Bumped by signOutLocally(). A refresh that was already in flight when the
// user signed out must not write its tokens back afterwards (resurrecting a
// session in storage that the UI and the server consider gone).
let sessionEpoch = 0;

/** Called by AuthContext.logout before it clears storage. */
export function signOutLocally() {
  sessionEpoch++;
}

async function commitTokens(access: string, refresh: string) {
  recordClockSkew(access);
  // Old pair out, new pair in, proposal cleared — one storage call so the
  // native mirror gets all three together.
  await setAuthItems({ accessToken: access, refreshToken: refresh, pendingRefresh: null });
  tokenListener?.(access);
}

async function runRefresh(): Promise<string> {
  const epoch = sessionEpoch;
  let triedPendingAlone = false;
  for (let round = 0; round < 3; round++) {
    const refresh = getAuthItem('refreshToken');
    if (!refresh) {
      // No token at all: a session only "ends" if there was one to end.
      if (getAuthItem('user')) throw new SessionEndedError('no refresh token');
      throw new Error('not signed in');
    }
    let next = getAuthItem('pendingRefresh');
    if (!next || next === refresh) {
      next = randomToken();
      await setAuthItems({ pendingRefresh: next }); // durable BEFORE the request leaves
    }

    try {
      // authPost retries transient failures with the SAME pair — safe now,
      // because the server answers a repeated pair idempotently.
      const { data } = await authPost('/auth/refresh', { refresh, next }, 3, REFRESH_TIMEOUT_MS);
      if (epoch !== sessionEpoch) throw new Error('signed out during refresh');
      await commitTokens(data.access, data.refresh || refresh);
      return data.access as string;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status !== 401 || epoch !== sessionEpoch) throw err; // transient / server error / signed out — not a session expiry

      // Another tab may have rotated and stored a newer token while ours was in flight.
      const current = getAuthItem('refreshToken');
      if (current && current !== refresh) continue;

      // The rotation we proposed may have landed in an earlier attempt whose
      // response never arrived, and the old row has since been purged: the
      // proposal itself would then be our live token.
      const pending = getAuthItem('pendingRefresh');
      if (!triedPendingAlone && pending && pending !== refresh) {
        triedPendingAlone = true;
        await setAuthItems({ refreshToken: pending, pendingRefresh: null });
        continue;
      }
      throw new SessionEndedError(err?.response?.data?.error || 'refresh rejected');
    }
  }
  throw new SessionEndedError('refresh rejected');
}

function performRefresh(): Promise<string> {
  if (!refreshPromise) {
    // runRefresh() commits the new tokens before resolving, so clearing the
    // shared promise afterwards can never expose the old token to a caller.
    refreshPromise = runRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/**
 * Refresh now (sharing any refresh already in flight). Resolves to the new
 * access token, or null on failure — never throws. After a null,
 * `sessionEnded()` says whether that failure was final.
 */
export async function ensureFreshToken(): Promise<string | null> {
  try {
    const access = await performRefresh();
    refreshWasUnauthorized = false;
    return access;
  } catch (err) {
    refreshWasUnauthorized = err instanceof SessionEndedError;
    return null;
  }
}

/** Refresh only if the stored access token expires within `withinMs` (resume, SSE reconnect). */
export async function ensureTokenValidFor(withinMs: number): Promise<string | null> {
  const token = getAuthItem('accessToken');
  if (token && !tokenExpiresSoon(token, withinMs)) return token;
  if (!getAuthItem('refreshToken')) return token;
  return ensureFreshToken();
}

export function sessionEnded(): boolean {
  return refreshWasUnauthorized;
}

/**
 * The session is definitively over: tell the user, drop only the auth keys
 * (theme/font/dark-mode preferences survive), and go to the login page
 * under the app's base path (/zenkara/login on the web, /login in the app).
 */
export function forceLogout(message = 'Your session has expired — please sign in again.') {
  if (loggedOutFromExpiry) return;
  loggedOutFromExpiry = true;
  addToast(message, 'warning', { duration: 6000 });
  clearAuthItems().finally(() => {
    window.location.href = `${import.meta.env.BASE_URL}login`;
  });
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config ?? {};

    if (error.response?.status === 401 && !original._retry && !original._skipAuthRefresh && !isAuthEndpoint(original.url)) {
      original._retry = true;

      // Another request already refreshed while this one was in flight:
      // just resend with the current token, no new rotation needed.
      const sentWith = String(original.headers?.Authorization || '').replace(/^Bearer /, '');
      const current = getAuthItem('accessToken');
      const newToken = current && current !== sentWith ? current : await ensureFreshToken();
      if (newToken) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      }
      // Only sign out when the refresh token itself was definitively
      // rejected. If the refresh merely couldn't reach the server (cold
      // start, network blip), keep the session and let this request fail.
      if (refreshWasUnauthorized) forceLogout();
      return Promise.reject(error);
    }

    if (original._silent) return Promise.reject(error);

    // Show toast for all other non-401 errors
    const status: number | undefined = error.response?.status;
    const serverMsg: string | undefined =
      error.response?.data?.error || error.response?.data?.message;

    /* Was this something the user did, or something a screen fetched on its
       own? A GET is the app reading data — the user did not "perform an
       action", so a refusal is not news they asked for. Anything that writes
       (POST/PATCH/PUT/DELETE) was provoked by a click, and being told why it
       did nothing is exactly what the user needs.

       This distinction is why permission warnings used to pile up. Every role
       except SUPER_ADMIN loads at least one screen that reads endpoints it is
       not cleared for — the dashboard alone fires four such reads for IT_AGENT
       and EMPLOYEE, three for IT_MANAGER, two for SALES_REP, one for
       CRM_MANAGER — and for EMPLOYEE the sidebar's custom-module lookup fires
       on every single navigation. All of those are passive GETs, so all of them
       raised "You don't have permission to perform this action." at someone who
       had merely logged in or changed page.

       Pages now avoid firing reads they know they can't make (see
       shared/permissions.ts); this is the backstop for any that slip through.
       A blocked read degrades to an empty or hidden section, which is what the
       screen should have rendered for that role anyway. */
    const method = String(original?.method ?? 'get').toUpperCase();
    const isUserAction = method !== 'GET' && method !== 'HEAD';

    if (!error.response) {
      addToast(
        'Cannot reach the server. Make sure the backend is running and the database is connected.',
        'error'
      );
    } else if (status === 403) {
      /* Prefer the server's own wording: controllers frequently explain the
         specific rule ("Only the assigned agent can resolve this ticket"),
         which is far more actionable than the generic sentence. */
      if (isUserAction) {
        addToast(serverMsg || "You don't have permission to do that.", 'warning');
      }
    } else if (status === 402) {
      // 402 covers seat limits, plan features and storage quotas alike —
      // the server's message says which; the fallback must not assume.
      // actionHref is an in-app path: ToastContainer routes it through the
      // router, so the /zenkara/ base (web) is applied.
      addToast(serverMsg || 'This needs a higher plan.', 'warning', {
        duration: 10000,
        actionLabel: 'Upgrade plan',
        actionHref: '/billing',
      });
    } else if (status === 409) {
      addToast(serverMsg || 'A conflict occurred — this item may already exist.', 'warning');
    } else if (status === 422) {
      addToast(serverMsg || 'Validation failed — check your inputs.', 'warning');
    } else if (status === 429) {
      addToast('Too many requests — please slow down.', 'warning');
    } else if (status && status >= 500) {
      addToast(
        serverMsg ? `Server error: ${serverMsg}` : 'A server error occurred. Try again in a moment.',
        'error'
      );
    } else if (status && status >= 400 && status !== 401) {
      addToast(serverMsg || 'Something went wrong.', 'error');
    }

    return Promise.reject(error);
  }
);
