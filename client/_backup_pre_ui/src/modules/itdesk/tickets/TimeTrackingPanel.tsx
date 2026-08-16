import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { Clock, Plus, Trash2 } from 'lucide-react';
import { useFormat } from '../../../hooks/useFormat';

interface TimeEntry {
  id: string;
  minutes: number;
  description: string | null;
  loggedAt: string;
  createdAt: string;
  user: { name: string };
}

interface Props { ticketId: string; }

export function TimeTrackingPanel({ ticketId }: Props) {
  const { dateTime: fmtLoggedAt } = useFormat();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ minutes: '', note: '' });

  const { data } = useQuery<{ entries: TimeEntry[]; totalMinutes: number }>({
    queryKey: ['time-entries', ticketId],
    queryFn: () => api.get(`/itdesk/time-tracking/${ticketId}`).then(r => r.data),
  });

  const log = useMutation({
    mutationFn: (body: { minutes: number; description?: string }) =>
      api.post(`/itdesk/time-tracking/${ticketId}`, body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['time-entries', ticketId] });
      setForm({ minutes: '', note: '' });
      setShowForm(false);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/itdesk/time-tracking/entry/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['time-entries', ticketId] }),
  });

  const entries = data?.entries ?? [];
  const totalMinutes = data?.totalMinutes ?? 0;

  function formatTime(min: number) {
    if (min < 60) return `${min}m`;
    return `${Math.floor(min / 60)}h ${min % 60}m`;
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden dark:bg-gray-900 dark:border-gray-700">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <Clock size={16} className="text-brand-600 dark:text-brand-400" />
          <span className="font-semibold text-gray-800 text-sm dark:text-gray-100">Time Tracking</span>
          {totalMinutes > 0 && (
            <span className="px-2 py-0.5 bg-brand-50 text-brand-700 rounded-full text-xs font-semibold dark:bg-brand-500/10 dark:text-brand-300">
              {formatTime(totalMinutes)} total
            </span>
          )}
        </div>
        <button
          onClick={() => setShowForm(f => !f)}
          className="flex items-center gap-1 px-2.5 py-1 bg-brand-50 text-brand-700 rounded-lg text-xs font-medium hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/20"
        >
          <Plus size={12} /> Log time
        </button>
      </div>

      {showForm && (
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 dark:bg-gray-800/60 dark:border-gray-800">
          <div className="flex items-end gap-3">
            <div className="flex-shrink-0">
              <label htmlFor="tt-minutes" className="form-label">Minutes</label>
              <input
                id="tt-minutes"
                aria-label="Minutes"
                type="number"
                min="1"
                className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-brand-500 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500"
                placeholder="30"
                value={form.minutes}
                onChange={e => setForm(f => ({ ...f, minutes: e.target.value }))}
              />
            </div>
            <div className="flex-1">
              <label htmlFor="tt-note" className="form-label">Note (optional)</label>
              <input
                id="tt-note"
                aria-label="Note"
                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500"
                placeholder="What did you work on?"
                value={form.note}
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowForm(false)} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
              <button
                disabled={!form.minutes || Number(form.minutes) < 1 || log.isPending}
                onClick={() => log.mutate({ minutes: Number(form.minutes), description: form.note || undefined })}
                className="px-3 py-1.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {log.isPending ? 'Saving…' : 'Log'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="divide-y divide-gray-50 dark:divide-gray-800">
        {entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400 dark:text-gray-500">No time logged yet.</div>
        ) : (
          entries.map(e => (
            <div key={e.id} className="px-4 py-3 flex items-start justify-between group hover:bg-gray-50 dark:hover:bg-gray-800">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-bold flex-shrink-0 dark:bg-brand-500/10 dark:text-brand-300">
                  {e.user.name[0].toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{formatTime(e.minutes)}</span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">by {e.user.name}</span>
                  </div>
                  {e.description && <p className="text-xs text-gray-500 mt-0.5 dark:text-gray-400">{e.description}</p>}
                  <p className="text-xs text-gray-300 mt-0.5 dark:text-gray-600">{fmtLoggedAt(e.loggedAt || e.createdAt)}</p>
                </div>
              </div>
              <button
                aria-label="Delete time entry"
                onClick={() => remove.mutate(e.id)}
                className="opacity-0 group-hover:opacity-100 p-1 text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 rounded transition-opacity"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
