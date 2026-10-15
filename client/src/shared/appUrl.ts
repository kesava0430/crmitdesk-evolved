import { isNative } from '../native/platform';
import { buildPublicUrl, publicAppRoot as rootFor, type PublicUrlEnv } from './publicUrl';

/**
 * Absolute, shareable URLs for in-app routes — use for anything copied,
 * emailed, embedded or opened in a new tab (portal link, public form link).
 *
 * In-app navigation doesn't need this: React Router's <Link>/navigate()
 * already apply the basename. asset() (shared/asset.ts) is for files in
 * public/. This is the third case: a full URL that must work for someone
 * who isn't inside this tab — correct under /zenkara/, at a domain root,
 * and from the Android app (whose own origin is http://localhost).
 */
function env(): PublicUrlEnv {
  return {
    baseUrl: import.meta.env.BASE_URL,
    origin: window.location.origin,
    isNative,
    apiUrl: import.meta.env.VITE_API_URL,
    publicAppUrl: import.meta.env.VITE_PUBLIC_APP_URL,
  };
}

/** "https://app.zenkara.in/zenkara" — no trailing slash. */
export function publicAppRoot(): string {
  return rootFor(env());
}

/** publicAppUrl('/portal?org=abc') → "https://app.zenkara.in/zenkara/portal?org=abc". */
export function publicAppUrl(path: string): string {
  return buildPublicUrl(path, env());
}
