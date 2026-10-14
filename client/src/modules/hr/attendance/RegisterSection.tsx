import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, History, RotateCcw, CalendarCheck, Pencil, Download, Plus, Camera, Lock } from 'lucide-react';
import { api } from '../../../api/client';
import {
  Card, CardHeader, Button, Modal, Badge, Field, Input, Select, Textarea, Alert, SkeletonTable, EmptyState, Avatar, IconButton,
} from '../../../shared/components';
import {
  useRegister, useMarkDay, useResetDay, useConvertToLeave, useAttendanceAudit, useDayDetail, fetchSelfie, registerToCsv,
  STATUS_LABEL, STATUS_SHORT, STATUS_CLASS, type DayStatus, type ManualStatus, type RegisterDay, type RegisterRow, type DaySession, type MarkDayInput,
} from '../../../api/attendanceAdmin';
import { useFormat } from '../../../hooks/useFormat';
import { useMediaQuery, MD_UP } from '../../../hooks/useMediaQuery';

const MANUAL_STATUSES: ManualStatus[] = ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'WFH', 'LEAVE', 'UNPAID_LEAVE', 'LOP', 'HOLIDAY', 'WEEK_OFF'];
const LEGEND: DayStatus[] = ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'UNPAID_LEAVE', 'WFH', 'HOLIDAY', 'WEEK_OFF', 'LOP', 'NOT_EMPLOYED'];

