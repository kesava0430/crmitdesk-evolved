import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { GitBranch, Plus, CheckCircle, XCircle, ChevronDown, X, Pencil, Trash2 } from 'lucide-react';
import { SearchableSelect , RowActions } from '../shared/components';
import { Attachments } from '../shared/components/Attachments';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChangeRequest {
  id: string;
  title: string;
  description: string;
  type: 'NORMAL' | 'EMERGENCY' | 'STANDARD';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'IMPLEMENTING' | 'DONE';
  requestedBy: string;
  assignedTo?: string | null;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  approvedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  requester: { id: string; name: string };
  assignee?: { id: string; name: string } | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  DRAFT:         'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  SUBMITTED:     'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  APPROVED:      'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  REJECTED:      'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  IMPLEMENTING:  'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-400',
  DONE:          'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};

const PRIORITY_COLOR: Record<string, string> = {
  LOW:      'text-gray-500 dark:text-gray-400',
  MEDIUM:   'text-yellow-600 dark:text-yellow-400',
  HIGH:     'text-orange-600 dark:text-orange-400',
  CRITICAL: 'text-red-600 dark:text-red-400',
};

const TYPE_COLOR: Record<string, string> = {
  NORMAL:    'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  EMERGENCY: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  STANDARD:  'bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
};

const STATUS_FLOW: Record<string, string[]> = {
  DRAFT:        ['SUBMITTED'],
  SUBMITTED:    [],  // approve/reject separately
  APPROVED:     ['IMPLEMENTING'],
  IMPLEMENTING: ['DONE'],
};

// ─── Form Modal ───────────────────────────────────────────────────────────────

function ChangeRequestModal({ cr, users, onClose }: {
  cr?: ChangeRequest; users: { id: string; name: string }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    title: cr?.title ?? '',
    description: cr?.description ?? '',
    type: cr?.type ?? 'NORMAL',
    priority: cr?.priority ?? 'MEDIUM',
    assignedTo: cr?.assignedTo ?? '',
    plannedStart: cr?.plannedStart ? cr.plannedStart.split('T')[0] : '',
    plannedEnd: cr?.plannedEnd ? cr.plannedEnd.split('T')[0] : '',
  });

  const save = useMutation({
    mutationFn: (data: any) =>
      cr ? api.patch(`/change-requests/${cr.id}`, data) : api.post('/change-requests', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['change-requests'] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white dark:bg-gray-900 dark:border-gray-800">
          <h2 className="font-semibold text-gray-900 dark:text-white">{cr ? 'Edit Change Request' : 'New Change Request'}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); save.mutate({ ...form, assignedTo: form.assignedTo || null, plannedStart: form.plannedStart || null, plannedEnd: form.plannedEnd || null }); }} className="p-6 space-y-3">
          <div className="form-section">
            <p className="form-section-title">Change Details</p>
            <div className="space-y-4">
              <div>
                <label className="form-label">Title <span className="req">*</span></label>
                <input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} required
                  className="ui-input" aria-label="Title" placeholder="e.g. Upgrade production database to v16" />
              </div>
              <div>
                <label className="form-label">Description <span className="req">*</span></label>
                <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} required rows={4}
                  className="ui-input" aria-label="Description" placeholder="Describe the change, impact, and rollback plan…" />
              </div>
            </div>
          </div>
          <div className="form-section">
            <p className="form-section-title">Classification</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="form-label">Type</label>
<SearchableSelect ariaLabel="Type" value={form.type} onChange={val => setForm(p => ({ ...p, type: val as any }))} required options={[{value:'STANDARD',label:'Standard'},{value:'NORMAL',label:'Normal'},{value:'EMERGENCY',label:'Emergency'}]} />
              </div>
              <div>
                <label className="form-label">Priority</label>
<SearchableSelect ariaLabel="Risk Level" value={form.priority} onChange={val => setForm(p => ({ ...p, priority: val as any }))} required options={['LOW','MEDIUM','HIGH','CRITICAL'].map(p => ({ value: p, label: p }))} />
              </div>
            </div>
          </div>
          <div className="form-section">
            <p className="form-section-title">Schedule & Assignment</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="form-label">Assigned To</label>
