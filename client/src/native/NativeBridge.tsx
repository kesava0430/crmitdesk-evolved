import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { App as CapApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { useAuth } from '../contexts/AuthContext';
import { ensureTokenValidFor } from '../api/client';
import { getAuthItem } from '../api/authStorage';
import { isNative } from './platform';
import { closeTopOverlay } from './overlayStack';
import { initNativePush } from './push';
import { completeNativeSso, parseSsoDeepLink, ssoErrorText } from './sso';

/**
 * Android app lifecycle glue. Renders nothing; on the web it does nothing.
 *
 * - Resume/pause: the WebView is frozen in the background, so timers (token
 *   refresh, attendance heartbeat, the SSE stream) all stall. On resume the
 *   access token is refreshed if it is about to expire, stale screens are
 *   refetched, and window events 'app:resume' / 'app:pause' let other hooks
 *   react (useSSE reconnects; the attendance heartbeat pings immediately).
 * - Hardware/gesture Back: closes the topmost modal or drawer, otherwise
 *   goes back, and on a top-level screen sends the app to the background
 *   instead of walking back into the login page.
 * - Deep links: com.zenkara.app://sso-callback finishes Microsoft sign-in.
 * - Push: registers for FCM once signed in (only when built with it).
 */
const TOP_LEVEL_PATHS = new Set(['/', '/dashboard', '/login', '/platform-admin']);
const REFETCH_AFTER_MS = 30_000;

function currentAppPath(): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const p = window.location.pathname;
  return (base && p.startsWith(base) ? p.slice(base.length) : p) || '/';
}

export function NativeBridge() {
  const { isAuthenticated, setSession } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Listeners are registered once; read the latest values through refs.
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const setSessionRef = useRef(setSession);
  setSessionRef.current = setSession;

  useEffect(() => {
    if (!isNative) return;
    let backgroundedAt = 0;
    const handles: Array<Promise<PluginListenerHandle>> = [];
    // getLaunchUrl() and appUrlOpen can both report the same link; a code is single-use.
    const seenLinks = new Set<string>();

    const handleDeepLink = async (url: string) => {
      const sso = parseSsoDeepLink(url);
      if (!sso || seenLinks.has(url)) return;
      seenLinks.add(url);
      const fail = (msg: string) => navRef.current(`/sso-callback#error=${encodeURIComponent(msg)}`, { replace: true });
      if (sso.error || !sso.code) return fail(ssoErrorText(sso.error || 'Sign-in did not complete.'));
      try {
        const { user, access, refresh } = await completeNativeSso(sso.code);
        setSessionRef.current(user, access, refresh);
        navRef.current('/dashboard', { replace: true });
      } catch (err: any) {
        fail(err?.response?.data?.error || err?.message || 'Sign-in failed — please try again.');
      }
    };

    handles.push(CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        backgroundedAt = Date.now();
        window.dispatchEvent(new Event('app:pause'));
        return;
      }
      window.dispatchEvent(new Event('app:resume'));
      if (!getAuthItem('refreshToken')) return;
      const away = backgroundedAt ? Date.now() - backgroundedAt : 0;
      // Refresh first (if the token has < 2 min left) so the refetches below
      // don't all 401 at once.
      ensureTokenValidFor(2 * 60_000).finally(() => {
        if (away > REFETCH_AFTER_MS) qc.invalidateQueries();
      });
    }));

    handles.push(CapApp.addListener('backButton', ({ canGoBack }) => {
      if (closeTopOverlay()) return;
      if (canGoBack && !TOP_LEVEL_PATHS.has(currentAppPath())) {
        window.history.back();
      } else {
        CapApp.minimizeApp().catch(() => {});
      }
    }));

    handles.push(CapApp.addListener('appUrlOpen', ({ url }) => { void handleDeepLink(url); }));
    // Cold start through the deep link (the app was killed while the Custom Tab was open).
    CapApp.getLaunchUrl().then(r => { if (r?.url) void handleDeepLink(r.url); }).catch(() => {});

    return () => {
      handles.forEach(h => h.then(x => x.remove()).catch(() => {}));
    };
  }, [qc]);

  useEffect(() => {
    if (!isNative || !isAuthenticated) return;
    void initNativePush(path => navRef.current(path));
  }, [isAuthenticated]);

  return null;
}
