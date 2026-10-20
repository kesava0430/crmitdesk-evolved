import { useState } from 'react';
import { ScanFace, Check, X, ShieldAlert } from 'lucide-react';
import {
  Card, Badge, Button, Modal, Alert, FormError, EmptyState, Avatar,
  DataTable, type Column, Textarea, Label, SkeletonTable,
} from '../../shared/components';
import { useFormat } from '../../hooks/useFormat';
import {
  useFaceRequests, useFaceRequest, useDecideFaceRequest, useFaceAttempts, useFaceAttempt,
  type FaceRequest, type FaceRequestStatus, type FaceAttempt,
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

// ─── Failed liveness checks ───────────────────────────────────────────────────

/** Plain-language versions of the reasons the server records (utils/liveness/challenge.ts). */
const ATTEMPT_REASON: Record<string, string> = {
  photo_suspected: 'Photo or screen suspected — no real 3D head movement',
  static_frames: 'Photo suspected — the same still image in every frame',
  steps_out_of_order: 'Movements done out of order',
  wrong_direction: 'Turned the wrong way',
  step_not_performed: 'A requested movement was not performed',
  motion_unconfirmed: 'Movement too small to confirm (image too dark or blurry)',
  not_facing_camera: 'Not facing the camera at the start',
  end_not_neutral: 'Did not look back at the camera at the end',
  face_changed: 'A different face appeared during the check',
  no_face: 'No face in one of the frames',
  multiple_faces: 'More than one face in view',
  face_mismatch: "Live face didn't match the enrolled face",
  timeout: 'Took too long',
  too_fast: 'Submitted impossibly fast (scripted?)',
  bad_frames: 'Frames missing or unreadable',
  challenge_invalid: 'Invalid challenge',
  client_timeout: 'Gave up: time ran out',
  client_face_lost: 'Gave up: face left the frame',
  client_multiple_faces: 'Gave up: more than one face',
  client_face_changed: 'Gave up: face changed',
  client_wrong_action: 'Gave up: wrong movement',
};
const reasonLabel = (r: string | null) => (r && ATTEMPT_REASON[r]) || r || 'Unknown';
const PURPOSE_LABEL: Record<FaceAttempt['purpose'], string> = { CHECK_IN: 'Check-in', CHECK_OUT: 'Check-out', ENROL: 'Enrolment' };

function AttemptModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useFaceAttempt(id);
  const { dateTime } = useFormat();
  return (
    <Modal open onClose={onClose} title="Failed face check" subtitle={data ? `${data.user.name} · ${data.user.email}` : undefined}
      icon={<ShieldAlert size={16} />} size="md" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {isLoading && <SkeletonTable rows={2} />}
      {data && (
        <div className="space-y-3">
          <Alert tone="warning" title={reasonLabel(data.failureReason)}>
            {PURPOSE_LABEL[data.purpose]}{data.usedAt ? ` · ${dateTime(data.usedAt)}` : ''}
            {data.steps?.length ? ` · asked for: ${data.steps.map(s => s.replace('_', ' ')).join(', ')}` : ''}
          </Alert>
          {data.evidenceFrame ? (
            <div>
              <Label>Camera frame at the start of the attempt</Label>
              <img src={data.evidenceFrame} alt="Evidence frame" className="mt-1 w-full max-w-[320px] rounded-lg border border-line -scale-x-100" />
            </div>
          ) : <p className="text-[12.5px] text-fg-muted">No frame was kept for this attempt.</p>}
        </div>
      )}
    </Modal>
  );
}

function FailedChecks() {
  const { data, isLoading } = useFaceAttempts();
  const { dateTime } = useFormat();
  const [viewing, setViewing] = useState<string | null>(null);
  const columns: Column<FaceAttempt>[] = [
    {
      key: 'user', header: 'Employee',
      cell: r => (
        <div className="min-w-0">
          <p className="text-[13px] text-fg truncate">{r.user.name}</p>
          <p className="text-[11.5px] text-fg-muted truncate">{r.user.email}</p>
        </div>
      ),
    },
    { key: 'purpose', header: 'For', cell: r => PURPOSE_LABEL[r.purpose] },
    { key: 'reason', header: 'Reason', cell: r => <span className="text-[12.5px]">{reasonLabel(r.failureReason)}</span> },
    { key: 'usedAt', header: 'When', cell: r => dateTime(r.usedAt ?? r.createdAt) },
    {
      key: 'actions', header: '', align: 'right',
      cell: r => r.hasEvidence ? <Button size="sm" variant="ghost" onClick={() => setViewing(r.id)}>View</Button> : null,
    },
  ];
  return (
    <Card>
      <div className="mb-3 min-w-0">
        <p className="text-[13px] font-medium text-fg">Failed face checks</p>
        <p className="text-[12px] text-fg-muted">
          Liveness or face-match failures from check-in, check-out and enrolment, with one camera frame for review. Kept for the check-in photo retention period.
        </p>
      </div>
      {isLoading ? <SkeletonTable rows={3} /> : !data?.length ? (
        <EmptyState icon={<ShieldAlert size={22} />} title="No failed checks" description="Attempts that fail the liveness check or don't match the enrolled face show up here." />
      ) : (
        <DataTable columns={columns} rows={data} rowKey={r => r.id} />
      )}
      {viewing && <AttemptModal id={viewing} onClose={() => setViewing(null)} />}
    </Card>
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
    <div className="space-y-4">
    <Card>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0 basis-[16rem] grow">
          <p className="text-[13px] font-medium text-fg">Face ID re-enrollment requests</p>
          <p className="text-[12px] text-fg-muted">
            An employee&apos;s existing Face ID keeps working for attendance until you approve a replacement.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
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
    <FailedChecks />
    </div>
  );
}