<SearchableSelect ariaLabel="Assigned To" value={form.assignedTo} onChange={val => setForm(p => ({ ...p, assignedTo: val }))} options={users.map(u => ({ value: u.id, label: u.name }))} placeholder="— Unassigned —" />
              </div>
              <div>
                <label className="form-label">Planned Start</label>
                <input type="date" value={form.plannedStart} onChange={e => setForm(p => ({ ...p, plannedStart: e.target.value }))} className="ui-input" />
              </div>
              <div>
                <label className="form-label">Planned End</label>
                <input type="date" value={form.plannedEnd} onChange={e => setForm(p => ({ ...p, plannedEnd: e.target.value }))} className="ui-input" />
              </div>
            </div>
          </div>
          {cr && <Attachments entityType="CHANGE_REQUEST" entityId={cr.id} />}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2 border border-gray-200 dark:border-gray-700 rounded-xl text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
            <button type="submit" disabled={save.isPending} className="flex-1 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50">
              {save.isPending ? 'Saving…' : cr ? 'Save Changes' : 'Create Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ChangeRequestsPage() {
  const qc = useQueryClient();
  const [filterStatus, setFilterStatus] = useState('');
  const [modal, setModal] = useState<ChangeRequest | null | 'new'>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data: usersData } = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api.get('/admin/users').then(r => r.data?.data ?? r.data ?? []),
  });

  const params = new URLSearchParams();
  if (filterStatus) params.set('status', filterStatus);
  params.set('limit', '50');

  const { data, isLoading } = useQuery<{ data: ChangeRequest[] }>({
    queryKey: ['change-requests', filterStatus],
    queryFn: () => api.get(`/change-requests?${params}`).then(r => r.data),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/change-requests/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['change-requests'] }),
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/change-requests/${id}/reject`, { reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['change-requests'] }); setRejectId(null); setRejectReason(''); },
  });

  const advanceStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/change-requests/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['change-requests'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/change-requests/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['change-requests'] }),
  });

  const changeRequests = data?.data ?? [];
  const users = usersData ?? [];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Change Requests</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Track and approve infrastructure and system changes</p>
        </div>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700">
          <Plus size={16} /> New Request
        </button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="appearance-none pl-3 pr-8 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none bg-white dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100">
            <option value="">All Statuses</option>
            {['DRAFT','SUBMITTED','APPROVED','REJECTED','IMPLEMENTING','DONE'].map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" />
        </div>
        <p className="text-sm text-gray-400 dark:text-gray-500 ml-auto">{changeRequests.length} requests</p>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-400 dark:text-gray-500">Loading…</div>
      ) : changeRequests.length === 0 ? (
        <div className="text-center py-20">
          <GitBranch size={48} className="text-gray-200 dark:text-gray-700 mx-auto mb-4" />
          <p className="font-medium text-gray-500 dark:text-gray-400">No change requests</p>
          <button onClick={() => setModal('new')} className="mt-4 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-semibold">
            Create First Request
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {changeRequests.map(cr => (
            <div key={cr.id} data-testid="cr-card" className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h3 className="font-semibold text-gray-900 dark:text-white">{cr.title}</h3>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLOR[cr.status]}`}>{cr.status}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TYPE_COLOR[cr.type]}`}>{cr.type}</span>
                    <span className={`text-xs font-semibold ${PRIORITY_COLOR[cr.priority]}`}>{cr.priority}</span>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-2">{cr.description}</p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-400 dark:text-gray-500">
                    <span>By {cr.requester.name}</span>
                    {cr.assignee && <span>→ {cr.assignee.name}</span>}
                    {cr.plannedStart && <span>Planned: {new Date(cr.plannedStart).toLocaleDateString()} – {cr.plannedEnd ? new Date(cr.plannedEnd).toLocaleDateString() : '?'}</span>}
                    <span>{new Date(cr.createdAt).toLocaleDateString()}</span>
                  </div>
                  {cr.status === 'REJECTED' && cr.rejectionReason && (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-1.5 bg-red-50 dark:bg-red-500/10 px-3 py-1.5 rounded-lg">Rejected: {cr.rejectionReason}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {cr.status === 'SUBMITTED' && (
                    <>
                      <button onClick={() => approve.mutate(cr.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-500/20 rounded-lg">
                        <CheckCircle size={13} /> Approve
                      </button>
                      <button onClick={() => setRejectId(cr.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 rounded-lg">
                        <XCircle size={13} /> Reject
                      </button>
                    </>
                  )}
                  {STATUS_FLOW[cr.status]?.length > 0 && (
                    <button onClick={() => advanceStatus.mutate({ id: cr.id, status: STATUS_FLOW[cr.status][0] })}
                      className="px-2.5 py-1.5 text-xs font-medium bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-400 hover:bg-brand-100 dark:hover:bg-brand-500/20 rounded-lg">
                      → {STATUS_FLOW[cr.status][0]}
                    </button>
                  )}
                  <RowActions items={[
                    { label: 'Edit change request', icon: <Pencil size={14} />, onClick: () => setModal(cr), hidden: !['DRAFT','SUBMITTED'].includes(cr.status) },
                    { label: 'Delete change request', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete?')) remove.mutate(cr.id); }, variant: 'danger', hidden: cr.status !== 'DRAFT' },
                  ]} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reject modal */}
      {rejectId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-2xl p-6">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Reject Change Request</h3>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3}
              className="ui-input"
              placeholder="Reason for rejection…" />
            <div className="flex gap-3">
              <button onClick={() => setRejectId(null)} className="flex-1 py-2 border border-gray-200 dark:border-gray-700 rounded-xl text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
              <button onClick={() => rejectReason && reject.mutate({ id: rejectId, reason: rejectReason })}
                disabled={!rejectReason || reject.isPending}
                className="flex-1 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {reject.isPending ? 'Rejecting…' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <ChangeRequestModal
          cr={modal === 'new' ? undefined : modal}
          users={users}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
