import { APP_WEBVIEW_ORIGINS } from './corsOrigins';

/**
 * Links into the web app that the server sends out (emails, redirects).
 *
 * FRONTEND_URL is the web app's public address INCLUDING its base path:
 * https://app.zenkara.in/zenkara in production. Before the move to AWS the
 * app sat at a domain root (Render), so `${FRONTEND_URL}/portal` was right
 * with FRONTEND_URL=https://host; under /zenkara the same value produces
 * https://app.zenkara.in/portal, which nginx doesn't route to the app. The
 * deploy docs (README "HTTPS", enable-https.sh) told operators to set the
 * bare host, so production may well have it without the prefix.
 */

type Env = Record<string, string | undefined>;

const trimSlashes = (s: string) => s.replace(/\/+$/, '');

/** FRONTEND_URL without a trailing slash (a trailing slash used to give "//portal"). */
export function frontendBase(env: Env = process.env): string {
  return trimSlashes((env.FRONTEND_URL || 'http://localhost:5173').trim());
}

/** frontendLink('/portal?org=x') → "https://app.zenkara.in/zenkara/portal?org=x". */
export function frontendLink(path: string, env: Env = process.env, base?: string): string {
  return `${base ?? frontendBase(env)}/${path.replace(/^\/+/, '')}`;
}

/** Origins whose pages may tell us where the app is served (see resolveAppBase). */
function trustedOrigins(env: Env): Set<string> {
  const out = new Set<string>();
  try { out.add(new URL(frontendBase(env)).origin); } catch { /* malformed FRONTEND_URL — ignore */ }
  for (const o of (env.CORS_ORIGIN || '').split(',')) {
    const v = trimSlashes(o.trim());
    if (!v || v === '*') continue;
    try { out.add(new URL(v).origin); } catch { /* ignore */ }
  }
  // The Android WebView's localhost is never a public address.
  for (const o of APP_WEBVIEW_ORIGINS) out.delete(o);
  return out;
}

/** "/", "/zenkara", "/a/b-c" — plain path segments, nothing else. */
const SIMPLE_PATH = /^(\/[A-Za-z0-9._~-]+)*\/?$/;

/**
 * The base for a link a client page asked for: the page tells us its own
 * public root (client shared/publicUrl.ts → "https://app.zenkara.in/zenkara")
 * and we use it when it is on one of OUR origins (FRONTEND_URL's, or one
 * listed in CORS_ORIGIN) with a plain path. That makes portal emails land
 * where the customer actually is — right base path, right hostname
 * (app.zenkara.in vs 360.zenkara.in) — whatever FRONTEND_URL says.
 *
 * Anything else falls back to FRONTEND_URL. The origin check is what makes
 * it safe on public endpoints: magic-link emails carry a login token, so a
 * caller must never be able to point them at a host they control.
 */
export function resolveAppBase(candidate: unknown, env: Env = process.env): string {
  const fallback = frontendBase(env);
  if (typeof candidate !== 'string' || !candidate || candidate.length > 300) return fallback;
  let url: URL;
  try { url = new URL(candidate.trim()); } catch { return fallback; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
  if (url.username || url.password || url.search || url.hash) return fallback;
  if (!SIMPLE_PATH.test(url.pathname)) return fallback;
  if (!trustedOrigins(env).has(url.origin)) return fallback;
  return trimSlashes(`${url.origin}${url.pathname}`);
}

/** Customer-portal entry link for an org. */
export function portalEntryLink(orgId: string, base?: string, env: Env = process.env): string {
  return frontendLink(`/portal?org=${encodeURIComponent(orgId)}`, env, base);
}

/** Customer-portal magic login link. */
export function portalVerifyLink(token: string, orgId: string, base?: string, env: Env = process.env): string {
  return frontendLink(`/portal/verify?token=${encodeURIComponent(token)}&org=${encodeURIComponent(orgId)}`, env, base);
}
