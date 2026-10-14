import { useState } from 'react';
import { Home, Plus, CalendarRange, Repeat, X, Undo2 } from 'lucide-react';
import {
  Card, CardHeader, Button, Modal, Badge, StatusBadge, approvalStatusVariant, Field, Input, Select, Textarea, Alert, SkeletonTable,
} from '../../../shared/components';
import { useUsers } from '../../../api/users';
import {
  useWfhSummary, useRequestWfh, useCancelOwnRequest, useWfhSchedules, useSaveWfhSchedule, useEndWfhSchedule, useSkipWfhDate, useUnskipWfhDate,
  usageLine, WEEKDAY_SHORT, WEEKDAY_ORDER, type WfhRequest, type WfhSummary, type WfhSchedule,
} from '../../../api/wfh';

const errMsg = (e: any, fallback: string) => e?.response?.data?.error || e?.response?.data?.details?.[0]?.message || fallback;
const num = (v: number | string) => Number(v);
const fmtDays = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} day${n === 1 ? '' : 's'}`;

/** "Mon 12 Oct", "Mon 12 – Wed 14 Oct", "Fri 16 Oct · first half" */
export function wfhDates(r: { startDate: string; endDate: string; halfDay?: boolean | null; halfDayPeriod?: string | null }) {
  const d = (s: string, opts: Intl.DateTimeFormatOptions) => new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, opts);
  const full: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
  if (r.halfDay) return `${d(r.startDate, full)} · ${r.halfDayPeriod === 'PM' ? 'second' : 'first'} half`;
  if (r.startDate.slice(0, 10) === r.endDate.slice(0, 10)) return d(r.startDate, full);
  return `${d(r.startDate, full)} – ${d(r.endDate, full)}`;
}

// ─── Employee: request form ──────────────────────────────────────────────────

export function WfhRequestModal({ summary, onClose }: { summary: WfhSummary; onClose: () => void }) {
  const request = useRequestWfh();
  const s = summary.settings;
  const [form, setForm] = useState({ range: false, startDate: summary.today, endDate: summary.today, duration: 'FULL' as 'FULL' | 'AM' | 'PM', reason: '', leaveTypeId: summary.defaultTypeId ?? '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState<WfhRequest | null>(null);
  const half = !form.range && form.duration !== 'FULL';
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm(f => ({ ...f, [k]: v }));

  const submit = () => {
    setError('');
    if (!form.startDate) return setError('Pick a date.');
    if (form.range && form.endDate < form.startDate) return setError('The end date is before the start date.');
    request.mutate({
      startDate: form.startDate, endDate: form.range ? form.endDate : form.startDate,
      halfDay: half, halfDayPeriod: half ? (form.duration as 'AM' | 'PM') : undefined,
      reason: form.reason.trim() || undefined, leaveTypeId: form.leaveTypeId || undefined,
    }, { onSuccess: r => setDone(r), onError: e => setError(errMsg(e, 'Could not send the request.')) });
  };

  if (done) {
    const approved = done.status === 'APPROVED';
    return (
      <Modal open onClose={onClose} title={approved ? 'Work from home approved' : 'Request sent'} icon={<Home size={16} />} size="sm"
        footer={<Button onClick={onClose}>Done</Button>}>
        <div className="space-y-2 text-[13px] text-fg">
          <p><strong>{wfhDates(done)}</strong> · {fmtDays(num(done.days))}</p>
          <p className="text-fg-muted">{approved
            ? 'Your policy approves work from home automatically, so it\'s confirmed.'
            : 'Your manager has been notified and will approve or reject it. You\'ll get a notification either way.'}</p>
          {s.requireCheckIn && <p className="text-fg-muted">On the day, check in and out from the Attendance page as usual — the office location check is skipped.</p>}
        </div>
      </Modal>
    );
  }

  const notice = s.minNoticeDays > 0 ? `${s.minNoticeDays} day${s.minNoticeDays === 1 ? '' : 's'} notice` : !s.allowSameDay ? 'at least a day ahead' : null;
  return (
    <Modal open onClose={onClose} title="Request work from home" icon={<Home size={16} />} size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={request.isPending} onClick={submit}>{s.approvalMode === 'AUTO' ? 'Confirm' : 'Send request'}</Button>
      </>}>
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <p className="text-[12.5px] text-fg-muted">{usageLine(summary.usage)}.</p>
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Days">
          {[{ v: false, l: 'One day' }, { v: true, l: 'Several days' }].map(o => (
            <Button key={String(o.v)} size="sm" variant={form.range === o.v ? 'primary' : 'secondary'} aria-pressed={form.range === o.v} onClick={() => set('range', o.v)}>{o.l}</Button>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={form.range ? 'From' : 'Date'}>
            <Input type="date" value={form.startDate} min={summary.today} onChange={e => setForm(f => ({ ...f, startDate: e.target.value, endDate: f.endDate < e.target.value ? e.target.value : f.endDate }))} />
          </Field>
          {form.range ? (
            <Field label="To"><Input type="date" value={form.endDate} min={form.startDate} onChange={e => set('endDate', e.target.value)} /></Field>
          ) : s.allowHalfDay ? (
            <Field label="Duration">
              <Select value={form.duration} onChange={e => set('duration', e.target.value as any)}>
                <option value="FULL">Full day</option><option value="AM">First half</option><option value="PM">Second half</option>
              </Select>
            </Field>
          ) : null}
        </div>
        {summary.types.length > 1 && (
          <Field label="Type">
            <Select value={form.leaveTypeId} onChange={e => set('leaveTypeId', e.target.value)}>
              {summary.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Reason (optional)"><Textarea rows={2} value={form.reason} onChange={e => set('reason', e.target.value)} placeholder="e.g. Waiting for a delivery" maxLength={500} /></Field>
        <ul className="text-[11.5px] text-fg-subtle space-y-0.5 list-disc pl-4">
          <li>Only working days count; weekly offs and holidays in a range are skipped.</li>
          <li>{s.approvalMode === 'AUTO' ? 'Approved straight away when it\'s within your limits.' : 'Your manager approves it.'}{notice ? ` Needs ${notice}.` : ''}</li>
          {s.requireCheckIn ? <li>Check in and out as usual on the day — no office location needed.</li> : <li>WFH days are paid; no check-in needed.</li>}
        </ul>
      </div>
    </Modal>
  );
}

// ─── Employee: "Work from home" card on My Attendance ────────────────────────

export function MyWfhCard() {
  const { data, isLoading } = useWfhSummary();
  const cancel = useCancelOwnRequest();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState('');
  if (isLoading || !data) return null;
  // Nothing to offer: WFH off for this group and no history.
  if (!data.enabled && data.requests.length === 0 && data.schedules.length === 0) return null;

  const today = data.today;
  const cancellable = (r: WfhRequest) => r.status === 'PENDING' || (r.status === 'APPROVED' && r.startDate.slice(0, 10) > today);
  const relevant = data.requests.filter(r => r.status === 'PENDING' || r.endDate.slice(0, 10) >= today);
  const list = showAll ? data.requests : relevant.slice(0, 5);

  return (
    <Card>
      <CardHeader
        title="Work from home" icon={<Home size={14} />}
        subtitle={data.enabled ? usageLine(data.usage) : `Work from home isn't enabled for your policy (${data.groupName}).`}
        actions={data.enabled ? <Button size="sm" icon={<Plus size={13} />} onClick={() => setOpen(true)} className="w-full sm:w-auto">Request WFH</Button> : undefined}
      />
      {data.todayWfh && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-teal-50 dark:bg-teal-500/10 text-teal-800 dark:text-teal-300 px-3 py-2 text-[12.5px]">
          <Home size={14} className="mt-0.5 shrink-0" />
          <span>You're working from home today{data.todayWfh.source === 'SCHEDULE' ? ' (recurring)' : ''}.{data.settings.requireCheckIn ? ' Check in and out as usual — the office location check is skipped.' : ' The day is paid; no check-in needed.'}</span>
        </div>
      )}
      {data.schedules.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
          <Repeat size={12} className="shrink-0" />
          {data.schedules.map(s => (
            <Badge key={s.id} variant="teal">{s.label}{s.endDate ? ` until ${new Date(`${s.endDate}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}{s.scope === 'GROUP' ? ' · team' : ''}</Badge>
          ))}
          <span>set by HR</span>
        </div>
      )}
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      {list.length > 0 ? (
        <ul className="divide-y divide-line-subtle mt-2">
          {list.map(r => (
            <li key={r.id} className="py-2.5 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-medium text-fg tabular-nums">{wfhDates(r)}</span>
                  <StatusBadge value={r.status} map={approvalStatusVariant} dot size="sm" />
                </div>
                <p className="text-[11.5px] text-fg-subtle mt-0.5">
                  {fmtDays(num(r.days))}{r.reason ? ` · ${r.reason}` : ''}
                  {r.status === 'APPROVED' && !r.decider ? ' · approved automatically' : ''}
                  {r.status === 'REJECTED' && r.rejectionReason ? ` · ${r.rejectionReason}` : ''}
                </p>
              </div>
              {cancellable(r) && (
                <Button size="xs" variant="ghost" loading={cancel.isPending && cancel.variables === r.id}
                  onClick={() => { setError(''); cancel.mutate(r.id, { onError: e => setError(errMsg(e, 'Could not cancel')) }); }}>
                  {r.status === 'PENDING' ? 'Cancel' : 'Withdraw'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-fg-subtle mt-3">No upcoming work-from-home requests.</p>
      )}
      {data.requests.length > list.length || showAll ? (
        <Button size="xs" variant="ghost" className="mt-1" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show upcoming only' : `Show all (${data.requests.length})`}</Button>
      ) : null}
      {open && <WfhRequestModal summary={data} onClose={() => setOpen(false)} />}
    </Card>
  );
}

// ─── HR: recurring WFH for a person or a policy group ────────────────────────

/** Weekday toggles, Monday first. */
function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAY_ORDER.map(d => (
        <Button key={d} size="xs" variant={value.includes(d) ? 'primary' : 'secondary'} aria-pressed={value.includes(d)}
          onClick={() => onChange(value.includes(d) ? value.filter(x => x !== d) : [...value, d])}>{WEEKDAY_SHORT[d]}</Button>
      ))}
    </div>
  );
}

const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const shortDate = (k: string) => new Date(`${k}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Recurring WFH: a weekly pattern (e.g. every Friday) from a start date,
 * optionally until an end date, for one person (`userId`) or a whole policy
 * group (`policyGroupId`). Days matching it are approved WFH days in the
 * register without any request; a single date can be skipped.
 */
export function WfhSchedulesPanel({ userId, policyGroupId, compact = false }: { userId?: string; policyGroupId?: string; compact?: boolean }) {
  const { data, isLoading } = useWfhSchedules({ userId, policyGroupId });
  const save = useSaveWfhSchedule();
  const end = useEndWfhSchedule();
  const skip = useSkipWfhDate();
  const unskip = useUnskipWfhDate();
  const { data: users } = useUsers();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ weekdays: [5] as number[], startDate: todayKey(), endDate: '', note: '' });
  const [skipFor, setSkipFor] = useState<WfhSchedule | null>(null);
  const [skipForm, setSkipForm] = useState({ date: '', userId: '', reason: '' });
  const [error, setError] = useState('');
  const today = todayKey();
  const active = (data ?? []).filter(s => !s.endDate || s.endDate >= today);
  const ended = (data ?? []).filter(s => s.endDate && s.endDate < today);
  const userName = (id: string | null) => (id ? users?.find(u => u.id === id)?.name ?? 'Someone' : 'Everyone');

  const add = () => {
    setError('');
    if (!form.weekdays.length) return setError('Pick at least one weekday.');
    if (form.endDate && form.endDate < form.startDate) return setError('The end date is before the start date.');
    save.mutate({ userId, policyGroupId, weekdays: form.weekdays, startDate: form.startDate, endDate: form.endDate || null, note: form.note.trim() || undefined },
      { onSuccess: () => { setAdding(false); setForm({ weekdays: [5], startDate: todayKey(), endDate: '', note: '' }); }, onError: e => setError(errMsg(e, 'Could not save')) });
  };
  const doSkip = () => {
    if (!skipFor || !skipForm.date) return;
    skip.mutate({ scheduleId: skipFor.id, date: skipForm.date, userId: skipFor.userId ? undefined : (skipForm.userId || null), reason: skipForm.reason.trim() || undefined },
      { onSuccess: () => { setSkipFor(null); setSkipForm({ date: '', userId: '', reason: '' }); }, onError: e => setError(errMsg(e, 'Could not skip that date')) });
  };

  return (
    <div className="space-y-2">
      {!compact && <p className="text-[11.5px] text-fg-muted">Days matching a pattern are approved work-from-home days automatically — no request needed. They count towards the monthly / weekly limits. Skip a single date if someone must come in.</p>}
      {error && <Alert tone="danger">{error}</Alert>}
      {isLoading ? <SkeletonTable rows={1} /> : active.length === 0 && !adding ? (
        <p className="text-[12px] text-fg-subtle">No recurring work from home.</p>
      ) : (
        <ul className="space-y-2">
          {active.map(s => (
            <li key={s.id} className="rounded-lg border border-line-subtle p-2.5 space-y-1.5">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-fg flex items-center gap-1.5"><Repeat size={12} className="text-teal-600 shrink-0" />{s.label}</p>
                  <p className="text-[11.5px] text-fg-subtle">From {shortDate(s.startDate)}{s.endDate ? ` until ${shortDate(s.endDate)}` : ', no end date'}{s.note ? ` · ${s.note}` : ''}</p>
                </div>
                <span className="flex gap-1">
                  <Button size="xs" variant="ghost" icon={<CalendarRange size={12} />} onClick={() => { setSkipFor(s); setSkipForm({ date: '', userId: '', reason: '' }); }}>Skip a date</Button>
                  <Button size="xs" variant="ghost" icon={<X size={12} />} loading={end.isPending && end.variables === s.id}
                    onClick={() => end.mutate(s.id, { onError: e => setError(errMsg(e, 'Could not stop it')) })}
                    title={s.startDate < today ? 'Ends it yesterday — past days stay WFH' : 'Removes it (it hasn\'t started)'}>Stop</Button>
                </span>
              </div>
              {s.exceptions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {s.exceptions.map(e => (
                    <span key={e.id} className="inline-flex items-center gap-1 text-[11px] rounded-badge bg-surface-sunken border border-line-subtle px-1.5 py-0.5 text-fg-muted">
                      Skipped {shortDate(e.date)}{!s.userId ? ` · ${userName(e.userId)}` : ''}
                      <button type="button" className="text-fg-subtle hover:text-fg" aria-label="Undo skip" title="Undo" onClick={() => unskip.mutate({ scheduleId: s.id, exceptionId: e.id })}><Undo2 size={11} /></button>
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="rounded-lg border border-dashed border-line p-3 space-y-3">
          <Field label="Every"><WeekdayPicker value={form.weekdays} onChange={v => setForm(f => ({ ...f, weekdays: v }))} /></Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Starting"><Input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} /></Field>
            <Field label="Until (optional)"><Input type="date" value={form.endDate} min={form.startDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} /></Field>
          </div>
          <Field label="Note (optional)"><Input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="e.g. Hybrid — Fridays from home" maxLength={200} /></Field>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" loading={save.isPending} onClick={add}>Save pattern</Button>
          </div>
        </div>
      ) : (
        <Button size="xs" variant="secondary" icon={<Plus size={12} />} onClick={() => setAdding(true)}>Add recurring WFH</Button>
      )}
      {ended.length > 0 && <p className="text-[11px] text-fg-subtle">{ended.length} ended pattern{ended.length === 1 ? '' : 's'}: {ended.map(s => `${s.label} (${shortDate(s.startDate)} – ${shortDate(s.endDate!)})`).join('; ')}</p>}

      {skipFor && (
        <Modal open onClose={() => setSkipFor(null)} title={`Skip a date · ${skipFor.label}`} size="sm" icon={<CalendarRange size={16} />}
          footer={<><Button variant="secondary" onClick={() => setSkipFor(null)}>Cancel</Button><Button loading={skip.isPending} disabled={!skipForm.date} onClick={doSkip}>Skip date</Button></>}>
          <div className="space-y-3">
            <Field label="Date"><Input type="date" value={skipForm.date} min={skipFor.startDate} onChange={e => setSkipForm(f => ({ ...f, date: e.target.value }))} /></Field>
            {!skipFor.userId && (
              <Field label="For" hint="Leave on Everyone to skip the date for the whole group (e.g. an all-hands day).">
                <Select value={skipForm.userId} onChange={e => setSkipForm(f => ({ ...f, userId: e.target.value }))}>
                  <option value="">Everyone on this pattern</option>
                  {(users ?? []).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Reason (optional)"><Input value={skipForm.reason} onChange={e => setSkipForm(f => ({ ...f, reason: e.target.value }))} placeholder="e.g. Office all-hands" /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** HR: one person's WFH at a glance (Leave → Employees): usage, recurring pattern, recent requests. */
export function EmployeeWfhCard({ userId, name }: { userId: string; name: string }) {
  const { data } = useWfhSummary(userId);
  return (
    <Card>
      <CardHeader title="Work from home" icon={<Home size={14} />} subtitle={data ? `${data.enabled ? usageLine(data.usage) : 'Not enabled for their policy'} · policy ${data.groupName}${data.settings.approvalMode === 'AUTO' ? ' (auto-approve)' : ''}` : undefined} className="mb-3" />
      <p className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1.5">Recurring WFH for {name}</p>
      <WfhSchedulesPanel userId={userId} compact />
      {!!data?.schedules.some(s => s.scope === 'GROUP') && (
        <p className="text-[11.5px] text-fg-subtle mt-2">Also from their policy group: {data.schedules.filter(s => s.scope === 'GROUP').map(s => s.label).join(', ')} (edit under HR Settings → Attendance policies).</p>
      )}
    </Card>
  );
}
