import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { PageHeader, Button, Modal, Badge, SearchInput, EmptyState, Spinner, SearchableSelect, RowActions } from '../shared/components';
import { Users, Plus, UserX, Pencil, Shield, Mail, Copy, Check, KeyRound } from 'lucide-react';
import { useFormat } from '../hooks/useFormat';

const ROLES = ['SUPER_ADMIN','CRM_MANAGER','SALES_REP','IT_MANAGER','IT_AGENT','EMPLOYEE'];
const roleVariant: Record<string, any> = {
  SUPER_ADMIN: 'red', CRM_MANAGER: 'purple', SALES_REP: 'blue',
  IT_MANAGER: 'orange', IT_AGENT: 'yellow', EMPLOYEE: 'gray',
};

function UserForm({ initial, onSubmit, loading }: any) {
  const [form, setForm] = useState(initial || { name: '', email: '', password: '', role: 'EMPLOYEE', department: '', phone: '' });
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: e.target.value }));
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(form); }} className="space-y-3">
      <div className="form-section">
        <p className="form-section-title">Account Details</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="form-label">Full Name <span className="req">*</span></label>
            <input aria-label="Full Name" required className="ui-input" value={form.name} onChange={f('name')} placeholder="Jane Smith" />
          </div>
          <div>
            <label className="form-label">Email <span className="req">*</span></label>
            <input aria-label="Email" required type="email" className="ui-input" value={form.email} onChange={f('email')} disabled={!!initial} placeholder="jane@company.com" />
          </div>
          {!initial && (
            <div>
              <label className="form-label">Password <span className="req">*</span></label>
              <input aria-label="Password" required type="password" minLength={8} className="ui-input" value={form.password} onChange={f('password')} placeholder="Min 8 characters" />
            </div>
          )}
          <div>
            <label className="form-label">Department</label>
            <input className="ui-input" value={form.department} onChange={f('department')} placeholder="e.g. Engineering, Sales" />
          </div>
          <div>
            <label className="form-label">Phone (WhatsApp)</label>
            <input aria-label="Phone" className="ui-input" value={form.phone || ''} onChange={f('phone')} placeholder="+14155551234" />
          </div>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Permissions</p>
        <div>
          <label className="form-label">Role <span className="req">*</span></label>
<SearchableSelect ariaLabel="Role" value={form.role} onChange={val => setForm((p: any) => ({ ...p, role: val }))} required options={ROLES.map(r => ({ value: r, label: r.replace(/_/g, ' ') }))} />
          <p className="form-hint">Controls what this user can see and do in the system.</p>
        </div>
      </div>
      <div className="flex justify-end pt-1">
        <Button type="submit" loading={loading}>{initial ? 'Save Changes' : 'Create User'}</Button>
      </div>
    </form>
  );
}

