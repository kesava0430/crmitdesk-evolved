import { useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { ensureTokenValidFor } from '../api/client';
import { getAuthItem } from '../api/authStorage';

export type SSEEventType =
  | 'ticket:created'
  | 'ticket:updated'
  | 'ticket:status'
  | 'inbox:message'
  | 'inbox:conversation'
  | 'lead:created'
  | 'deal:updated'
  | 'notification'
  | 'chat:message'
  | 'attendance:updated'
  | 'attendance:locate'
  | 'ping';

type Handler = (data: any) => void;

// ─── Global toast callback (set by NotificationBell) ─────────────────────────

let globalToastHandler: ((event: SSEEventType, data: any) => void) | null = null;
export function setSSEToastHandler(fn: typeof globalToastHandler) { globalToastHandler = fn; }

// ─── Main hook ────────────────────────────────────────────────────────────────

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Live updates over Server-Sent Events.
 *
 * This hook used to be the engine of the Android "random logout": in the app
 * the stream was blocked by CORS (fixed server-side), every error ran a
 * token refresh, the refreshed token changed `accessToken`, which re-created
 * `connect` and reconnected at once — a refresh loop that rotated the
 * refresh token many times a minute until one rotation response got lost.
 * Now:
 *  - the token is read from storage at connect time, never a dependency, so
 *    a refresh elsewhere doesn't tear the stream down;
 *  - an error only triggers a refresh when the token has actually expired
 *    (judged from its exp claim — EventSource can't see HTTP statuses);
 *  - reconnects back off exponentially, 5s → 60s, reset after a healthy
 *    connection;
 *  - the Android app closes the stream while backgrounded ('app:pause') and
 *    reconnects immediately on 'app:resume' (native/NativeBridge.tsx), as
 *    does any browser coming back online.
 */
export function useSSE() {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const pausedRef = useRef(false);
  // Bumped whenever an in-flight connect() must be abandoned (effect
  // re-run / unmount, app paused) — connect() awaits a token first, and must
  // not open a stream for a context that no longer exists.
  const genRef = useRef(0);

  const disconnect = useCallback(() => {
    if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    disconnect();
    if (!isAuthenticated || pausedRef.current) return;
    const gen = genRef.current;

    // Make sure the token outlives the handshake; refreshes only when needed
    // and shares any refresh already in flight.
    const token = (await ensureTokenValidFor(30_000)) ?? getAuthItem('accessToken');
    if (!token || pausedRef.current || gen !== genRef.current) return;
    if (esRef.current) return; // another connect() won the race while we awaited

    // Pass token as query param — EventSource doesn't support custom headers.
    // Same VITE_API_URL rule as api/client.ts: EventSource can't go through
    // the axios instance, so it needs its own base-URL resolution.
    const apiBase = import.meta.env.VITE_API_URL || '/api';
    const es = new EventSource(`${apiBase}/events/stream?_t=${encodeURIComponent(token)}`);
    esRef.current = es;

    const handlers: Partial<Record<SSEEventType, Handler>> = {
      // The server pings on connect and every 25s: proof the stream is
      // healthy, so the next failure starts again from the short delay.
      'ping': () => { backoffRef.current = MIN_BACKOFF_MS; },
      'ticket:created': (data) => {
        qc.invalidateQueries({ queryKey: ['tickets'] });
        globalToastHandler?.('ticket:created', data);
      },
      'ticket:status': (data) => {
        qc.invalidateQueries({ queryKey: ['tickets'] });
        qc.invalidateQueries({ queryKey: ['ticket', data.id] });
        globalToastHandler?.('ticket:status', data);
      },
      'ticket:updated': () => {
        qc.invalidateQueries({ queryKey: ['tickets'] });
      },
      'inbox:message': (data) => {
        qc.invalidateQueries({ queryKey: ['conversations'] });
        qc.invalidateQueries({ queryKey: ['messages', data.conversationId] });
        if (data.direction === 'INBOUND') globalToastHandler?.('inbox:message', data);
      },
      'inbox:conversation': () => {
        qc.invalidateQueries({ queryKey: ['conversations'] });
      },
      'lead:created': (data) => {
        qc.invalidateQueries({ queryKey: ['leads'] });
        globalToastHandler?.('lead:created', data);
      },
      'notification': (data) => {
        qc.invalidateQueries({ queryKey: ['notifications'] });
        globalToastHandler?.('notification', data);
      },
      'chat:message': (data) => {
        qc.invalidateQueries({ queryKey: ['chat-threads'] });
        if (data.threadId) qc.invalidateQueries({ queryKey: ['chat-messages', data.threadId] });
      },
      'attendance:updated': () => {
        qc.invalidateQueries({ queryKey: ['attendance-today'] });
        qc.invalidateQueries({ queryKey: ['attendance-live'] });
      },
      // A manager asked for this user's position — the heartbeat hook listens for this and pings immediately
      'attendance:locate': (data) => {
        window.dispatchEvent(new CustomEvent('attendance:locate', { detail: data }));
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      es.addEventListener(event, (e: MessageEvent) => {
        try { handler!(JSON.parse(e.data)); } catch {}
      });
    }

    es.onerror = () => {
      if (esRef.current !== es) return; // already replaced or closed
      es.close();
      esRef.current = null;
      if (pausedRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      // connect() itself refreshes the token first if (and only if) it has
      // expired — a network blip or server restart no longer rotates the
      // refresh token on every retry.
      retryRef.current = setTimeout(() => { void connect(); }, delay);
    };
  }, [isAuthenticated, qc, disconnect]);

  useEffect(() => {
    pausedRef.current = false;
    backoffRef.current = MIN_BACKOFF_MS;
    void connect();

    const onResume = () => {
      pausedRef.current = false;
      backoffRef.current = MIN_BACKOFF_MS;
      void connect();
    };
    const onPause = () => {
      pausedRef.current = true;
      genRef.current++;
      disconnect();
    };
    const onOnline = () => {
      if (pausedRef.current || esRef.current) return;
      backoffRef.current = MIN_BACKOFF_MS;
      void connect();
    };
    window.addEventListener('app:resume', onResume);
    window.addEventListener('app:pause', onPause);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('app:resume', onResume);
      window.removeEventListener('app:pause', onPause);
      window.removeEventListener('online', onOnline);
      genRef.current++; // stop any in-flight connect() from opening a stream
      disconnect();
    };
  }, [connect, disconnect]);
}
