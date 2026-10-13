import { Browser } from '@capacitor/browser';
import { api } from '../api/client';

/**
 * Microsoft (Entra) sign-in from the Android app.
 *
 * Microsoft refuses to sign in inside an embedded WebView, so the flow runs
 * in a Custom Tab (@capacitor/browser) and comes back through the
 * com.zenkara.app://sso-callback deep link (AndroidManifest intent-filter).
 * A custom scheme can be claimed by any app, so the link carries only a
 * short-lived one-time code; it is worthless without the verifier generated
 * here, which never leaves the app (PKCE-style — see server auth.controller
 * entraLoginRedirect / ssoExchange).
 */
const VERIFIER_KEY = 'ssoVerifier';
export const SSO_DEEP_LINK = 'com.zenkara.app://sso-callback';

function base64url(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startNativeEntraLogin(orgSlug: string): Promise<void> {
  const raw = new Uint8Array(48);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw); // 64 chars
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  try { localStorage.setItem(VERIFIER_KEY, verifier); } catch { /* ignore */ }
  const apiBase = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
  await Browser.open({
    url: `${apiBase}/auth/entra/${encodeURIComponent(orgSlug)}/login?app_challenge=${base64url(digest)}`,
  });
}

/** Parses com.zenkara.app://sso-callback#code=… / #error=…; null for any other URL. */
export function parseSsoDeepLink(url: string): { code?: string; error?: string } | null {
  if (!url.startsWith(SSO_DEEP_LINK)) return null;
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : (url.split('?')[1] ?? '');
  const params = new URLSearchParams(hash);
  return { code: params.get('code') ?? undefined, error: params.get('error') ?? undefined };
}

const SSO_ERROR_TEXT: Record<string, string> = {
  sso_not_found: "That sign-in ID isn't recognized. Check it with your admin.",
  sso_disabled: 'Single sign-on is currently turned off for your organization. Sign in with your password instead.',
  sso_error: 'Something went wrong starting Microsoft sign-in. Please try again.',
};
export const ssoErrorText = (e: string) => SSO_ERROR_TEXT[e] ?? e;

/** Redeems the deep-link code for a session ({ user, access, refresh }). */
export async function completeNativeSso(code: string) {
  let verifier: string | null = null;
  try { verifier = localStorage.getItem(VERIFIER_KEY); localStorage.removeItem(VERIFIER_KEY); } catch { /* ignore */ }
  Browser.close().catch(() => { /* already closed */ });
  if (!verifier) throw new Error('This sign-in was started on another launch of the app — please try again.');
  const { data } = await api.post('/auth/sso/exchange', { code, verifier }, { _silent: true });
  return data as { user: any; access: string; refresh: string };
}
