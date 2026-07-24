import { useState, useEffect, useRef } from 'react';
import { Bell, X, Ticket, MessageSquare, Target, CheckCircle } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useSSE, setSSEToastHandler, type SSEEventType } from '../../hooks/useSSE';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

interface Toast {
  id: string;
  event: SSEEventType;
  data: any;
  ts: number;
}

// ─── Toast icons ──────────────────────────────────────────────────────────────

function toastContent(event: SSEEventType, data: any): { icon: React.ReactNode; text: string } {
  switch (event) {
    case 'ticket:created': return { icon: <Ticket size={14} className="text-brand-500" />, text: `New ticket: ${data.title}` };
    case 'ticket:status':  return { icon: <CheckCircle size={14} className="text-green-500" />, text: `Ticket "${data.title}" → ${data.status}` };
    case 'inbox:message':  return { icon: <MessageSquare size={14} className="text-cyan-500" />, text: `New inbound message` };
    case 'lead:created':   return { icon: <Target size={14} className="text-violet-500" />, text: `New lead created` };
    default:               return { icon: <Bell size={14} className="text-gray-400" />, text: 'New notification' };
  }
}

// ─── Toast Stack ──────────────────────────────────────────────────────────────

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => {
        const { icon, text } = toastContent(t.event, t.data);
        return (
          <div key={t.id}
            className="pointer-events-auto flex items-center gap-3 bg-white border border-gray-200 shadow-lg rounded-xl px-4 py-3 min-w-[260px] max-w-sm animate-slide-in">
            <div className="flex-shrink-0">{icon}</div>
            <p className="text-sm text-gray-800 flex-1">{text}</p>
            <button onClick={() => onDismiss(t.id)} className="text-gray-300 hover:text-gray-500 flex-shrink-0">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Notification Bell ────────────────────────────────────────────────────────

export function NotificationBell() {
  // Start SSE connection for this component tree
  useSSE();

  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: () => api.get('/notifications').then(r => r.data?.data ?? r.data ?? []),
    refetchInterval: 60_000,
  });

  const unread = notifications.filter(n => !n.readAt).length;

  // Register toast handler once
  useEffect(() => {
    setSSEToastHandler((event, data) => {
      const id = Math.random().toString(36).slice(2);
      setToasts(prev => [...prev.slice(-3), { id, event, data, ts: Date.now() }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5_000);
    });
    return () => setSSEToastHandler(null);
  }, []);

  // Close panel when clicking outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  async function markAllRead() {
    try {
      await api.post('/notifications/read-all');
      qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch {}
  }

  async function markRead(id: string) {
    try {
      await api.patch(`/notifications/${id}/read`);
      qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch {}
  }

  function notifIcon(type: string) {
    if (type?.includes('TICKET')) return <Ticket size={13} className="text-brand-500" />;
    if (type?.includes('INBOX') || type?.includes('MESSAGE')) return <MessageSquare size={13} className="text-cyan-500" />;
    if (type?.includes('LEAD')) return <Target size={13} className="text-violet-500" />;
    return <Bell size={13} className="text-gray-400" />;
  }

  return (
    <>
      <div className="relative" ref={panelRef}>
        <button onClick={() => setOpen(o => !o)}
          className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
          <Bell size={18} />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-2xl shadow-2xl z-50 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
              {unread > 0 && (
                <button onClick={markAllRead} className="text-xs text-brand-600 hover:text-brand-700 font-medium">
                  Mark all read
                </button>
              )}
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
              {notifications.length === 0 ? (
                <div className="text-center py-8">
                  <Bell size={28} className="text-gray-200 mx-auto mb-2" />
                  <p className="text-xs text-gray-400">No notifications yet</p>
                </div>
              ) : (
                notifications.slice(0, 20).map(n => (
                  <button key={n.id} onClick={() => markRead(n.id)}
                    className={`w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors ${!n.readAt ? 'bg-brand-50/50' : ''}`}>
                    <div className="mt-0.5 flex-shrink-0">{notifIcon(n.type)}</div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-medium truncate ${!n.readAt ? 'text-gray-900' : 'text-gray-600'}`}>{n.title}</p>
                      {n.body && <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{n.body}</p>}
                      <p className="text-xs text-gray-300 mt-1">{new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                    {!n.readAt && <span className="w-1.5 h-1.5 bg-brand-500 rounded-full mt-1.5 flex-shrink-0" />}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <ToastStack toasts={toasts} onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))} />
    </>
  );
}
