import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useUsers } from '../../api/users';
import {
  PageHeader, PageBody, Card, CardHeader, Tabs, Button, Modal, StatusBadge, EmptyState,
  RowActions, SearchableSelect, Field, Label, Input, Textarea, Select, Checkbox, Alert, Avatar,
  IconButton, DataTable, SkeletonTable, SkeletonCard, type BadgeProps,
} from '../../shared/components';
import { Wallet, Plus, Pencil, Trash2, FileText, PlayCircle, CheckCircle2, Printer, Palette } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';

const MANAGER_ROLES = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'];

/** Shared with the payroll-run and payslip chips: paid is settled (green),
 *  anything else is still in flight (yellow). */
const PAYSLIP_STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  PAID: 'green', GENERATED: 'yellow', PENDING: 'yellow', DRAFT: 'gray',
};
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface EmployeeRef { id: string; name: string; email: string; department?: string | null; avatarUrl?: string | null }

interface SalaryStructure {
  id: string; userId: string;
  basic: string; hra: string; allowances: string;
  pfPercent: string; professionalTax: string; otherDeductions: string;
  effectiveFrom: string; isActive: boolean;
  user: EmployeeRef;
}

interface Payslip {
  id: string; payslipNumber: string; month: number; year: number;
  basic: string; hra: string; allowances: string; grossPay: string;
  pf: string; professionalTax: string; otherDeductions: string; totalDeductions: string; netPay: string;
  status: string; paidAt: string | null; createdAt: string;
  user: EmployeeRef;
}

interface PayrollRun {
  id: string; month: number; year: number; status: string; runAt: string;
  runByUser: { id: string; name: string };
  payslips?: Payslip[];
  _count?: { payslips: number };
}

interface PayslipTemplate {
  companyName: string | null; companyAddress: string | null; logoUrl: string | null;
  primaryColor: string; footerNote: string | null;
  showSignature: boolean; signatureLabel: string;
}

// ─── Salary Structures (managers) ───────────────────────────────────────────

const emptyStructureForm = { userId: '', basic: '', hra: '', allowances: '', pfPercent: '12', professionalTax: '', otherDeductions: '', effectiveFrom: new Date().toISOString().slice(0, 10) };

