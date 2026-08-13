import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { KeyRound, CheckCircle, AlertCircle, Trash2, Zap, Copy, Check, Plus, Pencil, X, RefreshCw } from 'lucide-react';

const ROLES = ['SUPER_ADMIN', 'CRM_MANAGER', 'SALES_REP', 'IT_MANAGER', 'IT_AGENT', 'EMPLOYEE'];

interface DirectoryConfig {
  tenantId: string;
  clientId: string;
  hasClientSecret: boolean;
  loginSlug: string;
  isEnabled: boolean;
  autoProvisioningEnabled: boolean;
  defaultRole: string;
  loginUrl: string;
  redirectUri: string;
  updatedAt: string;
}

interface RoleMapping {
  id: string;
  groupId: string;
  groupLabel: string;
  role: string;
  priority: number;
}

interface Form {
  tenantId: string; clientId: string; clientSecret: string; loginSlug: string; isEnabled: boolean;
  autoProvisioningEnabled: boolean; defaultRole: string;
}

const DEFAULT: Form = { tenantId: '', clientId: '', clientSecret: '', loginSlug: '', isEnabled: true, autoProvisioningEnabled: false, defaultRole: 'EMPLOYEE' };

const MAPPING_DEFAULT = { groupId: '', groupLabel: '', role: 'EMPLOYEE', priority: 0 };

