import webpush from 'web-push';
import { prisma } from './prisma';
import { enqueueJob, registerJobHandler } from './jobQueue';
import { fcmConfigured, sendFcm } from './fcm';

/**
 * Real browser/OS-level push notifications (Push API), separate from the
 * in-app-only SSE + notification-bell system in NotificationBell.tsx. Those
 * only reach a user while a tab is open; this reaches them even when the
 * app/browser is closed, via the browser vendor's push service (FCM,
 * Mozilla's autopush, etc.) — see client/src/sw.ts for the service worker
 * that receives these and client/src/hooks/usePushSubscription.ts for the
 * opt-in flow.
 *
 * Requires VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (generate with
 * `npx web-push generate-vapid-keys`). Left unconfigured, every function
 * here silently no-ops rather than erroring — same "off by default until a
 * key is set" pattern as GROQ_API_KEY/RESEND_API_KEY elsewhere.
 */
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@crmitdesk.io';

const configured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY as string, VAPID_PRIVATE_KEY as string);
}

export function pushConfigured(): boolean {
  return configured;
}

/** Whether the Android app can receive pushes from this server (FCM credentials present). */
export function appPushConfigured(): boolean {
  return fcmConfigured();
}

export function getVapidPublicKey(): string | null {
  return VAPID_PUBLIC_KEY || null;
}

export interface PushPayload {
  title: string;
  body?: string;
  url?: string; // opened on notification click — see sw.ts's notificationclick handler
  /** Collapses repeated notifications of the same kind (e.g. attendance nudges) */
  tag?: string;
  /** Machine-readable kind; sw.ts relays some of these to open tabs (e.g. 'attendance:locate') */
  type?: string;
}

/**
 * Sends a push notification to every browser/device a user has subscribed
 * on: browser Push API subscriptions (web-push, VAPID) AND Android app
 * device tokens (FCM — see utils/fcm.ts). Each channel is independent and
 * no-ops when its keys aren't configured. Subscriptions/tokens the push
 * service reports as gone are pruned automatically — a stale one would
 * otherwise fail forever on every future send.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  await Promise.all([sendWebPush(userId, payload), sendAppPush(userId, payload)]);
}

async function sendWebPush(userId: string, payload: PushPayload): Promise<void> {
  if (!configured) return;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (!subs.length) return;

  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      );
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        // Transient failure (push service hiccup, timeout, etc) — queue a
        // retry instead of just logging it and moving on. A gone/expired
        // subscription (404/410, handled above) is not retried — that will
        // never succeed no matter how many attempts.
        console.error(`[web-push] Failed to send to subscription ${sub.id} — queuing retry:`, err?.message || err);
        await enqueueJob('web_push', {
          subscriptionId: sub.id,
          endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth,
          body,
        });
      }
    }
  }));
}

async function sendAppPush(userId: string, payload: PushPayload): Promise<void> {
  if (!fcmConfigured()) return;
  const devices = await prisma.deviceToken.findMany({ where: { userId } });
  await Promise.all(devices.map(async (d) => {
    const verdict = await sendFcm(d.token, payload).catch((err) => {
      console.error(`[fcm] network error sending to device ${d.id}:`, err?.message || err);
      return 'retry' as const;
    });
    if (verdict === 'prune') await prisma.deviceToken.delete({ where: { id: d.id } }).catch(() => {});
    else if (verdict === 'retry') await enqueueJob('fcm_push', { deviceTokenId: d.id, token: d.token, payload });
  }));
}

registerJobHandler('fcm_push', async (job: { deviceTokenId: string; token: string; payload: PushPayload }) => {
  const verdict = await sendFcm(job.token, job.payload);
  if (verdict === 'prune') {
    await prisma.deviceToken.delete({ where: { id: job.deviceTokenId } }).catch(() => {});
    return;
  }
  if (verdict === 'retry') throw new Error('FCM send still failing'); // jobQueue backs off and retries
});

registerJobHandler('web_push', async (payload: { subscriptionId: string; endpoint: string; p256dh: string; auth: string; body: string }) => {
  try {
    await webpush.sendNotification(
      { endpoint: payload.endpoint, keys: { p256dh: payload.p256dh, auth: payload.auth } },
      payload.body,
    );
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      // Subscription expired/was revoked between the original attempt and
      // this retry — nothing left to deliver to, and not a failure worth
      // retrying further. Clean it up and treat the job as done.
      await prisma.pushSubscription.delete({ where: { id: payload.subscriptionId } }).catch(() => {});
      return;
    }
    throw err; // still failing — let jobQueue's backoff/attempts logic handle it
  }
});
