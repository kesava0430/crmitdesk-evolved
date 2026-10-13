import { PushNotifications } from '@capacitor/push-notifications';
import { api } from '../api/client';
import { addToast } from '../shared/components/toastStore';
import { isNative, nativePlatform } from './platform';

/**
 * Push notifications in the Android app, via Firebase Cloud Messaging.
 *
 * The browser Push API (usePushSubscription.ts + sw.ts) does not exist in a
 * WebView, so the app registers an FCM device token instead and the server
 * sends to it alongside web-push (server utils/fcm.ts).
 *
 * Two independent switches, both off by default, so nothing changes until
 * Firebase is actually set up:
 *  - build time: VITE_FCM_ENABLED=true. Required because calling
 *    PushNotifications.register() in an APK built WITHOUT
 *    google-services.json crashes the app natively (FirebaseApp not
 *    initialised) — no JS try/catch can stop that.
 *  - server: GET /push/app-config says whether FCM credentials exist; with
 *    none there is no point asking the user for permission.
 */
export const nativePushEnabled = isNative && import.meta.env.VITE_FCM_ENABLED === 'true';

const TOKEN_KEY = 'fcmToken';
let initialised = false;

type Navigate = (path: string) => void;

function isInAppPath(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
}

/** Call once a user is signed in. Safe to call repeatedly. */
export async function initNativePush(navigate: Navigate): Promise<void> {
  if (!nativePushEnabled || initialised) return;
  initialised = true;
  try {
    const { data } = await api.get('/push/app-config', { _silent: true });
    if (!data?.enabled) return;

    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== 'granted') return;

    await PushNotifications.addListener('registration', ({ value }) => {
      try { localStorage.setItem(TOKEN_KEY, value); } catch { /* ignore */ }
      api.post('/push/device', { token: value, platform: nativePlatform }, { _silent: true }).catch(() => {});
    });
    await PushNotifications.addListener('registrationError', (err) => {
      console.error('[push] FCM registration failed', err);
    });

    // Arrives while the app is in the foreground: Android shows nothing on
    // its own, so surface it as a toast — and relay attendance "locate"
    // requests to the heartbeat hook exactly like the SSE path does.
    await PushNotifications.addListener('pushNotificationReceived', (n) => {
      const type = (n.data as any)?.type;
      if (type === 'attendance:locate') {
        window.dispatchEvent(new CustomEvent('attendance:locate', { detail: n.data }));
        return;
      }
      const url = (n.data as any)?.url;
      addToast([n.title, n.body].filter(Boolean).join(' — ') || 'New notification', 'info', {
        duration: 8000,
        ...(isInAppPath(url) ? { actionHref: url, actionLabel: 'Open' } : {}),
      });
    });

    // The user tapped the system notification: open the page it points at.
    // Server URLs are app paths ('/hr/attendance'); the router adds any base.
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = action.notification.data as any;
      if (data?.type === 'attendance:locate') window.dispatchEvent(new CustomEvent('attendance:locate', { detail: data }));
      if (isInAppPath(data?.url)) navigate(data.url);
    });

    await PushNotifications.register();
  } catch (err) {
    initialised = false;
    console.error('[push] native push setup failed', err);
  }
}

/** On sign-out: stop this device receiving the previous user's notifications. */
export async function unregisterNativePush(accessToken: string | null): Promise<void> {
  if (!nativePushEnabled) return;
  let token: string | null = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* ignore */ }
  if (!token || !accessToken) return;
  await api.post('/push/device/unregister', { token }, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 8000,
    _skipAuthRefresh: true,
    _silent: true,
  }).catch(() => {});
  initialised = false;
  await PushNotifications.removeAllListeners().catch(() => {});
}
