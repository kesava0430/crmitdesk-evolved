/**
 * Origins the API answers CORS for.
 *
 * CORS_ORIGIN used to be a single origin (the web front end). The Android
 * app's WebView runs at http://localhost (androidScheme 'http' — see
 * client/capacitor.config.ts). CapacitorHttp carries axios calls through the
 * native stack, so those never needed CORS — but EventSource is not patched
 * by CapacitorHttp, so the live-updates stream (useSSE.ts) was a genuine
 * cross-origin request that the WebView rejected every time. Each rejection
 * triggered a token refresh and an immediate reconnect: a refresh loop that
 * rotated the refresh token many times a minute and, sooner or later, lost a
 * rotation response and logged the user out.
 *
 * CORS_ORIGIN may now list several origins separated by commas. The
 * Capacitor WebView origins are added by default (set
 * CORS_ALLOW_APP_ORIGINS=false to opt out). Allowing them is low-risk here:
 * the API authenticates with bearer tokens, not cookies, so a page on some
 * other localhost gains nothing it couldn't do with plain curl.
 */
export const APP_WEBVIEW_ORIGINS = ['http://localhost', 'https://localhost', 'capacitor://localhost'];

export function resolveCorsOrigins(env: Record<string, string | undefined> = process.env): string[] | true {
  const configured = (env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  // '*' inside an array is compared literally by the cors package and would
  // match nothing. `true` reflects the request's Origin instead — the only
  // form of "any origin" that is valid together with credentials: true
  // (a literal '*' Access-Control-Allow-Origin is rejected by browsers then).
  if (configured.includes('*')) return true;
  const app = env.CORS_ALLOW_APP_ORIGINS === 'false' ? [] : APP_WEBVIEW_ORIGINS;
  return Array.from(new Set([...configured, ...app]));
}
