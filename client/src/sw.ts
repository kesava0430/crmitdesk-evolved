/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa "injectManifest" strategy — see
// vite.config.ts). Replaces the previous auto-generated ("generateSW") one
// so we can add a 'push' handler: real OS/browser-level notifications that
// arrive even when no tab is open, on top of the in-app-only SSE + polling
// notification bell (see client/src/shared/components/NotificationBell.tsx
// and server/src/utils/webPush.ts, which sends these).
//
// This file is excluded from the app's main tsc build (see tsconfig.json's
// "exclude") because it runs under the "webworker" lib, not "DOM" — see
// tsconfig.sw.json for its own (editor-only) type-checking.

import { asset } from './shared/asset';
import { APP_NAME } from './shared/brand';
import { precacheAndRoute, matchPrecache } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkOnly, NetworkFirst, CacheFirst } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope;

// Page loads (HTML navigations) go to the network first, so a deploy shows up
// on the very next load — previously the precached index.html answered the
// app's root URL, pointing at the PREVIOUS build's scripts until the worker
// itself had updated and the page was reloaded again. The precached shell is
// only the offline fallback. Registered BEFORE precacheAndRoute because
// workbox uses the first matching route.
const pages = new NetworkFirst({ cacheName: 'pages-v1', networkTimeoutSeconds: 5 });
registerRoute(new NavigationRoute(async (options) => {
  try {
    const res = await pages.handle(options);
    if (res) return res;
  } catch { /* offline — fall through to the precached shell */ }
  return (await matchPrecache(asset('index.html'))) ?? Response.error();
}, {
  // API / portal routes are never app pages.
  denylist: [new RegExp(`^${asset('api/')}`), new RegExp(`^${asset('portal/')}`)],
}));

// The precache manifest is injected here at build time by vite-plugin-pwa.
precacheAndRoute(self.__WB_MANIFEST);

// Never cache API calls — this is a data-heavy authenticated app, a stale
// cached response would be actively wrong. Same rule the previous
// generateSW-based runtimeCaching config had.
// Matched on url.pathname, NOT a regex against the full URL string: workbox
// tests regexes against the absolute URL ("https://host/api/..."), so a
// ^-anchored /^\/api\//-style pattern silently never matches — and would
// also miss a future cross-origin VITE_API_URL deployment.
registerRoute(({ url }) => url.pathname.startsWith(asset('api/')), new NetworkOnly());
registerRoute(({ url }) => url.pathname.startsWith(asset('portal/')), new NetworkOnly());

// Face-verification model weights (<base>models/face/*, ~6.7 MB total) are static
// and versioned by path, but too large for the precache manifest and not
// matched by its globs. Cache them on first use so the camera dialog opens
// instantly (and offline) after the first successful check-in.
registerRoute(({ url }) => url.pathname.startsWith(asset('models/')), new CacheFirst({ cacheName: 'face-models-v1' }));

self.skipWaiting();
self.addEventListener('activate', () => self.clients.claim());

// ─── Push notifications ─────────────────────────────────────────────────────

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  type?: string;
}

self.addEventListener('push', (event: PushEvent) => {
  let data: PushPayload = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — fall back to defaults below rather than throwing.
  }

  const title = data.title || APP_NAME;
  event.waitUntil((async () => {
    // Attendance "locate" pushes: if the app is open in any tab (even a
    // backgrounded one), hand the request straight to it so it can send a
    // location fix without the person tapping anything. Service workers can't
    // read GPS themselves, so a closed app still needs the tap.
    if (data.type === 'attendance:locate') {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) c.postMessage({ type: 'attendance:locate' });
      if (clients.some(c => c.visibilityState === 'visible')) return; // already in the foreground — no notification needed
    }
    await self.registration.showNotification(title, {
      body: data.body || '',
      icon: asset('pwa-192x192.png'),
      badge: asset('pwa-192x192.png'),
      tag: data.tag,
      data: { url: data.url || '/', type: data.type },
    });
  })());
});

// Clicking the OS notification focuses an already-open tab if there is one,
// navigating it to the relevant page, rather than always opening a new tab.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  // The server sends in-app paths ('/hr/attendance'). Resolve them against
  // this worker's scope so they land under the deployment's base path
  // (https://app.zenkara.in/zenkara/hr/attendance) — opened as-is they
  // pointed at the domain root and 404'd. Absolute URLs pass through.
  const raw: string = event.notification.data?.url || '/';
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    ? raw
    : new URL(raw.replace(/^\/+/, ''), self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((c) => 'focus' in c) as WindowClient | undefined;
      if (existing) {
        existing.focus();
        if ('navigate' in existing) return existing.navigate(url);
        return undefined;
      }
      return self.clients.openWindow(url);
    }),
  );
});
