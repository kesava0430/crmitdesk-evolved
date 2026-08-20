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

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope;

// The precache manifest is injected here at build time by vite-plugin-pwa.
precacheAndRoute(self.__WB_MANIFEST);

// Never cache API calls — this is a data-heavy authenticated app, a stale
// cached response would be actively wrong. Same rule the previous
// generateSW-based runtimeCaching config had.
// Matched on url.pathname, NOT a regex against the full URL string: workbox
// tests regexes against the absolute URL ("https://host/api/..."), so a
// ^-anchored /^\/api\//-style pattern silently never matches — and would
// also miss a future cross-origin VITE_API_URL deployment.
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());
registerRoute(({ url }) => url.pathname.startsWith('/portal/'), new NetworkOnly());

self.skipWaiting();
self.addEventListener('activate', () => self.clients.claim());

// ─── Push notifications ─────────────────────────────────────────────────────

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
}

self.addEventListener('push', (event: PushEvent) => {
  let data: PushPayload = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — fall back to defaults below rather than throwing.
  }

  const title = data.title || 'CRM & IT Desk';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      data: { url: data.url || '/' },
    }),
  );
});

// Clicking the OS notification focuses an already-open tab if there is one,
// navigating it to the relevant page, rather than always opening a new tab.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url: string = event.notification.data?.url || '/';

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
