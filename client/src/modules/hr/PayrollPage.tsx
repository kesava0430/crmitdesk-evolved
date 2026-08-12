import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useUsers } from '../../api/users';
import { PageHeader, Button, Modal, Badge, Spinner, EmptyState, RowActions, SearchableSelect } from '../../shared/components';
import { Wallet, Plus, Pencil, Trash2, FileText, PlayCircle, CheckCircle2, Printer, Palette } from 'lucide-react';

const MANAGER_ROLES = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'];
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

const money = (v: string | number) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ─── Salary Structures (managers) ───────────────────────────────────────────

const emptyStructureForm = { userId: '', basic: '', hra: '', allowances: '', pfPercent: '12', professionalTax: '', otherDeductions: '', effectiveFrom: new Date().toISOString().slice(0, 10) };

function SalaryStructuresSection() {
  const qc = useQueryClient();
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
  const employeeOptions = (employees || []).map((u: EmployeeRef) => ({ value: u.id, label: u.name }));

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5"><Wallet size={14} /> Salary Structures</p>
        <Button size="sm" icon={<Plus size={13} />} onClick={openCreate}>Set Salary</Button>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">Each employee's current pay components. Saving a revision keeps the old one on record for past payslips.</p>

      {isLoading ? <Spinner /> : (data || []).length === 0 ? (
        <EmptyState icon={<Wallet size={20} />} title="No salary structures yet" description="Set one up before running payroll" />
      ) : (
        <div className="space-y-2">
          {(data || []).map(s => {
            const gross = Number(s.basic) + Number(s.hra) + Number(s.allowances);
            return (
              <div key={s.id} className="flex items-center justify-between gap-3 p-3 border border-gray-100 dark:border-gray-800 rounded-xl flex-wrap">
                <div className="min-w-0 flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-brand-100 dark:bg-brand-500/20 text-brand-600 dark:text-brand-400 flex items-center justify-center text-xs font-bold shrink-0">
                    {s.user.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-gray-800 dark:text-gray-200 text-sm">{s.user.name}</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
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
          {error && <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/30 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className="form-label">Employee</label>
            <SearchableSelect
              value={form.userId}
              onChange={val => setForm(f => ({ ...f, userId: val }))}
              options={editing ? employeeOptions : employeeOptions.filter(o => !alreadyAssigned.has(o.value))}
              disabled={!!editing}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">Basic</label>
              <input className="ui-input" type="number" min={0} value={form.basic} onChange={e => setForm(f => ({ ...f, basic: e.target.value }))} placeholder="0.00" />
            </div>
            <div>
              <label className="form-label">HRA</label>
              <input className="ui-input" type="number" min={0} value={form.hra} onChange={e => setForm(f => ({ ...f, hra: e.target.value }))} placeholder="0.00" />
            </div>
          </div>
          <div>
            <label className="form-label">Other allowances</label>
            <input className="ui-input" type="number" min={0} value={form.allowances} onChange={e => setForm(f => ({ ...f, allowances: e.target.value }))} placeholder="0.00" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="form-label">PF %</label>
              <input className="ui-input" type="number" min={0} max={100} value={form.pfPercent} onChange={e => setForm(f => ({ ...f, pfPercent: e.target.value }))} />
            </div>
            <div>
              <label className="form-label">Professional tax</label>
              <input className="ui-input" type="number" min={0} value={form.professionalTax} onChange={e => setForm(f => ({ ...f, professionalTax: e.target.value }))} placeholder="0.00" />
            </div>
            <div>
              <label className="form-label">Other deductions</label>
              <input className="ui-input" type="number" min={0} value={form.otherDeductions} onChange={e => setForm(f => ({ ...f, otherDeductions: e.target.value }))} placeholder="0.00" />
            </div>
          </div>
          <div>
            <label className="form-label">Effective from</label>
            <input type="date" className="ui-input" value={form.effectiveFrom} onChange={e => setForm(f => ({ ...f, effectiveFrom: e.target.value }))} />
          </div>
        </div>
      </Modal>
    </div>
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
        {error && <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/30 rounded-lg px-3 py-2">{error}</p>}
        <p className="text-xs text-gray-400 dark:text-gray-500">Generates a payslip for every employee with a salary structure, using their current pay components.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="form-label">Month</label>
            <select className="ui-input" value={month} onChange={e => setMonth(e.target.value)}>
              {MONTH_NAMES.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label">Year</label>
            <input className="ui-input" type="number" value={year} onChange={e => setYear(e.target.value)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PayrollRunsSection() {
  const qc = useQueryClient();
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
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5"><FileText size={14} /> Payroll Runs</p>
        <Button size="sm" icon={<PlayCircle size={13} />} onClick={() => setRunOpen(true)}>Run Payroll</Button>
      </div>

      {isLoading ? <Spinner /> : (data || []).length === 0 ? (
        <EmptyState icon={<FileText size={20} />} title="No payroll runs yet" description="Run payroll once salary structures are set up" />
      ) : (
        <div className="space-y-2">
          {(data || []).map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 p-3 border border-gray-100 dark:border-gray-800 rounded-xl flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-800 dark:text-gray-200 text-sm">{MONTH_NAMES[r.month]} {r.year}</span>
                  <Badge variant={r.status === 'PAID' ? 'green' : 'yellow'}>{r.status}</Badge>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {r._count?.payslips ?? 0} payslip{(r._count?.payslips ?? 0) === 1 ? '' : 's'} · run by {r.runByUser?.name}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => setViewing(r.id)} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">View</button>
                {r.status !== 'PAID' && (
                  <button onClick={() => markPaid.mutate(r.id)} className="flex items-center gap-1 px-2.5 py-1 bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400 rounded-lg text-xs font-medium hover:bg-green-100 dark:hover:bg-green-500/20">
                    <CheckCircle2 size={12} /> Mark All Paid
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <RunModal open={runOpen} onClose={() => setRunOpen(false)} />

      <Modal open={!!viewing} onClose={() => setViewing(null)} title={run ? `${MONTH_NAMES[run.month]} ${run.year} payroll` : 'Payroll run'} icon={<FileText size={16} />} size="lg">
        {!run ? <Spinner /> : (
          <div className="table-container">
            <table className="w-full text-sm min-w-[480px]">
              <thead><tr className="text-left text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wide border-b border-gray-100 dark:border-gray-800">
                <th className="pb-2 font-medium">Employee</th>
                <th className="pb-2 font-medium">Gross</th>
                <th className="pb-2 font-medium">Deductions</th>
                <th className="pb-2 font-medium">Net Pay</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium"></th>
              </tr></thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {(run.payslips || []).map(p => (
                  <tr key={p.id}>
                    <td className="py-2.5 dark:text-gray-300">{p.user.name}</td>
                    <td className="py-2.5 dark:text-gray-300">{money(p.grossPay)}</td>
                    <td className="py-2.5 text-gray-500 dark:text-gray-400">{money(p.totalDeductions)}</td>
                    <td className="py-2.5 font-medium dark:text-gray-200">{money(p.netPay)}</td>
                    <td className="py-2.5"><Badge variant={p.status === 'PAID' ? 'green' : 'yellow'}>{p.status}</Badge></td>
                    <td className="py-2.5 text-right">
                      <button onClick={() => window.open(`/hr/payroll/payslips/${p.id}/print`, '_blank')} title="Print / Save as PDF"
                        className="text-gray-400 hover:text-brand-600 dark:hover:text-brand-400">
                        <Printer size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── My Payslips (everyone) ──────────────────────────────────────────────────

function PayslipDetail({ payslip, onClose }: { payslip: Payslip; onClose: () => void }) {
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
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">{payslip.user.name}</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">{payslip.user.department || payslip.user.email}</p>
          </div>
          <Badge variant={payslip.status === 'PAID' ? 'green' : 'yellow'}>{payslip.status}</Badge>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm border-t border-gray-100 dark:border-gray-800 pt-3">
          <p className="text-gray-500 dark:text-gray-400">Basic</p><p className="text-right dark:text-gray-200">{money(payslip.basic)}</p>
          <p className="text-gray-500 dark:text-gray-400">HRA</p><p className="text-right dark:text-gray-200">{money(payslip.hra)}</p>
          <p className="text-gray-500 dark:text-gray-400">Allowances</p><p className="text-right dark:text-gray-200">{money(payslip.allowances)}</p>
          <p className="font-medium text-gray-800 dark:text-gray-200 border-t border-gray-100 dark:border-gray-800 pt-2">Gross Pay</p>
          <p className="text-right font-medium text-gray-800 dark:text-gray-200 border-t border-gray-100 dark:border-gray-800 pt-2">{money(payslip.grossPay)}</p>
          <p className="text-gray-500 dark:text-gray-400">Provident Fund</p><p className="text-right text-red-500 dark:text-red-400">-{money(payslip.pf)}</p>
          <p className="text-gray-500 dark:text-gray-400">Professional Tax</p><p className="text-right text-red-500 dark:text-red-400">-{money(payslip.professionalTax)}</p>
          <p className="text-gray-500 dark:text-gray-400">Other Deductions</p><p className="text-right text-red-500 dark:text-red-400">-{money(payslip.otherDeductions)}</p>
          <p className="font-semibold text-gray-900 dark:text-white border-t border-gray-200 dark:border-gray-700 pt-2">Net Pay</p>
          <p className="text-right font-semibold text-gray-900 dark:text-white border-t border-gray-200 dark:border-gray-700 pt-2">{money(payslip.netPay)}</p>
        </div>
        {payslip.paidAt && <p className="text-xs text-gray-400 dark:text-gray-500">Paid on {new Date(payslip.paidAt).toLocaleDateString()}</p>}
      </div>
    </Modal>
  );
}

function MyPayslips() {
  const [viewing, setViewing] = useState<Payslip | null>(null);
  const { data, isLoading } = useQuery<Payslip[]>({
    queryKey: ['payslips', 'mine'],
    queryFn: () => api.get('/hr/payroll/payslips').then(r => r.data),
  });

  return (
    <div className="card p-5">
      <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">My Payslips</p>
      {isLoading ? <Spinner /> : (data || []).length === 0 ? (
        <EmptyState icon={<Wallet size={22} />} title="No payslips yet" description="They'll show up here once payroll is run" />
      ) : (
        <div className="space-y-2">
          {(data || []).map(p => (
            <button key={p.id} onClick={() => setViewing(p)}
              className="w-full flex items-center justify-between gap-3 p-3 border border-gray-100 dark:border-gray-800 rounded-xl hover:border-gray-200 dark:hover:border-gray-700 text-left">
              <div>
                <p className="font-medium text-gray-800 dark:text-gray-200 text-sm">{MONTH_NAMES[p.month]} {p.year}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">{p.payslipNumber}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold text-gray-800 dark:text-gray-200 text-sm">{money(p.netPay)}</span>
                <Badge variant={p.status === 'PAID' ? 'green' : 'yellow'}>{p.status}</Badge>
              </div>
            </button>
          ))}
        </div>
      )}
      {viewing && <PayslipDetail payslip={viewing} onClose={() => setViewing(null)} />}
    </div>
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
    queryFn: () => api.get('/hr/payroll/template').then(r => {
      const t = r.data;
      setForm({
        companyName: t.companyName || '', companyAddress: t.companyAddress || '', logoUrl: t.logoUrl || '',
        primaryColor: t.primaryColor || '#2563eb', footerNote: t.footerNote || '',
        showSignature: t.showSignature ?? true, signatureLabel: t.signatureLabel || 'Authorized Signatory',
      });
      return t;
    }),
  });

  const save = useMutation({
    mutationFn: () => api.put('/hr/payroll/template', form).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payslip-template'] }); setSaved(true); setTimeout(() => setSaved(false), 2000); },
    onError: (err: any) => setError(err?.response?.data?.error || 'Could not save template.'),
  });

  if (isLoading || !data) return <div className="card p-5"><Spinner /></div>;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5"><Palette size={14} /> Payslip Template</p>
        <Button size="sm" onClick={() => { setError(''); save.mutate(); }} loading={save.isPending}>{saved ? 'Saved!' : 'Save'}</Button>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">This letterhead is applied to every employee's downloadable payslip.</p>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          {error && <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/30 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className="form-label">Company name</label>
            <input className="ui-input" value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} placeholder="Defaults to your org name" />
          </div>
          <div>
            <label className="form-label">Company address</label>
            <textarea className="ui-input" rows={2} value={form.companyAddress} onChange={e => setForm(f => ({ ...f, companyAddress: e.target.value }))} placeholder="123 Main St, Springfield" />
          </div>
          <div>
            <label className="form-label">Logo URL</label>
            <input className="ui-input" value={form.logoUrl} onChange={e => setForm(f => ({ ...f, logoUrl: e.target.value }))} placeholder="https://..." />
          </div>
          <div>
            <label className="form-label">Accent color</label>
            <div className="flex items-center gap-2">
              <input type="color" value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} className="w-9 h-9 rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer" />
              <input className="ui-input" value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="form-label">Footer note</label>
            <textarea className="ui-input" rows={2} value={form.footerNote} onChange={e => setForm(f => ({ ...f, footerNote: e.target.value }))} placeholder="This is a system-generated payslip and does not require a signature." />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={form.showSignature} onChange={e => setForm(f => ({ ...f, showSignature: e.target.checked }))} />
            Show a signature line
          </label>
          {form.showSignature && (
            <div>
              <label className="form-label">Signature label</label>
              <input className="ui-input" value={form.signatureLabel} onChange={e => setForm(f => ({ ...f, signatureLabel: e.target.value }))} placeholder="Authorized Signatory" />
            </div>
          )}
        </div>

        <div>
          <p className="form-label mb-2">Preview</p>
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-white dark:bg-gray-900">
            <div className="flex items-center gap-2 pb-3 mb-3 border-b" style={{ borderColor: form.primaryColor }}>
              {form.logoUrl && <img src={form.logoUrl} alt="" className="w-8 h-8 rounded object-contain" onError={e => (e.currentTarget.style.display = 'none')} />}
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{form.companyName || 'Your Company'}</p>
                {form.companyAddress && <p className="text-[11px] text-gray-400 whitespace-pre-line">{form.companyAddress}</p>}
              </div>
            </div>
            <p className="text-xs font-semibold" style={{ color: form.primaryColor }}>PAYSLIP — August 2026</p>
            <p className="text-[11px] text-gray-400 mt-1">Jane Doe · PAY-2026-08-0001</p>
            {form.showSignature && <p className="text-[11px] text-gray-400 mt-4 pt-2 border-t border-dashed border-gray-200 dark:border-gray-700">{form.signatureLabel}</p>}
            {form.footerNote && <p className="text-[10px] text-gray-300 dark:text-gray-600 mt-2">{form.footerNote}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PayrollPage() {
  const { user } = useAuth();
  const isManager = MANAGER_ROLES.includes(user?.role || '');
  const [tab, setTab] = useState<'me' | 'structures' | 'runs' | 'template'>('me');

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">
      <PageHeader title="Payroll" subtitle="Salary structures, payroll runs, and payslips" />

      {isManager && (
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl w-fit flex-wrap">
          {(['me', 'structures', 'runs', 'template'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-[13px] font-semibold rounded-lg transition-all ${tab === t ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              {t === 'me' ? 'My Payslips' : t === 'structures' ? 'Salary Structures' : t === 'runs' ? 'Payroll Runs' : 'Template'}
            </button>
          ))}
        </div>
      )}

      {tab === 'me' && <MyPayslips />}
      {tab === 'structures' && isManager && <SalaryStructuresSection />}
      {tab === 'runs' && isManager && <PayrollRunsSection />}
      {tab === 'template' && isManager && <PayslipTemplateSection />}
    </div>
  );
}
