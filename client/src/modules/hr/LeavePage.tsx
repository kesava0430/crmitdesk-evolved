import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { PageHeader, Button, Modal, Badge, Spinner, EmptyState, SearchableSelect } from '../../shared/components';
import { CalendarCheck, Plus, X, Check, Clock3 } from 'lucide-react';

const MANAGER_ROLES = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'];

interface LeaveType { id: string; name: string; annualQuota: number; isPaid: boolean; color: string }
interface Balance { leaveType: LeaveType; used: number; remaining: number }
interface LeaveRequest {
  id: string; startDate: string; endDate: string; days: number; reason?: string;
  status: string; rejectionReason?: string; createdAt: string;
  leaveType: LeaveType; user: { id: string; name: string; avatarUrl?: string };
  decider?: { name: string } | null;
}

const STATUS_VARIANT: Record<string, any> = {
  PENDING: 'yellow', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'gray',
};

function BalanceCards() {
  const { data, isLoading } = useQuery<Balance[]>({
    queryKey: ['leave-balance'],
    queryFn: () => api.get('/hr/leave/balance').then(r => r.data),
  });
  if (isLoading) return <Spinner />;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {(data || []).map(b => (
        <div key={b.leaveType.id} className="bg-white border border-gray-200 rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: b.leaveType.color }} />
            <p className="text-xs text-gray-500 truncate">{b.leaveType.name}</p>
          </div>
          <p className="text-xl font-bold text-gray-900">{b.remaining}<span className="text-xs font-normal text-gray-400"> / {b.leaveType.annualQuota} left</span></p>
        </div>
      ))}
    </div>
  );
}

function ApplyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: types } = useQuery<LeaveType[]>({ queryKey: ['leave-types'], queryFn: () => api.get('/hr/leave/types').then(r => r.data) });
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
  const [error, setError] = useState('');

  const submit = useMutation({
    mutationFn: () => api.post('/hr/leave/requests', form).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave-requests'] });
      qc.invalidateQueries({ queryKey: ['leave-balance'] });
      setForm({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
      onClose();
    },
    onError: (err: any) => setError(err?.response?.data?.error || 'Could not submit request.'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Apply for leave" icon={<CalendarCheck size={16} />}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { setError(''); submit.mutate(); }} loading={submit.isPending} disabled={!form.leaveTypeId || !form.startDate || !form.endDate}>
          Submit Request
        </Button>
      </>}>
      <div className="space-y-4">
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
        <div>
          <label className="form-label">Leave type</label>
          <SearchableSelect
            value={form.leaveTypeId}
            onChange={val => setForm(f => ({ ...f, leaveTypeId: val }))}
            options={(types || []).map(t => ({ value: t.id, label: t.name }))}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="form-label">Start date</label>
            <input type="date" className="ui-input" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} required />
          </div>
          <div>
            <label className="form-label">End date</label>
            <input type="date" className="ui-input" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} required />
          </div>
        </div>
        <div>
          <label className="form-label">Reason (optional)</label>
          <textarea className="ui-input" rows={3} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
        </div>
      </div>
    </Modal>
  );
}