function monthKey(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function shiftMonth(m: string, delta: number) { const [y, mo] = m.split('-').map(Number); return monthKey(new Date(y, mo - 1 + delta, 1)); }
function monthLabel(m: string) { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
/** ISO instant → value for <input type="datetime-local"> (device time zone). */
function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (v: string) => new Date(v).toISOString();
const fmtMin = (m: number) => (m ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : '—');

function downloadCsv(name: string, csv: string) {
  // BOM so Excel opens UTF-8 names correctly
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface RegisterSectionProps { canEdit: boolean; onlyUserId?: string }

export function RegisterSection({ canEdit, onlyUserId }: RegisterSectionProps) {
  const [month, setMonth] = useState(monthKey(new Date()));
  const [search, setSearch] = useState('');
  const { data, isLoading, isError } = useRegister(month, onlyUserId, canEdit && !onlyUserId);
  const [selected, setSelected] = useState<{ row: RegisterRow; day: RegisterDay } | null>(null);
  const [historyFor, setHistoryFor] = useState<RegisterRow | null>(null);

  const rows = useMemo(() => {
    const list = data?.rows ?? [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(r => r.user.name.toLowerCase().includes(q) || (r.user.department || '').toLowerCase().includes(q));
  }, [data, search]);
  const days = data?.rows?.[0]?.days ?? [];
  const mdUp = useMediaQuery(MD_UP);
  // An employee's own register reads best as a month calendar on a phone; the
  // days × people grid stays for HR and for wider screens.
  const calendar = !!onlyUserId && !mdUp && rows.length === 1;

  // Keep today's column in view: on a phone only 6–8 day columns fit next to
  // the pinned employee column, so open the grid scrolled to today.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const today = el.querySelector<HTMLElement>('th[data-today]');
    const sticky = el.querySelector<HTMLElement>('th[data-sticky]');
    if (!today) { el.scrollLeft = 0; return; }
    const pinned = sticky?.offsetWidth ?? 0;
    const visible = today.offsetLeft >= el.scrollLeft + pinned && today.offsetLeft + today.offsetWidth <= el.scrollLeft + el.clientWidth;
    // Past days matter more than future ones: put today near the right edge.
    if (!visible) el.scrollLeft = Math.max(0, Math.min(today.offsetLeft - pinned, today.offsetLeft + today.offsetWidth * 3 - el.clientWidth));
  }, [data, month, calendar]);

  return (
    <Card>
      <CardHeader
        title={onlyUserId ? 'Monthly register' : 'Attendance register'}
        subtitle={onlyUserId
          ? 'Day-wise status computed from your policy; tap a day for its sessions. Corrections by HR are marked.'
          : 'Click any day to see its sessions and correct it. Manual corrections are audited. Totals are to date.'}
        actions={
          <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
            {!onlyUserId && <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter people…" className="flex-1 min-w-0 sm:flex-none sm:w-44" />}
            {!onlyUserId && rows.length > 0 && (
              <IconButton label="Export CSV" icon={<Download size={16} />} onClick={() => downloadCsv(`attendance-register-${month}.csv`, registerToCsv(rows))} />
            )}
            {/* Phones: month switcher on its own full-width row, above the filter. */}
            <div className="flex items-center justify-between gap-2 w-full order-first sm:order-none sm:w-auto sm:justify-start">
              <IconButton label="Previous month" icon={<ChevronLeft size={16} />} onClick={() => setMonth(m => shiftMonth(m, -1))} />
              <span className="text-sm font-medium text-fg min-w-[9rem] text-center">{monthLabel(month)}</span>
              <IconButton label="Next month" icon={<ChevronRight size={16} />} onClick={() => setMonth(m => shiftMonth(m, 1))} />
            </div>
          </div>
        }
      />
      {isLoading ? <SkeletonTable rows={6} /> : isError ? <Alert tone="danger">Could not load the register.</Alert> : rows.length === 0 ? (
        <EmptyState icon={<CalendarCheck size={20} />} title="No people in this register" description="Nothing to show for this month." />
      ) : calendar ? (
        <MonthCalendar row={rows[0]} onPick={day => setSelected({ row: rows[0], day })} />
      ) : (
        <div ref={scroller} className="overflow-x-auto overscroll-x-contain -mx-card sm:mx-0">
          <table className="text-xs border-separate border-spacing-0 min-w-full">
            <thead>
              <tr>
                <th data-sticky className="sticky left-0 z-10 bg-surface text-left font-medium text-fg-muted pl-card pr-2 sm:px-3 py-2 border-b border-r sm:border-r-0 border-line-subtle w-[7.5rem] min-w-[7.5rem] max-w-[7.5rem] sm:w-auto sm:max-w-none sm:min-w-[12rem]">Employee</th>
                {days.map(d => {
                  const dt = new Date(d.date + 'T00:00:00');
                  const isToday = d.phase === 'today';
                  return (
                    <th key={d.date} data-today={isToday || undefined} className={`px-0.5 py-1 border-b border-line-subtle font-normal text-center ${isToday ? 'text-accent font-semibold' : 'text-fg-subtle'}`}>
                      <div className="leading-tight"><div>{dt.getDate()}</div><div className="text-[10px] uppercase">{dt.toLocaleDateString(undefined, { weekday: 'narrow' })}</div></div>
                    </th>
                  );
                })}
                <th className="px-2 py-2 border-b border-line-subtle text-right font-medium text-fg-muted whitespace-nowrap" title="Paid days / working days so far">Paid / Work</th>
                <th className="px-2 py-2 border-b border-line-subtle text-right font-medium text-fg-muted">LOP</th>
                <th className="px-2 py-2 border-b border-line-subtle text-right font-medium text-fg-muted">Late</th>
                <th className="px-2 py-2 border-b border-line-subtle text-right font-medium text-fg-muted">OT</th>
                {canEdit && <th className="px-2 py-2 border-b border-line-subtle" />}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.user.id} className="group">
                  <td className="sticky left-0 z-10 bg-surface pl-card pr-2 sm:px-3 py-1.5 border-b border-r sm:border-r-0 border-line-subtle w-[7.5rem] min-w-[7.5rem] max-w-[7.5rem] sm:w-auto sm:max-w-none">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="hidden sm:inline-flex shrink-0"><Avatar name={row.user.name} src={row.user.avatarUrl ?? undefined} size="xs" /></span>
                      <div className="min-w-0">
                        <div className="font-medium text-fg truncate" title={row.user.name}>{row.user.name}{row.user.isActive === false && <span className="ml-1 text-[10px] text-fg-subtle">(inactive)</span>}</div>
                        <div className="hidden sm:block text-[10px] text-fg-subtle truncate">{row.policyGroup}{row.user.department ? ` · ${row.user.department}` : ''}</div>
                        {/* The totals columns sit off-screen on a phone — show the key one here. */}
                        <div className="sm:hidden text-[10px] text-fg-muted tabular-nums truncate">Paid {row.summary.paidDays}/{row.summary.workingDays}{row.summary.lopDays ? ` · LOP ${row.summary.lopDays}` : ''}</div>
                      </div>
                    </div>
                  </td>
                  {row.days.map(d => {
                    const provisional = d.phase === 'today' && d.status !== 'PENDING';
                    return (
                      <td key={d.date} className="p-0.5 border-b border-line-subtle text-center">
                        <button
                          type="button"
                          title={`${d.date}: ${STATUS_LABEL[d.status]}${provisional ? ' (so far — day in progress)' : ''}${d.source === 'MANUAL' ? ' (manual)' : ''}${d.workedMinutes ? ` · ${fmtMin(d.workedMinutes)}` : ''}${d.lateMinutes ? ` · late ${d.lateMinutes}m` : ''}${d.frozen ? ' · paid (locked)' : ''}`}
                          onClick={() => setSelected({ row, day: d })}
                          className={`relative w-7 h-7 rounded font-semibold tabular-nums hover:ring-2 hover:ring-accent/60 cursor-pointer ${STATUS_CLASS[d.status]} ${provisional ? 'opacity-70 italic ring-1 ring-dashed ring-accent/40' : ''}`}
                        >
                          {STATUS_SHORT[d.status]}
                          {d.source === 'MANUAL' && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-accent" aria-label="Manually corrected" />}
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 border-b border-line-subtle text-right tabular-nums font-medium text-fg whitespace-nowrap">{row.summary.paidDays} / {row.summary.workingDays}</td>
                  <td className={`px-2 py-1.5 border-b border-line-subtle text-right tabular-nums ${row.summary.lopDays ? 'text-danger font-medium' : 'text-fg-subtle'}`}>{row.summary.lopDays}</td>
                  <td className={`px-2 py-1.5 border-b border-line-subtle text-right tabular-nums ${row.summary.lateCount ? 'text-warning' : 'text-fg-subtle'}`}>{row.summary.lateCount}</td>
                  <td className="px-2 py-1.5 border-b border-line-subtle text-right tabular-nums text-fg-subtle">{row.summary.overtimeHours ? `${row.summary.overtimeHours}h` : '—'}</td>
                  {canEdit && <td className="px-1 border-b border-line-subtle"><IconButton label="Change history" icon={<History size={14} />} size="xs" onClick={() => setHistoryFor(row)} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
          <Legend />
        </div>
      )}

      {selected && <DayModal row={selected.row} day={selected.day} canEdit={canEdit} onClose={() => setSelected(null)} />}
      {historyFor && <HistoryModal row={historyFor} onClose={() => setHistoryFor(null)} />}
    </Card>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 text-[11px] text-fg-subtle border-t border-line-subtle sticky left-0">
      {LEGEND.map(s => <span key={s} className="inline-flex items-center gap-1"><span className={`inline-flex w-4 h-4 rounded items-center justify-center font-semibold ${STATUS_CLASS[s]}`}>{STATUS_SHORT[s]}</span>{STATUS_LABEL[s]}</span>)}
      <span className="inline-flex items-center gap-1"><span className={`inline-flex w-4 h-4 rounded ${STATUS_CLASS.PENDING}`} /> not yet</span>
      <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-accent" /> manual correction</span>
      <span className="inline-flex items-center gap-1 italic">italic = today so far</span>
    </div>
  );
}

/** Monday-first weekday initials in the user's locale (2024-01-01 was a Monday). */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));

/**
 * One person's month as a 7-column calendar — the phone view of an employee's
 * own register. Same data, colours and "tap a day to open it" as the grid.
 */
function MonthCalendar({ row, onPick }: { row: RegisterRow; onPick: (day: RegisterDay) => void }) {
  const first = row.days[0] ? new Date(row.days[0].date + 'T00:00:00') : null;
  const lead = first ? (first.getDay() + 6) % 7 : 0;
  const s = row.summary;
  return (
    <div className="mt-3">
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase text-fg-subtle mb-1">
        {WEEKDAYS.map((w, i) => <div key={i}>{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
        {row.days.map(d => {
          const dt = new Date(d.date + 'T00:00:00');
          const isToday = d.phase === 'today';
          const provisional = isToday && d.status !== 'PENDING';
          return (
            <button
              key={d.date}
              type="button"
              aria-label={`${dt.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}: ${STATUS_LABEL[d.status] || 'not yet'}${d.source === 'MANUAL' ? ' (manual)' : ''}`}
              onClick={() => onPick(d)}
              className={`relative h-12 rounded-lg flex flex-col items-center justify-center tabular-nums ${STATUS_CLASS[d.status]} ${isToday ? 'ring-2 ring-accent' : ''} ${provisional ? 'italic' : ''}`}
            >
              <span className={`text-[10px] leading-none ${isToday ? 'text-accent font-semibold' : 'opacity-70'}`}>{dt.getDate()}</span>
              <span className="text-[12px] font-semibold leading-tight mt-0.5 min-h-[1em]">{STATUS_SHORT[d.status]}</span>
              {d.source === 'MANUAL' && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-4 gap-2 mt-3 text-xs">
        <Stat label="Paid / work" value={<span className="tabular-nums">{s.paidDays} / {s.workingDays}</span>} />
        <Stat label="LOP" value={<span className={`tabular-nums ${s.lopDays ? 'text-danger' : ''}`}>{s.lopDays}</span>} />
        <Stat label="Late" value={<span className={`tabular-nums ${s.lateCount ? 'text-warning' : ''}`}>{s.lateCount}</span>} />
        <Stat label="OT" value={<span className="tabular-nums">{s.overtimeHours ? `${s.overtimeHours}h` : '—'}</span>} />
      </div>
      <div className="-mx-3 mt-3"><Legend /></div>
    </div>
  );
}

/** Stored check-in/out photo, fetched only when asked for. */
function SelfieButton({ session, which }: { session: DaySession; which: 'in' | 'out' }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  if (!(which === 'in' ? session.hasCheckInSelfie : session.hasCheckOutSelfie)) return null;
  if (src) return <img src={src} alt={`Check-${which} photo`} className="w-12 h-12 rounded object-cover -scale-x-100 border border-line" />;
  return (
    <Button size="xs" variant="ghost" icon={<Camera size={12} />} loading={state === 'loading'}
      onClick={() => { setState('loading'); fetchSelfie(session.id, which).then(s => { setSrc(s); setState('idle'); }).catch(() => setState('error')); }}>
      {state === 'error' ? 'Unavailable' : `${which === 'in' ? 'In' : 'Out'} photo`}
    </Button>
  );
}

const SOURCE_LABEL: Record<string, string> = { AUTO_GEOFENCE: 'auto: left office', AUTO_TIMEOUT: 'auto: app silent', AUTO_CLOSE: 'auto: not checked out', DEDUPED: 'closed (duplicate)', MANUAL: 'set by HR' };

type SessionDraft = { checkInAt: string; checkOutAt: string };

function DayModal({ row, day, canEdit, onClose }: { row: RegisterRow; day: RegisterDay; canEdit: boolean; onClose: () => void }) {
  const { dateTime, time } = useFormat();
  const mark = useMarkDay();
  const reset = useResetDay();
  const convert = useConvertToLeave();
  const { data: detail, isLoading: loadingDetail } = useDayDetail(row.user.id, day.date);
  const current = detail?.day ?? day;
  const editable = canEdit && !current.frozen;
  const { data: leaveTypes } = useQuery<any[]>({ queryKey: ['leave-types'], queryFn: () => api.get('/hr/leave/types').then(r => r.data), enabled: editable });
  const [mode, setMode] = useState<'edit' | 'leave'>('edit');
  const [status, setStatus] = useState<ManualStatus | ''>('');
  // Only sessions the user actually touched are sent (ATT-1): untouched
  // punches are never re-submitted, so they can't be merged or cleared.
  const [drafts, setDrafts] = useState<Record<string, Partial<SessionDraft>>>({});
  const [adding, setAdding] = useState<SessionDraft | null>(null);
  const [notes, setNotes] = useState(day.notes ?? '');
  const [reason, setReason] = useState('');
  const [leave, setLeave] = useState({ leaveTypeId: '', halfDay: false, halfDayPeriod: 'AM' as 'AM' | 'PM', reason: '' });
  const [error, setError] = useState('');
  const onErr = (e: any) => setError(e?.response?.data?.error || e?.response?.data?.details?.[0]?.message || 'Could not save');
  const sessions = detail?.sessions ?? [];

  const setDraft = (s: DaySession, field: keyof SessionDraft, value: string) => setDrafts(d => {
    const orig = field === 'checkInAt' ? toLocalInput(s.checkInAt) : toLocalInput(s.checkOutAt);
    const next = { ...(d[s.id] ?? {}) };
    if (value === orig) delete next[field]; else next[field] = value;
    const out = { ...d };
    if (Object.keys(next).length) out[s.id] = next; else delete out[s.id];
    return out;
  });

  const submitMark = () => {
    setError('');
    if (!reason.trim()) return setError('A reason is required for every correction.');
    const edits: NonNullable<MarkDayInput['sessions']> = [];
    for (const [recordId, d] of Object.entries(drafts)) {
      const e: { recordId: string; checkInAt?: string; checkOutAt?: string | null } = { recordId };
      if (d.checkInAt !== undefined) { if (!d.checkInAt) return setError('A session needs a check-in time.'); e.checkInAt = fromLocalInput(d.checkInAt); }
      if (d.checkOutAt !== undefined) e.checkOutAt = d.checkOutAt ? fromLocalInput(d.checkOutAt) : null;
      edits.push(e);
    }
    let addSession: MarkDayInput['addSession'];
    if (adding) {
      if (!adding.checkInAt) return setError('Enter the new session\'s check-in time.');
      if (current.phase === 'past' && !adding.checkOutAt) return setError('Enter the new session\'s check-out time — a past session can\'t be left open.');
      addSession = { checkInAt: fromLocalInput(adding.checkInAt), checkOutAt: adding.checkOutAt ? fromLocalInput(adding.checkOutAt) : null };
    }
    if (!status && !edits.length && !addSession) return setError('Nothing to save — pick a status, change a session time or add a session.');
    mark.mutate({ userId: row.user.id, date: day.date, status: status || undefined, sessions: edits.length ? edits : undefined, addSession, notes: notes || undefined, reason }, { onSuccess: onClose, onError: onErr });
  };
  const submitLeave = () => {
    if (!leave.leaveTypeId) return setError('Pick a leave type.');
    if (!leave.reason.trim()) return setError('A reason is required.');
    convert.mutate({ userId: row.user.id, date: day.date, ...leave }, { onSuccess: onClose, onError: onErr });
  };

  return (
    <Modal open onClose={onClose} title={`${row.user.name} · ${day.date}`} icon={<Pencil size={16} />} size="md"
      footer={!editable ? <Button variant="secondary" onClick={onClose}>Close</Button> : (
        <>
          {current.source === 'MANUAL' && <Button variant="ghost" icon={<RotateCcw size={14} />} loading={reset.isPending} onClick={() => reset.mutate({ userId: row.user.id, date: day.date, reason: reason || 'Reset to computed' }, { onSuccess: onClose, onError: onErr })}>Reset to computed</Button>}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {mode === 'edit' ? <Button loading={mark.isPending} onClick={submitMark}>Save correction</Button> : <Button loading={convert.isPending} onClick={submitLeave}>Convert to leave</Button>}
        </>
      )}>
      <div className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {current.frozen && <Alert tone="info"><Lock size={12} className="inline mr-1" />This day is in a payroll period that has been finalised, so it's locked. Adjust the next payroll run instead.</Alert>}
        {current.phase === 'today' && current.status !== 'PENDING' && <p className="text-[11.5px] text-fg-muted">The day is still in progress — this status is provisional and is finalised after the shift.</p>}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <Stat label="Status" value={<Badge className={STATUS_CLASS[current.status]}>{STATUS_LABEL[current.status]}</Badge>} />
          <Stat label="Source" value={current.source === 'MANUAL' ? 'Manual' : 'Computed'} />
          <Stat label="Worked" value={fmtMin(current.workedMinutes)} />
          <Stat label="Paid" value={`${Math.round(current.paidFraction * 100)}%`} />
          <Stat label="First in" value={current.firstInAt ? dateTime(current.firstInAt) : '—'} />
          <Stat label="Last out" value={current.lastOutAt ? dateTime(current.lastOutAt) : '—'} />
          <Stat label="Late by" value={current.lateMinutes ? `${current.lateMinutes} min` : '—'} />
          <Stat label="Overtime" value={current.overtimeMinutes ? `${current.overtimeMinutes} min` : '—'} />
        </div>
        {current.reason && <p className="text-xs text-fg-muted">{current.source === 'MANUAL' ? 'Last correction' : 'Why'}: {current.reason}</p>}
        {current.notes && <p className="text-xs text-fg-muted">Notes: {current.notes}</p>}

        <div>
          <p className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">Sessions{detail?.timezone ? <span className="normal-case"> · policy time zone {detail.timezone}</span> : null}</p>
          {loadingDetail ? <SkeletonTable rows={2} /> : sessions.length === 0 ? <p className="text-xs text-fg-subtle">No check-ins on this day.</p> : (
            <ul className="space-y-2">
              {sessions.map(s => (
                <li key={s.id} className="rounded-lg border border-line-subtle p-2 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="font-medium text-fg tabular-nums">{s.checkInAt ? time(s.checkInAt) : '—'} – {s.checkOutAt ? time(s.checkOutAt) : 'open'}</span>
                    {s.source === 'MANUAL' && <Badge variant="gray">manual</Badge>}
                    {s.checkOutSource && SOURCE_LABEL[s.checkOutSource] && <Badge variant="yellow">{SOURCE_LABEL[s.checkOutSource]}</Badge>}
                    {s.checkInFaceOk && <Badge variant="teal">face ✓</Badge>}
                    <span className="flex-1" />
                    <SelfieButton session={s} which="in" />
                    <SelfieButton session={s} which="out" />
                  </div>
                  {editable && mode === 'edit' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <Field label="Check-in"><Input type="datetime-local" value={drafts[s.id]?.checkInAt ?? toLocalInput(s.checkInAt)} onChange={e => setDraft(s, 'checkInAt', e.target.value)} /></Field>
                      <Field label="Check-out"><Input type="datetime-local" value={drafts[s.id]?.checkOutAt ?? toLocalInput(s.checkOutAt)} onChange={e => setDraft(s, 'checkOutAt', e.target.value)} /></Field>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && mode === 'edit' && (adding ? (
            <div className="mt-2 rounded-lg border border-dashed border-line p-2 space-y-2">
              <p className="text-[11.5px] font-medium text-fg">New session <span className="font-normal text-fg-subtle">(added next to the ones above — nothing is merged)</span></p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Field label="Check-in"><Input type="datetime-local" value={adding.checkInAt} onChange={e => setAdding(a => ({ ...a!, checkInAt: e.target.value }))} /></Field>
                <Field label="Check-out"><Input type="datetime-local" value={adding.checkOutAt} onChange={e => setAdding(a => ({ ...a!, checkOutAt: e.target.value }))} /></Field>
              </div>
              <Button size="xs" variant="ghost" onClick={() => setAdding(null)}>Remove</Button>
            </div>
          ) : (
            <Button size="xs" variant="secondary" className="mt-2" icon={<Plus size={12} />} onClick={() => setAdding({ checkInAt: `${day.date}T09:00`, checkOutAt: `${day.date}T18:00` })}>Add session</Button>
          ))}
        </div>

        {editable && (
          <>
            <div className="flex gap-1 border-b border-line-subtle">
              {(['edit', 'leave'] as const).map(m => (
                <button key={m} type="button" onClick={() => { setMode(m); setError(''); }} className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${mode === m ? 'border-accent text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}>
                  {m === 'edit' ? 'Correct day' : 'Convert to leave'}
                </button>
              ))}
            </div>
            {mode === 'edit' ? (
              <div className="space-y-3">
                <Field label="Status" hint="Leave on the first option to only fix the punches above and let the policy decide.">
                  <Select value={status} onChange={e => setStatus(e.target.value as ManualStatus | '')}>
                    <option value="">{current.source === 'MANUAL' ? `No change (keep manual: ${STATUS_LABEL[current.status]})` : 'Computed from punches'}</option>
                    {MANUAL_STATUSES.map(s => <option key={s} value={s}>Set manually: {STATUS_LABEL[s]}</option>)}
                  </Select>
                </Field>
                <Field label="Notes (visible to employee)"><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Client visit, regularised" /></Field>
                <Field label="Reason for correction" required><Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Recorded in the audit log" /></Field>
              </div>
            ) : (
              <div className="space-y-3">
                <Field label="Leave type">
                  <Select value={leave.leaveTypeId} onChange={e => setLeave(l => ({ ...l, leaveTypeId: e.target.value }))}>
                    <option value="">Select…</option>
                    {(leaveTypes ?? []).map(t => <option key={t.id} value={t.id}>{t.name}{t.isWfh ? ' (work from home)' : t.isPaid === false ? ' (unpaid)' : ''}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Duration">
                    <Select value={leave.halfDay ? 'half' : 'full'} onChange={e => setLeave(l => ({ ...l, halfDay: e.target.value === 'half' }))}>
                      <option value="full">Full day</option><option value="half">Half day</option>
                    </Select>
                  </Field>
                  {leave.halfDay && <Field label="Half"><Select value={leave.halfDayPeriod} onChange={e => setLeave(l => ({ ...l, halfDayPeriod: e.target.value as 'AM' | 'PM' }))}><option value="AM">First half</option><option value="PM">Second half</option></Select></Field>}
                </div>
                <Field label="Reason" required><Textarea rows={2} value={leave.reason} onChange={e => setLeave(l => ({ ...l, reason: e.target.value }))} placeholder="Creates an approved leave request and updates the day" /></Field>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-lg bg-surface-sunken px-2.5 py-2"><div className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</div><div className="mt-0.5 font-medium text-fg">{value}</div></div>;
}

function HistoryModal({ row, onClose }: { row: RegisterRow; onClose: () => void }) {
  const { dateTime } = useFormat();
  const { data, isLoading } = useAttendanceAudit(row.user.id);
  return (
    <Modal open onClose={onClose} title={`Change history · ${row.user.name}`} icon={<History size={16} />} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {isLoading ? <SkeletonTable rows={4} /> : !data?.length ? <EmptyState icon={<History size={20} />} title="No changes yet" description="Manual corrections, leave changes and resets will appear here." /> : (
        <ul className="divide-y divide-line-subtle text-xs">
          {data.map(a => (
            <li key={a.id} className="py-2.5 flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <div className="sm:w-36 shrink-0 text-fg-subtle tabular-nums">{dateTime(a.changedAt)}</div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-fg"><Badge variant="gray">{a.entityType}</Badge> <span className="ml-1">{a.action.replace(/_/g, ' ').toLowerCase()}</span>{a.date ? <span className="text-fg-subtle"> · {a.date.slice(0, 10)}</span> : null}</div>
                {(a.before?.status || a.after?.status) && <div className="text-fg-muted mt-0.5">{a.before?.status ?? '—'} → <strong>{a.after?.status ?? '—'}</strong></div>}
                {a.reason && <div className="text-fg-muted mt-0.5 italic">“{a.reason}”</div>}
                <div className="text-[11px] text-fg-subtle mt-0.5">by {a.changer?.name}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
