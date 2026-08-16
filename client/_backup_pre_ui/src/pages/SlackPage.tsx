import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Slack, CheckCircle, AlertCircle, Trash2, Send } from 'lucide-react';

interface SlackConfig {
  id?: string;
  webhookUrl: string;
  channel: string;
  notifyOnNewTicket: boolean;
  notifyOnCritical: boolean;
  notifyOnSlaBreached: boolean;
  notifyOnDealWon: boolean;
  notifyOnNewLead: boolean;
}

const DEFAULT: SlackConfig = {
  webhookUrl: '',
  channel: '#general',
  notifyOnNewTicket: true,
  notifyOnCritical: true,
  notifyOnSlaBreached: true,
  notifyOnDealWon: false,
  notifyOnNewLead: false,
};

export default function SlackPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<SlackConfig>(DEFAULT);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const { data: config, isLoading } = useQuery<SlackConfig | null>({
    queryKey: ['slack-config'],
    queryFn: () => api.get('/slack/config').then(r => r.data),
  });

  useEffect(() => { if (config) setForm(config); }, [config]);

  const save = useMutation({
    mutationFn: (data: SlackConfig) => api.put('/slack/config', data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['slack-config'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete('/slack/config'),
    onSuccess: () => {
      setForm(DEFAULT);
      qc.invalidateQueries({ queryKey: ['slack-config'] });
    },
  });

  async function sendTest() {
    setTestResult(null);
    try {
      await api.post('/slack/test');
      setTestResult({ ok: true, msg: 'Test message sent! Check your Slack channel.' });
    } catch (err: any) {
      setTestResult({ ok: false, msg: err.response?.data?.error ?? 'Failed to send test message' });
    }
  }

  const connected = Boolean(config?.webhookUrl);

  function toggle(field: keyof SlackConfig) {
    setForm(prev => ({ ...prev, [field]: !prev[field as keyof SlackConfig] }));
  }

  if (isLoading) return <div className="flex items-center justify-center h-64 text-gray-400 dark:text-gray-500">Loading...</div>;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-[#4A154B] rounded-xl flex items-center justify-center">
          <Slack size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Slack Integration</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Get real-time alerts in Slack for important events</p>
        </div>
        {connected && (
          <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 px-2.5 py-1 rounded-full">
            <CheckCircle size={12} /> Connected
          </span>
        )}
      </div>

      <div className="space-y-5">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">Webhook Configuration</h2>
          <div className="space-y-4">
            <div>
              <label className="form-label">Incoming Webhook URL</label>
              <input
                type="url"
                value={form.webhookUrl}
                onChange={e => setForm(p => ({ ...p, webhookUrl: e.target.value }))}
                aria-label="Webhook URL" placeholder="https://hooks.slack.com/services/T.../B.../..."
                className="ui-input focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Create an incoming webhook at{' '}
                <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-brand-600 dark:text-brand-400 hover:underline">
                  api.slack.com/apps
                </a>
              </p>
            </div>
            <div>
              <label className="form-label">Default Channel</label>
              <input
                type="text"
                value={form.channel}
                onChange={e => setForm(p => ({ ...p, channel: e.target.value }))}
                placeholder="#general"
                className="ui-input focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">Notify me when...</h2>
          <div className="space-y-3">
            {[
              { key: 'notifyOnNewTicket',   label: 'New ticket created',      desc: 'Any priority' },
              { key: 'notifyOnCritical',    label: 'Critical ticket created', desc: 'CRITICAL priority only' },
              { key: 'notifyOnSlaBreached', label: 'SLA is breached',         desc: 'Resolution deadline exceeded' },
              { key: 'notifyOnDealWon',     label: 'Deal is marked Won',      desc: 'CRM pipeline update' },
              { key: 'notifyOnNewLead',     label: 'New lead captured',       desc: 'Lead created in CRM' },
            ].map(({ key, label, desc }) => (
              <label key={key} className="flex items-start gap-3 cursor-pointer group">
                <div className="relative mt-0.5">
                  <input
                    type="checkbox"
                    checked={Boolean(form[key as keyof SlackConfig])}
                    onChange={() => toggle(key as keyof SlackConfig)}
                    className="sr-only"
                  />
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    form[key as keyof SlackConfig] ? 'bg-brand-600 border-brand-600' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 group-hover:border-brand-400'
                  }`}>
                    {form[key as keyof SlackConfig] && <CheckCircle size={10} className="text-white" />}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{label}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">{desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {saved && (
          <div className="flex items-center gap-2 p-3 rounded-lg text-sm bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-500/30">
            <CheckCircle size={15} /> Configuration saved successfully!
          </div>
        )}

        {testResult && (
          <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${testResult.ok ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400'}`}>
            {testResult.ok ? <CheckCircle size={15} /> : <AlertCircle size={15} />}
            {testResult.msg}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={() => save.mutate(form)}
            disabled={!form.webhookUrl || save.isPending}
            className="flex-1 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {save.isPending ? 'Saving...' : connected ? 'Update Configuration' : 'Connect Slack'}
          </button>
          {connected && (
            <>
              <button
                onClick={sendTest}
                className="flex items-center gap-1.5 px-4 py-2.5 border border-gray-200 dark:border-gray-700 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <Send size={14} /> Test
              </button>
              <button
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                className="flex items-center gap-1.5 px-4 py-2.5 border border-red-200 dark:border-red-500/30 rounded-xl text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={14} /> Disconnect
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
