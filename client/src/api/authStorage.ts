import { Preferences } from '@capacitor/preferences';
import { isNative } from '../native/platform';

/**
 * The only place session keys are written or removed.
 *
 * Web: localStorage, exactly as before.
 *
 * Android app: localStorage stays the synchronous source of truth (the
 * axios interceptor and AuthContext read it on every call), and every write
 * is mirrored into @capacitor/preferences — native SharedPreferences, which
 * survive things that wipe the WebView's own storage (WebView data resets,
 * a future switch of androidScheme to https, which changes the origin and
 * therefore the localStorage bucket). hydrateAuthFromDurable() copies them
 * back before the first render when localStorage comes up empty.
 *
 * Signing out removes ONLY these keys. It used to call localStorage.clear(),
 * which also wiped the user's theme/font/dark-mode choices.
 */
export const AUTH_KEYS = ['accessToken', 'refreshToken', 'user', 'pendingRefresh', 'tokenClockSkew'] as const;
export type AuthKey = (typeof AUTH_KEYS)[number];

const PREF_PREFIX = 'auth.';

export function getAuthItem(key: AuthKey): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/**
 * Writes (string) or removes (null) the given keys. The localStorage part is
 * synchronous; the returned promise settles when the native mirror is
 * written too — callers that must survive the app being killed right after
 * (the pending refresh proposal) await it.
 */
export async function setAuthItems(items: Partial<Record<AuthKey, string | null>>): Promise<void> {
  for (const [k, v] of Object.entries(items)) {
    try {
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch { /* storage disabled — nothing durable to do on web */ }
  }
  if (!isNative) return;
  await Promise.all(Object.entries(items).map(([k, v]) =>
    (v === null || v === undefined
      ? Preferences.remove({ key: PREF_PREFIX + k })
      : Preferences.set({ key: PREF_PREFIX + k, value: v })
    ).catch(() => { /* best-effort mirror */ }),
  ));
}

export function clearAuthItems(): Promise<void> {
  return setAuthItems(Object.fromEntries(AUTH_KEYS.map(k => [k, null])) as Record<AuthKey, null>);
}

/**
 * Native only, before React renders: if the WebView's localStorage lost the
 * session but the native mirror still has it, restore it; if localStorage
 * has a session the mirror doesn't (first launch after this update), seed
 * the mirror. localStorage wins when both exist — it is always written first.
 */
export async function hydrateAuthFromDurable(): Promise<void> {
  if (!isNative) return;
  try {
    const hasLocal = !!getAuthItem('refreshToken');
    if (hasLocal) {
      const snapshot: Partial<Record<AuthKey, string | null>> = {};
      for (const k of AUTH_KEYS) snapshot[k] = getAuthItem(k);
      await setAuthItems(snapshot);
      return;
    }
    const restored: Partial<Record<AuthKey, string | null>> = {};
    for (const k of AUTH_KEYS) {
      const { value } = await Preferences.get({ key: PREF_PREFIX + k });
      if (value !== null) restored[k] = value;
    }
    if (restored.refreshToken) {
      for (const [k, v] of Object.entries(restored)) {
        try { localStorage.setItem(k, v as string); } catch { /* ignore */ }
      }
    }
  } catch {
    /* Preferences unavailable — carry on with whatever localStorage has. */
  }
}
