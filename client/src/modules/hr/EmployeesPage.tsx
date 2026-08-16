import { useState } from 'react';
import {
  useEmployees,
  useEmployee,
  useEmployeeStats,
  useDepartments,
  useLocations,
  useCreateEmployee,
  useRecordExit,
  useOrgChart,
  type Employee,
  type OrgChartNode,
} from '../../api/people';
import {
  PageHeader, PageBody, Toolbar, Card, StatTile, Tabs, Button, IconButton, Modal, Badge, Spinner,
  EmptyState, SearchInput, Avatar, Field, Input, Select, Textarea, FormGrid, FormError,
} from '../../shared/components';
import { Users, Plus, Network, LogOut, Building2, Mail, Phone, Shield } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';

/**
 * Employee directory + org chart.
 *
 * Note the masked-field handling below: the API returns bank/tax columns
 * already masked ('••••••1234') or removed entirely, depending on the caller's
 * FieldPermission rules. The client never decides what to hide — it renders
 * whatever came back. That's deliberate: a client-side hide is a suggestion,
 * and the moment someone opens devtools it stops being one.
 */

const STATUS_VARIANT: Record<string, any> = {
  ACTIVE: 'green',
  PROBATION: 'yellow',
  ON_LEAVE: 'blue',
  NOTICE_PERIOD: 'orange',
  SUSPENDED: 'red',
  EXITED: 'gray',
};

// ─── Detail ───────────────────────────────────────────────────────────────────

function EmployeeDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: employee, isLoading } = useEmployee(id ?? undefined);
  const [exitOpen, setExitOpen] = useState(false);
  const fmt = useFormat();

  if (!id) return null;

  return (
    <>
      <Modal
        open={!!id && !exitOpen}
        onClose={onClose}
        title={employee?.displayName ?? 'Employee'}
        subtitle={employee?.employeeCode}
        icon={<Users size={16} />}
        size="xl"
        footer={
          employee && employee.employmentStatus !== 'EXITED' ? (
            <Button variant="secondary" icon={<LogOut size={13} />} onClick={() => setExitOpen(true)}>
              Record exit
            </Button>
          ) : undefined
        }
      >
        {isLoading && <Spinner />}
        {employee && (
          <div className="space-y-5">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={STATUS_VARIANT[employee.employmentStatus]}>
                {employee.employmentStatus.replace(/_/g, ' ')}
              </Badge>
              <Badge variant="gray">{employee.employmentType.replace(/_/g, ' ')}</Badge>
              <Badge variant="indigo">{employee.workMode}</Badge>
              {!employee.user && <Badge variant="orange">No login</Badge>}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-[12.5px]">
              {[
                ['Designation', employee.designation],
                ['Department', employee.department?.name],
                ['Location', employee.location?.name],
                ['Reports to', employee.manager?.displayName],
                ['Joined', employee.joiningDate ? fmt.date(employee.joiningDate) : null],
                ['Work email', employee.workEmail],
                ['Phone', employee.phone],
                ['Cost centre', employee.costCenter],
                ['Last working day', employee.lastWorkingDate ? fmt.date(employee.lastWorkingDate) : null],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <p className="text-fg-subtle">{label}</p>
                  <p className="text-fg truncate">{(value as string) || '—'}</p>
                </div>
              ))}
            </div>

            {/* Sensitive block. Absent fields mean the permission layer removed
                them; masked values mean it masked them. Both are correct to
                render as-is. */}
            {(employee.bankAccountNumber || employee.taxId || employee.nationalId) && (
              <Card tone="sunken" padding="sm" flat>
                <div className="flex items-center gap-1.5 mb-2">
                  <Shield size={12} className="text-fg-subtle" />
                  <p className="text-[12px] font-semibold text-fg-muted">Sensitive details</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[12.5px]">
                  {[
                    ['Bank', employee.bankName],
                    ['Account', employee.bankAccountNumber],
                    ['Tax ID', employee.taxId],
                    ['National ID', employee.nationalId],
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <p className="text-fg-subtle">{label}</p>
                      <p className="text-fg font-mono truncate">{(value as string) || '—'}</p>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-fg-subtle mt-2">
                  Values shown as •••• are masked by your role's field permissions.
                </p>
              </Card>
            )}

            {!!employee.reports?.length && (
              <div>
                <p className="text-[12px] font-semibold text-fg-muted mb-2">
                  Direct reports ({employee.reports.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {employee.reports.map(r => (
                    <Badge key={r.id} variant="blue">
                      {r.displayName}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {!!employee.skills?.length && (
              <div>
                <p className="text-[12px] font-semibold text-fg-muted mb-2">Skills</p>
                <div className="flex flex-wrap gap-1.5">
                  {employee.skills.map(s => (
                    <Badge key={s.id} variant="teal">
                      {s.skill.name} · L{s.level}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {!!employee.certifications?.length && (
              <div>
                <p className="text-[12px] font-semibold text-fg-muted mb-2">Certifications</p>
                <div className="space-y-1">
                  {employee.certifications.map(c => (
                    <div key={c.id} className="flex items-center gap-2 text-[12.5px]">
                      <span className="text-fg">{c.name}</span>
                      {c.expiresOn && (
                        <span className="text-[11px] text-fg-subtle">expires {fmt.date(c.expiresOn)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ExitModal employee={employee ?? null} open={exitOpen} onClose={() => setExitOpen(false)} />
    </>
  );
}

function ExitModal({ employee, open, onClose }: { employee: Employee | null; open: boolean; onClose: () => void }) {
  const recordExit = useRecordExit();
  const [form, setForm] = useState({ lastWorkingDate: '', exitType: 'RESIGNATION', exitReason: '' });
  const [error, setError] = useState('');
  if (!employee) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record exit — ${employee.displayName}`}
      icon={<LogOut size={16} />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={recordExit.isPending}
            disabled={!form.lastWorkingDate}
            onClick={() => {
              setError('');
              recordExit.mutate(
                { id: employee.id, ...form },
                {
                  onSuccess: onClose,
                  onError: (err: any) => setError(err?.response?.data?.error || 'Could not record that exit.'),
                }
              );
            }}
          >
            Record exit
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12.5px] text-fg-muted">
          This records the exit and sets the employment status. It does not revoke access, recover assets or reassign
          their open records — run the offboarding checklist for that.
        </p>
        <Field label="Last working day">
          <Input
            type="date"
            value={form.lastWorkingDate}
            onChange={e => setForm({ ...form, lastWorkingDate: e.target.value })}
          />
        </Field>
        <Field label="Exit type">
          <Select value={form.exitType} onChange={e => setForm({ ...form, exitType: e.target.value })}>
            {['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'END_OF_CONTRACT', 'ABSCONDED'].map(t => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason (optional)">
          <Textarea
            rows={2}
            value={form.exitReason}
            onChange={e => setForm({ ...form, exitReason: e.target.value })}
          />
        </Field>
        <FormError>{error}</FormError>
      </div>
    </Modal>
  );
}

// ─── Create ───────────────────────────────────────────────────────────────────

function NewEmployeeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateEmployee();
  const { data: departments } = useDepartments();
  const { data: locations } = useLocations();
  const { data: employees } = useEmployees({ limit: '200' });
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    workEmail: '',
    phone: '',
    designation: '',
    departmentId: '',
    locationId: '',
    managerId: '',
    employmentType: 'FULL_TIME',
    joiningDate: '',
  });

  const submit = () => {
    setError('');
    create.mutate(
      {
        ...form,
        departmentId: form.departmentId || null,
        locationId: form.locationId || null,
        managerId: form.managerId || null,
        workEmail: form.workEmail || null,
      } as any,
      {
        onSuccess: () => {
          setForm({
            firstName: '',
            lastName: '',
            workEmail: '',
            phone: '',
            designation: '',
            departmentId: '',
            locationId: '',
            managerId: '',
            employmentType: 'FULL_TIME',
            joiningDate: '',
          });
          onClose();
        },
        onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that employee.'),
      }
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add employee"
      subtitle="An employee record is separate from a login — you can add staff who never sign in."
      icon={<Users size={16} />}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={!form.firstName || !form.joiningDate}>
            Add employee
          </Button>
        </>
      }
    >
      <FormGrid cols={2}>
        <Field label="First name">
          <Input value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} />
        </Field>
        <Field label="Work email">
          <Input value={form.workEmail} onChange={e => setForm({ ...form, workEmail: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Designation">
          <Input value={form.designation} onChange={e => setForm({ ...form, designation: e.target.value })} />
        </Field>
        <Field label="Joining date">
          <Input
            type="date"
            value={form.joiningDate}
            onChange={e => setForm({ ...form, joiningDate: e.target.value })}
          />
        </Field>
        <Field label="Department">
          <Select value={form.departmentId} onChange={e => setForm({ ...form, departmentId: e.target.value })}>
            <option value="">—</option>
            {(departments?.data ?? []).map(d => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Location">
          <Select value={form.locationId} onChange={e => setForm({ ...form, locationId: e.target.value })}>
            <option value="">—</option>
            {(locations?.data ?? []).map(l => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reports to">
          <Select value={form.managerId} onChange={e => setForm({ ...form, managerId: e.target.value })}>
            <option value="">—</option>
            {(employees?.data ?? []).map(e2 => (
              <option key={e2.id} value={e2.id}>
                {e2.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Employment type">
          <Select value={form.employmentType} onChange={e => setForm({ ...form, employmentType: e.target.value })}>
            {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT', 'TEMPORARY'].map(t => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>
        {error && <FormError className="sm:col-span-2">{error}</FormError>}
      </FormGrid>
    </Modal>
  );
}

// ─── Org chart ────────────────────────────────────────────────────────────────

function ChartNode({ node, depth = 0 }: { node: OrgChartNode; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  return (
    <div className={depth > 0 ? 'ml-5 border-l border-line pl-4' : ''}>
      <div className="flex items-center gap-2 py-1.5">
        {node.reports.length > 0 ? (
          <IconButton
            size="xs"
            label={open ? 'Collapse reports' : 'Expand reports'}
            icon={<span className="text-[10px]">{open ? '▾' : '▸'}</span>}
            onClick={() => setOpen(v => !v)}
          />
        ) : (
          <span className="w-4" />
        )}
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-fg truncate">{node.displayName}</p>
          <p className="text-[11px] text-fg-subtle truncate">
            {node.designation || node.employeeCode}
            {node.department ? ` · ${node.department.name}` : ''}
            {node.reports.length ? ` · ${node.reports.length} report${node.reports.length > 1 ? 's' : ''}` : ''}
          </p>
        </div>
      </div>
      {open && node.reports.map(r => <ChartNode key={r.id} node={r} depth={depth + 1} />)}
    </div>
  );
}

function OrgChartPanel() {
  const { data, isLoading } = useOrgChart();
  if (isLoading) return <Spinner />;
  if (!data?.data.length) {
    return (
      <EmptyState
        icon={<Network />}
        title="No org chart yet"
        description="Set a reporting manager on employee records and the hierarchy will build itself here."
      />
    );
  }
  return (
    <Card padding="sm">
      <p className="text-[12px] text-fg-subtle mb-3">
        {data.total} people · employees with no manager set appear as roots
      </p>
      {data.data.map(n => (
        <ChartNode key={n.id} node={n} />
      ))}
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeesPage() {
  const [tab, setTab] = useState<'list' | 'chart'>('list');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, isLoading } = useEmployees({
    search: search || undefined,
    departmentId: departmentId || undefined,
    employmentStatus: status || undefined,
  });
  const { data: stats } = useEmployeeStats();
  const { data: departments } = useDepartments();
  const fmt = useFormat();

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Employees"
        subtitle="The people who work here — separate from logins, so staff without system access are still tracked."
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setNewOpen(true)}>
            Add employee
          </Button>
        }
      />

      <div className="flex-1 overflow-auto">
        <PageBody width="full">
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total', value: stats.total },
                { label: 'Joined (30d)', value: stats.recentJoiners },
                { label: 'On notice', value: stats.exiting },
                { label: 'Departments', value: stats.byDepartment.length },
              ].map(s => (
                <StatTile key={s.label} label={s.label} value={s.value} />
              ))}
            </div>
          )}

          <Toolbar>
            <Tabs<'list' | 'chart'>
              aria-label="Employee views"
              variant="segmented"
              value={tab}
              onChange={setTab}
              items={[
                { key: 'list', label: 'Directory' },
                { key: 'chart', label: 'Org chart' },
              ]}
            />

            {tab === 'list' && (
              <>
                <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, email…" />
                <Select
                  selectSize="sm"
                  aria-label="Filter by department"
                  className="w-auto"
                  value={departmentId}
                  onChange={e => setDepartmentId(e.target.value)}
                >
                  <option value="">All departments</option>
                  {(departments?.data ?? []).map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
                <Select
                  selectSize="sm"
                  aria-label="Filter by status"
                  className="w-auto"
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {['ACTIVE', 'PROBATION', 'ON_LEAVE', 'NOTICE_PERIOD', 'EXITED'].map(s => (
                    <option key={s} value={s}>
                      {s.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </Toolbar>

          {tab === 'chart' ? (
            <OrgChartPanel />
          ) : isLoading ? (
            <Spinner />
          ) : !data?.data.length ? (
            <EmptyState
              icon={<Users />}
              title="No employees yet"
              description="Add your first employee, or run the backfill script to create records from your existing users."
              action={{ label: 'Add employee', onClick: () => setNewOpen(true) }}
            />
          ) : (
            <Card padding="none" className="overflow-hidden">
              {data.data.map(e => (
                <button
                  key={e.id}
                  onClick={() => setDetailId(e.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 border-b border-line-subtle last:border-0 hover:bg-surface-hover text-left transition-colors"
                >
                  <Avatar name={e.displayName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium text-fg truncate">{e.displayName}</p>
                    <div className="flex items-center gap-2 text-[11px] text-fg-subtle flex-wrap">
                      <span>{e.employeeCode}</span>
                      {e.designation && <span>· {e.designation}</span>}
                      {e.department && (
                        <span className="inline-flex items-center gap-1">
                          · <Building2 size={10} /> {e.department.name}
                        </span>
                      )}
                      {e.workEmail && (
                        <span className="inline-flex items-center gap-1">
                          · <Mail size={10} /> {e.workEmail}
                        </span>
                      )}
                      {e.phone && (
                        <span className="inline-flex items-center gap-1">
                          · <Phone size={10} /> {e.phone}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!e.user && <Badge variant="orange">No login</Badge>}
                    <Badge variant={STATUS_VARIANT[e.employmentStatus]}>
                      {e.employmentStatus.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-[11px] text-fg-subtle hidden sm:block">
                      {fmt.date(e.joiningDate)}
                    </span>
                  </div>
                </button>
              ))}
            </Card>
          )}
        </PageBody>
      </div>

      <NewEmployeeModal open={newOpen} onClose={() => setNewOpen(false)} />
      <EmployeeDetail id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
