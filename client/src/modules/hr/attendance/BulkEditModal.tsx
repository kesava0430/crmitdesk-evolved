import { useMemo, useState } from 'react';
import { CalendarRange, ChevronDown, CheckCircle2 } from 'lucide-react';
import { Button, Modal, Field, Input, Select, Textarea, Alert, Checkbox, Toggle, Badge, addToast } from '../../../shared/components';
import {
  useBulkDays, STATUS_LABEL, BULK_MAX_CELLS,
  type ManualStatus, type RegisterRow, type BulkCell, type BulkInput, type BulkResult,
} from '../../../api/attendanceAdmin';

const MANUAL_STATUSES: ManualStatus[] = ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'WFH', 'LEAVE', 'UNPAID_LEAVE', 'LOP', 'HOLIDAY', 'WEEK_OFF'];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const daysInclusive = (from: string, to: string) => (from && to && to >= from ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : 0);
const shortDate = (k: string) => new Date(k + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

interface BulkEditModalProps {
  /** Everyone in the register (the people picker's list) */
  rows: RegisterRow[];
  /** The register's visible month — the default date range */
  from: string; to: string;
  /** Exactly these cells (from "Select days"); hides the people / date pickers */
  cells?: BulkCell[] | null;
  onClose: () => void;
  /** Called after a successful apply */
  onApplied?: (r: BulkResult) => void;
}

/**
 * Bulk correction of the register: many people × many days in one go.
 * Form → confirm (a dry run shows exactly what will change and what is
 * skipped) → result. The server applies the same per-day rules as the single
 * day modal, so frozen days, weekly offs / holidays and manual corrections are
 * reported rather than changed.
 */
export function BulkEditModal({ rows, from, to, cells, onClose, onApplied }: BulkEditModalProps) {
  const fixed = !!cells?.length;
  const bulk = useBulkDays();
  const [step, setStep] = useState<'form' | 'confirm' | 'result'>('form');
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState('');

  // People
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [group, setGroup] = useState('');
  const departments = useMemo(() => [...new Set(rows.map(r => r.user.department).filter(Boolean) as string[])].sort(), [rows]);
  const groups = useMemo(() => [...new Set(rows.map(r => r.policyGroup).filter(Boolean))].sort(), [rows]);
  const shown = useMemo(() => rows.filter(r =>
    (!q.trim() || r.user.name.toLowerCase().includes(q.trim().toLowerCase()))
    && (!dept || r.user.department === dept) && (!group || r.policyGroup === group)), [rows, q, dept, group]);
  const allShownPicked = shown.length > 0 && shown.every(r => picked.has(r.user.id));
  const togglePerson = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleShown = () => setPicked(p => { const n = new Set(p); shown.forEach(r => (allShownPicked ? n.delete(r.user.id) : n.add(r.user.id))); return n; });

  // Dates & options. Explicit cells were chosen one by one, so nothing in
  // them is filtered out unless asked; a range skips offs and holidays.
  const [rangeFrom, setRangeFrom] = useState(from);
  const [rangeTo, setRangeTo] = useState(to);
  const [skipWeeklyOffs, setSkipWeeklyOffs] = useState(!fixed);
  const [skipHolidays, setSkipHolidays] = useState(!fixed);
  const [action, setAction] = useState<'mark' | 'reset'>('mark');
  const [status, setStatus] = useState<ManualStatus>('PRESENT');
  const [overwriteManual, setOverwriteManual] = useState(false);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  const nameOf = useMemo(() => new Map(rows.map(r => [r.user.id, r.user.name])), [rows]);
  const cellPeople = fixed ? new Set(cells!.map(c => c.userId)).size : picked.size;
  const span = daysInclusive(rangeFrom, rangeTo);
  const estimate = fixed ? cells!.length : picked.size * span;

  const payload = (): BulkInput => ({
    ...(fixed ? { cells: cells! } : { userIds: [...picked], range: { from: rangeFrom, to: rangeTo } }),
    skipWeeklyOffs, skipHolidays, action,
    status: action === 'mark' ? status : undefined,
    notes: action === 'mark' && notes.trim() ? notes.trim() : undefined,
    reason: reason.trim(), overwriteManual: action === 'mark' && overwriteManual,
  });
  const onErr = (e: any) => setError(e?.response?.data?.error || 'Could not apply the change');

  const review = () => {
    setError('');
    if (!fixed && !picked.size) return setError('Pick at least one person.');
    if (!fixed && !span) return setError('Pick a valid date range (the end can\'t be before the start).');
    if (estimate > BULK_MAX_CELLS) return setError(`That's ${estimate.toLocaleString()} days — the limit is ${BULK_MAX_CELLS.toLocaleString()} per change. Pick fewer people or a shorter range.`);
    if (!reason.trim()) return setError('A reason is required — it is recorded in the audit log for every day.');
    bulk.mutate({ ...payload(), dryRun: true }, { onSuccess: r => { setPreview(r); setStep('confirm'); }, onError: onErr });
  };
  const apply = () => {
    setError('');
    bulk.mutate(payload(), {
      onSuccess: r => {
        setResult(r); setStep('result');
        addToast(`${plural(r.changed, 'day')} updated${r.skipped.length ? ` · ${r.skipped.length.toLocaleString()} skipped` : ''}`, r.changed ? 'success' : 'info');
        onApplied?.(r);
      },
      onError: onErr,
    });
  };

  const what = action === 'mark' ? `mark as ${STATUS_LABEL[status]}` : 'reset to computed';

  return (
    <Modal open onClose={onClose} size="lg" icon={<CalendarRange size={16} />}
      title={step === 'result' ? 'Bulk edit — done' : 'Bulk edit attendance'}
      subtitle={step === 'form' ? (fixed ? `${plural(cells!.length, 'selected day')} · ${plural(cellPeople, 'person', 'people')}` : 'Correct many people and days at once. Every changed day is audited with your reason.') : undefined}
      footer={step === 'form' ? (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={bulk.isPending} onClick={review} disabled={!estimate}>Review…</Button>
        </>
      ) : step === 'confirm' ? (
        <>
          <Button variant="secondary" onClick={() => { setStep('form'); setError(''); }} disabled={bulk.isPending}>Back</Button>
          <Button loading={bulk.isPending} onClick={apply} disabled={!preview?.changed}>Apply to {plural(preview?.changed ?? 0, 'day')}</Button>
        </>
      ) : <Button onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        {step === 'form' && (
          <>
            {fixed ? (
              <SelectedCells cells={cells!} nameOf={nameOf} />
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="text-[13px] font-medium text-fg">People <span className="font-normal text-fg-muted">· {picked.size} selected</span></span>
                  <Button size="xs" variant="ghost" onClick={toggleShown} disabled={!shown.length}>{allShownPicked ? 'Clear shown' : `Select all shown (${shown.length})`}</Button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                  <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search people…" aria-label="Search people" />
                  {departments.length > 0 && (
                    <Select value={dept} onChange={e => setDept(e.target.value)} aria-label="Department">
                      <option value="">All departments</option>
                      {departments.map(d => <option key={d} value={d}>{d}</option>)}
                    </Select>
                  )}
                  {groups.length > 1 && (
                    <Select value={group} onChange={e => setGroup(e.target.value)} aria-label="Policy group">
                      <option value="">All policy groups</option>
                      {groups.map(g => <option key={g} value={g}>{g}</option>)}
                    </Select>
                  )}
                </div>
                <ul className="max-h-48 overflow-y-auto overscroll-contain rounded-lg border border-line-subtle divide-y divide-line-subtle" data-testid="bulk-people">
                  {shown.length === 0 ? <li className="px-3 py-3 text-xs text-fg-subtle">No one matches.</li> : shown.map(r => (
                    <li key={r.user.id} className="px-3 py-2">
                      <Checkbox checked={picked.has(r.user.id)} onChange={() => togglePerson(r.user.id)}
                        label={<>{r.user.name}{r.user.isActive === false && <span className="ml-1 text-[11px] text-fg-subtle">(inactive)</span>}</>}
                        hint={[r.user.department, r.policyGroup].filter(Boolean).join(' · ') || undefined} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!fixed && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="From"><Input type="date" value={rangeFrom} onChange={e => setRangeFrom(e.target.value)} /></Field>
                <Field label="To"><Input type="date" value={rangeTo} min={rangeFrom} onChange={e => setRangeTo(e.target.value)} /></Field>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Action">
                <Select value={action === 'reset' ? 'reset' : status} onChange={e => {
                  if (e.target.value === 'reset') setAction('reset'); else { setAction('mark'); setStatus(e.target.value as ManualStatus); }
                }}>
                  {MANUAL_STATUSES.map(s => <option key={s} value={s}>Mark as {STATUS_LABEL[s]}</option>)}
                  <option value="reset">Reset to computed (undo manual corrections)</option>
                </Select>
              </Field>
              {action === 'mark' && <Field label="Notes (visible to employee)"><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Offsite training" /></Field>}
            </div>

            <div className="space-y-2.5">
              {action === 'mark' && (
                <div className="flex flex-col sm:flex-row gap-2.5 sm:gap-6">
                  <Checkbox checked={skipWeeklyOffs} onChange={e => setSkipWeeklyOffs(e.target.checked)} label="Skip weekly offs" hint="Per each person's policy group" />
                  <Checkbox checked={skipHolidays} onChange={e => setSkipHolidays(e.target.checked)} label="Skip holidays" hint="Holidays at each person's location" />
                </div>
              )}
              {action === 'mark' && (
                <Toggle checked={overwriteManual} onChange={setOverwriteManual} label="Overwrite manual corrections"
                  hint={overwriteManual ? 'Days already corrected by hand get the new status too.' : 'Days already corrected by hand are left as they are and listed as skipped.'} />
              )}
              <p className="text-[11.5px] text-fg-muted">Days in a finalised payroll period are locked and are never changed.</p>
            </div>

            <Field label="Reason" required><Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Recorded in the audit log for every changed day" /></Field>

            <p className="text-[13px] text-fg rounded-lg bg-surface-sunken px-3 py-2" data-testid="bulk-estimate">
              {estimate
                ? <>This will {what} up to <strong>{plural(estimate, 'day')}</strong> for <strong>{plural(cellPeople, 'person', 'people')}</strong>.</>
                : fixed ? 'Nothing selected.' : 'Pick people and a date range.'}
              {estimate > BULK_MAX_CELLS && <span className="block text-danger text-xs mt-0.5">Over the limit of {BULK_MAX_CELLS.toLocaleString()} days per change.</span>}
            </p>
          </>
        )}

        {step === 'confirm' && preview && (
          <div className="space-y-3" data-testid="bulk-confirm">
            <p className="text-[13.5px] text-fg">
              {preview.changed
                ? <>This will <strong>{what}</strong> on <strong>{plural(preview.changed, 'day')}</strong> for {plural(cellPeople, 'person', 'people')}.</>
                : <>Nothing would change — every selected day is skipped.</>}
            </p>
            {reason.trim() && <p className="text-xs text-fg-muted">Reason: <span className="italic">“{reason.trim()}”</span></p>}
            <SkippedList skipped={preview.skipped} nameOf={nameOf} title="Will be skipped" />
          </div>
        )}

        {step === 'result' && result && (
          <div className="space-y-3" data-testid="bulk-result">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 size={20} className="text-success shrink-0 mt-0.5" />
              <div>
                <p className="text-[14px] font-medium text-fg">{plural(result.changed, 'day')} updated</p>
                <p className="text-xs text-fg-muted">{result.skipped.length ? `${plural(result.skipped.length, 'day')} skipped. ` : ''}Each change is in the person's change history, marked “bulk”.</p>
              </div>
            </div>
            <SkippedList skipped={result.skipped} nameOf={nameOf} title="Skipped" />
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Selected cells grouped by person: "Carla Chen — 6 days: 5 Oct, 6 Oct…" */
function SelectedCells({ cells, nameOf }: { cells: BulkCell[]; nameOf: Map<string, string> }) {
  const byUser = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of cells) { const l = m.get(c.userId) ?? []; l.push(c.date); m.set(c.userId, l); }
    return [...m.entries()].map(([id, dates]) => ({ id, name: nameOf.get(id) ?? 'Unknown', dates: dates.sort() })).sort((a, b) => a.name.localeCompare(b.name));
  }, [cells, nameOf]);
  return (
    <ul className="max-h-40 overflow-y-auto overscroll-contain rounded-lg border border-line-subtle divide-y divide-line-subtle text-xs">
      {byUser.map(u => (
        <li key={u.id} className="px-3 py-2">
          <span className="font-medium text-fg">{u.name}</span> <span className="text-fg-subtle">· {plural(u.dates.length, 'day')}</span>
          <div className="text-fg-muted mt-0.5 leading-relaxed">{u.dates.map(shortDate).join(', ')}</div>
        </li>
      ))}
    </ul>
  );
}

/** Skipped days grouped by reason; each group expands to the person/day list. */
function SkippedList({ skipped, nameOf, title }: { skipped: BulkResult['skipped']; nameOf: Map<string, string>; title: string }) {
  const groups = useMemo(() => {
    const m = new Map<string, typeof skipped>();
    for (const s of skipped) { const l = m.get(s.reason) ?? []; l.push(s); m.set(s.reason, l); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [skipped]);
  if (!groups.length) return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">{title} · {skipped.length.toLocaleString()}</p>
      <ul className="rounded-lg border border-line-subtle divide-y divide-line-subtle">
        {groups.map(([reason, list]) => (
          <li key={reason}>
            <details className="group">
              <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none text-xs [&::-webkit-details-marker]:hidden">
                <Badge variant="gray">{list.length.toLocaleString()}</Badge>
                <span className="flex-1 min-w-0 text-fg">{reason}</span>
                <ChevronDown size={14} className="text-fg-subtle transition-transform group-open:rotate-180 shrink-0" />
              </summary>
              <ul className="px-3 pb-2 text-[11.5px] text-fg-muted space-y-0.5 max-h-40 overflow-y-auto">
                {list.slice(0, 300).map(s => <li key={`${s.userId}|${s.date}`}>{nameOf.get(s.userId) ?? 'Unknown'} · {shortDate(s.date)}</li>)}
                {list.length > 300 && <li className="text-fg-subtle">…and {(list.length - 300).toLocaleString()} more</li>}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
