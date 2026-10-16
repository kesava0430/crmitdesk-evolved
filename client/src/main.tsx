import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { ThemeProvider } from './contexts/ThemeContext';
// Renders the toastStore. Without this mounted, every addToast() call in the
// app pushed into a store with no subscriber and the user saw nothing.
import { ToastContainer } from './shared/components/ToastContainer';
// Top-level crash net. AppLayout has its own ErrorBoundary around the routed
// pages, but a render crash in LoginPage, the customer portal, or AppLayout's
// own chrome (sidebar/header) happened OUTSIDE that boundary — the user got a
// blank white screen with no way back. This outer boundary is the fallback
// for everything the inner one can't see.
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import { isNative } from './native/platform';
import { hydrateAuthFromDurable } from './api/authStorage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      // Network-aware retry. A response with an error status (4xx/5xx) is a
      // real answer — retrying it once (the old behavior) is plenty. NO
      // response at all means the server is briefly unreachable (a deploy
      // restart, a network blip), so those get more attempts with growing
      // delays instead of failing the screen.
      retry: (failureCount, error: any) => {
        if (!error?.response) return failureCount < 5;
        return failureCount < 1;
      },
      retryDelay: attempt => Math.min(2000 * 2 ** attempt, 15_000),
      refetchOnWindowFocus: false,
    },
  },
});

const render = () => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          {/* Derived from Vite's `base` (see vite.config.ts) so the router
              and the asset URLs can never disagree. BASE_URL is '/' for the
              Capacitor build and '/zenkara/' when the web build is hosted
              under a path; React Router wants no trailing slash, and ''
              means "no basename", which is exactly right at the root. */}
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <App />
            <ToastContainer />
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// Service worker (push notifications + precache) — web only; same
// registration vite-plugin-pwa used to inject (see vite.config.ts). In the app,
// remove any worker an older build registered so it can't serve a stale bundle.
if ('serviceWorker' in navigator) {
  if (!isNative && import.meta.env.PROD) {
    // After a deploy the new worker activates at once (skipWaiting +
    // clients.claim in sw.ts), but the page already running is the OLD
    // bundle. Reload once when a worker takes over from a previous one — an
    // update, not the very first install — so nobody keeps using the old app
    // (e.g. areas a platform admin has since switched off). Guarded so it can
    // never loop.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).then(reg => {
        // Long-lived tabs (and installed PWAs) look for a new deploy when they
        // come back to the foreground and every 30 minutes.
        const check = () => { reg.update().catch(() => {}); };
        window.addEventListener('focus', check);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
        setInterval(check, 30 * 60 * 1000);
      }).catch(() => {});
    });
  } else if (isNative) {
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  }
}

// Android app: restore the session from native storage before the first
// render reads localStorage (see api/authStorage.ts). The web renders at once.
if (isNative) hydrateAuthFromDurable().finally(render);
else render();
