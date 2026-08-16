import { useState } from 'react';
import {
  useMyWork,
  useCreateTask,
  useUpdateTask,
  useToggleChecklistItem,
  useDecideApproval,
  type Task,
  type PendingApproval,
} from '../../api/work';
import { PageHeader, Button, Modal, Badge, Spinner, EmptyState } from '../../shared/components';
import { CheckSquare, Plus, AlertTriangle, Calendar, Clock, Inbox, Check, X, ChevronRight } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';

/**
 * "My Work" (§2, §47) — one cross-module queue per person.
 *
 * The organising principle is time, not module: an overdue IT ticket task and
 * an overdue onboarding step belong in the same bucket because they compete
 * for the same hour. Approvals sit alongside because from the user's point of
 * view "someone is waiting on me" is the same kind of obligation as "this is
 * due".
 */

const PRIORITY_VARIANT: Record<string, any> = {
  URGENT: 'red',
  HIGH: 'orange',
  MEDIUM: 'blue',
  LOW: 'gray',
};

const STATUS_VARIANT: Record<string, any> = {
  OPEN: 'gray',
  IN_PROGRESS: 'blue',
  BLOCKED: 'red',
  DONE: 'green',
  CANCELLED: 'gray',
};

function TaskRow({ task, onOpen }: { task: Task; onOpen: (t: Task) => void }) {
  const update = useUpdateTask();
  const fmt = useFormat();
  const done = task.status === 'DONE';
  const checklistDone = (task.checklist ?? []).filter(i => i.done).length;
  const checklistTotal = (task.checklist ?? []).length;

  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50/70 dark:hover:bg-gray-800/40 transition-colors">
      <button
        onClick={() => update.mutate({ id: task.id, status: done ? 'OPEN' : 'DONE' })}
        disabled={update.isPending}
        aria-label={done ? 'Reopen task' : 'Mark task done'}
        className={`mt-0.5 w-[18px] h-[18px] rounded-md border shrink-0 flex items-center justify-center transition-colors ${
          done
            ? 'bg-emerald-500 border-emerald-500 text-white'
            : 'border-gray-300 dark:border-gray-600 hover:border-emerald-500'
        }`}
      >
        {done && <Check size={12} strokeWidth={3} />}
      </button>

      <button onClick={() => onOpen(task)} className="flex-1 min-w-0 text-left">
        <p
          className={`text-[13.5px] font-medium truncate ${
            done ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-white'
          }`}
        >
          {task.title}
        </p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
          {task.entityType && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {task.entityType.replace(/_/g, ' ').toLowerCase()}
            </span>
          )}
          {checklistTotal > 0 && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {checklistDone}/{checklistTotal} done
            </span>
          )}
          {task.dueAt && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500">{fmt.date(task.dueAt)}</span>
          )}
          {task.assigneeUser && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500">· {task.assigneeUser.name}</span>
          )}
        </div>
      </button>

      <ChevronRight size={15} className="text-gray-300 dark:text-gray-600 mt-1 shrink-0" />
    </div>
  );
}

