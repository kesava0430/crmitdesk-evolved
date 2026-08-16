import { useState } from 'react';
import {
  useApprovalRequests,
  useMyPendingApprovals,
  useApprovalPolicies,
  useCreateApprovalPolicy,
  useDeleteApprovalPolicy,
  useDecideApproval,
  useCancelApproval,
  useDelegations,
  useCreateDelegation,
  useRevokeDelegation,
  type ApprovalPolicyStep,
} from '../../api/work';
import { useRoles } from '../../api/work';
import { PageHeader, Button, Modal, Badge, Spinner, EmptyState } from '../../shared/components';
import { CheckCircle2, Plus, Trash2, UserCheck, Inbox, GitBranch, Check, X } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';
import { useAuth } from '../../contexts/AuthContext';

/**
 * Approvals (§46) — one engine for leave, changes, quotes, expenses and
 * anything else a customer wires up.
 *
 * Three views, because approvals have three audiences: the person who has to
 * decide (Inbox), the person who wants to know where their request got to
 * (All requests), and the admin who defines the rules (Policies).
 */

const STATUS_VARIANT: Record<string, any> = {
  PENDING: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  CANCELLED: 'gray',
  EXPIRED: 'orange',
  SKIPPED: 'gray',
};

const ENTITY_TYPES = [
  'LEAVE_REQUEST',
  'CHANGE_REQUEST',
  'QUOTE',
  'EXPENSE',
  'SERVICE_REQUEST',
  'TASK',
  'PURCHASE',
  'ONBOARDING',
  'OFFBOARDING',
  'CUSTOM',
];

const APPROVER_TYPES = [
  { value: 'MANAGER', label: "Requester's manager" },
  { value: 'SKIP_LEVEL_MANAGER', label: "Manager's manager" },
  { value: 'DEPARTMENT_HEAD', label: 'Head of department' },
  { value: 'TEAM_LEAD', label: 'Team lead' },
  { value: 'ROLE', label: 'Anyone with a role' },
  { value: 'USER', label: 'A specific person' },
];

const field =
  'w-full px-3 py-2 text-[13px] border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white';

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">{children}</label>;
}

// ─── Inbox ────────────────────────────────────────────────────────────────────

