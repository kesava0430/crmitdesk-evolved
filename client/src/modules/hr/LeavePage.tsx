import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import {
  PageHeader, PageBody, Card, CardHeader, StatTile, Tabs, Button, Modal, Badge, Spinner,
  EmptyState, SearchableSelect, Field, Input, Textarea, Alert,
} from '../../shared/components';
import { CalendarCheck, Plus, X, Check, Clock3 } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';

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
        <StatTile
          key={b.leaveType.id}
          label={
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: b.leaveType.color }} />
              <span className="truncate">{b.leaveType.name}</span>
            </span>
          }
          value={<>{b.remaining}<span className="text-xs font-normal text-fg-subtle"> / {b.leaveType.annualQuota} left</span></>}
        />
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
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Leave type">
          <SearchableSelect
            value={form.leaveTypeId}
            onChange={val => setForm(f => ({ ...f, leaveTypeId: val }))}
            options={(types || []).map(t => ({ value: t.id, label: t.name }))}
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <Input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} required />
          </Field>
          <Field label="End date">
            <Input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} required />
          </Field>
        </div>
        <Field label="Reason (optional)">
          <Textarea rows={3} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
        </Field>
      </div>
    </Modal>
  );
}

function RequestRow({ req, showEmployee, onCancel, onApprove, onReject }: {
  req: LeaveRequest; showEmployee?: boolean;
  onCancel?: () => void; onApprove?: () => void; onReject?: () => void;
}) {
  const { date } = useFormat();
  return (
    <div className="flex items-center justify-between gap-3 py-3 border-b border-line-subtle last:border-0 flex-wrap">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {showEmployee && <span className="font-medium text-fg text-sm">{req.user.name}</span>}
          <span className="text-xs px-2 py-0.5 rounded-badge" style={{ background: `${req.leaveType.color}20`, color: req.leaveType.color }}>
            {req.leaveType.name}
          </span>
          <Badge variant={STATUS_VARIANT[req.status]}>{req.status}</Badge>
        </div>
        <p className="text-xs text-fg-muted mt-1">
          {date(req.startDate)} → {date(req.endDate)} · {req.days} day{req.days === 1 ? '' : 's'}
        </p>
        {req.reason && <p className="text-xs text-fg-subtle mt-0.5">{req.reason}</p>}
        {req.status === 'REJECTED' && req.rejectionReason && (
          <p className="text-xs text-danger mt-0.5">Reason: {req.rejectionReason}</p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onCancel && req.status === 'PENDING' && (
          <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
        )}
        {onApprove && req.status === 'PENDING' && (
          <>
            <Button size="xs" icon={<Check size={12} />} onClick={onApprove}>Approve</Button>
            <Button size="xs" variant="danger" icon={<X size={12} />} onClick={onReject}>Reject</Button>
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
      <Card>
        <CardHeader
          title="My Requests"
          className="mb-3"
          actions={<Button icon={<Plus size={14} />} onClick={() => setApplyOpen(true)}>Apply for Leave</Button>}
        />
        {isLoading ? <Spinner /> : (data || []).length === 0 ? (
          <EmptyState icon={<CalendarCheck size={22} />} title="No leave requests" description="Apply when you need time off" />
        ) : (
          <div>{(data || []).map(r => <RequestRow key={r.id} req={r} onCancel={() => cancel.mutate(r.id)} />)}</div>
        )}
      </Card>
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
      <Card>
        <CardHeader title={`Pending Approval (${pending.length})`} icon={<Clock3 size={14} />} className="mb-3" />
        {isLoading ? <Spinner /> : pending.length === 0 ? (
          <p className="text-sm text-fg-subtle py-4 text-center">Nothing waiting on you 🎉</p>
        ) : (
          <div>{pending.map(r => (
            <RequestRow key={r.id} req={r} showEmployee
              onApprove={() => approve.mutate(r.id)}
              onReject={() => setRejecting(r)}
            />
          ))}</div>
        )}
      </Card>
      {decided.length > 0 && (
        <Card>
          <CardHeader title="History" className="mb-3" />
          <div>{decided.map(r => <RequestRow key={r.id} req={r} showEmployee />)}</div>
        </Card>
      )}

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Reject leave request" size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => rejecting && reject.mutate({ id: rejecting.id, reason })} loading={reject.isPending} disabled={!reason.trim()}>
            Reject
          </Button>
        </>}>
        <Field label="Reason">
          <Textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Let them know why" autoFocus />
        </Field>
      </Modal>
    </div>
  );
}

export default function LeavePage() {
  const { user } = useAuth();
  const isManager = MANAGER_ROLES.includes(user?.role || '');
  const [tab, setTab] = useState<'me' | 'approvals'>('me');

  return (
    <div>
      <PageHeader
        title="Leave"
        subtitle="Apply for and track time off"
        below={isManager ? (
          <Tabs<'me' | 'approvals'>
            aria-label="Leave views"
            variant="segmented"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'me', label: 'My Leave' },
              { key: 'approvals', label: 'Approvals' },
            ]}
          />
        ) : undefined}
      />

      <PageBody width="full" className="max-w-4xl mx-auto">
        {tab === 'me' ? <MyLeave /> : <Approvals />}
      </PageBody>
    </div>
  );
}
