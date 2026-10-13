import { useState } from 'react';
import { ScanFace, Check, X } from 'lucide-react';
import {
  Card, Badge, Button, Modal, Alert, FormError, EmptyState, Avatar,
  DataTable, type Column, Textarea, Label, SkeletonTable,
} from '../../shared/components';
import { useFormat } from '../../hooks/useFormat';
import {
  useFaceRequests, useFaceRequest, useDecideFaceRequest,
  type FaceRequest, type FaceRequestStatus,
} from '../../api/faceApprovals';

const STATUS_VARIANT: Record<FaceRequestStatus, 'orange' | 'green' | 'red'> = {
  PENDING: 'orange', APPROVED: 'green', REJECTED: 'red',
};
const STATUS_LABEL: Record<FaceRequestStatus, string> = {
  PENDING: 'Pending Verification', APPROVED: 'Approved', REJECTED: 'Rejected',
};

// ─── Review popup ─────────────────────────────────────────────────────────────

/**
 * The decision surface: the currently active face beside every newly
 * submitted sample. The images come from the server on each open rather than
 * from the row that launched this, so a reviewer who refreshes, signs back in,
 * or picks up a colleague's queue sees exactly the same evidence.
 */
function ReviewModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useFaceRequest(id);
  const decide = useDecideFaceRequest();
  const { dateTime } = useFormat();
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [failed, setFailed] = useState('');

  const decided = !!data && data.status !== 'PENDING';

  async function run(decision: 'approve' | 'reject') {
    setFailed('');
    try {
      await decide.mutateAsync({ id, decision, reason: decision === 'reject' ? reason.trim() || undefined : undefined });
      onClose();
    } catch (err: any) {
      setFailed(err?.response?.data?.error || 'Could not save that decision. Please try again.');
      setConfirm(null);
    }
  }

  const current = data?.user.faceEnrollment?.referenceSelfie ?? data?.previousSelfie ?? null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Face ID Re-enrollment Review"
      subtitle={data ? `${data.user.name} · ${data.user.email}` : undefined}
      icon={<ScanFace size={16} />}
      size="lg"
      footer={
        decided ? <Button variant="secondary" onClick={onClose}>Close</Button>
        : confirm ? (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={decide.isPending}>Back</Button>
            <Button
              variant={confirm === 'reject' ? 'danger' : 'primary'}
              loading={decide.isPending}
              icon={confirm === 'approve' ? <Check size={14} /> : <X size={14} />}
              onClick={() => run(confirm)}
            >
              {confirm === 'approve' ? 'Yes, approve and replace' : 'Yes, reject'}
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="danger" icon={<X size={14} />} onClick={() => setConfirm('reject')} disabled={!data}>Reject</Button>
            <Button icon={<Check size={14} />} onClick={() => setConfirm('approve')} disabled={!data}>Approve</Button>
          </div>
        )
      }
    >
      {isLoading && <SkeletonTable rows={3} />}
      {error && <Alert tone="danger">Could not load this request.</Alert>}

      {data && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Avatar name={data.user.name} src={data.user.avatarUrl ?? undefined} size="md" />
            <div className="flex-1 min-w-[200px]">
              <p className="text-[13px] font-medium text-fg">{data.user.name}</p>
              <p className="text-[12px] text-fg-muted">
                {[data.user.employee?.employeeCode, data.user.employee?.designation, data.user.employee?.department?.name]
                  .filter(Boolean).join(' · ') || data.user.email}
              </p>
            </div>
            <Badge variant={STATUS_VARIANT[data.status]}>{STATUS_LABEL[data.status]}</Badge>
          </div>

          <p className="text-[12px] text-fg-muted">Submitted {dateTime(data.createdAt)}</p>

          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4">
            <div>
              <Label>Current Face ID</Label>
              {current ? (
                <img src={current} alt="Currently enrolled face" className="mt-1 w-28 h-28 rounded-lg object-cover -scale-x-100 border border-line" />
              ) : (
                <div className="mt-1 w-28 h-28 rounded-lg bg-surface-sunken border border-line flex items-center justify-center text-fg-subtle">
                  <ScanFace size={24} />
                </div>
              )}
              {data.user.faceEnrollment && (
                <p className="text-[11.5px] text-fg-subtle mt-1">Enrolled {dateTime(data.user.faceEnrollment.enrolledAt)}</p>
              )}
            </div>

            <div>
              <Label>New samples ({data.sampleImages.length})</Label>
              <div className="mt-1 flex gap-2 flex-wrap">
                {data.sampleImages.map((src, i) => (
                  <img key={i} src={src} alt={`Submitted sample ${i + 1}`} className="w-28 h-28 rounded-lg object-cover -scale-x-100 border border-line" />
                ))}
              </div>
            </div>
          </div>

          {decided && (
            <Alert tone={data.status === 'APPROVED' ? 'success' : 'warning'}>
              {data.status === 'APPROVED' ? 'Approved' : 'Rejected'}
              {data.decider ? ` by ${data.decider.name}` : ''}
              {data.decidedAt ? ` on ${dateTime(data.decidedAt)}` : ''}
              {data.rejectionReason ? ` — ${data.rejectionReason}` : ''}
            </Alert>
          )}

          {confirm === 'approve' && (
            <Alert tone="warning">
              This replaces the active Face ID for {data.user.name} with the new samples. Attendance will match against the new face from now on.
            </Alert>
          )}

          {confirm === 'reject' && (
            <div>
              <Label htmlFor="face-reject-reason">Reason (optional — shown to the employee)</Label>
              <Textarea
                id="face-reject-reason"
                rows={2}
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. Photo is too dark to compare — please retry in better light."
              />
              <p className="text-[12px] text-fg-muted mt-1">Their existing Face ID stays exactly as it is.</p>
            </div>
          )}

          <FormError>{failed}</FormError>
        </div>
      )}
    </Modal>
  );
}

