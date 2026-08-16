import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { CheckCircle, AlertCircle, Trash2, Send, MessageSquare } from 'lucide-react';

interface TeamsConfig {
  id?: string;
  webhookUrl: string;
  notifyOnNewTicket: boolean;
  notifyOnDealWon: boolean;
  notifyOnNewLead: boolean;
}

const DEFAULT: TeamsConfig = {
  webhookUrl: '',
  notifyOnNewTicket: true,
  notifyOnDealWon: false,
  notifyOnNewLead: false,
};

export default function TeamsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<TeamsConfig>(DEFAULT);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const { data: config, isLoading } = useQuery<TeamsConfig | null>({
    queryKey: ['teams-config'],
    queryFn: () => api.get('/teams').then(r => r.data).catch(() => null),
  });

  useEffect(() => { if (config) setForm(config); }, [config]);

  const save = useMutation({
    mutationFn: (body: TeamsConfig) => api.post('/teams', body).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams-config'] }),
  });

  const disconnect = useMutation({
    mutationFn: () => api.delete('/teams'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['teams-config'] }); setForm(DEFAULT); },
  });

  async function testWebhook() {
    try {
      await api.post('/teams/test');
      setTestResult({ ok: true, msg: 'Test message sent to Teams!' });
    } catch {
      setTestResult({ ok: false, msg: 'Failed to send test message. Check your webhook URL.' });
    }
  }

  const isConnected = !!(config?.webhookUrl);

  if (isLoading) return <div className="p-8 text-gray-500 dark:text-gray-400">Loading...</div>;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-[#464eb8] rounded-xl flex items-center justify-center">
          <MessageSquare size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Microsoft Teams</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Send automated alerts to a Teams channel via Incoming Webhook</p>
        </div>
        {isConnected && (
          <span className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400 rounded-full text-xs font-semibold border border-green-200 dark:border-green-500/30">
            <CheckCircle size={12} /> Connected
          </span>
        )}
      </div>

      <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-100 dark:border-blue-500/30 rounded-xl p-4 mb-6 text-sm text-blue-800 dark:text-blue-300">
        <p className="font-semibold mb-1">Setup Instructions</p>
        <ol className="list-decimal list-inside space-y-1 text-blue-700 dark:text-blue-300">
          <li>In Teams, go to the channel &rarr; More options &rarr; Connectors</li>
          <li>Find <strong>Incoming Webhook</strong> and click Configure</li>
          <li>Give it a name, optionally upload an icon, and click Create</li>
          <li>Copy the webhook URL and paste it below</li>
        </ol>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm p-6 space-y-5">
        <div>
          <label className="form-label">Webhook URL</label>
          <input
            className="ui-input focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-label="Webhook URL" placeholder="https://outlook.office.com/webhook/..."
            value={form.webhookUrl}
            onChange={e => setForm(f => ({ ...f, webhookUrl: e.target.value }))}
          />
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Send notifications for</p>
          <div className="space-y-2">
            {[
              { key: 'notifyOnNewTicket', label: 'New support tickets' },
              { key: 'notifyOnDealWon',   label: 'Deals marked as Won' },
              { key: 'notifyOnNewLead',   label: 'New leads created' },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(form as any)[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))}
                  className="rounded accent-brand-600"
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        {testResult && (
          <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${testResult.ok ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400'}`}>
            {testResult.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
            {testResult.msg}
          </div>
        )}

        <div className="flex gap-3">
          {isConnected && (
            <>
              <button
                onClick={testWebhook}
                className="flex items-center gap-2 px-4 py-2 border border-[#464eb8] text-[#464eb8] dark:text-[#8b91d6] rounded-lg hover:bg-blue-50 dark:hover:bg-blue-500/10 text-sm font-medium"
              >
                <Send size={14} /> Test
              </button>
              <button
                onClick={() => { if (confirm('Disconnect Teams?')) disconnect.mutate(); }}
                className="flex items-center gap-2 px-4 py-2 border border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium"
              >
                <Trash2 size={14} /> Disconnect
              </button>
            </>
          )}
          <button
            disabled={!form.webhookUrl || save.isPending}
            onClick={() => save.mutate(form)}
            className="ml-auto px-6 py-2 bg-[#464eb8] text-white rounded-lg hover:bg-[#3d44a0] text-sm font-medium disabled:opacity-50"
          >
            {save.isPending ? 'Saving...' : isConnected ? 'Save Changes' : 'Connect Teams'}
          </button>
        </div>
      </div>
    </div>
  );
}