function InboxPanel() {
  const { data, isLoading } = useMyPendingApprovals();
  const decide = useDecideApproval();
  const fmt = useFormat();
  const [comments, setComments] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (isLoading) return <Spinner />;
  if (!data?.data.length) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="Nothing waiting on you"
        description="When someone raises a request that needs your approval, it lands here."
      />
    );
  }

  const act = (id: string, decision: 'APPROVED' | 'REJECTED') => {
    setErrors(e => ({ ...e, [id]: '' }));
    decide.mutate(
      { id, decision, comment: comments[id] || undefined },
      {
        onError: (err: any) =>
          setErrors(e => ({ ...e, [id]: err?.response?.data?.error || 'Could not record that decision.' })),
      }
    );
  };

  return (
    <div className="space-y-2">
      {data.data.map(a => (
        <div
          key={a.stepId}
          className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-gray-900 dark:text-white">{a.title}</p>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <Badge variant="yellow">{a.stepName}</Badge>
                <Badge variant="gray">{a.entityType.replace(/_/g, ' ').toLowerCase()}</Badge>
                <span className="text-[11.5px] text-gray-400 dark:text-gray-500">from {a.requester.name}</span>
                {a.amount != null && (
                  <span className="text-[11.5px] font-medium text-gray-700 dark:text-gray-200">
                    {fmt.money(a.amount)}
                  </span>
                )}
                {a.policyName && <span className="text-[11.5px] text-gray-400">· {a.policyName}</span>}
              </div>
              {a.description && (
                <p className="text-[12.5px] text-gray-500 dark:text-gray-400 mt-2">{a.description}</p>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="xs" variant="danger" onClick={() => act(a.requestId, 'REJECTED')} loading={decide.isPending}>
                <X size={12} /> Reject
              </Button>
              <Button size="xs" onClick={() => act(a.requestId, 'APPROVED')} loading={decide.isPending}>
                <Check size={12} /> Approve
              </Button>
            </div>
          </div>

          <input
            value={comments[a.requestId] ?? ''}
            onChange={e => setComments(c => ({ ...c, [a.requestId]: e.target.value }))}
            placeholder="Optional comment — the requester will see this"
            className={`${field} mt-3`}
          />
          {errors[a.requestId] && (
            <p className="text-[12px] text-red-600 dark:text-red-400 mt-1.5">{errors[a.requestId]}</p>
          )}
          {a.expiresAt && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1.5">
              Expires {fmt.dateTime(a.expiresAt)} if no decision is made
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── All requests ─────────────────────────────────────────────────────────────

function RequestsPanel() {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useApprovalRequests({ status: status || undefined });
  const cancel = useCancelApproval();
  const { user } = useAuth();
  const fmt = useFormat();

  return (
    <>
      <select className={`${field} w-auto mb-3`} value={status} onChange={e => setStatus(e.target.value)}>
        <option value="">All statuses</option>
        {['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'].map(s => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <EmptyState
          icon={<CheckCircle2 />}
          title="No approval requests"
          description="Requests appear here once a module raises one and a matching policy exists."
        />
      ) : (
        <div className="space-y-2">
          {data.data.map(r => (
            <div
              key={r.id}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-gray-900 dark:text-white">{r.title}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                    <span className="text-[11.5px] text-gray-400">{r.requester.name}</span>
                    <span className="text-[11.5px] text-gray-400">· {fmt.date(r.createdAt)}</span>
                    {r.policy && <span className="text-[11.5px] text-gray-400">· {r.policy.name}</span>}
                  </div>
                </div>
                {r.status === 'PENDING' && r.requester.id === user?.id && (
                  <Button size="xs" variant="secondary" onClick={() => cancel.mutate(r.id)}>
                    Cancel
                  </Button>
                )}
              </div>

              <div className="mt-3 space-y-1.5">
                {r.steps.map(s => (
                  <div key={s.id} className="flex items-center gap-2 text-[12px]">
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${
                        s.status === 'APPROVED'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                          : s.status === 'REJECTED'
                            ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                            : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                      }`}
                    >
                      {s.order}
                    </span>
                    <span className="text-gray-700 dark:text-gray-200">{s.name}</span>
                    <Badge variant={STATUS_VARIANT[s.status]}>{s.status}</Badge>
                    {s.actions.map(a => (
                      <span key={a.id} className="text-[11px] text-gray-400">
                        {a.approver.name} {a.decision.toLowerCase()}
                        {a.comment ? ` — "${a.comment}"` : ''}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Policies ─────────────────────────────────────────────────────────────────

function NewPolicyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateApprovalPolicy();
  const { data: roles } = useRoles();
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('LEAVE_REQUEST');
  const [mode, setMode] = useState('SEQUENTIAL');
  const [expiryHours, setExpiryHours] = useState('168');
  const [steps, setSteps] = useState<ApprovalPolicyStep[]>([
    { order: 1, name: 'Manager approval', approverType: 'MANAGER', minApprovals: 1 },
  ]);

  const addStep = () =>
    setSteps(s => [...s, { order: s.length + 1, name: `Step ${s.length + 1}`, approverType: 'MANAGER', minApprovals: 1 }]);

  const updateStep = (i: number, patch: Partial<ApprovalPolicyStep>) =>
    setSteps(s => s.map((step, idx) => (idx === i ? { ...step, ...patch } : step)));

  const removeStep = (i: number) =>
    setSteps(s => s.filter((_, idx) => idx !== i).map((step, idx) => ({ ...step, order: idx + 1 })));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New approval policy"
      subtitle="Rules that decide who signs off on a record, and in what order."
      icon={<GitBranch size={16} />}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!name.trim() || !steps.length}
            onClick={() => {
              setError('');
              create.mutate(
                {
                  name,
                  entityType,
                  mode,
                  expiryHours: expiryHours ? Number(expiryHours) : null,
                  steps,
                },
                {
                  onSuccess: () => {
                    setName('');
                    setSteps([{ order: 1, name: 'Manager approval', approverType: 'MANAGER', minApprovals: 1 }]);
                    onClose();
                  },
                  onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that policy.'),
                }
              );
            }}
          >
            Create policy
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Policy name</Label>
          <input className={field} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Standard leave approval" />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Applies to</Label>
            <select className={field} value={entityType} onChange={e => setEntityType(e.target.value)}>
              {ENTITY_TYPES.map(t => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Mode</Label>
            <select className={field} value={mode} onChange={e => setMode(e.target.value)}>
              <option value="SEQUENTIAL">Sequential</option>
              <option value="PARALLEL">Parallel</option>
              <option value="ANY_ONE">Any one</option>
              <option value="UNANIMOUS">Unanimous</option>
            </select>
          </div>
          <div>
            <Label>Expires after (hours)</Label>
            <input className={field} value={expiryHours} onChange={e => setExpiryHours(e.target.value)} />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <Label>Steps</Label>
            <Button size="xs" variant="secondary" onClick={addStep}>
              <Plus size={11} /> Add step
            </Button>
          </div>
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-[10px] font-semibold flex items-center justify-center text-gray-600 dark:text-gray-300">
                    {s.order}
                  </span>
                  <input
                    className={`${field} flex-1`}
                    value={s.name}
                    onChange={e => updateStep(i, { name: e.target.value })}
                    placeholder="Step name"
                  />
                  {steps.length > 1 && (
                    <button onClick={() => removeStep(i)} className="text-gray-300 hover:text-red-500">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    className={field}
                    value={s.approverType}
                    onChange={e => updateStep(i, { approverType: e.target.value })}
                  >
                    {APPROVER_TYPES.map(t => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {s.approverType === 'ROLE' && (
                    <select
                      className={field}
                      value={s.approverRoleKey ?? ''}
                      onChange={e => updateStep(i, { approverRoleKey: e.target.value })}
                    >
                      <option value="">Choose a role…</option>
                      {(roles?.data ?? []).map(r => (
                        <option key={r.id} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}

function PoliciesPanel() {
  const { data, isLoading } = useApprovalPolicies();
  const del = useDeleteApprovalPolicy();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12.5px] text-gray-500 dark:text-gray-400">
          With no matching policy, a record proceeds without approval — so adding one is opt-in, never a surprise block.
        </p>
        <Button size="xs" onClick={() => setOpen(true)}>
          <Plus size={12} /> Policy
        </Button>
      </div>

      {error && <p className="text-[12.5px] text-red-600 dark:text-red-400 mb-2">{error}</p>}

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <EmptyState
          icon={<GitBranch />}
          title="No approval policies"
          description="Create one to route leave, changes, quotes or expenses through the right people."
          action={{ label: 'Create policy', onClick: () => setOpen(true) }}
        />
      ) : (
        <div className="space-y-2">
          {data.data.map(p => (
            <div
              key={p.id}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4 group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-gray-900 dark:text-white">{p.name}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <Badge variant="indigo">{p.entityType.replace(/_/g, ' ').toLowerCase()}</Badge>
                    <Badge variant="gray">{p.mode.toLowerCase()}</Badge>
                    {!p.isActive && <Badge variant="gray">Inactive</Badge>}
                    <span className="text-[11.5px] text-gray-400">{p._count?.requests ?? 0} requests</span>
                    {p.expiryHours && <span className="text-[11.5px] text-gray-400">· expires in {p.expiryHours}h</span>}
                  </div>
                </div>
                <button
                  onClick={() => {
                    setError('');
                    del.mutate(p.id, {
                      onError: (err: any) => setError(err?.response?.data?.error || 'Could not delete that policy.'),
                    });
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity"
                  aria-label="Delete policy"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                {p.steps.map(s => (
                  <span
                    key={s.order}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"
                  >
                    {s.order}. {s.name}
                    {s.isOptional && <span className="text-[10px] text-gray-400">optional</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <NewPolicyModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

// ─── Delegations ──────────────────────────────────────────────────────────────

function DelegationsPanel() {
  const { data, isLoading } = useDelegations();
  const create = useCreateDelegation();
  const revoke = useRevokeDelegation();
  const fmt = useFormat();
  const [form, setForm] = useState({ toUserId: '', startsAt: '', endsAt: '', reason: '' });
  const [error, setError] = useState('');

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
        <p className="text-[13px] font-medium text-gray-900 dark:text-white mb-1">Delegate your approvals</p>
        <p className="text-[12px] text-gray-500 dark:text-gray-400 mb-3">
          While a delegation is active, both you and your delegate can approve — so coming back early doesn't lock you
          out of your own queue.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <input
            className={field}
            placeholder="Delegate's user ID"
            value={form.toUserId}
            onChange={e => setForm({ ...form, toUserId: e.target.value })}
          />
          <input
            type="date"
            className={field}
            value={form.startsAt}
            onChange={e => setForm({ ...form, startsAt: e.target.value })}
          />
          <input
            type="date"
            className={field}
            value={form.endsAt}
            onChange={e => setForm({ ...form, endsAt: e.target.value })}
          />
          <Button
            size="sm"
            loading={create.isPending}
            disabled={!form.toUserId || !form.startsAt || !form.endsAt}
            onClick={() => {
              setError('');
              create.mutate(
                { toUserId: form.toUserId, startsAt: form.startsAt, endsAt: form.endsAt, reason: form.reason || undefined },
                {
                  onSuccess: () => setForm({ toUserId: '', startsAt: '', endsAt: '', reason: '' }),
                  onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that delegation.'),
                }
              );
            }}
          >
            Delegate
          </Button>
        </div>
        {error && <p className="text-[12px] text-red-600 dark:text-red-400 mt-2">{error}</p>}
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <EmptyState
          icon={<UserCheck />}
          title="No delegations"
          description="Delegate your approvals when you're away so nothing sits waiting."
        />
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {data.data.map(d => (
            <div
              key={d.id}
              className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0"
            >
              <UserCheck size={14} className="text-gray-400" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-gray-900 dark:text-white">
                  {d.from?.name} → {d.to?.name}
                </p>
                <p className="text-[11px] text-gray-400">
                  {fmt.date(d.startsAt)} – {fmt.date(d.endsAt)}
                  {d.reason ? ` · ${d.reason}` : ''}
                </p>
              </div>
              {d.isActive ? (
                <Button size="xs" variant="secondary" onClick={() => revoke.mutate(d.id)}>
                  Revoke
                </Button>
              ) : (
                <Badge variant="gray">Revoked</Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'inbox', label: 'My inbox', icon: Inbox },
  { key: 'requests', label: 'All requests', icon: CheckCircle2 },
  { key: 'policies', label: 'Policies', icon: GitBranch },
  { key: 'delegations', label: 'Delegations', icon: UserCheck },
] as const;

export default function ApprovalsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('inbox');
  const { data: pending } = useMyPendingApprovals();

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Approvals"
        subtitle="One approval engine shared by leave, change requests, quotes and anything else you wire up."
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden w-fit mb-4">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium ${
                tab === t.key
                  ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                  : 'text-gray-600 dark:text-gray-300'
              }`}
            >
              <t.icon size={12} /> {t.label}
              {t.key === 'inbox' && !!pending?.total && (
                <span className="ml-0.5 px-1.5 rounded-full bg-red-500 text-white text-[10px]">{pending.total}</span>
              )}
            </button>
          ))}
        </div>

        {tab === 'inbox' && <InboxPanel />}
        {tab === 'requests' && <RequestsPanel />}
        {tab === 'policies' && <PoliciesPanel />}
        {tab === 'delegations' && <DelegationsPanel />}
      </div>
    </div>
  );
}