// ─── Queue ────────────────────────────────────────────────────────────────────

/** Review queue for the People page's Face Approvals tab. Super Admin only —
 *  the endpoints behind it refuse everyone else regardless of this render. */
export function FaceApprovals() {
  const [status, setStatus] = useState<FaceRequestStatus | 'ALL'>('PENDING');
  const [reviewing, setReviewing] = useState<string | null>(null);
  const { data, isLoading } = useFaceRequests(status);
  const { dateTime } = useFormat();

  const columns: Column<FaceRequest>[] = [
    {
      key: 'user', header: 'Employee',
      cell: r => (
        <div className="flex items-center gap-2">
          <Avatar name={r.user.name} src={r.user.avatarUrl ?? undefined} size="sm" />
          <div className="min-w-0">
            <p className="text-[13px] text-fg truncate">{r.user.name}</p>
            <p className="text-[11.5px] text-fg-muted truncate">{r.user.email}</p>
          </div>
        </div>
      ),
    },
    { key: 'samples', header: 'Samples', cell: r => <span className="tabular-nums">{r.samples}</span> },
    { key: 'createdAt', header: 'Submitted', cell: r => dateTime(r.createdAt) },
    { key: 'status', header: 'Status', cell: r => <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge> },
    {
      key: 'actions', header: '', align: 'right',
      cell: r => (
        <Button size="sm" variant={r.status === 'PENDING' ? 'secondary' : 'ghost'} onClick={() => setReviewing(r.id)}>
          {r.status === 'PENDING' ? 'Review' : 'View'}
        </Button>
      ),
    },
  ];

  const rows = data?.data ?? [];

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <p className="text-[13px] font-medium text-fg">Face ID re-enrollment requests</p>
          <p className="text-[12px] text-fg-muted">
            An employee&apos;s existing Face ID keeps working for attendance until you approve a replacement.
          </p>
        </div>
        <div className="flex gap-1">
          {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map(s => (
            <Button key={s} size="sm" variant={status === s ? 'secondary' : 'ghost'} onClick={() => setStatus(s)}>
              {s === 'ALL' ? 'All' : STATUS_LABEL[s].replace(' Verification', '')}
              {s === 'PENDING' && !!data?.pendingCount && ` (${data.pendingCount})`}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <SkeletonTable rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ScanFace size={22} />}
          title={status === 'PENDING' ? 'No requests waiting' : 'Nothing here'}
          description={status === 'PENDING'
            ? 'Re-enrollment requests appear here for approval as employees submit them.'
            : 'No requests with this status yet.'}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={r => r.id} />
      )}

      {reviewing && <ReviewModal id={reviewing} onClose={() => setReviewing(null)} />}
    </Card>
  );
}
