/**
 * Rerun / reopen / revise a payroll run — the pieces the run review modal
 * (PayrollPage.tsx RunReviewModal) composes:
 *   RerunDialog      options for "Rerun with latest salaries" (subset, adjustments, joiners, leavers)
 *   RerunResults     per-employee change summary, largest change first
 *   ReopenDialog     reason + confirmation to reopen a finalised run / revise a paid one
 *   FinaliseDialog   re-finalise a reopened run (optionally re-pin the template)
 *   RevisionNotices  reopened banner, later-runs warning, "re-send revised payslips"
 *   VersionsSection  v1 issued … reopened because … v2 …
 *   SettlementPanel  arrears / recoveries vs what was paid, CSV
 *   CompareModal     one payslip, version vs version, line by line
 */
import { useMemo, useState } from 'react';
import { Modal, Button, Checkbox, Textarea, Field, Alert, Badge, Select, Toggle } from '../../../shared/components';
import { RefreshCw, RotateCcw, Send, History, Scale, FileDown, ChevronDown, ChevronRight, X, GitCompare, Mail } from 'lucide-react';
import { useFormat } from '../../../hooks/useFormat';
import { csvCell } from '../../../shared/csv';
import {
  useRerun, useReopen, useFinalize, useComparePayslip, useEmailRevised,
  type RerunSummary, type ChangeEntry, type Settlement, type VersionEntry, type RunHistory, type SlipFigures,
} from '../../../api/payrollRevision';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const errMsg = (e: any) => e?.response?.data?.error || e?.response?.data?.message || 'Something went wrong';

/** ▲ +₹1,000 / ▼ −₹500 / no change */
export function DeltaText({ value, className = '' }: { value: number; className?: string }) {
  const { money } = useFormat();
  if (Math.abs(value) < 0.005) return <span className={`text-fg-subtle ${className}`}>no change</span>;
  const up = value > 0;
  return (
    <span className={`tabular-nums font-medium whitespace-nowrap ${up ? 'text-success' : 'text-danger'} ${className}`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? '+' : '−'}{money(Math.abs(value))}
    </span>
  );
}

// ─── Rerun ───────────────────────────────────────────────────────────────────

export interface Candidate { userId: string; name: string; inRun: boolean }

export function RerunDialog({ runId, candidates, onClose, onDone }: { runId: string; candidates: Candidate[]; onClose: () => void; onDone: (s: RerunSummary) => void }) {
  const rerun = useRerun(runId);
  const [who, setWho] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [keepAdjustments, setKeep] = useState(true);
  const [includeNewEmployees, setIncludeNew] = useState(true);
  const [removeWithoutSalary, setRemove] = useState(false);
  const [error, setError] = useState('');
  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  const canRun = who === 'all' || picked.length > 0;
  const submit = () => {
    setError('');
    rerun.mutate(
      { keepAdjustments, includeNewEmployees, removeWithoutSalary, ...(who === 'some' ? { userIds: picked } : {}) },
      { onSuccess: r => { onDone(r.summary); onClose(); }, onError: e => setError(errMsg(e)) },
    );
  };
  return (
    <Modal open onClose={onClose} title="Rerun with latest salaries" icon={<RefreshCw size={16} />} size="md"
      subtitle="Recalculates the draft from each employee's current salary and the attendance register."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button icon={<RefreshCw size={13} />} disabled={!canRun} loading={rerun.isPending} onClick={submit}>Rerun</Button>
      </>}>
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Who">
          <div className="grid grid-cols-2 gap-2">
            {(['all', 'some'] as const).map(k => (
              <button key={k} type="button" onClick={() => setWho(k)}
                className={`rounded-btn border px-3 py-2 text-sm text-left transition-colors ${who === k ? 'border-accent bg-accent-soft text-accent-soft-fg font-medium' : 'border-line hover:bg-surface-hover text-fg'}`}>
                {k === 'all' ? 'Everyone' : 'Choose employees'}
              </button>
            ))}
          </div>
        </Field>
        {who === 'some' && (
          <div className="rounded-card border border-line-subtle max-h-56 overflow-y-auto divide-y divide-line-subtle">
            {candidates.length === 0 && <p className="p-3 text-xs text-fg-subtle">No employees to choose from.</p>}
            {candidates.map(c => (
              <label key={c.userId} className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-surface-hover">
                <input type="checkbox" className="w-4 h-4 rounded-[4px] shrink-0" checked={picked.includes(c.userId)} onChange={() => toggle(c.userId)} />
                <span className="min-w-0 flex-1 truncate text-fg">{c.name}</span>
                {!c.inRun && <Badge variant="blue" size="sm">new</Badge>}
              </label>
            ))}
          </div>
        )}
        <div className="space-y-3">
          <Checkbox checked={keepAdjustments} onChange={e => setKeep(e.target.checked)} label="Keep manual adjustments" hint="Lines you adjusted during review keep your amount." />
          <Checkbox checked={includeNewEmployees} onChange={e => setIncludeNew(e.target.checked)} label="Add new employees" hint="People who now have a salary on this cycle but no payslip in the run." />
          <Checkbox checked={removeWithoutSalary} onChange={e => setRemove(e.target.checked)} label="Remove people without a salary" hint="Otherwise their previous payslip stays and they're listed in the results." />
        </div>
        <p className="text-[11px] text-fg-subtle">Attendance is always re-read, so corrections made since the draft was calculated are picked up.</p>
      </div>
    </Modal>
  );
}

