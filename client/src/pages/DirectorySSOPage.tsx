import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { KeyRound, CheckCircle, AlertCircle, Trash2, Zap, Copy, Check } from 'lucide-react';

interface DirectoryConfig {
  tenantId: string;
  clientId: string;
  hasClientSecret: boolean;
  loginSlug: string;
  isEnabled: boolean;
  loginUrl: string;
  redirectUri: string;
  updatedAt: string;
}

interface Form {
  tenantId: string; clientId: string; clientSecret: string; loginSlug: string; isEnabled: boolean;
}

const DEFAULT: Form = { tenantId: '', clientId: '', clientSecret: '', loginSlug: '', isEnabled: true };

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label className="form-label">{label}</label>
      <div className="flex items-center gap-2">
        <input readOnly value={value} className="ui-input font-mono text-xs" onFocus={e => e.target.select()} />
        <button
          type="button"
          onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="shrink-0 p-2.5 border border-gray-200 dark:border-gray-700 rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={14} className="text-green-600 dark:text-green-400" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

export default function DirectorySSOPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(DEFAULT);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const { data: config, isLoading } = useQuery<DirectoryConfig | null>({
    queryKey: ['directory-config'],
    queryFn: () => api.get('/directory/config').then(r => r.data),
  });

  useEffect(() => {
    if (config) setForm({ tenantId: config.tenantId, clientId: config.clientId, clientSecret: '', loginSlug: config.loginSlug, isEnabled: config.isEnabled });
  }, [config]);

  const save = useMutation({
    mutationFn: (data: Form) => api.put('/directory/config', data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['directory-config'] });
      setForm(f => ({ ...f, clientSecret: '' }));
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete('/directory/config'),
    onSuccess: () => {
      setForm(DEFAULT);
      qc.invalidateQueries({ queryKey: ['directory-config'] });
    },
  });

  async function runTest() {
    setTestResult(null);
    try {
      const { data } = await api.post('/directory/test');
      setTestResult({ ok: true, msg: data.message });
    } catch (err: any) {
      setTestResult({ ok: false, msg: err.response?.data?.error ?? 'Test failed' });
    }
  }

  const connected = !!config;
  const canSave = !!form.tenantId && !!form.clientId && !!form.loginSlug && (connected || !!form.clientSecret);

  if (isLoading) return <div className="flex items-center justify-center h-64 text-gray-400 dark:text-gray-500">Loading...</div>;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-[#0078D4] rounded-xl flex items-center justify-center">
          <KeyRound size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Single Sign-On (Microsoft Entra ID)</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Let employees sign in with their Microsoft work account</p>
        </div>
        {connected && form.isEnabled && (
          <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 px-2.5 py-1 rounded-full">
            <CheckCircle size={12} /> Connected
          </span>
        )}
      </div>

      <div className="space-y-5">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">Entra App Registration</h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
            Register CRMITdesk as an app in your organization's Microsoft Entra admin center, then paste its details here.
            Only existing CRMITdesk accounts can sign in this way — new employees are still added via Invite.
          </p>
          <div className="space-y-4">
            <div>
              <label className="form-label">Tenant ID</label>
              <input className="ui-input" value={form.tenantId} onChange={e => setForm(f => ({ ...f, tenantId: e.target.value }))} placeholder="00000000-0000-0000-0000-000000000000" />
            </div>
            <div>
              <label className="form-label">Client (Application) ID</label>
              <input className="ui-input" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} placeholder="00000000-0000-0000-0000-000000000000" />
            </div>
            <div>
              <label className="form-label">Client Secret</label>
              <input type="password" className="ui-input" value={form.clientSecret} onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))}
                placeholder={config?.hasClientSecret ? '•••••••••••••• (saved — leave blank to keep it)' : 'Paste the secret value'} />
            </div>
            <div>
              <label className="form-label">Sign-in link</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400 dark:text-gray-500 shrink-0">/login/</span>
                <input className="ui-input" value={form.loginSlug} onChange={e => setForm(f => ({ ...f, loginSlug: e.target.value.toLowerCase() }))} placeholder="acme" />
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">Share this link with your employees to sign in with Microsoft.</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={form.isEnabled} onChange={e => setForm(f => ({ ...f, isEnabled: e.target.checked }))} />
              Enabled
            </label>
          </div>
        </div>

        {connected && (
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Give these to your Entra admin</h2>
            <CopyField label="Redirect URI (add under Authentication in your app registration)" value={config.redirectUri} />
            <CopyField label="Employee sign-in link" value={config.loginUrl} />
          </div>
        )}

        {saved && (
          <div className="flex items-center gap-2 p-3 rounded-lg text-sm bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-500/30">
            <CheckCircle size={15} /> Configuration saved successfully!
          </div>
        )}
        {save.isError && (
          <div className="flex items-center gap-2 p-3 rounded-lg text-sm bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-500/30">
            <AlertCircle size={15} /> {(save.error as any)?.response?.data?.error ?? 'Could not save configuration'}
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
            disabled={!canSave || save.isPending}
            className="flex-1 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {save.isPending ? 'Saving...' : connected ? 'Update Configuration' : 'Connect Microsoft Entra ID'}
          </button>
          {connected && (
            <>
              <button
                onClick={runTest}
                className="flex items-center gap-1.5 px-4 py-2.5 border border-gray-200 dark:border-gray-700 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <Zap size={14} /> Test
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