function Bucket({
  title,
  icon,
  tone,
  tasks,
  onOpen,
}: {
  title: string;
  icon: React.ReactNode;
  tone: string;
  tasks: Task[];
  onOpen: (t: Task) => void;
}) {
  if (!tasks.length) return null;
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-800">
        <span className={tone}>{icon}</span>
        <h2 className="text-[13px] font-semibold text-gray-900 dark:text-white">{title}</h2>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">{tasks.length}</span>
      </div>
      <div>
        {tasks.map(t => (
          <TaskRow key={t.id} task={t} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const decide = useDecideApproval();
  const fmt = useFormat();
  const [comment, setComment] = useState('');
  const [showComment, setShowComment] = useState(false);
  const [error, setError] = useState('');

  const act = (decision: 'APPROVED' | 'REJECTED') => {
    setError('');
    decide.mutate(
      { id: approval.requestId, decision, comment: comment || undefined },
      {
        onError: (err: any) =>
          setError(err?.response?.data?.error || 'Could not record that decision.'),
      }
    );
  };

  return (
    <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-gray-900 dark:text-white truncate">{approval.title}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant="yellow">{approval.stepName}</Badge>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              from {approval.requester.name}
            </span>
            {approval.amount != null && (
              <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300">
                {fmt.money(approval.amount)}
              </span>
            )}
            {approval.expiresAt && (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">
                expires {fmt.date(approval.expiresAt)}
              </span>
            )}
          </div>
          {approval.description && (
            <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 line-clamp-2">
              {approval.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="xs" variant="secondary" onClick={() => setShowComment(v => !v)}>
            Note
          </Button>
          <Button size="xs" variant="danger" onClick={() => act('REJECTED')} loading={decide.isPending}>
            <X size={12} /> Reject
          </Button>
          <Button size="xs" onClick={() => act('APPROVED')} loading={decide.isPending}>
            <Check size={12} /> Approve
          </Button>
        </div>
      </div>

      {showComment && (
        <input
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="Add a comment (optional) — shown to the requester"
          className="mt-2 w-full px-3 py-1.5 text-[12.5px] border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
        />
      )}
      {error && <p className="text-[12px] text-red-600 dark:text-red-400 mt-1.5">{error}</p>}
    </div>
  );
}

function TaskDetailModal({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const update = useUpdateTask();
  const toggle = useToggleChecklistItem();
  const fmt = useFormat();
  if (!task) return null;

  return (
    <Modal open={!!task} onClose={onClose} title={task.title} icon={<CheckSquare size={16} />} size="lg">
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={STATUS_VARIANT[task.status]}>{task.status.replace('_', ' ')}</Badge>
          <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
          {task.source !== 'MANUAL' && <Badge variant="purple">{task.source.toLowerCase()}</Badge>}
        </div>

        {task.description && (
          <p className="text-[13px] text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{task.description}</p>
        )}

        <div className="grid grid-cols-2 gap-3 text-[12.5px]">
          <div>
            <p className="text-gray-400 dark:text-gray-500">Due</p>
            <p className="text-gray-900 dark:text-white">{task.dueAt ? fmt.dateTime(task.dueAt) : '—'}</p>
          </div>
          <div>
            <p className="text-gray-400 dark:text-gray-500">Assigned to</p>
            <p className="text-gray-900 dark:text-white">
              {task.assigneeUser?.name ?? task.assigneeEmployee?.displayName ?? 'Unassigned'}
            </p>
          </div>
        </div>

        {!!task.checklist?.length && (
          <div>
            <p className="text-[12px] font-semibold text-gray-500 dark:text-gray-400 mb-2">Checklist</p>
            <div className="space-y-1.5">
              {task.checklist.map(item => (
                <label key={item.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={e => toggle.mutate({ id: task.id, itemId: item.id, done: e.target.checked })}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  <span
                    className={`text-[13px] ${
                      item.done ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-200'
                    }`}
                  >
                    {item.text}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {!!task.dependsOn?.length && (
          <div>
            <p className="text-[12px] font-semibold text-gray-500 dark:text-gray-400 mb-2">Blocked by</p>
            <div className="space-y-1">
              {task.dependsOn.map(d => (
                <div key={d.dependsOn.id} className="flex items-center gap-2 text-[12.5px]">
                  <Badge variant={STATUS_VARIANT[d.dependsOn.status]}>{d.dependsOn.status}</Badge>
                  <span className="text-gray-700 dark:text-gray-200">{d.dependsOn.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          {(['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const).map(s => (
            <Button
              key={s}
              size="xs"
              variant={task.status === s ? 'primary' : 'secondary'}
              onClick={() => update.mutate({ id: task.id, status: s })}
              loading={update.isPending}
            >
              {s.replace('_', ' ')}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function NewTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateTask();
  const [form, setForm] = useState({ title: '', description: '', priority: 'MEDIUM', dueAt: '' });
  const [error, setError] = useState('');

  const submit = () => {
    setError('');
    create.mutate(
      {
        title: form.title,
        description: form.description || undefined,
        priority: form.priority as Task['priority'],
        dueAt: form.dueAt || undefined,
      },
      {
        onSuccess: () => {
          setForm({ title: '', description: '', priority: 'MEDIUM', dueAt: '' });
          onClose();
        },
        onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that task.'),
      }
    );
  };

  const field =
    'w-full px-3 py-2 text-[13px] border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New task"
      icon={<CheckSquare size={16} />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={!form.title.trim()}>
            Create task
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">Title</label>
          <input
            className={field}
            value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
            placeholder="What needs doing?"
          />
        </div>
        <div>
          <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">Details</label>
          <textarea
            className={field}
            rows={3}
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">Priority</label>
            <select
              className={field}
              value={form.priority}
              onChange={e => setForm({ ...form, priority: e.target.value })}
            >
              {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">Due</label>
            <input
              type="datetime-local"
              className={field}
              value={form.dueAt}
              onChange={e => setForm({ ...form, dueAt: e.target.value })}
            />
          </div>
        </div>
        {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}

export default function MyWorkPage() {
  const { data, isLoading } = useMyWork();
  const [newOpen, setNewOpen] = useState(false);
  const [detail, setDetail] = useState<Task | null>(null);

  const empty =
    !isLoading &&
    data &&
    !data.overdue.length &&
    !data.today.length &&
    !data.thisWeek.length &&
    !data.later.length &&
    !data.noDate.length &&
    !data.approvals.length;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="My Work"
        subtitle="Everything assigned to you across CRM, IT Desk and HR — plus anything waiting on your approval."
        actions={
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus size={14} /> New task
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {isLoading && <Spinner />}

        {data && !isLoading && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Overdue', value: data.counts.overdue, tone: 'text-red-600 dark:text-red-400' },
                { label: 'Due today', value: data.counts.today, tone: 'text-amber-600 dark:text-amber-400' },
                { label: 'This week', value: data.counts.thisWeek, tone: 'text-blue-600 dark:text-blue-400' },
                { label: 'Approvals', value: data.counts.approvals, tone: 'text-violet-600 dark:text-violet-400' },
              ].map(s => (
                <div
                  key={s.label}
                  className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-3.5"
                >
                  <p className="text-xs text-gray-500 dark:text-gray-400">{s.label}</p>
                  <p className={`text-xl font-bold mt-0.5 ${s.tone}`}>{s.value}</p>
                </div>
              ))}
            </div>

            {!!data.approvals.length && (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-800">
                  <Inbox size={14} className="text-violet-500" />
                  <h2 className="text-[13px] font-semibold text-gray-900 dark:text-white">Waiting on you</h2>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">{data.approvals.length}</span>
                </div>
                {data.approvals.map(a => (
                  <ApprovalCard key={a.stepId} approval={a} />
                ))}
              </div>
            )}

            <Bucket title="Overdue" icon={<AlertTriangle size={14} />} tone="text-red-500" tasks={data.overdue} onOpen={setDetail} />
            <Bucket title="Today" icon={<Clock size={14} />} tone="text-amber-500" tasks={data.today} onOpen={setDetail} />
            <Bucket title="This week" icon={<Calendar size={14} />} tone="text-blue-500" tasks={data.thisWeek} onOpen={setDetail} />
            <Bucket title="Later" icon={<Calendar size={14} />} tone="text-gray-400" tasks={data.later} onOpen={setDetail} />
            <Bucket title="No date" icon={<CheckSquare size={14} />} tone="text-gray-400" tasks={data.noDate} onOpen={setDetail} />
          </>
        )}

        {empty && (
          <EmptyState
            icon={<CheckSquare />}
            title="Nothing on your plate"
            description="Tasks assigned to you and approvals waiting on you will appear here."
            action={{ label: 'Create a task', onClick: () => setNewOpen(true) }}
          />
        )}
      </div>

      <NewTaskModal open={newOpen} onClose={() => setNewOpen(false)} />
      <TaskDetailModal task={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