function ChangeRow({ e }: { e: ChangeEntry }) {
  const { money } = useFormat();
  const [open, setOpen] = useState(false);
  const d = e.diff;
  const hasDetail = d.lines.length > 0 || (d.paidDays?.delta ?? 0) !== 0 || (e.adjustmentsDropped?.length ?? 0) > 0 || (e.adjustmentsKept ?? 0) > 0;
  return (
    <li className="py-2">
      <button type="button" onClick={() => hasDetail && setOpen(o => !o)} className={`w-full flex items-start gap-2 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`} aria-expanded={hasDetail ? open : undefined}>
        <span className="mt-0.5 w-3.5 shrink-0 text-fg-subtle">{hasDetail ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-medium text-fg truncate">{e.name}</span>
            {e.kind === 'ADDED' && <Badge variant="blue" size="sm">added</Badge>}
            {e.kind === 'REMOVED' && <Badge variant="red" size="sm">removed</Badge>}
          </span>
          <span className="block text-[11px] text-fg-muted tabular-nums mt-0.5">
            Net {d.net.old != null ? money(d.net.old) : '—'} → {d.net.new != null ? money(d.net.new) : '—'}
            {d.gross.delta !== 0 && <> · gross {d.gross.delta > 0 ? '+' : '−'}{money(Math.abs(d.gross.delta))}</>}
            {d.deductions.delta !== 0 && <> · deductions {d.deductions.delta > 0 ? '+' : '−'}{money(Math.abs(d.deductions.delta))}</>}
          </span>
        </span>
        <DeltaText value={d.net.delta} className="text-[12.5px] shrink-0" />
      </button>
      {open && (
        <div className="ml-5 mt-1.5 rounded-lg bg-surface-sunken p-2 text-[11.5px]">
          {d.lines.length > 0 && (
            // A stacked list rather than a 4-column table so it fits a 360px screen.
            <ul className="divide-y divide-line-subtle tabular-nums">
              {d.lines.map(l => {
                const good = l.category === 'DEDUCTION' ? l.delta < 0 : l.delta > 0;
                return (
                  <li key={l.code} className="py-1 flex flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 basis-full sm:basis-auto sm:flex-1 truncate text-fg" title={`${l.name} (${l.code})`}>{l.name}</span>
                    <span className="text-fg-muted whitespace-nowrap">{l.old != null ? money(l.old) : '—'} → <span className="text-fg">{l.new != null ? money(l.new) : '—'}</span></span>
                    <span className={`whitespace-nowrap font-medium ${good ? 'text-success' : 'text-danger'}`}>{l.delta > 0 ? '+' : '−'}{money(Math.abs(l.delta))}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {(d.paidDays?.delta ?? 0) !== 0 && <p className="mt-1 text-fg-muted">Paid days {d.paidDays!.old ?? '—'} → {d.paidDays!.new ?? '—'}{(d.lopDays?.delta ?? 0) !== 0 ? ` · LOP ${d.lopDays!.old ?? 0} → ${d.lopDays!.new ?? 0}` : ''}</p>}
          {(e.adjustmentsKept ?? 0) > 0 && <p className="mt-1 text-fg-subtle">{e.adjustmentsKept} manual adjustment{e.adjustmentsKept === 1 ? '' : 's'} kept.</p>}
          {(e.adjustmentsDropped?.length ?? 0) > 0 && <p className="mt-1 text-warning">Adjusted line{e.adjustmentsDropped!.length === 1 ? '' : 's'} {e.adjustmentsDropped!.join(', ')} no longer on the payslip — adjustment dropped.</p>}
        </div>
      )}
    </li>
  );
}

export function RerunResults({ summary, onClose }: { summary: RerunSummary; onClose: () => void }) {
  const [onlyChanged, setOnlyChanged] = useState(true);
  const rows = onlyChanged ? summary.entries.filter(e => e.diff.changed) : summary.entries;
  return (
    <section className="mb-4 rounded-card border border-accent/30 bg-accent-soft/30 p-3" aria-label="Rerun results">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-fg">Rerun results</p>
          <p className="text-[11.5px] text-fg-muted mt-0.5">
            {summary.changedCount} changed · {summary.unchangedCount} unchanged
            {summary.added.length > 0 && ` · ${summary.added.length} added`}
            {summary.removed.length > 0 && ` · ${summary.removed.length} removed`}
            {summary.skipped.length > 0 && ` · ${summary.skipped.length} skipped`}
            {' · net '}<DeltaText value={summary.totals.net} />
          </p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 w-7 h-7 flex items-center justify-center rounded-btn text-fg-subtle hover:bg-surface-hover" aria-label="Close results"><X size={14} /></button>
      </div>
      <div className="mt-2"><Toggle checked={onlyChanged} onChange={setOnlyChanged} label="Only changed" /></div>
      {rows.length === 0 ? <p className="mt-2 text-xs text-fg-subtle">Nothing changed — every payslip already matches the current salaries and attendance.</p> : (
        <ul className="mt-1 divide-y divide-line-subtle">{rows.map(e => <ChangeRow key={`${e.kind}-${e.userId}`} e={e} />)}</ul>
      )}
      {summary.skipped.length > 0 && (
        <div className="mt-2 pt-2 border-t border-line-subtle">
          <p className="text-[11px] font-medium text-fg-muted mb-1">Skipped</p>
          <ul className="space-y-0.5 text-[11.5px]">{summary.skipped.map(s => <li key={s.userId}><span className="text-fg">{s.name}</span> <span className="text-fg-subtle">— {s.reason}</span></li>)}</ul>
        </div>
      )}
      {summary.removed.length > 0 && (
        <div className="mt-2 pt-2 border-t border-line-subtle">
          <p className="text-[11px] font-medium text-fg-muted mb-1">Removed</p>
          <ul className="space-y-0.5 text-[11.5px]">{summary.removed.map(s => <li key={s.userId}><span className="text-fg">{s.name}</span> <span className="text-fg-subtle">— {s.reason}</span></li>)}</ul>
        </div>
      )}
    </section>
  );
}

// ─── Reopen / finalise ───────────────────────────────────────────────────────

const laterLabel = (r: RunHistory['laterFinalisedRuns'][number]) => `${MONTHS[r.month]} ${r.year}${r.cycleName ? ` (${r.cycleName})` : ''}`;

export function ReopenDialog({ runId, status, version, laterRuns, onClose }: { runId: string; status: string; version: number; laterRuns: RunHistory['laterFinalisedRuns']; onClose: () => void }) {
  const reopen = useReopen(runId);
  const paid = status === 'PAID';
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const valid = reason.trim().length >= 5 && (!paid || ack);
  return (
    <Modal open onClose={onClose} title={paid ? 'Revise paid payroll' : 'Reopen for changes'} icon={<RotateCcw size={16} />} size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={paid ? 'danger' : 'primary'} icon={<RotateCcw size={13} />} disabled={!valid} loading={reopen.isPending}
          onClick={() => { setError(''); reopen.mutate({ reason: reason.trim(), acknowledgePaid: paid ? ack : undefined }, { onSuccess: onClose, onError: e => setError(errMsg(e)) }); }}>
          {paid ? 'Revise payroll' : 'Reopen run'}
        </Button>
      </>}>
      <div className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {paid ? (
          <Alert tone="warning" title="Money for this run was already paid">
            Revising creates new payslip versions. For each employee the difference against what was paid becomes <strong>arrears</strong> (to pay) or a <strong>recovery</strong>, listed in a settlement panel. The run stays “Processed” until you mark the differences settled.
          </Alert>
        ) : (
          <p className="text-[13px] text-fg-muted">The run goes back to draft so you can correct salaries or attendance and rerun it.</p>
        )}
        <ul className="text-[12px] text-fg-muted list-disc pl-4 space-y-1">
          <li>The current payslips are saved as version {version} and stay in the history.</li>
          <li>Employees won't see these payslips until you finalise again.</li>
          <li>Attendance for this period can be corrected while the run is reopened.</li>
        </ul>
        {laterRuns.length > 0 && (
          <Alert tone="warning">
            Later payroll {laterRuns.map(laterLabel).join(', ')} {laterRuns.length === 1 ? 'is' : 'are'} already finalised. Attendance for this period stays locked by {laterRuns.length === 1 ? 'that run' : 'those runs'}, and leave/attendance carried into later periods is not recalculated.
          </Alert>
        )}
        <Field label="Reason" hint="At least 5 characters — shown in the version history and audit log." required>
          <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={500} placeholder={paid ? 'e.g. Increment for Carla effective September was missed' : 'e.g. Sam’s salary revised from September'} />
        </Field>
        {paid && <Checkbox checked={ack} onChange={e => setAck(e.target.checked)} label="I understand salaries were already paid and differences will need settling" />}
      </div>
    </Modal>
  );
}

export function FinaliseDialog({ runId, version, onClose, onDone }: { runId: string; version: number; onClose: () => void; onDone: (msg: string) => void }) {
  const finalize = useFinalize(runId);
  const [repin, setRepin] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal open onClose={onClose} title={`Finalise version ${version}`} icon={<Send size={16} />} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button icon={<Send size={13} />} loading={finalize.isPending} onClick={() => {
          setError('');
          finalize.mutate({ repinTemplate: repin }, {
            onSuccess: r => {
              const f = r.refinalize;
              onDone(f ? `Version ${version} issued: ${f.revised} revised, ${f.unchanged} unchanged${f.first ? `, ${f.first} new` : ''}.` : 'Payslips issued.');
              onClose();
            },
            onError: e => setError(errMsg(e)),
          });
        }}>Finalise &amp; issue</Button>
      </>}>
      <div className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <p className="text-[13px] text-fg-muted">Payslips that changed are issued as a new version and show a “Revised” note. Unchanged payslips are restored exactly as they were.</p>
        <Checkbox checked={repin} onChange={e => setRepin(e.target.checked)} label="Re-pin revised payslips to the current template" hint="Off: revised payslips keep the template they were first issued with." />
      </div>
    </Modal>
  );
}

// ─── Notices, versions, settlement ──────────────────────────────────────────

export function RevisionNotices({ runId, status, version, history, onMessage }: { runId: string; status: string; version: number; history: RunHistory | undefined; onMessage: (m: string, tone?: 'success' | 'danger') => void }) {
  const emailRevised = useEmailRevised(runId);
  if (!history) return null;
  const reopenedEntry = history.versions.length > 1 ? history.versions[history.versions.length - 2] : null;
  return (
    <>
      {history.reopened && (
        <Alert tone="warning" className="mb-3" title={`Reopened for changes — working on version ${version}`}>
          {reopenedEntry?.reason && <span className="block">Reason: “{reopenedEntry.reason}”{reopenedEntry.reopenedByName ? ` (${reopenedEntry.reopenedByName})` : ''}.</span>}
          <span className="block">Employees can't see these payslips until you finalise again. Attendance for this period can be corrected while the run is reopened — then Rerun.</span>
        </Alert>
      )}
      {status === 'DRAFT' && history.laterFinalisedRuns.length > 0 && (
        <Alert tone="info" className="mb-3">
          Later payroll {history.laterFinalisedRuns.map(laterLabel).join(', ')} is already finalised — attendance for this period stays locked by it, and carry-over into later periods is not recalculated.
        </Alert>
      )}
      {status !== 'DRAFT' && history.revisedEmailedBefore > 0 && (
        <Alert tone="info" className="mb-3" actions={
          <Button size="xs" icon={<Mail size={12} />} loading={emailRevised.isPending}
            onClick={() => emailRevised.mutate(undefined, { onSuccess: r => onMessage(`${r.sent} revised payslip${r.sent === 1 ? '' : 's'} e-mailed${r.failed.length ? `, ${r.failed.length} failed` : ''}.`), onError: e => onMessage(errMsg(e), 'danger') })}>
            E-mail revised payslips
          </Button>
        }>
          {history.revisedEmailedBefore} revised payslip{history.revisedEmailedBefore === 1 ? ' was' : 's were'} e-mailed before — re-send?
        </Alert>
      )}
    </>
  );
}

export function VersionsSection({ versions }: { versions: VersionEntry[] }) {
  const { date } = useFormat();
  if (versions.length < 2) return null;
  return (
    <section className="mt-4 rounded-card border border-line-subtle p-3" aria-label="Versions">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-fg mb-2"><History size={13} /> Versions</p>
      <ol className="space-y-2.5">
        {versions.map(v => (
          <li key={v.version} className="flex gap-2.5">
            <span className={`shrink-0 mt-0.5 w-7 h-5 rounded-full text-[10.5px] font-semibold flex items-center justify-center ${v.current ? 'bg-accent text-accent-fg' : 'bg-surface-sunken text-fg-muted'}`}>v{v.version}</span>
            <div className="min-w-0 text-[11.5px]">
              <p className="text-fg">
                {v.issuedAt ? <>Issued {date(v.issuedAt)}{v.issuedByName ? ` by ${v.issuedByName}` : ''}</> : <>Draft — not issued yet</>}
                {v.current && <span className="text-fg-subtle"> · current</span>}
                {!v.current && v.status === 'PAID' && <span className="text-fg-subtle"> · paid</span>}
              </p>
              {v.reopenedAt && <p className="text-fg-muted mt-0.5">Reopened {date(v.reopenedAt)}{v.reopenedByName ? ` by ${v.reopenedByName}` : ''}{v.reason ? <>: “{v.reason}”</> : ''}</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const KIND_LABEL: Record<string, string> = { ARREARS: 'Arrears', RECOVERY: 'Recovery', NONE: 'No change', NOT_PAID_BEFORE: 'Not paid before', REMOVED: 'Removed' };

export function SettlementPanel({ settlement, runLabel }: { settlement: Settlement; runLabel: string }) {
  const { money } = useFormat();
  const [showAll, setShowAll] = useState(false);
  if (!settlement.applicable) return null;
  const t = settlement.totals;
  const rows = showAll ? settlement.rows : settlement.rows.filter(r => r.difference !== 0);
  const csv = () => {
    const q = csvCell;
    const lines = [['Employee', 'Paid net', 'Revised net', 'Difference', 'Type', 'Settled'].join(','),
      ...settlement.rows.map(r => [r.name, r.paidNet ?? '', r.newNet ?? '', r.difference.toFixed(2), KIND_LABEL[r.kind] ?? r.kind, r.settled ? 'yes' : 'no'].map(q).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `settlement-${runLabel.replace(/\s+/g, '-').toLowerCase()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="mb-4 rounded-card border border-line-subtle p-3" aria-label="Settlement">
      <div className="flex flex-col sm:flex-row sm:items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-fg"><Scale size={14} /> Settlement vs what was paid</p>
          <p className="text-[11.5px] text-fg-muted mt-0.5">{t.pendingCount > 0 ? `${t.pendingCount} difference${t.pendingCount === 1 ? '' : 's'} to settle — “Mark all paid” records them as settled.` : 'All differences are settled.'}</p>
        </div>
        <Button size="xs" variant="secondary" icon={<FileDown size={12} />} onClick={csv} className="self-start">CSV</Button>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 text-center">
        <div className="rounded-lg bg-surface-sunken px-1.5 py-2"><div className="text-[10px] uppercase tracking-wide text-fg-subtle leading-tight">Arrears to pay</div><div className="text-[13px] font-semibold text-success tabular-nums mt-0.5 break-all">{money(t.arrears)}</div></div>
        <div className="rounded-lg bg-surface-sunken px-1.5 py-2"><div className="text-[10px] uppercase tracking-wide text-fg-subtle leading-tight">Recoveries</div><div className="text-[13px] font-semibold text-danger tabular-nums mt-0.5 break-all">{money(t.recovery)}</div></div>
        <div className="rounded-lg bg-surface-sunken px-1.5 py-2"><div className="text-[10px] uppercase tracking-wide text-fg-subtle leading-tight">Net</div><div className="text-[13px] font-semibold text-fg tabular-nums mt-0.5 break-all">{t.net < 0 ? '−' : ''}{money(Math.abs(t.net))}</div></div>
      </div>
      <ul className="mt-2 divide-y divide-line-subtle">
        {rows.map(r => (
          <li key={r.userId} className="py-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-fg truncate">{r.name}</p>
              <p className="text-[11px] text-fg-muted tabular-nums">
                {KIND_LABEL[r.kind]} · paid {r.paidNet != null ? money(r.paidNet) : '—'} → {r.newNet != null ? money(r.newNet) : '—'}
              </p>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-0.5">
              <DeltaText value={r.difference} className="text-[12px]" />
              {r.difference !== 0 && <Badge size="sm" variant={r.settled ? 'green' : 'yellow'}>{r.settled ? 'settled' : 'pending'}</Badge>}
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="py-2 text-xs text-fg-subtle">No differences.</li>}
      </ul>
      {settlement.rows.some(r => r.difference === 0) && (
        <button type="button" onClick={() => setShowAll(s => !s)} className="mt-1 text-[11.5px] text-accent hover:underline">{showAll ? 'Hide unchanged' : `Show unchanged (${settlement.rows.filter(r => r.difference === 0).length})`}</button>
      )}
    </section>
  );
}

// ─── Compare ─────────────────────────────────────────────────────────────────

export function CompareModal({ runId, payslipId, onClose }: { runId: string; payslipId: string; onClose: () => void }) {
  const { money, date } = useFormat();
  const { data, isLoading, error } = useComparePayslip(runId, payslipId);
  const [fromIdx, setFromIdx] = useState<number | null>(null);
  const versions = data?.versions ?? [];
  const idx = fromIdx ?? versions.length - 1;
  const from = versions[idx];
  const toFigures: SlipFigures | undefined = from ? (idx + 1 < versions.length ? versions[idx + 1].figures : data!.current) : undefined;
  const toLabel = from ? (idx + 1 < versions.length ? `v${versions[idx + 1].version}` : `v${data!.payslip.version}${data!.payslip.status === 'DRAFT' ? ' (draft)' : ''}`) : '';
  const rows = useMemo(() => {
    if (!from || !toFigures) return [];
    const codes: { code: string; name: string; category: string }[] = [];
    for (const l of [...from.figures.lines, ...toFigures.lines]) if (!codes.some(c => c.code === l.code)) codes.push(l);
    return codes.map(c => {
      const a = from.figures.lines.find(l => l.code === c.code)?.amount ?? null;
      const b = toFigures.lines.find(l => l.code === c.code)?.amount ?? null;
      return { ...c, a, b, d: (b ?? 0) - (a ?? 0) };
    });
  }, [from, toFigures]);
  const Tot = ({ label, a, b }: { label: string; a: number; b: number }) => (
    <tr className="border-t border-line font-semibold"><td className="py-1.5 pr-2 text-fg">{label}</td><td className="py-1.5 text-right text-fg-muted">{money(a)}</td><td className="py-1.5 text-right text-fg">{money(b)}</td><td className="py-1.5 pl-2 text-right"><DeltaText value={b - a} /></td></tr>
  );
  return (
    <Modal open onClose={onClose} title={data ? `${data.payslip.name} · ${data.payslip.payslipNumber}` : 'Compare versions'} icon={<GitCompare size={16} />} size="lg"
      subtitle="Line-by-line comparison between issued versions of this payslip."
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {isLoading ? <p className="text-sm text-fg-subtle">Loading…</p> : error ? <Alert tone="danger">{errMsg(error)}</Alert> : versions.length === 0 ? (
        <p className="text-sm text-fg-subtle">This payslip has only one version.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <span className="text-[12px] text-fg-muted shrink-0">Compare</span>
            <div className="sm:w-64"><Select value={String(idx)} onChange={e => setFromIdx(Number(e.target.value))}>
              {versions.map((v, i) => <option key={i} value={i}>v{v.version} · issued {v.issuedAt ? date(v.issuedAt) : '—'}{v.status === 'PAID' ? ' · paid' : ''}</option>)}
            </Select></div>
            <span className="text-[12px] text-fg-muted">with <strong className="text-fg">{toLabel}</strong></span>
          </div>
          {from?.reason && <p className="text-[11.5px] text-fg-subtle">Reopened {date(from.reopenedAt)}: “{from.reason}”</p>}
          {/* Phones: stacked rows (a 4-column table doesn't fit 360px). */}
          <ul className="sm:hidden divide-y divide-line-subtle text-[12px] tabular-nums">
            {rows.map(r => {
              const changed = Math.abs(r.d) >= 0.005;
              return (
                <li key={r.code} className={`py-1.5 px-1 ${changed ? 'bg-warning/5' : ''}`}>
                  <div className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate text-fg">{r.name}</span>{changed && <DeltaText value={r.d} className="text-[11.5px]" />}</div>
                  <div className="text-[11px] text-fg-muted">v{from!.version} {r.a != null ? money(r.a) : '—'} → {toLabel} <span className="text-fg">{r.b != null ? money(r.b) : '—'}</span></div>
                </li>
              );
            })}
            {([['Gross', from!.figures.gross, toFigures!.gross], ['Deductions', from!.figures.deductions, toFigures!.deductions], ['Net pay', from!.figures.net, toFigures!.net]] as const).map(([lbl, a, b]) => (
              <li key={lbl} className="py-1.5 px-1 font-semibold">
                <div className="flex items-baseline gap-2"><span className="flex-1 text-fg">{lbl}</span><DeltaText value={b - a} className="text-[11.5px]" /></div>
                <div className="text-[11px] font-normal text-fg-muted">{money(a)} → <span className="text-fg">{money(b)}</span></div>
              </li>
            ))}
          </ul>
          <table className="hidden sm:table w-full text-[12px] tabular-nums">
            <thead><tr className="text-[10.5px] uppercase text-fg-subtle"><th className="text-left font-medium pb-1">Line</th><th className="text-right font-medium pb-1">v{from!.version}</th><th className="text-right font-medium pb-1">{toLabel}</th><th className="text-right font-medium pb-1">Change</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.code} className={`border-t border-line-subtle ${Math.abs(r.d) >= 0.005 ? 'bg-warning/5' : ''}`}>
                  <td className="py-1.5 pr-2 text-fg"><span className="block truncate max-w-[8.5rem] sm:max-w-none" title={r.name}>{r.name}</span></td>
                  <td className="py-1.5 text-right text-fg-muted">{r.a != null ? money(r.a) : '—'}</td>
                  <td className="py-1.5 text-right text-fg">{r.b != null ? money(r.b) : '—'}</td>
                  <td className="py-1.5 pl-2 text-right">{Math.abs(r.d) >= 0.005 ? <DeltaText value={r.d} /> : <span className="text-fg-subtle">—</span>}</td>
                </tr>
              ))}
              <Tot label="Gross" a={from!.figures.gross} b={toFigures!.gross} />
              <Tot label="Deductions" a={from!.figures.deductions} b={toFigures!.deductions} />
              <Tot label="Net pay" a={from!.figures.net} b={toFigures!.net} />
            </tbody>
          </table>
          {(from!.figures.paidDays !== toFigures!.paidDays) && <p className="text-[11.5px] text-fg-muted">Paid days {from!.figures.paidDays ?? '—'} → {toFigures!.paidDays ?? '—'}</p>}
          {from!.paidNet != null && <p className="text-[11.5px] text-fg-muted">v{from!.version} was paid: {money(from!.paidNet)}</p>}
        </div>
      )}
    </Modal>
  );
}