function SalaryStructuresSection() {
  const qc = useQueryClient();
  const { money } = useFormat();
  const { data: employees } = useUsers();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SalaryStructure | null>(null);
  const [form, setForm] = useState(emptyStructureForm);
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery<SalaryStructure[]>({
    queryKey: ['payroll-structures'],
    queryFn: () => api.get('/hr/payroll/structures').then(r => r.data),
  });

  const save = useMutation({
    mutationFn: () => api.post('/hr/payroll/structures', {
      userId: form.userId,
      basic: Number(form.basic),
      hra: Number(form.hra || 0),
      allowances: Number(form.allowances || 0),
      pfPercent: Number(form.pfPercent || 0),
      professionalTax: Number(form.professionalTax || 0),
      otherDeductions: Number(form.otherDeductions || 0),
      effectiveFrom: form.effectiveFrom,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-structures'] }); closeModal(); },
    onError: (err: any) => setError(err?.response?.data?.error || 'Could not save salary structure.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/hr/payroll/structures/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-structures'] }),
  });

  function openCreate() { setEditing(null); setForm(emptyStructureForm); setError(''); setModalOpen(true); }
  function openEdit(s: SalaryStructure) {
    setEditing(s);
    setForm({
      userId: s.userId, basic: s.basic, hra: s.hra, allowances: s.allowances,
      pfPercent: s.pfPercent, professionalTax: s.professionalTax, otherDeductions: s.otherDeductions,
      effectiveFrom: new Date().toISOString().slice(0, 10),
    });
    setError(''); setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); }

  const alreadyAssigned = new Set((data || []).map(s => s.userId));
  const employeeOptions: { value: string; label: string }[] =
    (employees || []).map((u: EmployeeRef) => ({ value: u.id, label: u.name }));

  return (
    <Card>
      <CardHeader
        title="Salary Structures"
        icon={<Wallet size={14} />}
        className="mb-3"
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={openCreate}>Set Salary</Button>}
      />
      <p className="text-xs text-fg-subtle mb-4">Each employee's current pay components. Saving a revision keeps the old one on record for past payslips.</p>

      {isLoading ? <SkeletonTable rows={3} /> : (data || []).length === 0 ? (
        <EmptyState
          compact
          icon={<Wallet />}
          title="No salary structures yet"
          description="Set each employee's pay components here before running payroll."
          action={{ label: 'Set a salary', onClick: openCreate }}
        />
      ) : (
        <div className="space-y-2">
          {(data || []).map(s => {
            const gross = Number(s.basic) + Number(s.hra) + Number(s.allowances);
            return (
              <div key={s.id} className="flex items-center justify-between gap-3 p-3 border border-line-subtle rounded-card flex-wrap">
                <div className="min-w-0 flex items-center gap-2.5">
                  <Avatar name={s.user.name} src={s.user.avatarUrl} size="sm" />
                  <div className="min-w-0">
                    <p className="font-medium text-fg text-sm truncate" title={s.user.name}>{s.user.name}</p>
                    <p className="text-xs text-fg-subtle tabular-nums">
                      Basic {money(s.basic)} + HRA {money(s.hra)} + Allowances {money(s.allowances)} · Gross {money(gross)}/mo
                    </p>
                  </div>
                </div>
                <RowActions items={[
                  { label: 'Revise', icon: <Pencil size={13} />, onClick: () => openEdit(s) },
                  { label: 'Remove from payroll', icon: <Trash2 size={13} />, variant: 'danger', onClick: () => { if (confirm(`Remove ${s.user.name} from payroll?`)) remove.mutate(s.id); } },
                ]} />
              </div>
            );
          })}
        </div>
      )}

      <Modal open={modalOpen} onClose={closeModal} title={editing ? `Revise salary — ${editing.user.name}` : 'Set salary structure'} icon={<Wallet size={16} />}
        footer={<>
          <Button variant="secondary" onClick={closeModal}>Cancel</Button>
          <Button onClick={() => { setError(''); save.mutate(); }} loading={save.isPending} disabled={!form.userId || !form.basic}>
            {editing ? 'Save Revision' : 'Set Salary'}
          </Button>
        </>}>
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Employee">
            <SearchableSelect
              value={form.userId}
              onChange={val => setForm(f => ({ ...f, userId: val }))}
              options={editing ? employeeOptions : employeeOptions.filter(o => !alreadyAssigned.has(o.value))}
              disabled={!!editing}
              required
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Basic">
              <Input type="number" min={0} value={form.basic} onChange={e => setForm(f => ({ ...f, basic: e.target.value }))} placeholder="0.00" />
            </Field>
            <Field label="HRA">
              <Input type="number" min={0} value={form.hra} onChange={e => setForm(f => ({ ...f, hra: e.target.value }))} placeholder="0.00" />
            </Field>
          </div>
          <Field label="Other allowances">
            <Input type="number" min={0} value={form.allowances} onChange={e => setForm(f => ({ ...f, allowances: e.target.value }))} placeholder="0.00" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="PF %">
              <Input type="number" min={0} max={100} value={form.pfPercent} onChange={e => setForm(f => ({ ...f, pfPercent: e.target.value }))} />
            </Field>
            <Field label="Professional tax">
              <Input type="number" min={0} value={form.professionalTax} onChange={e => setForm(f => ({ ...f, professionalTax: e.target.value }))} placeholder="0.00" />
            </Field>
            <Field label="Other deductions">
              <Input type="number" min={0} value={form.otherDeductions} onChange={e => setForm(f => ({ ...f, otherDeductions: e.target.value }))} placeholder="0.00" />
            </Field>
          </div>
          <Field label="Effective from">
            <Input type="date" value={form.effectiveFrom} onChange={e => setForm(f => ({ ...f, effectiveFrom: e.target.value }))} />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

// ─── Payroll Runs (managers) ─────────────────────────────────────────────────

function RunModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const now = new Date();
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [error, setError] = useState('');

  const run = useMutation({
    mutationFn: () => api.post('/hr/payroll/runs', { month: Number(month), year: Number(year) }).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); onClose(); },
    onError: (err: any) => setError(err?.response?.data?.error || 'Could not run payroll.'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Run payroll" icon={<PlayCircle size={16} />} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { setError(''); run.mutate(); }} loading={run.isPending}>Run Payroll</Button>
      </>}>
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <p className="text-xs text-fg-subtle">Generates a payslip for every employee with a salary structure, using their current pay components.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Month">
            <Select value={month} onChange={e => setMonth(e.target.value)}>
              {MONTH_NAMES.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </Select>
          </Field>
          <Field label="Year">
            <Input type="number" value={year} onChange={e => setYear(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function PayrollRunsSection() {
  const qc = useQueryClient();
  const { money } = useFormat();
  const [runOpen, setRunOpen] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  const { data, isLoading } = useQuery<PayrollRun[]>({
    queryKey: ['payroll-runs'],
    queryFn: () => api.get('/hr/payroll/runs').then(r => r.data),
  });

  const { data: run } = useQuery<PayrollRun>({
    queryKey: ['payroll-run', viewing],
    queryFn: () => api.get(`/hr/payroll/runs/${viewing}`).then(r => r.data),
    enabled: !!viewing,
  });

  const markPaid = useMutation({
    mutationFn: (id: string) => api.patch(`/hr/payroll/runs/${id}/mark-paid`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); qc.invalidateQueries({ queryKey: ['payroll-run'] }); },
  });

  return (
    <Card>
      <CardHeader
        title="Payroll Runs"
        icon={<FileText size={14} />}
        className="mb-3"
        actions={<Button size="sm" icon={<PlayCircle size={13} />} onClick={() => setRunOpen(true)}>Run Payroll</Button>}
      />

      {isLoading ? <SkeletonTable rows={3} /> : (data || []).length === 0 ? (
        <EmptyState
          compact
          icon={<FileText />}
          title="No payroll runs yet"
          description="Once salary structures are set up, run payroll to generate everyone's payslips in one go."
          action={{ label: 'Run payroll', onClick: () => setRunOpen(true) }}
        />
      ) : (
        <div className="space-y-2">
          {(data || []).map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 p-3 border border-line-subtle rounded-card flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-fg text-sm tabular-nums">{MONTH_NAMES[r.month]} {r.year}</span>
                  <StatusBadge value={r.status} map={PAYSLIP_STATUS_VARIANT} fallback="yellow" dot />
                </div>
                <p className="text-xs text-fg-subtle mt-0.5 tabular-nums">
                  {r._count?.payslips ?? 0} payslip{(r._count?.payslips ?? 0) === 1 ? '' : 's'} · run by {r.runByUser?.name}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="xs" variant="ghost" onClick={() => setViewing(r.id)}>View</Button>
                {r.status !== 'PAID' && (
                  <Button size="xs" variant="subtle" icon={<CheckCircle2 size={12} />} onClick={() => markPaid.mutate(r.id)}>
                    Mark All Paid
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <RunModal open={runOpen} onClose={() => setRunOpen(false)} />

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={run ? `${MONTH_NAMES[run.month]} ${run.year} payroll` : 'Payroll run'} icon={<FileText size={16} />} size="lg">
        <DataTable<Payslip>
            minWidth={480}
            loading={!run}
            rows={run?.payslips || []}
            rowKey={p => p.id}
            columns={[
              { key: 'employee', header: 'Employee', cell: p => <span className="truncate" title={p.user.name}>{p.user.name}</span> },
              { key: 'gross', header: 'Gross', align: 'right', cell: p => <span className="tabular-nums">{money(p.grossPay)}</span> },
              { key: 'deductions', header: 'Deductions', align: 'right', muted: true, hideBelow: 'sm', cell: p => <span className="tabular-nums">{money(p.totalDeductions)}</span> },
              { key: 'net', header: 'Net Pay', align: 'right', cell: p => <span className="font-medium tabular-nums">{money(p.netPay)}</span> },
              { key: 'status', header: 'Status', cell: p => <StatusBadge value={p.status} map={PAYSLIP_STATUS_VARIANT} fallback="yellow" /> },
              {
                key: 'actions',
                header: '',
                align: 'right',
                cell: p => (
                  <IconButton
                    label="Print / Save as PDF"
                    tone="accent"
                    icon={<Printer size={14} />}
                    onClick={() => window.open(`/hr/payroll/payslips/${p.id}/print`, '_blank')}
                  />
                ),
              },
            ]}
          />
      </Modal>
    </Card>
  );
}

// ─── My Payslips (everyone) ──────────────────────────────────────────────────

function PayslipDetail({ payslip, onClose }: { payslip: Payslip; onClose: () => void }) {
  const { money, date } = useFormat();
  return (
    <Modal open onClose={onClose} title={payslip.payslipNumber} subtitle={`${MONTH_NAMES[payslip.month]} ${payslip.year}`} icon={<FileText size={16} />}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button icon={<Printer size={13} />} onClick={() => window.open(`/hr/payroll/payslips/${payslip.id}/print`, '_blank')}>
          Print / Save as PDF
        </Button>
      </>}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="font-medium text-fg truncate" title={payslip.user.name}>{payslip.user.name}</p>
            <p className="text-xs text-fg-subtle truncate">{payslip.user.department || payslip.user.email}</p>
          </div>
          <StatusBadge value={payslip.status} map={PAYSLIP_STATUS_VARIANT} fallback="yellow" dot />
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm tabular-nums border-t border-line-subtle pt-3">
          <p className="text-fg-muted">Basic</p><p className="text-right text-fg">{money(payslip.basic)}</p>
          <p className="text-fg-muted">HRA</p><p className="text-right text-fg">{money(payslip.hra)}</p>
          <p className="text-fg-muted">Allowances</p><p className="text-right text-fg">{money(payslip.allowances)}</p>
          <p className="font-medium text-fg border-t border-line-subtle pt-2">Gross Pay</p>
          <p className="text-right font-medium text-fg border-t border-line-subtle pt-2">{money(payslip.grossPay)}</p>
          <p className="text-fg-muted">Provident Fund</p><p className="text-right text-danger">-{money(payslip.pf)}</p>
          <p className="text-fg-muted">Professional Tax</p><p className="text-right text-danger">-{money(payslip.professionalTax)}</p>
          <p className="text-fg-muted">Other Deductions</p><p className="text-right text-danger">-{money(payslip.otherDeductions)}</p>
          <p className="font-semibold text-fg border-t border-line pt-2">Net Pay</p>
          <p className="text-right font-semibold text-fg border-t border-line pt-2">{money(payslip.netPay)}</p>
        </div>
        {payslip.paidAt && <p className="text-xs text-fg-subtle">Paid on {date(payslip.paidAt)}</p>}
      </div>
    </Modal>
  );
}

function MyPayslips() {
  const { money } = useFormat();
  const [viewing, setViewing] = useState<Payslip | null>(null);
  const { data, isLoading } = useQuery<Payslip[]>({
    queryKey: ['payslips', 'mine'],
    queryFn: () => api.get('/hr/payroll/payslips').then(r => r.data),
  });

  return (
    <Card>
      <CardHeader title="My Payslips" className="mb-3" />
      {isLoading ? <SkeletonTable rows={3} /> : (data || []).length === 0 ? (
        <EmptyState
          compact
          icon={<Wallet />}
          title="No payslips yet"
          description="Your payslips will appear here after each payroll run — ready to view and download."
        />
      ) : (
        <div className="space-y-2">
          {(data || []).map(p => (
            <button key={p.id} onClick={() => setViewing(p)}
              className="w-full flex items-center justify-between gap-3 p-3 border border-line-subtle rounded-card hover:border-line-strong hover:bg-surface-hover transition-colors text-left">
              <div>
                <p className="font-medium text-fg text-sm tabular-nums">{MONTH_NAMES[p.month]} {p.year}</p>
                <p className="text-xs text-fg-subtle font-mono">{p.payslipNumber}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold text-fg text-sm tabular-nums">{money(p.netPay)}</span>
                <StatusBadge value={p.status} map={PAYSLIP_STATUS_VARIANT} fallback="yellow" dot />
              </div>
            </button>
          ))}
        </div>
      )}
      {viewing && <PayslipDetail payslip={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}

// ─── Payslip Template (managers) ─────────────────────────────────────────────

const emptyTemplateForm = { companyName: '', companyAddress: '', logoUrl: '', primaryColor: '#2563eb', footerNote: '', showSignature: true, signatureLabel: 'Authorized Signatory' };

function PayslipTemplateSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState(emptyTemplateForm);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<PayslipTemplate>({
    queryKey: ['payslip-template'],
    queryFn: () => api.get('/hr/payroll/template').then(r => r.data),
  });

  // Seeding the form happens here, not inside queryFn. A queryFn is not a
  // render-safe place to call setState: React Query re-runs it on refetch —
  // window refocus, cache invalidation, the save mutation's own
  // invalidateQueries — and each run overwrote whatever the user had typed but
  // not yet saved. Keying off the loaded row and filling only once keeps
  // in-progress edits intact.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const key = (data as any).id ?? 'template';
    if (seededFor.current === key) return;
    seededFor.current = key;
    setForm({
      companyName: data.companyName || '', companyAddress: data.companyAddress || '', logoUrl: data.logoUrl || '',
      primaryColor: data.primaryColor || '#2563eb', footerNote: data.footerNote || '',
      showSignature: data.showSignature ?? true, signatureLabel: data.signatureLabel || 'Authorized Signatory',
    });
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put('/hr/payroll/template', form).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payslip-template'] }); setSaved(true); setTimeout(() => setSaved(false), 2000); },
    onError: (err: any) => setError(err?.response?.data?.error || 'Could not save template.'),
  });

  if (isLoading || !data) return <SkeletonCard lines={6} />;

  return (
    <Card>
      <CardHeader
        title="Payslip Template"
        icon={<Palette size={14} />}
        className="mb-3"
        actions={<Button size="sm" onClick={() => { setError(''); save.mutate(); }} loading={save.isPending}>{saved ? 'Saved!' : 'Save'}</Button>}
      />
      <p className="text-xs text-fg-subtle mb-4">This letterhead is applied to every employee's downloadable payslip.</p>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Company name">
            <Input value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} placeholder="Defaults to your org name" />
          </Field>
          <Field label="Company address">
            <Textarea rows={2} value={form.companyAddress} onChange={e => setForm(f => ({ ...f, companyAddress: e.target.value }))} placeholder="123 Main St, Springfield" />
          </Field>
          <Field label="Logo URL">
            <Input value={form.logoUrl} onChange={e => setForm(f => ({ ...f, logoUrl: e.target.value }))} placeholder="https://..." />
          </Field>
          <Field label="Accent color">
            <div className="flex items-center gap-2">
              <input type="color" value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} className="w-9 h-9 rounded-input border border-line cursor-pointer shrink-0" />
              <Input value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} />
            </div>
          </Field>
          <Field label="Footer note">
            <Textarea rows={2} value={form.footerNote} onChange={e => setForm(f => ({ ...f, footerNote: e.target.value }))} placeholder="This is a system-generated payslip and does not require a signature." />
          </Field>
          <Checkbox
            label="Show a signature line"
            checked={form.showSignature}
            onChange={e => setForm(f => ({ ...f, showSignature: e.target.checked }))}
          />
          {form.showSignature && (
            <Field label="Signature label">
              <Input value={form.signatureLabel} onChange={e => setForm(f => ({ ...f, signatureLabel: e.target.value }))} placeholder="Authorized Signatory" />
            </Field>
          )}
        </div>

        <div>
          <Label className="mb-2">Preview</Label>
          <Card tone="sunken" padding="sm" flat>
            <div className="flex items-center gap-2 pb-3 mb-3 border-b" style={{ borderColor: form.primaryColor }}>
              {form.logoUrl && <img src={form.logoUrl} alt="" className="w-8 h-8 rounded object-contain" onError={e => (e.currentTarget.style.display = 'none')} />}
              <div>
                <p className="text-sm font-semibold text-fg">{form.companyName || 'Your Company'}</p>
                {form.companyAddress && <p className="text-[11px] text-fg-subtle whitespace-pre-line">{form.companyAddress}</p>}
              </div>
            </div>
            <p className="text-xs font-semibold" style={{ color: form.primaryColor }}>PAYSLIP — August 2026</p>
            <p className="text-[11px] text-fg-subtle mt-1">Jane Doe · PAY-2026-08-0001</p>
            {form.showSignature && <p className="text-[11px] text-fg-subtle mt-4 pt-2 border-t border-dashed border-line">{form.signatureLabel}</p>}
            {form.footerNote && <p className="text-[10px] text-fg-subtle mt-2">{form.footerNote}</p>}
          </Card>
        </div>
      </div>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PayrollPage() {
  const { user } = useAuth();
  const isManager = MANAGER_ROLES.includes(user?.role || '');
  const [tab, setTab] = useState<'me' | 'structures' | 'runs' | 'template'>('me');

  return (
    <div>
      <PageHeader
        title="Payroll"
        subtitle="Salary structures, payroll runs, and payslips"
        below={isManager ? (
          <Tabs<'me' | 'structures' | 'runs' | 'template'>
            aria-label="Payroll views"
            variant="segmented"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'me', label: 'My Payslips' },
              { key: 'structures', label: 'Salary Structures' },
              { key: 'runs', label: 'Payroll Runs' },
              { key: 'template', label: 'Template' },
            ]}
          />
        ) : undefined}
      />

      <PageBody width="full" className="max-w-4xl mx-auto">
        {tab === 'me' && <MyPayslips />}
        {tab === 'structures' && isManager && <SalaryStructuresSection />}
        {tab === 'runs' && isManager && <PayrollRunsSection />}
        {tab === 'template' && isManager && <PayslipTemplateSection />}
      </PageBody>
    </div>
  );
}