function InviteForm({ onSuccess }: { onSuccess: (link: string) => void }) {
  const [form, setForm] = useState({ email: '', role: 'EMPLOYEE' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/admin/users/invite', form);
      onSuccess(res.data.link);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to send invite');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 text-sm px-3 py-2.5 rounded-lg">{error}</div>}
      <div className="form-section">
        <p className="form-section-title">Invite Details</p>
        <div className="space-y-4">
          <div>
            <label className="form-label">Email address <span className="req">*</span></label>
            <input aria-label="Email" required type="email" className="ui-input" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="colleague@company.com" />
          </div>
          <div>
            <label className="form-label">Role</label>
<SearchableSelect ariaLabel="Role" value={form.role} onChange={val => setForm(f => ({ ...f, role: val }))} required options={ROLES.map(r => ({ value: r, label: r.replace(/_/g, ' ') }))} />
            <p className="form-hint">An invite link will be generated. Share it with the person you're inviting.</p>
          </div>
        </div>
      </div>
      <div className="flex justify-end pt-1">
        <Button type="submit" loading={loading} icon={<Mail size={14} />}>Generate Invite Link</Button>
      </div>
    </form>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-lg">
        <Check size={16} className="text-green-600 dark:text-green-400 flex-shrink-0" />
        <span className="text-sm text-green-700 dark:text-green-300 font-medium">Invite link generated!</span>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300">Share this link with the invitee — it expires in 7 days:</p>
      <div className="flex gap-2">
        <input readOnly value={link} className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-gray-50 dark:bg-gray-800 dark:text-gray-200 font-mono truncate" />
        <button onClick={copy} className="flex items-center gap-1 px-3 py-2 bg-brand-600 text-white text-xs rounded-lg hover:bg-brand-700 transition-colors flex-shrink-0">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

type ModalState = null | 'create' | 'invite' | { type: 'edit'; user: any };

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const { date } = useFormat();
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get('/admin/users').then(r => Array.isArray(r.data) ? r.data : r.data.data ?? []),
  });

  const { data: invites } = useQuery({
    queryKey: ['admin-invites'],
    queryFn: () => api.get('/org/invites').then(r => r.data),
  });

  const create = useMutation({
    mutationFn: (data: any) => api.post('/admin/users', data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-users'] }); setModal(null); },
  });
  const update = useMutation({
    mutationFn: ({ id, ...data }: any) => api.patch(`/admin/users/${id}`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-users'] }); setModal(null); },
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/reset-password`).then(r => r.data),
    onSuccess: (data: any) => alert(data?.message || 'Reset link sent.'),
    onError: (err: any) => alert(err?.response?.data?.error || 'Could not send reset link.'),
  });

  const filtered = users?.filter((u: any) =>
    !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase())
  );

  const roleGroups = ROLES.reduce((acc: any, role) => {
    acc[role] = users?.filter((u: any) => u.role === role).length || 0;
    return acc;
  }, {});

  const pendingInvites = invites?.filter((i: any) => !i.usedAt && new Date(i.expiresAt) > new Date()) || [];

  function closeModal() {
    setModal(null);
    setInviteLink(null);
  }

  const BLOCKED_ROLES = ['SALES_REP', 'IT_AGENT', 'EMPLOYEE'];
  if (currentUser && BLOCKED_ROLES.includes(currentUser.role)) {
    return (
      <div className="p-8 text-center">
        <p className="text-red-600 dark:text-red-400 text-sm font-medium">Access denied. You don't have permission to view this page.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 animate-slide-up">
      {/* Role summary */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {ROLES.map(role => (
          <div key={role} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-3 text-center">
            <p className="text-xl font-bold text-gray-900 dark:text-white">{roleGroups[role]}</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{role.replace(/_/g,' ')}</p>
          </div>
        ))}
      </div>

      <PageHeader
        title="Users"
        subtitle={`${filtered?.length ?? 0} users`}
        actions={<>
          <SearchInput value={search} onChange={setSearch} placeholder="Search users..." />
          <Button variant="secondary" icon={<Mail size={15} />} onClick={() => { setInviteLink(null); setModal('invite'); }}>Invite User</Button>
          <Button icon={<Plus size={15} />} onClick={() => setModal('create')}>Create User</Button>
        </>}
      />

      {/* Pending Invites */}
      {pendingInvites.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl p-4">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-2">Pending Invites ({pendingInvites.length})</p>
          <div className="space-y-1">
            {pendingInvites.map((inv: any) => (
              <div key={inv.id} className="flex items-center justify-between text-sm">
                <span className="text-amber-700 dark:text-amber-300">{inv.email}</span>
                <div className="flex items-center gap-2">
                  <Badge variant="yellow">{inv.role.replace(/_/g,' ')}</Badge>
                  <span className="text-xs text-amber-500 dark:text-amber-400">Expires {date(inv.expiresAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isLoading ? <Spinner /> : filtered?.length === 0 ? (
        <EmptyState icon={<Users size={24} />} title="No users found" description="Invite or create team members to get started" action={{ label: 'Invite User', onClick: () => setModal('invite') }} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
          <div className="table-container">
          <table className="w-full text-sm min-w-[640px]">
            <thead><tr className="bg-gray-50 dark:bg-gray-800/60 border-b border-gray-100 dark:border-gray-800">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">User</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Role</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Department</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell">Last Login</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell">Created At</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {filtered?.map((u: any) => (
                <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center text-sm font-bold flex-shrink-0">
                        {u.name[0]?.toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">{u.name}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={roleVariant[u.role] || 'gray'}>{u.role.replace(/_/g,' ')}</Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{u.department || '—'}</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-gray-400 dark:text-gray-500">—</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-gray-400 dark:text-gray-500">
                    {u.createdAt ? date(u.createdAt) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={u.isActive ? 'green' : 'gray'}>{u.isActive ? 'Active' : 'Inactive'}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <RowActions items={[
                      { label: 'Edit', icon: <Pencil size={14} />, onClick: () => setModal({ type: 'edit', user: u }) },
                      { label: 'Reset Password', icon: <KeyRound size={14} />, onClick: () => resetPassword.mutate(u.id), hidden: !u.isActive },
                      { label: 'Deactivate', icon: <UserX size={14} />, onClick: () => deactivate.mutate(u.id), variant: 'danger', hidden: !u.isActive },
                      { label: 'Reactivate', icon: <Shield size={14} />, onClick: () => update.mutate({ id: u.id, isActive: true }), hidden: u.isActive },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      <Modal open={modal === 'create'} onClose={closeModal} title="Create User">
        <UserForm
          loading={create.isPending}
          onSubmit={(form: any) => create.mutate(form)}
        />
      </Modal>

      {/* Edit User Modal */}
      <Modal open={!!(modal && typeof modal === 'object' && modal.type === 'edit')} onClose={closeModal} title="Edit User">
        <UserForm
          initial={modal && typeof modal === 'object' && modal.type === 'edit' ? modal.user : null}
          loading={update.isPending}
          onSubmit={(form: any) => {
            if (modal && typeof modal === 'object' && modal.type === 'edit') {
              update.mutate({ id: modal.user.id, ...form });
            }
          }}
        />
      </Modal>

      {/* Invite User Modal */}
      <Modal open={modal === 'invite'} onClose={closeModal} title="Invite Team Member">
        {inviteLink ? (
          <CopyLink link={inviteLink} />
        ) : (
          <InviteForm onSuccess={(link) => {
            setInviteLink(link);
            qc.invalidateQueries({ queryKey: ['admin-invites'] });
          }} />
        )}
      </Modal>

    </div>
  );
}
