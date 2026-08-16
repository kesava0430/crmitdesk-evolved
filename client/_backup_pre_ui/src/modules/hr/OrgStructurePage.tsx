import { useState } from 'react';
import {
  useDepartmentTree,
  useDepartments,
  useCreateDepartment,
  useDeleteDepartment,
  useTeams,
  useCreateTeam,
  useDeleteTeam,
  useAddTeamMember,
  useRemoveTeamMember,
  useLocations,
  useCreateLocation,
  useDeleteLocation,
  useEmployees,
  type Department,
} from '../../api/people';
import { PageHeader, Button, Modal, Badge, Spinner, EmptyState } from '../../shared/components';
import { Building2, Plus, Users2, MapPin, Trash2, ChevronRight } from 'lucide-react';

/**
 * Org structure — departments, teams and locations.
 *
 * These three exist because `User.department: String?` could not answer
 * "who runs Sales?", "which department does this cost centre belong to?" or
 * "who is on the escalation team?". Team membership additionally feeds
 * TEAM-scoped permissions, so editing a team here changes what its members
 * can see.
 */

const field =
  'w-full px-3 py-2 text-[13px] border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white';

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">{children}</label>;
}

// ─── Departments ──────────────────────────────────────────────────────────────

function DepartmentNode({ dept, depth = 0 }: { dept: Department; depth?: number }) {
  const [open, setOpen] = useState(true);
  const del = useDeleteDepartment();
  const [error, setError] = useState('');
  const children = dept.children ?? [];

  return (
    <div className={depth > 0 ? 'ml-4 border-l border-gray-200 dark:border-gray-700 pl-4' : ''}>
      <div className="flex items-center gap-2 py-2 group">
        {children.length > 0 ? (
          <button onClick={() => setOpen(v => !v)} className="w-4 text-[10px] text-gray-400">
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <Building2 size={13} className="text-gray-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-gray-900 dark:text-white truncate">
            {dept.name}
            {dept.code && <span className="text-[11px] text-gray-400 ml-1.5">{dept.code}</span>}
          </p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            {dept._count?.employees ?? 0} people
            {dept.head ? ` · led by ${dept.head.displayName}` : ' · no head set'}
            {dept.costCenter ? ` · ${dept.costCenter}` : ''}
          </p>
        </div>
        {!dept.isActive && <Badge variant="gray">Inactive</Badge>}
        <button
          onClick={() => {
            setError('');
            del.mutate(dept.id, {
              onError: (err: any) => setError(err?.response?.data?.error || 'Could not delete.'),
            });
          }}
          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity"
          aria-label="Delete department"
        >
          <Trash2 size={13} />
        </button>
      </div>
      {error && <p className="text-[11.5px] text-red-600 dark:text-red-400 ml-10 mb-1">{error}</p>}
      {open && children.map(c => <DepartmentNode key={c.id} dept={c} depth={depth + 1} />)}
    </div>
  );
}

function DepartmentsPanel() {
  const { data, isLoading } = useDepartmentTree();
  const { data: flat } = useDepartments();
  const { data: employees } = useEmployees({ limit: '200' });
  const create = useCreateDepartment();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', code: '', parentId: '', headId: '', costCenter: '' });

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12.5px] text-gray-500 dark:text-gray-400">
          Departments nest, so you can model Sales → Inside Sales → SDR.
        </p>
        <Button size="xs" onClick={() => setOpen(true)}>
          <Plus size={12} /> Department
        </Button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <EmptyState
          icon={<Building2 />}
          title="No departments yet"
          description="Create your first department, or run the backfill to generate them from existing user records."
          action={{ label: 'Add department', onClick: () => setOpen(true) }}
        />
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-3">
          {data.data.map(d => (
            <DepartmentNode key={d.id} dept={d} />
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New department"
        icon={<Building2 size={16} />}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!form.name.trim()}
              onClick={() => {
                setError('');
                create.mutate(
                  {
                    name: form.name,
                    code: form.code || null,
                    parentId: form.parentId || null,
                    headId: form.headId || null,
                    costCenter: form.costCenter || null,
                  },
                  {
                    onSuccess: () => {
                      setForm({ name: '', code: '', parentId: '', headId: '', costCenter: '' });
                      setOpen(false);
                    },
                    onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that department.'),
                  }
                );
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <input className={field} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Code</Label>
              <input className={field} value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />
            </div>
            <div>
              <Label>Cost centre</Label>
              <input
                className={field}
                value={form.costCenter}
                onChange={e => setForm({ ...form, costCenter: e.target.value })}
              />
            </div>
          </div>
          <div>
            <Label>Parent department</Label>
            <select className={field} value={form.parentId} onChange={e => setForm({ ...form, parentId: e.target.value })}>
              <option value="">— top level —</option>
              {(flat?.data ?? []).map(d => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Head of department</Label>
            <select className={field} value={form.headId} onChange={e => setForm({ ...form, headId: e.target.value })}>
              <option value="">—</option>
              {(employees?.data ?? []).map(e => (
                <option key={e.id} value={e.id}>
                  {e.displayName}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">
              Used by approval policies with a "Department head" step.
            </p>
          </div>
          {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </Modal>
    </>
  );
}

// ─── Teams ────────────────────────────────────────────────────────────────────

function TeamsPanel() {
  const { data, isLoading } = useTeams();
  const { data: departments } = useDepartments();
  const { data: employees } = useEmployees({ limit: '200' });
  const create = useCreateTeam();
  const del = useDeleteTeam();
  const addMember = useAddTeamMember();
  const removeMember = useRemoveTeamMember();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', description: '', departmentId: '', leadId: '' });

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12.5px] text-gray-500 dark:text-gray-400">
          Team membership drives TEAM-scoped permissions — members can see each other's records where a role allows it.
        </p>
        <Button size="xs" onClick={() => setOpen(true)}>
          <Plus size={12} /> Team
        </Button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <EmptyState
          icon={<Users2 />}
          title="No teams yet"
          description="Teams group people across departments — useful for escalation rotas and shared queues."
          action={{ label: 'Create team', onClick: () => setOpen(true) }}
        />
      ) : (
        <div className="space-y-2">
          {data.data.map(t => (
            <div
              key={t.id}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden"
            >
              <div className="flex items-center gap-2 px-4 py-3">
                <button onClick={() => setExpanded(expanded === t.id ? null : t.id)} className="text-gray-400">
                  <ChevronRight size={14} className={expanded === t.id ? 'rotate-90 transition-transform' : 'transition-transform'} />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-gray-900 dark:text-white truncate">{t.name}</p>
                  <p className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t.members.length} member{t.members.length === 1 ? '' : 's'}
                    {t.department ? ` · ${t.department.name}` : ''}
                    {t.lead ? ` · led by ${t.lead.displayName}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => del.mutate(t.id)}
                  className="text-gray-300 hover:text-red-500"
                  aria-label="Delete team"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {expanded === t.id && (
                <div className="px-4 pb-3 border-t border-gray-100 dark:border-gray-800 pt-3">
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {t.members.map(m => (
                      <span
                        key={m.id}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[11.5px] rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                      >
                        {m.employee.displayName}
                        {m.role === 'LEAD' && <span className="text-[10px] text-indigo-500">lead</span>}
                        <button
                          onClick={() => removeMember.mutate({ teamId: t.id, employeeId: m.employee.id })}
                          className="text-gray-400 hover:text-red-500"
                          aria-label="Remove member"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {!t.members.length && <span className="text-[12px] text-gray-400">No members yet</span>}
                  </div>
                  <select
                    className={field}
                    value=""
                    onChange={e => {
                      if (e.target.value) addMember.mutate({ teamId: t.id, employeeId: e.target.value });
                    }}
                  >
                    <option value="">Add a member…</option>
                    {(employees?.data ?? [])
                      .filter(emp => !t.members.some(m => m.employee.id === emp.id))
                      .map(emp => (
                        <option key={emp.id} value={emp.id}>
                          {emp.displayName}
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New team"
        icon={<Users2 size={16} />}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!form.name.trim()}
              onClick={() => {
                setError('');
                create.mutate(
                  {
                    name: form.name,
                    description: form.description || undefined,
                    departmentId: form.departmentId || null,
                    leadId: form.leadId || null,
                  },
                  {
                    onSuccess: () => {
                      setForm({ name: '', description: '', departmentId: '', leadId: '' });
                      setOpen(false);
                    },
                    onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that team.'),
                  }
                );
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <input className={field} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>Description</Label>
            <input
              className={field}
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Department</Label>
              <select
                className={field}
                value={form.departmentId}
                onChange={e => setForm({ ...form, departmentId: e.target.value })}
              >
                <option value="">—</option>
                {(departments?.data ?? []).map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Team lead</Label>
              <select className={field} value={form.leadId} onChange={e => setForm({ ...form, leadId: e.target.value })}>
                <option value="">—</option>
                {(employees?.data ?? []).map(e => (
                  <option key={e.id} value={e.id}>
                    {e.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </Modal>
    </>
  );
}

// ─── Locations ────────────────────────────────────────────────────────────────

function LocationsPanel() {
  const { data, isLoading } = useLocations();
  const create = useCreateLocation();
  const del = useDeleteLocation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', code: '', type: 'BRANCH', city: '', country: '', timezone: '' });

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12.5px] text-gray-500 dark:text-gray-400">
          A location is the HR/asset concept. Attendance geo-fences stay where they are and can roll up to one.
        </p>
        <Button size="xs" onClick={() => setOpen(true)}>
          <Plus size={12} /> Location
        </Button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <EmptyState
          icon={<MapPin />}
          title="No locations yet"
          description="Add offices, plants and warehouses so employees and assets can be placed."
          action={{ label: 'Add location', onClick: () => setOpen(true) }}
        />
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {data.data.map(l => (
            <div
              key={l.id}
              className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0 group"
            >
              <MapPin size={14} className="text-gray-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-gray-900 dark:text-white truncate">{l.name}</p>
                <p className="text-[11px] text-gray-400 dark:text-gray-500">
                  {[l.city, l.country].filter(Boolean).join(', ') || 'No address'}
                  {` · ${l._count?.employees ?? 0} people`}
                  {l._count?.officeLocations ? ` · ${l._count.officeLocations} geo-fence(s)` : ''}
                </p>
              </div>
              <Badge variant="indigo">{l.type.replace(/_/g, ' ')}</Badge>
              <button
                onClick={() => del.mutate(l.id)}
                className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity"
                aria-label="Delete location"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New location"
        icon={<MapPin size={16} />}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!form.name.trim()}
              onClick={() => {
                setError('');
                create.mutate(
                  { ...form, code: form.code || null, city: form.city || null, country: form.country || null, timezone: form.timezone || null },
                  {
                    onSuccess: () => {
                      setForm({ name: '', code: '', type: 'BRANCH', city: '', country: '', timezone: '' });
                      setOpen(false);
                    },
                    onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that location.'),
                  }
                );
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Name</Label>
              <input className={field} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label>Type</Label>
              <select className={field} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                {['HEAD_OFFICE', 'BRANCH', 'PLANT', 'WAREHOUSE', 'CLIENT_SITE', 'REMOTE'].map(t => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>City</Label>
              <input className={field} value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} />
            </div>
            <div>
              <Label>Country</Label>
              <input className={field} value={form.country} onChange={e => setForm({ ...form, country: e.target.value })} />
            </div>
          </div>
          {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </Modal>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'departments', label: 'Departments', icon: Building2 },
  { key: 'teams', label: 'Teams', icon: Users2 },
  { key: 'locations', label: 'Locations', icon: MapPin },
] as const;

export default function OrgStructurePage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('departments');

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Org Structure"
        subtitle="Departments, teams and locations — the backbone the org chart, approvals and permission scopes are built on."
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden w-fit mb-4">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium ${
                tab === t.key
                  ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                  : 'text-gray-600 dark:text-gray-300'
              }`}
            >
              <t.icon size={12} /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'departments' && <DepartmentsPanel />}
        {tab === 'teams' && <TeamsPanel />}
        {tab === 'locations' && <LocationsPanel />}
      </div>
    </div>
  );
}