function RequestRow({ req, showEmployee, onCancel, onApprove, onReject }: {
  req: LeaveRequest; showEmployee?: boolean;
  onCancel?: () => void; onApprove?: () => void; onReject?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 border-b border-gray-50 last:border-0 flex-wrap">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {showEmployee && <span className="font-medium text-gray-800 text-sm">{req.user.name}</span>}
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${req.leaveType.color}20`, color: req.leaveType.color }}>
            {req.leaveType.name}
          </span>
          <Badge variant={STATUS_VARIANT[req.status]}>{req.status}</Badge>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          {new Date(req.startDate).toLocaleDateString()} → {new Date(req.endDate).toLocaleDateString()} · {req.days} day{req.days === 1 ? '' : 's'}
        </p>
        {req.reason && <p className="text-xs text-gray-400 mt-0.5">{req.reason}</p>}
        {req.status === 'REJECTED' && req.rejectionReason && (
          <p className="text-xs text-red-500 mt-0.5">Reason: {req.rejectionReason}</p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onCancel && req.status === 'PENDING' && (
          <button onClick={onCancel} className="text-xs font-medium text-gray-500 hover:text-red-600">Cancel</button>
        )}
        {onApprove && req.status === 'PENDING' && (
          <>
            <button onClick={onApprove} className="flex items-center gap-1 px-2.5 py-1 bg-green-50 text-green-700 rounded-lg text-xs font-medium hover:bg-green-100">
              <Check size={12} /> Approve
            </button>
            <button onClick={onReject} className="flex items-center gap-1 px-2.5 py-1 bg-red-50 text-red-700 rounded-lg text-xs font-medium hover:bg-red-100">
              <X size={12} /> Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function MyLeave() {
  const qc = useQueryClient();
  const [applyOpen, setApplyOpen] = useState(false);
  const { data, isLoading } = useQuery<LeaveRequest[]>({
    queryKey: ['leave-requests', 'mine'],
    queryFn: () => api.get('/hr/leave/requests').then(r => r.data),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/hr/leave/requests/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-requests'] }),
  });

  return (
    <div className="space-y-5">
      <BalanceCards />
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-gray-800">My Requests</p>
          <Button icon={<Plus size={14} />} onClick={() => setApplyOpen(true)}>Apply for Leave</Button>
        </div>
        {isLoading ? <Spinner /> : (data || []).length === 0 ? (
          <EmptyState icon={<CalendarCheck size={22} />} title="No leave requests" description="Apply when you need time off" />
        ) : (
          <div>{(data || []).map(r => <RequestRow key={r.id} req={r} onCancel={() => cancel.mutate(r.id)} />)}</div>
        )}
      </div>
      <ApplyModal open={applyOpen} onClose={() => setApplyOpen(false)} />
    </div>
  );
}

function Approvals() {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState<LeaveRequest | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading } = useQuery<LeaveRequest[]>({
    queryKey: ['leave-requests', 'org'],
    queryFn: () => api.get('/hr/leave/requests', { params: { scope: 'org' } }).then(r => r.data),
  });
  const approve = useMutation({
    mutationFn: (id: string) => api.patch(`/hr/leave/requests/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-requests'] }),
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.patch(`/hr/leave/requests/${id}/reject`, { reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['leave-requests'] }); setRejecting(null); setReason(''); },
  });

  const pending = (data || []).filter(r => r.status === 'PENDING');
  const decided = (data || []).filter(r => r.status !== 'PENDING');

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <p className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-1.5"><Clock3 size={14} /> Pending Approval ({pending.length})</p>
        {isLoading ? <Spinner /> : pending.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">Nothing waiting on you 🎉</p>
        ) : (
          <div>{pending.map(r => (
            <RequestRow key={r.id} req={r} showEmployee
              onApprove={() => approve.mutate(r.id)}
              onReject={() => setRejecting(r)}
            />
          ))}</div>
        )}
      </div>
      {decided.length > 0 && (
        <div className="card p-5">
          <p className="text-sm font-semibold text-gray-800 mb-3">History</p>
          <div>{decided.map(r => <RequestRow key={r.id} req={r} showEmployee />)}</div>
        </div>
      )}

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Reject leave request" size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => rejecting && reject.mutate({ id: rejecting.id, reason })} loading={reject.isPending} disabled={!reason.trim()}>
            Reject
          </Button>
        </>}>
        <label className="form-label">Reason</label>
        <textarea className="ui-input" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Let them know why" autoFocus />
      </Modal>
    </div>
  );
}

export default function LeavePage() {
  const { user } = useAuth();
  const isManager = MANAGER_ROLES.includes(user?.role || '');
  const [tab, setTab] = useState<'me' | 'approvals'>('me');

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">
      <PageHeader title="Leave" subtitle="Apply for and track time off" />

      {isManager && (
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
          {(['me', 'approvals'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-[13px] font-semibold rounded-lg transition-all ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              {t === 'me' ? 'My Leave' : 'Approvals'}
            </button>
          ))}
        </div>
      )}

      {tab === 'me' ? <MyLeave /> : <Approvals />}
    </div>
  );
}
