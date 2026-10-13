import crypto from 'crypto';

/**
 * Firebase Cloud Messaging (HTTP v1) sender for the Android app — the native
 * counterpart of web-push in webPush.ts. The Capacitor WebView has no Push
 * API, so the app registers an FCM device token instead
 * (client/src/native/push.ts) and sendPushToUser() fans out to both.
 *
 * Deliberately dependency-free: the only Google API involved is the OAuth
 * token exchange, which is one signed JWT (RS256 via node:crypto) and one
 * POST — not worth pulling firebase-admin and its transitive tree into the
 * server bundle.
 *
 * Configuration (both optional — unset means every function here no-ops):
 *   FCM_SERVICE_ACCOUNT_JSON  the Firebase service-account key file, either
 *                             raw JSON or base64 of it (FIREBASE_SERVICE_ACCOUNT
 *                             is accepted as an alias)
 *   FCM_PROJECT_ID            overrides project_id from the key file
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

export function parseServiceAccount(env: Record<string, string | undefined> = process.env): ServiceAccount | null {
  const raw = (env.FCM_SERVICE_ACCOUNT_JSON || env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  const candidates = [raw];
  if (!raw.startsWith('{')) {
    try { candidates.push(Buffer.from(raw, 'base64').toString('utf8')); } catch { /* not base64 */ }
  }
  for (const text of candidates) {
    try {
      const json = JSON.parse(text);
      if (json && typeof json.client_email === 'string' && typeof json.private_key === 'string') {
        // Keys pasted into a .env often arrive with literal "\n" sequences.
        return { ...json, private_key: json.private_key.replace(/\\n/g, '\n') };
      }
    } catch { /* try the next form */ }
  }
  return null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** The signed assertion Google's token endpoint exchanges for an access token. */
export function buildServiceAccountAssertion(sa: ServiceAccount, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: sa.token_uri || DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(sa.private_key))}`;
}

/**
 * What to do with a device token after a failed send. FCM v1 reports a dead
 * registration as 404 UNREGISTERED (app uninstalled, token rotated) or 400
 * INVALID_ARGUMENT naming the token; those are pruned. 429/5xx are worth a
 * retry. Anything else (bad credentials, malformed message) is our problem,
 * not the device's — log it and move on.
 */
export function classifyFcmFailure(status: number, body: any): 'prune' | 'retry' | 'drop' {
  const code: string = body?.error?.status || body?.error?.details?.find?.((d: any) => d?.errorCode)?.errorCode || '';
  if (status === 404 || code === 'UNREGISTERED' || code === 'NOT_FOUND') return 'prune';
  if (status === 400 && (code === 'INVALID_ARGUMENT' || code === 'SENDER_ID_MISMATCH') && /token/i.test(body?.error?.message || '')) return 'prune';
  // 401: our cached OAuth token went stale; the retry fetches a new one.
  if (status === 401 || status === 429 || status >= 500) return 'retry';
  return 'drop';
}

export interface FcmPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  type?: string;
}

/** FCM v1 message body. `data` values must all be strings. */
export function buildFcmMessage(token: string, p: FcmPayload) {
  const data: Record<string, string> = {};
  if (p.url) data.url = p.url;
  if (p.type) data.type = p.type;
  if (p.tag) data.tag = p.tag;
  return {
    message: {
      token,
      notification: { title: p.title, body: p.body || '' },
      data,
      android: {
        priority: 'HIGH',
        notification: p.tag ? { tag: p.tag } : {},
      },
    },
  };
}

const serviceAccount = parseServiceAccount();
const projectId = process.env.FCM_PROJECT_ID || serviceAccount?.project_id || '';
if ((process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT) && (!serviceAccount || !projectId)) {
  console.warn('[fcm] FCM_SERVICE_ACCOUNT_JSON is set but could not be parsed (or has no project_id) — app push disabled');
}

export function fcmConfigured(): boolean {
  return !!(serviceAccount && projectId);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value;
  const sa = serviceAccount!;
  const res = await fetch(sa.token_uri || DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildServiceAccountAssertion(sa),
    }).toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`FCM auth failed (${res.status}): ${json.error_description || json.error || 'no access_token'}`);
  }
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  return cachedToken.value;
}

/** Sends one message. Resolves to 'ok' or the failure class from classifyFcmFailure; throws only on network errors. */
export async function sendFcm(token: string, payload: FcmPayload): Promise<'ok' | 'prune' | 'retry' | 'drop'> {
  if (!fcmConfigured()) return 'drop';
  const accessToken = await getAccessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildFcmMessage(token, payload)),
  });
  if (res.ok) return 'ok';
  if (res.status === 401) cachedToken = null; // credentials rotated — fetch a new token next time
  const body: any = await res.json().catch(() => ({}));
  const verdict = classifyFcmFailure(res.status, body);
  if (verdict === 'drop') console.error(`[fcm] send rejected (${res.status}):`, body?.error?.message || body);
  return verdict;
}
