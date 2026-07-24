import { useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';

export type SSEEventType =
  | 'ticket:created'
  | 'ticket:updated'
  | 'ticket:status'
  | 'inbox:message'
  | 'inbox:conversation'
  | 'lead:created'
  | 'deal:updated'
  | 'notification'
  | 'ping';

type Handler = (data: any) => void;

// ─── Global toast callback (set by NotificationBell) ─────────────────────────

let globalToastHandler: ((event: SSEEventType, data: any) => void) | null = null;
export function setSSEToastHandler(fn: typeof globalToastHandler) { globalToastHandler = fn; }

// ─── Main hook ────────────────────────────────────────────────────────────────

export function useSSE() {
  const { accessToken, isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!isAuthenticated || !accessToken) return;
    if (esRef.current) esRef.current.close();

    // Pass token as query param — EventSource doesn't support custom headers.
    // Same VITE_API_URL bug as api/client.ts: EventSource can't go through
    // the axios instance, so it needs its own base-URL resolution rather
    // than a hardcoded relative '/api' path.
    const apiBase = import.meta.env.VITE_API_URL || '/api';
    const es = new EventSource(`${apiBase}/events/stream?_t=${encodeURIComponent(accessToken)}`);
    esRef.current = es;

    const handlers: Partial<Record<SSEEventType, Handler>> = {
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
    };

    for (const [event, handler] of Object.entries(handlers)) {
      es.addEventListener(event, (e: MessageEvent) => {
        try { handler!(JSON.parse(e.data)); } catch {}
      });
    }

    es.onerror = () => {
      es.close();
      esRef.current = null;
      // Reconnect after 5s
      retryRef.current = setTimeout(connect, 5_000);
    };
  }, [isAuthenticated, accessToken, qc]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connect]);
}
