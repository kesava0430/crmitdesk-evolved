import { useState } from 'react';
import { Bell, Send, Trash2, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  useSchedules, useCreateSchedule, useCancelSchedule,
  type ScheduleEntityType, type RecipientType, type Recurrence,
} from '../../api/schedules';
import { SearchableSelect } from './SearchableSelect';

interface Props {
  entityType: ScheduleEntityType;
  entityId: string;
}

const RECIPIENT_OPTIONS: Record<ScheduleEntityType, { value: RecipientType; label: string }[]> = {
  DEAL: [
    { value: 'CONTACT', label: "Deal's contact" },
    { value: 'ASSIGNEE', label: 'Assigned rep' },
    { value: 'CUSTOM_NUMBER', label: 'Custom number' },
    { value: 'ORG_DEFAULT', label: 'Org default number' },
  ],
  // Tickets have no linked CRM Contact — requester is an internal user, not
  // a Contact record — so CONTACT isn't offered here (the server also
  // rejects it defensively if sent anyway).
  TICKET: [
    { value: 'ASSIGNEE', label: 'Assigned agent' },
    { value: 'CUSTOM_NUMBER', label: 'Custom number' },
    { value: 'ORG_DEFAULT', label: 'Org default number' },
  ],
};

const RECURRENCE_OPTIONS: { value: Recurrence; label: string }[] = [
  { value: 'NONE', label: 'One-time' },
  { value: 'DAILY', label: 'Repeats daily' },
  { value: 'WEEKLY', label: 'Repeats weekly' },
];

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  PENDING: { icon: <Clock size={12} />, color: 'text-blue-600 bg-blue-50 border-blue-200', label: 'Upcoming' },
  SENT: { icon: <CheckCircle2 size={12} />, color: 'text-green-600 bg-green-50 border-green-200', label: 'Sent' },
  FAILED: { icon: <AlertCircle size={12} />, color: 'text-red-600 bg-red-50 border-red-200', label: 'Failed' },
};

/** Local datetime-local input value for "now" (rounded to the next minute), used as a sane min. */
function nowLocal() {
  const d = new Date(Date.now() + 60_000);
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 16);
}

export function ScheduleReminderPanel({ entityType, entityId }: Props) {
  const { data: schedules = [], isLoading } = useSchedules(entityType, entityId);
  const create = useCreateSchedule();
  const cancel = useCancelSchedule();

  const [open, setOpen] = useState(false);
  const [dueAt, setDueAt] = useState('');
  const [message, setMessage] = useState('');
  const [recipientType, setRecipientType] = useState<RecipientType>('ASSIGNEE');
  const [customNumber, setCustomNumber] = useState('');
  const [recurrence, setRecurrence] = useState<Recurrence>('NONE');

  function reset() {
    setDueAt(''); setMessage(''); setRecipientType('ASSIGNEE'); setCustomNumber(''); setRecurrence('NONE'); setOpen(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dueAt || !message.trim()) return;
    create.mutate({
      entityType,
      entityId,
      dueAt: new Date(dueAt).toISOString(),
      recurrence,
      message: message.trim(),
      recipientType,
      customNumber: recipientType === 'CUSTOM_NUMBER' ? customNumber.trim() : undefined,
    }, { onSuccess: reset });
  }

  return (
    <div className="border-t pt-4 mt-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Bell size={14} className="text-brand-500" /> WhatsApp Reminders ({schedules.length})
        </h3>
        {!open && (
          <button onClick={() => setOpen(true)} className="text-xs text-brand-600 hover:text-brand-700 font-medium">
            + Schedule a reminder
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={handleSubmit} className="bg-gray-50 rounded-xl p-3 space-y-3 mb-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">Due <span className="req">*</span></label>
              <input
                aria-label="Due date"
                type="datetime-local"
                required
                min={nowLocal()}
                value={dueAt}
                onChange={e => setDueAt(e.target.value)}
                className="ui-input text-sm"
              />
            </div>
            <div>
              <label className="form-label">Repeat</label>
              <select aria-label="Recurrence" value={recurrence} onChange={e => setRecurrence(e.target.value as Recurrence)} className="ui-input text-sm">
                {RECURRENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="form-label">Message <span className="req">*</span></label>
            <textarea
              aria-label="Message"
              required
              rows={2}
              placeholder="e.g. Follow up with {{title}} — check in on next steps"
              value={message}
              onChange={e => setMessage(e.target.value)}
              className="ui-input text-sm resize-none"
            />
          </div>

          <div>
            <label className="form-label">Send via WhatsApp to</label>
            <SearchableSelect
              ariaLabel="Recipient"
              value={recipientType}
              onChange={val => setRecipientType(val as RecipientType)}
              options={RECIPIENT_OPTIONS[entityType]}
            />
          </div>

          {recipientType === 'CUSTOM_NUMBER' && (
            <div>
              <label className="form-label">Phone number <span className="req">*</span></label>
              <input
                aria-label="Custom number"
                required
                placeholder="+14155551234"
                value={customNumber}
                onChange={e => setCustomNumber(e.target.value)}
                className="ui-input text-sm"
              />
            </div>
          )}

          {create.isError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">
              {(create.error as any)?.response?.data?.error || 'Could not schedule the reminder'}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={reset} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
            <button type="submit" disabled={create.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 text-white text-xs font-medium rounded-lg hover:bg-brand-700 disabled:opacity-40">
              <Send size={12} /> Schedule reminder
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : schedules.length === 0 ? (
        !open && <p className="text-xs text-gray-400 text-center py-3">No reminders scheduled yet.</p>
      ) : (
        <div className="space-y-2">
          {schedules.map(s => {
            const status = STATUS_CONFIG[s.status] || STATUS_CONFIG.PENDING;
            return (
              <div key={s.id} className="flex items-start justify-between gap-2 bg-white border border-gray-100 rounded-xl p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full border ${status.color}`}>
                      {status.icon} {status.label}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(s.dueAt).toLocaleString()} · {formatDistanceToNow(new Date(s.dueAt), { addSuffix: true })}
                    </span>
                    {s.recurrence !== 'NONE' && (
                      <span className="text-[11px] text-violet-500 bg-violet-50 px-1.5 py-0.5 rounded-full">{s.recurrence === 'DAILY' ? 'Daily' : 'Weekly'}</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-700 mt-1 truncate">{s.message}</p>
                  {s.status === 'FAILED' && s.lastError && (
                    <p className="text-xs text-red-500 mt-0.5">{s.lastError}</p>
                  )}
                </div>
                <button onClick={() => cancel.mutate(s.id)} title="Cancel reminder"
                  className="p-1 text-gray-300 hover:text-red-500 flex-shrink-0">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
