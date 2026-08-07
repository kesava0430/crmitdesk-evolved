import { useState } from 'react';
import { Users, Plus, ToggleLeft, ToggleRight, Trash2, Send, X, ExternalLink, Copy, CheckCircle } from 'lucide-react';
import {
  usePortalUsers, useCreatePortalUser, useTogglePortalUser,
  useDeletePortalUser, useResendPortalInvite,
} from '../../api/portalAdmin';
import { useAuth } from '../../contexts/AuthContext';
import { Spinner, RowActions } from '../../shared/components';

export function PortalUsersPage() {
  const { user } = useAuth();
  const { data: portalUsers = [], isLoading } = usePortalUsers();
  const createUser = useCreatePortalUser();
  const toggleUser = useTogglePortalUser();
  const deleteUser = useDeletePortalUser();
  const resendInvite = useResendPortalInvite();

  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  const [copied, setCopied] = useState(false);

  const orgId = user?.orgId || '';
  const portalUrl = `${window.location.origin}/portal?org=${orgId}`;

  function copyPortalLink() {
    navigator.clipboard.writeText(portalUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  function handleCreate() {
    createUser.mutate({ name, email, sendInvite }, {
      onSuccess: () => { setShowModal(false); setName(''); setEmail(''); setSendInvite(true); }
    });
  }

  return (
    <div className="p-6 max-w-4xl mx-auto animate-slide-up">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Users size={20} className="text-brand-600" />
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Customer Portal</h1>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage customer access to the self-service support portal.</p>
        </div>
        <button onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700">
          <Plus size={15} /> Add Customer
        </button>
      </div>

      {/* Portal Link Banner */}
      <div className="bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/20 rounded-xl p-4 mb-6 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-violet-800 dark:text-violet-300 mb-0.5">Portal Link</p>
          <p className="text-xs text-violet-600 dark:text-violet-400 truncate">{portalUrl}</p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={copyPortalLink}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white dark:bg-gray-900 border border-violet-200 dark:border-violet-500/20 text-violet-700 dark:text-violet-300 rounded-lg hover:bg-violet-50 dark:hover:bg-violet-500/10">
            {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
            {copied ? 'Copied!' : 'Copy link'}
          </button>
          <a href={portalUrl} target="_blank" rel="noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-violet-600 text-white rounded-lg hover:bg-violet-700">
            <ExternalLink size={12} /> Preview
          </a>
        </div>
      </div>

      {/* Stats */}
      {portalUsers.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {[
            { label: 'Total Customers', value: portalUsers.length },
            { label: 'Active', value: portalUsers.filter(u => u.isActive).length },
            { label: 'Never logged in', value: portalUsers.filter(u => !u.lastLoginAt).length },
          ].map(s => (
            <div key={s.label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-4 text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{s.value}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* User list */}
      {isLoading ? <Spinner label="Loading…" /> : portalUsers.length === 0 ? (
        <div className="text-center py-16 bg-white dark:bg-gray-900 border border-dashed border-gray-200 dark:border-gray-700 rounded-2xl">
          <div className="w-14 h-14 rounded-2xl bg-brand-50 dark:bg-brand-500/10 flex items-center justify-center mx-auto mb-4">
            <Users size={24} className="text-brand-400" />
          </div>
          <h3 className="text-base font-semibold text-gray-700 dark:text-gray-300 mb-1">No portal customers yet</h3>
          <p className="text-sm text-gray-400 dark:text-gray-500 max-w-sm mx-auto mb-5">Add customers to give them access to submit and track support tickets without a full account.</p>
          <button onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700">
            <Plus size={14} /> Add first customer
          </button>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
          <div className="table-container">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-800">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Customer</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell">Last login</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell">Added</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {portalUsers.map(u => (
                <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center text-sm font-bold flex-shrink-0">
                        {u.name[0]?.toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">{u.name}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${u.isActive ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-gray-500 dark:text-gray-400 hidden sm:table-cell">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : <span className="text-gray-300 dark:text-gray-600">Never</span>}
                  </td>
                  <td className="px-5 py-3.5 text-xs text-gray-400 dark:text-gray-500 hidden sm:table-cell">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3.5">
                    <RowActions items={[
                      { label: 'Resend invite', icon: <Send size={13} />, onClick: () => resendInvite.mutate(u.id) },
                      { label: u.isActive ? 'Deactivate' : 'Activate', icon: u.isActive ? <ToggleRight size={16} /> : <ToggleLeft size={16} />, onClick: () => toggleUser.mutate(u.id) },
                      { label: 'Remove user', icon: <Trash2 size={13} />, onClick: () => { if (confirm('Remove this portal user?')) deleteUser.mutate(u.id); }, variant: 'danger' },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Add Customer Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-gray-900 dark:text-white">Add Portal Customer</h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div className="form-section">
                <p className="form-section-title">Customer Details</p>
                <div className="space-y-4">
                  <div>
                    <label className="form-label">Full Name <span className="req">*</span></label>
                    <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Jane Smith" className="ui-input" />
                  </div>
                  <div>
                    <label className="form-label">Email <span className="req">*</span></label>
                    <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="jane@company.com" className="ui-input" />
                  </div>
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input type="checkbox" checked={sendInvite} onChange={e => setSendInvite(e.target.checked)} className="w-4 h-4 accent-brand-600" />
                    <span className="text-gray-600 dark:text-gray-300">Send invite email with portal link</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="flex-1 px-4 py-2 text-sm border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
              <button onClick={handleCreate} disabled={!name || !email || createUser.isPending}
                className="flex-1 px-4 py-2 text-sm bg-brand-600 text-white rounded-xl hover:bg-brand-700 disabled:opacity-40 flex items-center justify-center gap-2">
                {createUser.isPending && <Spinner />}
                Add Customer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
