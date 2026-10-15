import { useState } from 'react';
import { Plus, HandCoins, PauseCircle, PlayCircle, Banknote, CheckCircle2, XCircle, Pencil } from 'lucide-react';
import {
  Card, CardHeader, Button, Modal, Badge, StatusBadge, EmptyState, Field, Input, Select, Textarea, Checkbox, Alert, SkeletonTable, DataTable, SearchableSelect,
  type BadgeProps,
} from '../../../shared/components';
import { useUsers } from '../../../api/users';
import { useFormat } from '../../../hooks/useFormat';
import {
  useLoans, useLoan, useMyLoans, useCreateLoan, useUpdateLoan, useSkipMonth, useUnskipMonth, useRepayment, useCloseLoan, useCancelLoan,
  previewPlan, ymLabel, MONTHS_SHORT, type Loan, type LedgerRow,
} from '../../../api/payrollLoans';

// Payroll → "Loans & advances" (HR managers) and the employee's read-only
// "My loans & advances" card. Recovery happens in payroll runs: one EMI per
// month from the start month, capped at the balance and at net pay — see
// server/src/utils/payrollLoans.ts for the rules.

const STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = { ACTIVE: 'blue', CLOSED: 'green', CANCELLED: 'gray' };
const ENTRY_LABEL: Record<string, string> = { RECOVERY: 'Payroll recovery', REPAYMENT: 'Repayment to HR', WAIVER: 'Written off', SKIP: 'Paused (no EMI)' };
const errMsg = (e: any) => e?.response?.data?.error || e?.response?.data?.message || 'Something went wrong';
const today = () => new Date().toISOString().slice(0, 10);
const nextMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return { m: d.getUTCMonth() + 1, y: d.getUTCFullYear() }; };

function Progress({ loan }: { loan: Loan }) {
  const pct = loan.totalRepayable > 0 ? Math.min(100, Math.round(((loan.totalRepayable - loan.outstanding) / loan.totalRepayable) * 100)) : 0;
  return (
    <div className="min-w-[90px]">
      <div className="h-1.5 rounded-full bg-surface-sunken overflow-hidden"><div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} /></div>
      <p className="text-[10.5px] text-fg-subtle mt-0.5 tabular-nums">{pct}% · {loan.emisRecovered}/{loan.instalments} EMIs</p>
    </div>
  );
}

// ─── Create ──────────────────────────────────────────────────────────────────

function NewLoanModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { money } = useFormat();
  const { data: users } = useUsers();
  const create = useCreateLoan();
  const nm = nextMonth();
  const [f, setF] = useState({ userId: '', name: '', type: 'LOAN' as 'LOAN' | 'ADVANCE', principal: '', mode: 'instalments' as 'instalments' | 'emi', value: '', rate: '', disbursedOn: today(), startMonth: nm.m, startYear: nm.y, notes: '' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f, v: any) => setF(p => ({ ...p, [k]: v }));
  const plan = previewPlan(Number(f.principal), Number(f.rate || 0), f.mode, Number(f.value));
  const options = (users ?? []).filter((u: any) => u.isActive !== false).map((u: any) => ({ value: u.id, label: `${u.name} — ${u.email}` }));
  const years = [nm.y - 1, nm.y, nm.y + 1, nm.y + 2];

  const submit = () => {
    setError('');
    if (!f.userId || !f.name.trim() || !(Number(f.principal) > 0) || !(Number(f.value) > 0)) { setError('Employee, name, amount and EMI / instalments are required.'); return; }
    create.mutate({
      userId: f.userId, name: f.name.trim(), type: f.type, principal: Number(f.principal), interestRate: f.rate ? Number(f.rate) : null,
      instalments: f.mode === 'instalments' ? Number(f.value) : null, emiAmount: f.mode === 'emi' ? Number(f.value) : null,
      disbursedOn: f.disbursedOn, startMonth: Number(f.startMonth), startYear: Number(f.startYear), notes: f.notes.trim() || null,
    }, { onSuccess: l => { onClose(); onCreated(l.id); }, onError: e => setError(errMsg(e)) });
  };

  return (
    <Modal open onClose={onClose} title="New loan / advance" icon={<HandCoins size={16} />} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.isPending} onClick={submit}>Create</Button></>}>
      <div className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Employee" className="sm:col-span-2"><SearchableSelect value={f.userId} onChange={v => set('userId', v)} options={options} ariaLabel="Employee" placeholder="Choose an employee" /></Field>
          <Field label="Name on payslip" hint='e.g. "Laptop loan", "Festival advance"'><Input value={f.name} maxLength={80} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Type"><Select value={f.type} onChange={e => set('type', e.target.value)}><option value="LOAN">Loan</option><option value="ADVANCE">Salary advance</option></Select></Field>
          <Field label="Amount given"><Input type="number" min={0} step="0.01" inputMode="decimal" value={f.principal} onChange={e => set('principal', e.target.value)} /></Field>
          <Field label="Disbursed on"><Input type="date" value={f.disbursedOn} onChange={e => set('disbursedOn', e.target.value)} /></Field>
          <Field label="Repay by">
            <Select value={f.mode} onChange={e => set('mode', e.target.value)}><option value="instalments">Number of instalments</option><option value="emi">Fixed EMI amount</option></Select>
          </Field>
          <Field label={f.mode === 'instalments' ? 'Instalments (months)' : 'EMI per month'}><Input type="number" min={1} step={f.mode === 'instalments' ? 1 : 0.01} inputMode="decimal" value={f.value} onChange={e => set('value', e.target.value)} /></Field>
          <Field label="First recovery in">
            <div className="flex gap-2">
              <Select value={f.startMonth} onChange={e => set('startMonth', Number(e.target.value))} aria-label="Start month">{MONTHS_SHORT.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>
              <Select value={f.startYear} onChange={e => set('startYear', Number(e.target.value))} aria-label="Start year">{years.map(y => <option key={y} value={y}>{y}</option>)}</Select>
            </div>
          </Field>
          <Field label="Interest (optional)" hint="Flat % a year on the amount, for the tenure. Leave empty for interest-free."><Input type="number" min={0} max={60} step="0.01" value={f.rate} onChange={e => set('rate', e.target.value)} placeholder="0" /></Field>
          <Field label="Notes (optional)" className="sm:col-span-2"><Textarea rows={2} value={f.notes} maxLength={1000} onChange={e => set('notes', e.target.value)} /></Field>
        </div>
        {plan && (
          <div className="rounded-lg bg-surface-sunken p-3 text-xs text-fg-muted tabular-nums">
            <span className="font-medium text-fg">{plan.instalments} × {money(plan.emi)}</span> from {ymLabel(Number(f.startYear), Number(f.startMonth))}
            {plan.interest > 0 && <> · interest {money(plan.interest)}</>} · total to recover <span className="font-medium text-fg">{money(plan.total)}</span>.
            <span className="block mt-1 text-fg-subtle">The last EMI is capped at the balance; if net pay can't cover an EMI it's reduced (never below zero net) and the rest stays in the balance.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Detail / actions ────────────────────────────────────────────────────────

function LedgerList({ rows, money }: { rows: LedgerRow[]; money: (v: number) => string }) {
  if (!rows.length) return <p className="text-xs text-fg-subtle">Nothing recovered yet.</p>;
  return (
    <ul className="divide-y divide-line-subtle text-sm">
      {rows.map(r => (
        <li key={r.id} className="py-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-fg">{ENTRY_LABEL[r.type] ?? r.type} <span className="text-fg-subtle">· {ymLabel(r.year, r.month)}</span>
              {r.payslipStatus === 'DRAFT' && <Badge variant="yellow" className="ml-1.5">draft run</Badge>}</p>
            <p className="text-[11px] text-fg-subtle truncate">{[r.payslipNumber, r.note].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="text-right shrink-0 tabular-nums">
            <p className={r.type === 'SKIP' ? 'text-fg-subtle' : 'text-fg font-medium'}>{r.type === 'SKIP' ? '—' : `−${money(r.amount)}`}</p>
            <p className="text-[11px] text-fg-subtle">bal. {money(r.balance)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function LoanFigures({ loan, money }: { loan: Loan; money: (v: number) => string }) {
  const cell = (label: string, value: string, strong = false) => (
    <div className="rounded-lg bg-surface-sunken px-3 py-2 min-w-0"><p className="text-[10.5px] uppercase tracking-wide text-fg-subtle">{label}</p><p className={`tabular-nums text-sm ${strong ? 'font-semibold text-fg' : 'text-fg'}`}>{value}</p></div>
  );
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {cell('Amount', money(loan.principal))}
      {cell('EMI', `${money(loan.emiAmount)} × ${loan.instalments}`)}
      {cell('Recovered', money(loan.recovered))}
      {cell('Outstanding', money(loan.outstanding), true)}
    </div>
  );
}

type Action = null | 'pause' | 'repay' | 'close' | 'cancel' | 'edit';

function LoanDetailModal({ id, onClose, readOnly = false }: { id: string; onClose: () => void; readOnly?: boolean }) {
  const { money, date } = useFormat();
  const m = (v: number) => money(v);
  const { data: loan, isLoading } = useLoan(id);
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const nm = nextMonth();
  const [form, setForm] = useState({ month: nm.m, year: nm.y, note: '', amount: '', date: today(), reason: '', waive: false, emi: '', name: '' });
  const skip = useSkipMonth(id), unskip = useUnskipMonth(id), repay = useRepayment(id), close = useCloseLoan(id), cancel = useCancelLoan(id), update = useUpdateLoan(id);
  const done = (l: Loan) => { setAction(null); setError(''); setNotice(l.notice ?? 'Saved.'); };
  const onErr = (e: any) => setError(errMsg(e));
  const active = loan?.status === 'ACTIVE';
  const busy = skip.isPending || repay.isPending || close.isPending || cancel.isPending || update.isPending;

  const submit = () => {
    setError('');
    if (action === 'pause') skip.mutate({ month: form.month, year: form.year, note: form.note || undefined }, { onSuccess: done, onError: onErr });
    if (action === 'repay') repay.mutate({ amount: Number(form.amount), date: form.date, note: form.note || undefined }, { onSuccess: done, onError: onErr });
    if (action === 'close') close.mutate({ reason: form.reason, waiveRemaining: form.waive }, { onSuccess: done, onError: onErr });
    if (action === 'cancel') cancel.mutate({ reason: form.reason }, { onSuccess: done, onError: onErr });
    if (action === 'edit') update.mutate({ ...(form.name.trim() ? { name: form.name.trim() } : {}), ...(Number(form.emi) > 0 ? { emiAmount: Number(form.emi) } : {}) }, { onSuccess: done, onError: onErr });
  };
  const years = [nm.y - 1, nm.y, nm.y + 1];

  return (
    <Modal open onClose={onClose} title={loan ? loan.name : 'Loan'} icon={<HandCoins size={16} />} size="lg"
      subtitle={loan ? `${loan.user?.name ? loan.user.name + ' · ' : ''}${loan.type === 'ADVANCE' ? 'Salary advance' : 'Loan'} · disbursed ${date(loan.disbursedOn)} · recovery from ${ymLabel(loan.startYear, loan.startMonth)}` : undefined}
      footer={!readOnly && loan && !action ? (
        <div className="flex flex-wrap gap-2 w-full">
          {active && <Button size="sm" variant="secondary" icon={<PauseCircle size={13} />} onClick={() => setAction('pause')}>Pause a month</Button>}
          {active && <Button size="sm" variant="secondary" icon={<Banknote size={13} />} onClick={() => setAction('repay')}>Record repayment</Button>}
          {active && <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => { setForm(f => ({ ...f, emi: String(loan.emiAmount), name: loan.name })); setAction('edit'); }}>Edit</Button>}
          <span className="flex-1" />
          {active && loan.recovered === 0 && <Button size="sm" variant="ghost" icon={<XCircle size={13} />} onClick={() => setAction('cancel')}>Cancel loan</Button>}
          {active && <Button size="sm" icon={<CheckCircle2 size={13} />} onClick={() => setAction('close')}>Close loan</Button>}
        </div>
      ) : action ? <><Button variant="secondary" onClick={() => { setAction(null); setError(''); }}>Back</Button><Button loading={busy} variant={action === 'cancel' ? 'danger' : 'primary'} onClick={submit}>Confirm</Button></> : undefined}>
      {isLoading || !loan ? <SkeletonTable rows={4} /> : (
        <div className="space-y-4">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
          {notice && !action && <Alert tone={notice === 'Saved.' ? 'success' : 'warning'} onDismiss={() => setNotice('')}>{notice}</Alert>}
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge value={loan.status} map={STATUS_VARIANT} fallback="gray" dot />
            {loan.closeReason && <span className="text-xs text-fg-subtle">{loan.closeReason}</span>}
            {loan.pending > 0 && <span className="text-xs text-warning">{money(loan.pending)} in a draft payroll run</span>}
            {loan.interestAmount > 0 && <span className="text-xs text-fg-subtle">Interest {loan.interestRate}% flat · {money(loan.interestAmount)} · total {money(loan.totalRepayable)}</span>}
          </div>
          <LoanFigures loan={loan} money={m} />

          {action === 'pause' && (
            <div className="space-y-3 rounded-lg border border-line-subtle p-3">
              <p className="text-xs text-fg-muted">No EMI will be deducted in that payroll month; the schedule runs one month longer. If that month's run is already a draft, rerun it afterwards.</p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Month"><Select value={form.month} onChange={e => setForm({ ...form, month: Number(e.target.value) })}>{MONTHS_SHORT.map((x, i) => <option key={x} value={i + 1}>{x}</option>)}</Select></Field>
                <Field label="Year"><Select value={form.year} onChange={e => setForm({ ...form, year: Number(e.target.value) })}>{years.map(y => <option key={y} value={y}>{y}</option>)}</Select></Field>
              </div>
              <Field label="Note (optional)"><Input value={form.note} maxLength={300} onChange={e => setForm({ ...form, note: e.target.value })} /></Field>
            </div>
          )}
          {action === 'repay' && (
            <div className="space-y-3 rounded-lg border border-line-subtle p-3">
              <p className="text-xs text-fg-muted">The employee paid HR directly. Outstanding now: <strong className="text-fg">{money(loan.outstanding)}</strong>. Paying it all closes the loan.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Field label="Amount"><Input type="number" min={0} step="0.01" inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></Field>
                <Field label="Received on"><Input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></Field>
              </div>
              <Button size="xs" variant="ghost" onClick={() => setForm({ ...form, amount: String(loan.outstanding) })}>Pay off in full</Button>
              <Field label="Note (optional)"><Input value={form.note} maxLength={300} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="Cheque / UPI reference" /></Field>
            </div>
          )}
          {action === 'close' && (
            <div className="space-y-3 rounded-lg border border-line-subtle p-3">
              <Field label="Reason"><Input value={form.reason} maxLength={300} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Settled in full and final" /></Field>
              {loan.outstanding > 0 && <Checkbox checked={form.waive} onChange={e => setForm({ ...form, waive: e.target.checked })} label={`Write off the remaining ${money(loan.outstanding)}`} hint="Recorded in the ledger as written off. To recover it instead, record a repayment first." />}
            </div>
          )}
          {action === 'cancel' && (
            <div className="space-y-3 rounded-lg border border-line-subtle p-3">
              <p className="text-xs text-fg-muted">For a loan entered by mistake or never disbursed. Nothing has been recovered on it.</p>
              <Field label="Reason"><Input value={form.reason} maxLength={300} onChange={e => setForm({ ...form, reason: e.target.value })} /></Field>
            </div>
          )}
          {action === 'edit' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg border border-line-subtle p-3">
              <Field label="Name on payslip"><Input value={form.name} maxLength={80} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="EMI from now on" hint="Instalments are recalculated for the remaining balance"><Input type="number" min={1} step="0.01" value={form.emi} onChange={e => setForm({ ...form, emi: e.target.value })} /></Field>
            </div>
          )}

          {!action && <>
            {loan.skippedMonths.length > 0 && (
              <div className="flex flex-wrap gap-1.5 items-center text-xs">
                <span className="text-fg-subtle">Paused:</span>
                {loan.skippedMonths.map(s => (
                  <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5">{ymLabel(s.year, s.month)}
                    {!readOnly && active && <button className="text-fg-subtle hover:text-fg" title="Resume this month" aria-label={`Resume ${ymLabel(s.year, s.month)}`} onClick={() => unskip.mutate(s.id, { onSuccess: done, onError: onErr })}><PlayCircle size={12} /></button>}
                  </span>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <section className="min-w-0">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">Ledger</h4>
                <LedgerList rows={loan.ledger ?? []} money={m} />
              </section>
              <section className="min-w-0">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">Upcoming EMIs</h4>
                {(loan.schedule ?? []).length === 0 ? <p className="text-xs text-fg-subtle">{active ? 'Nothing left to recover.' : 'This loan is closed.'}</p> : (
                  <ul className="divide-y divide-line-subtle text-sm">
                    {(loan.schedule ?? []).slice(0, 12).map(s => (
                      <li key={`${s.year}-${s.month}`} className="py-1.5 flex justify-between gap-3 tabular-nums"><span className="text-fg-muted">{ymLabel(s.year, s.month)}</span><span className="text-fg">{money(s.amount)} <span className="text-[11px] text-fg-subtle">→ {money(s.balanceAfter)}</span></span></li>
                    ))}
                    {(loan.schedule ?? []).length > 12 && <li className="py-1.5 text-xs text-fg-subtle">+ {(loan.schedule ?? []).length - 12} more months</li>}
                  </ul>
                )}
              </section>
            </div>
            {loan.notes && <p className="text-xs text-fg-muted whitespace-pre-line border-t border-line-subtle pt-3">{loan.notes}</p>}
          </>}
        </div>
      )}
    </Modal>
  );
}

// ─── Manager list ────────────────────────────────────────────────────────────

export function LoansSection() {
  const { money, date } = useFormat();
  const [status, setStatus] = useState<'ACTIVE' | 'CLOSED' | 'CANCELLED' | ''>('ACTIVE');
  const { data, isLoading } = useLoans(status || undefined);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const rows = data ?? [];
  const totals = rows.reduce((s, l) => ({ out: s.out + l.outstanding, emi: s.emi + (l.status === 'ACTIVE' && l.outstanding > 0 ? Math.min(l.emiAmount, l.outstanding) : 0) }), { out: 0, emi: 0 });

  return (
    <Card>
      <CardHeader title="Loans & advances" icon={<HandCoins size={14} />} className="mb-3"
        subtitle="Loans and salary advances are recovered automatically in each payroll run, shown on the payslip with the running balance."
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={() => setCreating(true)}>New loan</Button>} />
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-40"><Select value={status} onChange={e => setStatus(e.target.value as any)} aria-label="Status"><option value="ACTIVE">Active</option><option value="CLOSED">Closed</option><option value="CANCELLED">Cancelled</option><option value="">All</option></Select></div>
        {rows.length > 0 && <p className="text-xs text-fg-muted tabular-nums">{rows.length} loan{rows.length === 1 ? '' : 's'} · outstanding <strong className="text-fg">{money(totals.out)}</strong>{totals.emi > 0 && <> · next month's EMIs {money(totals.emi)}</>}</p>}
      </div>
      {isLoading ? <SkeletonTable rows={3} /> : rows.length === 0 ? (
        <EmptyState compact icon={<HandCoins />} title={status === 'ACTIVE' ? 'No active loans' : 'No loans here'}
          description="Record a loan or salary advance; payroll deducts the EMI every month and prints it on the payslip."
          action={{ label: 'New loan', onClick: () => setCreating(true) }} />
      ) : (
        <DataTable<Loan>
          rows={rows} rowKey={l => l.id} onRowClick={l => setViewing(l.id)} minWidth={640}
          columns={[
            { key: 'employee', header: 'Employee', mobile: 'title', cell: l => <div className="min-w-0"><p className="font-medium text-fg truncate">{l.user?.name}</p><p className="text-xs text-fg-subtle truncate">{l.name}{l.type === 'ADVANCE' ? ' · advance' : ''}</p></div> },
            { key: 'amount', header: 'Amount', align: 'right', cell: l => <span className="tabular-nums">{money(l.principal)}</span> },
            { key: 'emi', header: 'EMI', align: 'right', cell: l => <span className="tabular-nums">{money(l.emiAmount)}</span> },
            { key: 'progress', header: 'Progress', hideBelow: 'md', mobile: 'hidden', cell: l => <Progress loan={l} /> },
            { key: 'outstanding', header: 'Outstanding', align: 'right', cell: l => <span className="tabular-nums font-medium">{money(l.outstanding)}</span> },
            { key: 'start', header: 'Since', hideBelow: 'lg', muted: true, mobile: 'hidden', cell: l => <span className="text-xs">{date(l.disbursedOn)}</span> },
            { key: 'status', header: '', cell: l => <StatusBadge value={l.status} map={STATUS_VARIANT} fallback="gray" /> },
          ]}
        />
      )}
      {creating && <NewLoanModal onClose={() => setCreating(false)} onCreated={id => setViewing(id)} />}
      {viewing && <LoanDetailModal id={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}

// ─── Employee (read-only) ────────────────────────────────────────────────────

export function MyLoans() {
  const { money } = useFormat();
  const { data } = useMyLoans();
  const [viewing, setViewing] = useState<string | null>(null);
  const loans = data ?? [];
  if (!loans.length) return null;
  return (
    <Card className="mt-4">
      <CardHeader title="My loans & advances" icon={<HandCoins size={14} />} className="mb-3" subtitle="Recovered from your salary each month — the payslip shows each EMI and your balance." />
      <div className="space-y-2">
        {loans.map(l => (
          <button key={l.id} onClick={() => setViewing(l.id)} className="w-full text-left p-3 border border-line-subtle rounded-card hover:border-line-strong hover:bg-surface-hover transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-fg text-sm truncate">{l.name}</p>
                <p className="text-xs text-fg-subtle tabular-nums">{money(l.principal)} · EMI {money(l.emiAmount)} · {l.emisRecovered}/{l.instalments} paid</p>
              </div>
              <div className="text-right shrink-0">
                <p className="font-semibold text-fg text-sm tabular-nums">{money(l.outstanding)}</p>
                <p className="text-[11px] text-fg-subtle">{l.status === 'ACTIVE' ? 'outstanding' : l.status.toLowerCase()}</p>
              </div>
            </div>
            <div className="mt-2"><Progress loan={l} /></div>
          </button>
        ))}
      </div>
      {viewing && <LoanDetailModal id={viewing} readOnly onClose={() => setViewing(null)} />}
    </Card>
  );
}
