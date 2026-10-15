/**
 * Pure logic behind publicAppUrl() (shared/appUrl.ts): where the WEB app
 * lives, as an absolute URL someone outside the app can open.
 *
 * Kept free of import.meta / window / Capacitor so the server's unit tests
 * can import it directly (server/tests/unit/public-url.test.ts).
 *
 * Why it exists: shareable links were built as `${location.origin}/portal…`.
 * That was right while the app sat at a domain root (Render). Since the move
 * to app.zenkara.in/zenkara it drops the /zenkara base — the customer-portal
 * link pointed at app.zenkara.in/portal, which nginx doesn't route to the
 * app at all — and inside the Android app location.origin is
 * http://localhost, a link that only means something on that one phone.
 */
export interface PublicUrlEnv {
  /** import.meta.env.BASE_URL — '/' or '/zenkara/'. */
  baseUrl: string;
  /** window.location.origin. */
  origin: string;
  /** Running inside the Capacitor shell (origin is the WebView's localhost). */
  isNative: boolean;
  /** import.meta.env.VITE_API_URL — relative on the web, absolute in the app. */
  apiUrl?: string;
  /** import.meta.env.VITE_PUBLIC_APP_URL — explicit override, wins when set. */
  publicAppUrl?: string;
}

const trimSlashes = (s: string) => s.replace(/\/+$/, '');
const isAbsoluteHttp = (s?: string): s is string => !!s && /^https?:\/\//i.test(s.trim());

/** Absolute root of the web app, no trailing slash: "https://app.zenkara.in/zenkara". */
export function publicAppRoot(env: PublicUrlEnv): string {
  if (isAbsoluteHttp(env.publicAppUrl)) return trimSlashes(env.publicAppUrl.trim());

  // The app's bundle is served from http://localhost with base '/', so its
  // own origin is useless to anyone else. Its API URL is the one absolute
  // address it was built with (https://app.zenkara.in/zenkara/api), and the
  // web app is served from the same place minus /api — exactly how nginx
  // lays the two out.
  if (env.isNative && isAbsoluteHttp(env.apiUrl)) {
    return trimSlashes(trimSlashes(env.apiUrl.trim()).replace(/\/api$/i, ''));
  }

  return trimSlashes(`${trimSlashes(env.origin)}/${env.baseUrl.replace(/^\/+/, '')}`);
}

/** Absolute URL of an in-app route: buildPublicUrl('/portal?org=x', env). */
export function buildPublicUrl(path: string, env: PublicUrlEnv): string {
  return `${publicAppRoot(env)}/${path.replace(/^\/+/, '')}`;
}
