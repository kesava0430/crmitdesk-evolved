import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { RefreshCw, AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';

interface Job {
  id: string;
  type: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  payload: any;
}

const STATUS_TABS = ['FAILED', 'PENDING', 'PROCESSING', 'COMPLETED'] as const;

const STATUS_STYLE: Record<string, string> = {
  FAILED: 'text-red-600 bg-red-50',
  PENDING: 'text-amber-600 bg-amber-50',
  PROCESSING: 'text-blue-600 bg-blue-50',
  COMPLETED: 'text-green-600 bg-green-50',
};

const TYPE_LABEL: Record<string, string> = {
  send_email: 'Email',
  slack_webhook: 'Slack',
  teams_webhook: 'Teams',
  web_push: 'Push notification',
};

/** Best-effort one-line description of what a job was trying to deliver, for the admin's benefit — payload shapes are internal (see jobQueue.ts callers), so this is deliberately defensive. */
function describePayload(type: string, payload: any): string {
  try {
    if (type === 'send_email') return `To: ${payload?.to ?? 'unknown'} — "${payload?.subject ?? ''}"`;
    if (type === 'slack_webhook' || type === 'teams_webhook') return payload?.payload?.text ?? 'Notification';
    if (type === 'web_push') return payload?.body ? JSON.parse(payload.body)?.title ?? 'Push notification' : 'Push notification';
  } catch { /* fall through */ }
  return '—';
}

export default function JobsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<typeof STATUS_TABS[number]>('FAILED');

  const { data, isLoading } = useQuery<{ data: Job[]; summary: Record<string, number> }>({
    queryKey: ['jobs', status],
    queryFn: () => api.get(`/jobs?status=${status}`).then(r => r.data),
    refetchInterval: 15_000, // matches the server poll interval — see jobQueue.ts
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/jobs/${id}/retry`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const jobs = data?.data ?? [];
  const summary = data?.summary ?? { PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };

  return (
    <div className="p-6 max-w-5xl mx-auto animate-slide-up">
      <div className="flex items-center gap-3 mb-2">
        <RefreshCw size={24} className="text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Background Jobs</h1>
          <p className="text-sm text-gray-500">
            Email, Slack, Teams, and push notifications retry automatically on failure. Anything here has already been retried up to its limit — retry it manually, or check the error below to see why it keeps failing.
          </p>
        </div>
      </div>

      <div className="flex gap-2 mt-6 mb-4">
        {STATUS_TABS.map(s => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${status === s ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {s === 'FAILED' && <AlertTriangle size={13} className="inline mr-1 -mt-0.5" />}
            {s === 'COMPLETED' && <CheckCircle2 size={13} className="inline mr-1 -mt-0.5" />}
            {s.charAt(0) + s.slice(1).toLowerCase()} ({summary[s] ?? 0})
          </button>
        ))}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        {isLoading ? (
          <div className="py-16 text-center text-gray-400"><Loader2 size={24} className="mx-auto animate-spin" /></div>
        ) : jobs.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <CheckCircle2 size={40} className="mx-auto mb-3 opacity-30" />
            <p>Nothing here.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Details</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Attempts</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide hidden sm:table-cell">Last error</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {jobs.map(j => (
                  <tr key={j.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{TYPE_LABEL[j.type] ?? j.type}</td>
                    <td className="px-4 py-3 text-gray-600 max-w-[240px] truncate" title={describePayload(j.type, j.payload)}>
                      {describePayload(j.type, j.payload)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[j.status]}`}>{j.status}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{j.attempts} / {j.maxAttempts}</td>
                    <td className="px-4 py-3 text-red-500 text-xs max-w-[260px] truncate hidden sm:table-cell" title={j.lastError ?? ''}>
                      {j.lastError ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {j.status === 'FAILED' && (
                        <button
                          onClick={() => retry.mutate(j.id)}
                          disabled={retry.isPending}
                          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 rounded-lg transition-colors disabled:opacity-50"
                        >
                          <RefreshCw size={12} className={retry.isPending && retry.variables === j.id ? 'animate-spin' : ''} /> Retry
                        </button>
                      )}
                      {j.status === 'PENDING' && (
                        <span className="flex items-center gap-1 text-xs text-gray-400">
                          <Clock size={12} /> {new Date(j.nextAttemptAt).toLocaleTimeString()}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