function RoleMappingsSection() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(MAPPING_DEFAULT);
  const [adding, setAdding] = useState(false);

  const { data: mappings = [], isLoading } = useQuery<RoleMapping[]>({
    queryKey: ['directory-mappings'],
    queryFn: () => api.get('/directory/mappings').then(r => r.data),
  });

  const create = useMutation({
    mutationFn: (data: typeof MAPPING_DEFAULT) => api.post('/directory/mappings', data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['directory-mappings'] }); setAdding(false); setForm(MAPPING_DEFAULT); },
  });

  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: typeof MAPPING_DEFAULT }) => api.patch(`/directory/mappings/${id}`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['directory-mappings'] }); setEditingId(null); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/directory/mappings/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['directory-mappings'] }),
  });

  function startEdit(m: RoleMapping) {
    setEditingId(m.id);
    setForm({ groupId: m.groupId, groupLabel: m.groupLabel, role: m.role, priority: m.priority });
  }

  const rowForm = (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_140px_80px_auto] gap-2 items-start">
      <input className="ui-input text-xs" placeholder="Entra group object ID" value={form.groupId} onChange={e => setForm(f => ({ ...f, groupId: e.target.value }))} />
      <input className="ui-input text-xs" placeholder="Group name (for reference)" value={form.groupLabel} onChange={e => setForm(f => ({ ...f, groupLabel: e.target.value }))} />
      <select className="ui-input text-xs" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
        {ROLES.map(r => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
      </select>
      <input type="number" className="ui-input text-xs" placeholder="Priority" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) || 0 }))} />
      <div className="flex items-center gap-1">
        <button
          onClick={() => editingId ? update.mutate({ id: editingId, data: form }) : create.mutate(form)}
          disabled={!form.groupId || !form.groupLabel || create.isPending || update.isPending}
          className="p-2 rounded-lg bg-brand-600 text-white disabled:opacity-50"
          aria-label="Save mapping"
        >
          <Check size={14} />
        </button>
        <button
          onClick={() => { setAdding(false); setEditingId(null); setForm(MAPPING_DEFAULT); }}
          className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400"
          aria-label="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Group → role mapping</h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            People in the highest-priority matching group get that role. Anyone not in a mapped group gets the default role above.
          </p>
        </div>
        {!adding && (
          <button
            onClick={() => { setAdding(true); setEditingId(null); setForm(MAPPING_DEFAULT); }}
            className="flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline shrink-0"
          >
            <Plus size={14} /> Add mapping
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading...</p>
      ) : mappings.length === 0 && !adding ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">No group mappings yet — everyone provisioned via SSO gets the default role.</p>
      ) : (
        <div className="space-y-2">
          {mappings.map(m => editingId === m.id ? (
            <div key={m.id}>{rowForm}</div>
          ) : (
            <div key={m.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
              <span className="flex-1 truncate text-gray-700 dark:text-gray-300">{m.groupLabel}</span>
              <span className="text-gray-400 dark:text-gray-500">priority {m.priority}</span>
              <span className="font-medium text-gray-800 dark:text-gray-200">{m.role.replace(/_/g, ' ')}</span>
              <button onClick={() => startEdit(m)} className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label="Edit mapping"><Pencil size={13} /></button>
              <button onClick={() => remove.mutate(m.id)} className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400" aria-label="Delete mapping"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}

      {adding && rowForm}
    </div>
  );
}

interface SyncLog {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'OK' | 'ERROR';
  usersCreated: number;
  usersDeactivated: number;
  errorMessage: string | null;
}

function SyncSection({ autoProvisioningEnabled }: { autoProvisioningEnabled: boolean }) {
  const qc = useQueryClient();

  const { data: logs = [] } = useQuery<SyncLog[]>({
    queryKey: ['directory-sync-logs'],
    queryFn: () => api.get('/directory/sync-logs').then(r => r.data),
  });

  const sync = useMutation({
    mutationFn: () => api.post('/directory/sync').then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['directory-sync-logs'] }),
  });

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Scheduled sync</h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            Runs automatically once a day, pre-creating and deactivating accounts based on group membership.
            {!autoProvisioningEnabled && ' Turn on automatic provisioning above to enable it.'}
          </p>
        </div>
        <button
          onClick={() => sync.mutate()}
          disabled={!autoProvisioningEnabled || sync.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 shrink-0"
        >
          <RefreshCw size={13} className={sync.isPending ? 'animate-spin' : ''} /> Sync Now
        </button>
      </div>

      {sync.isError && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg text-xs bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-500/30">
          <AlertCircle size={13} /> {(sync.error as any)?.response?.data?.error ?? 'Sync failed'}
        </div>
      )}

      {logs.length > 0 && (
        <div className="space-y-1.5">
          {logs.slice(0, 5).map(log => (
            <div key={log.id} className="flex items-center gap-3 text-xs py-1 border-b border-gray-100 dark:border-gray-800 last:border-0">
              <span className={`shrink-0 ${log.status === 'OK' ? 'text-green-600 dark:text-green-400' : log.status === 'ERROR' ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}`}>
                {log.status === 'RUNNING' ? 'Running…' : log.status === 'OK' ? 'Succeeded' : 'Failed'}
              </span>
              <span className="text-gray-400 dark:text-gray-500">{new Date(log.startedAt).toLocaleString()}</span>
              {log.status === 'OK' && (
                <span className="text-gray-500 dark:text-gray-400 ml-auto">
                  +{log.usersCreated} created, {log.usersDeactivated} deactivated
                </span>
              )}
              {log.status === 'ERROR' && <span className="text-red-500 dark:text-red-400 ml-auto truncate">{log.errorMessage}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
    if (config) setForm({
      tenantId: config.tenantId, clientId: config.clientId, clientSecret: '', loginSlug: config.loginSlug, isEnabled: config.isEnabled,
      autoProvisioningEnabled: config.autoProvisioningEnabled, defaultRole: config.defaultRole,
    });
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
            Existing CRMITdesk accounts can always sign in this way; turn on automatic provisioning below to also create accounts for new employees on first sign-in.
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

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">Automatic provisioning</h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
            When enabled, people signing in with Microsoft for the first time get a CRMITdesk account automatically instead of needing an Invite.
          </p>
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={form.autoProvisioningEnabled} onChange={e => setForm(f => ({ ...f, autoProvisioningEnabled: e.target.checked }))} />
              Automatically create accounts for new Microsoft sign-ins
            </label>
            <div>
              <label className="form-label">Default role</label>
              <select className="ui-input" value={form.defaultRole} onChange={e => setForm(f => ({ ...f, defaultRole: e.target.value }))}>
                {ROLES.map(r => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">Given to anyone not in a group mapped below.</p>
            </div>
          </div>
        </div>

        {connected && <RoleMappingsSection />}
        {connected && <SyncSection autoProvisioningEnabled={config.autoProvisioningEnabled} />}

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
