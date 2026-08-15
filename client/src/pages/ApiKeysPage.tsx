import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Key, Plus, Trash2, Copy, CheckCircle, AlertCircle } from 'lucide-react';
import { useFormat } from '../hooks/useFormat';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  creator: { name: string };
}

// Matches server/src/modules/apikeys/apikeys.controller.ts's SCOPES exactly
// — these are the only scope strings authenticateApiKey() actually checks.
// (Previously this list offered resource-level scopes like "read:tickets"
// that nothing on the backend understood or enforced — every key worked
// the same regardless of what you picked here. 'read' allows GET requests;
// 'write' allows POST/PUT/PATCH/DELETE too; 'admin' also allows managing
// API keys and org settings via the key.)
const ALL_SCOPES = [
  { value: 'read', label: 'Read', hint: 'View data (GET requests)' },
  { value: 'write', label: 'Write', hint: 'Create, update, delete records' },
  { value: 'admin', label: 'Admin', hint: 'Manage org settings & API keys' },
];

export default function ApiKeysPage() {
  const { date } = useFormat();
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Defaults to ['read'] rather than empty — now that scopes are actually
  // enforced (authenticateApiKey checks them on every request), a key
  // created with no scopes at all would authenticate successfully but 403
  // on every single call, which is a confusing dead end for whoever creates it.
  const [form, setForm] = useState({ name: '', scopes: ['read'] as string[], expiresAt: '' });

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['api-keys'],
    queryFn: () => api.get('/api-keys').then(r => Array.isArray(r.data) ? r.data : (r.data.data ?? [])),
  });

  const create = useMutation({
    mutationFn: (body: typeof form) => api.post('/api-keys', body).then(r => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      setNewKey(data.rawKey);
      setForm({ name: '', scopes: ['read'], expiresAt: '' });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  function toggleScope(scope: string) {
    setForm(f => ({
      ...f,
      scopes: f.scopes.includes(scope)
        ? f.scopes.filter(s => s !== scope)
        : [...f.scopes, scope],
    }));
  }

  function copyKey() {
    if (newKey) { navigator.clipboard.writeText(newKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  }

  if (isLoading) return <div className="p-8 text-gray-500">Loading…</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto animate-slide-up">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Key size={24} className="text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">API Keys</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Manage programmatic access to your data</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`${api.defaults.baseURL}/docs`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-sm font-medium"
          >
            API docs
          </a>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium"
          >
            <Plus size={16} /> Create API Key
          </button>
        </div>
      </div>

      {/* New Key Banner */}
      {newKey && (
        <div className="mb-6 p-4 bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={18} className="text-green-600 dark:text-green-400" />
            <span className="font-semibold text-green-800 dark:text-green-300">Your API key is shown once — copy it now before dismissing</span>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <code className="flex-1 bg-white dark:bg-gray-900 border border-green-200 dark:border-green-500/30 rounded-lg px-3 py-2 text-sm font-mono text-gray-800 dark:text-gray-200 truncate">
              {newKey}
            </code>
            <button
              onClick={copyKey}
              className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700"
            >
              {copied ? <CheckCircle size={14} /> : <Copy size={14} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button onClick={() => setNewKey(null)} className="mt-2 text-xs text-green-600 dark:text-green-400 hover:underline">Dismiss</button>
        </div>
      )}

      {/* Keys Table */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        {keys.length === 0 ? (
          <div className="py-16 text-center text-gray-400 dark:text-gray-500">
            <Key size={40} className="mx-auto mb-3 opacity-30" />
            <p>No API keys yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="table-container">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Prefix</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Scopes</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide hidden sm:table-cell">Last Used</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide hidden sm:table-cell">Expires</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Created by</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {keys.map(k => (
                <tr key={k.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{k.name}</td>
                  <td className="px-4 py-3">
                    <code className="bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-xs font-mono">{k.keyPrefix}…</code>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map(s => (
                        <span key={s} className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 rounded text-xs">{s}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 hidden sm:table-cell">
                    {k.lastUsedAt ? date(k.lastUsedAt) : <span className="text-gray-300 dark:text-gray-600">Never</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 hidden sm:table-cell">
                    {k.expiresAt ? (
                      <span className={new Date(k.expiresAt) < new Date() ? 'text-red-500 dark:text-red-400 flex items-center gap-1' : ''}>
                        {new Date(k.expiresAt) < new Date() && <AlertCircle size={12} />}
                        {date(k.expiresAt)}
                      </span>
                    ) : <span className="text-gray-300 dark:text-gray-600">Never</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{k.creator?.name}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => { if (confirm('Revoke this API key?')) revoke.mutate(k.id); }}
                      className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
                      title="Revoke key"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-gray-900 dark:text-white"><Key size={20} /> Create API Key</h2>

            <div className="space-y-3">
              <div className="form-section">
                <p className="form-section-title">Key Details</p>
                <div className="space-y-4">
                  <div>
                    <label className="form-label">Name <span className="req">*</span></label>
                    <input className="ui-input" aria-label="Name" placeholder="e.g. Zapier integration"
                      value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Expires (optional)</label>
                    <input type="date" className="ui-input" value={form.expiresAt}
                      onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} />
                    <p className="form-hint">Leave blank for a non-expiring key</p>
                  </div>
                </div>
              </div>
              <div className="form-section">
                <p className="form-section-title">Permissions</p>
                <div className="space-y-2">
                  {ALL_SCOPES.map(scope => (
                    <label key={scope.value} className="flex items-start gap-2 text-sm cursor-pointer select-none">
                      <input type="checkbox" checked={form.scopes.includes(scope.value)}
                        onChange={() => toggleScope(scope.value)} className="rounded mt-0.5" />
                      <span>
                        <code className="text-xs text-gray-700 dark:text-gray-300 font-semibold">{scope.label}</code>
                        <span className="block text-xs text-gray-400 dark:text-gray-500">{scope.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                disabled={!form.name || form.scopes.length === 0 || create.isPending}
                onClick={() => { create.mutate(form); setShowModal(false); }}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {create.isPending ? 'Creating…' : 'Create Key'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
