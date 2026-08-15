import { useState } from 'react';
import {
  usePeople,
  usePeopleStats,
  useCreatePerson,
  useGrantLogin,
  useRevokeLogin,
  useAssignPersonRole,
  useRepairUnlinked,
  useDepartments,
  useLocations,
  useEmployees,
  type Person,
} from '../../api/people';
import { useRoles } from '../../api/work';
import { PageHeader, Button, Modal, Badge, Spinner, EmptyState, SearchInput, RowActions } from '../../shared/components';
import { UserSquare2, Plus, KeyRound, ShieldOff, Copy, Check, Link2, Building2, Mail } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';
import { useAuth } from '../../contexts/AuthContext';

/**
 * People — one screen for everyone in the organization.
 *
 * Replaces the old split between Administration → Users and HR → Employees.
 * Underneath, User and Employee are still separate tables (a login costs a
 * metered seat, and bank/tax data has no business on an auth record), but that
 * is an implementation detail an admin should never have to hold in their head.
 * Here a person simply either can sign in or cannot.
 */

const STATUS_VARIANT: Record<string, any> = {
  ACTIVE: 'green',
  PROBATION: 'yellow',
  ON_LEAVE: 'blue',
  NOTICE_PERIOD: 'orange',
  SUSPENDED: 'red',
  EXITED: 'gray',
};

const field =
  'w-full px-3 py-2 text-[13px] border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white';

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">
      {children} {required && <span className="text-red-500">*</span>}
    </label>
  );
}

function InviteLinkBox({ link, onDone }: { link: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-4">
      <p className="text-[13px] font-medium text-emerald-900 dark:text-emerald-200 mb-1">Invite created</p>
      <p className="text-[12px] text-emerald-800/80 dark:text-emerald-300/80 mb-3">
        We emailed it too, but sending can fail quietly — copy the link so you have it either way.
      </p>
      <div className="flex items-center gap-2">
        <input readOnly value={link} className={`${field} font-mono text-[11.5px]`} />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            navigator.clipboard?.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </Button>
      </div>
      <div className="flex justify-end mt-3">
        <Button size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

// ─── Add person ───────────────────────────────────────────────────────────────

function AddPersonModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreatePerson();
  const { data: departments } = useDepartments();
  const { data: locations } = useLocations();
  const { data: managers } = useEmployees({ limit: '200' });
  const { data: roles } = useRoles();

  const [error, setError] = useState('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    designation: '',
    departmentId: '',
    locationId: '',
    managerId: '',
    phone: '',
    joiningDate: new Date().toISOString().slice(0, 10),
    employmentType: 'FULL_TIME',
    loginMode: 'invite' as 'none' | 'password' | 'invite',
    email: '',
    password: '',
    roleId: '',
  });

  const needsEmail = form.loginMode !== 'none';

  const reset = () => {
    setForm({
      firstName: '', lastName: '', designation: '', departmentId: '', locationId: '', managerId: '',
      phone: '', joiningDate: new Date().toISOString().slice(0, 10), employmentType: 'FULL_TIME',
      loginMode: 'invite', email: '', password: '', roleId: '',
    });
    setInviteLink(null);
    setError('');
  };

  const submit = () => {
    setError('');
    create.mutate(
      {
        ...form,
        departmentId: form.departmentId || null,
        locationId: form.locationId || null,
        managerId: form.managerId || null,
        email: needsEmail ? form.email : undefined,
        password: form.loginMode === 'password' ? form.password : undefined,
        roleId: needsEmail ? form.roleId || undefined : undefined,
      },
      {
        onSuccess: res => {
          if (res.inviteLink) setInviteLink(res.inviteLink);
          else {
            reset();
            onClose();
          }
        },
        onError: (err: any) => setError(err?.response?.data?.error || 'Could not add that person.'),
      }
    );
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add a person"
      subtitle="Everyone who works here — whether or not they need to sign in."
      icon={<UserSquare2 size={16} />}
      size="lg"
      footer={
        inviteLink ? undefined : (
          <>
            <Button variant="secondary" onClick={() => { reset(); onClose(); }}>Cancel</Button>
            <Button
              onClick={submit}
              loading={create.isPending}
              disabled={!form.firstName.trim() || !form.joiningDate || (needsEmail && !form.email.trim())}
            >
              Add person
            </Button>
          </>
        )
      }
    >
      {inviteLink ? (
        <InviteLinkBox link={inviteLink} onDone={() => { reset(); onClose(); }} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label required>First name</Label>
              <input className={field} value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} />
            </div>
            <div>
              <Label>Last name</Label>
              <input className={field} value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} />
            </div>
            <div>
              <Label>Designation</Label>
              <input className={field} value={form.designation} onChange={e => setForm({ ...form, designation: e.target.value })} placeholder="e.g. Account Executive" />
            </div>
            <div>
              <Label required>Joining date</Label>
              <input type="date" className={field} value={form.joiningDate} onChange={e => setForm({ ...form, joiningDate: e.target.value })} />
            </div>
            <div>
              <Label>Department</Label>
              <select className={field} value={form.departmentId} onChange={e => setForm({ ...form, departmentId: e.target.value })}>
                <option value="">—</option>
                {(departments?.data ?? []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <Label>Location</Label>
              <select className={field} value={form.locationId} onChange={e => setForm({ ...form, locationId: e.target.value })}>
                <option value="">—</option>
                {(locations?.data ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <Label>Reports to</Label>
              <select className={field} value={form.managerId} onChange={e => setForm({ ...form, managerId: e.target.value })}>
                <option value="">—</option>
                {(managers?.data ?? []).map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
            </div>
            <div>
              <Label>Employment type</Label>
              <select className={field} value={form.employmentType} onChange={e => setForm({ ...form, employmentType: e.target.value })}>
                {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT', 'TEMPORARY'].map(t => (
                  <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
          </div>

          {/* ── Access ── */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
            <Label>System access</Label>
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden w-fit mb-3">
              {([
                { key: 'invite', label: 'Send an invite' },
                { key: 'password', label: 'Set a password' },
                { key: 'none', label: 'No login' },
              ] as const).map(o => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setForm({ ...form, loginMode: o.key })}
                  className={`px-3 py-1.5 text-[12.5px] font-medium ${
                    form.loginMode === o.key
                      ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                      : 'text-gray-600 dark:text-gray-300'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {form.loginMode === 'none' ? (
              <p className="text-[12px] text-gray-500 dark:text-gray-400">
                They'll appear in the directory and org chart, can be assigned tasks and hold assets — but cannot sign
                in, and don't use a licensed seat. You can grant access later at any time.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label required>Work email</Label>
                  <input className={field} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" />
                </div>
                <div>
                  <Label>Role</Label>
                  <select className={field} value={form.roleId} onChange={e => setForm({ ...form, roleId: e.target.value })}>
                    <option value="">Employee (self-service only)</option>
                    {(roles?.data ?? []).filter(r => r.isActive).map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
                {form.loginMode === 'password' && (
                  <div className="col-span-2">
                    <Label required>Password</Label>
                    <input type="password" className={field} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="At least 8 characters" />
                  </div>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

// ─── Grant login to an existing person ────────────────────────────────────────

function GrantLoginModal({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const grant = useGrantLogin();
  const { data: roles } = useRoles();
  const [error, setError] = useState('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', roleId: '', mode: 'invite' as 'password' | 'invite', password: '' });

  if (!person) return null;

  return (
    <Modal
      open={!!person}
      onClose={() => { setInviteLink(null); onClose(); }}
      title={`Give ${person.displayName} a login`}
      subtitle="They stay the same person — this only adds system access."
      icon={<KeyRound size={16} />}
      footer={
        inviteLink ? undefined : (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              loading={grant.isPending}
              disabled={!form.email.trim() || (form.mode === 'password' && form.password.length < 8)}
              onClick={() => {
                setError('');
                grant.mutate(
                  { id: person.employeeId!, ...form, roleId: form.roleId || undefined },
                  {
                    onSuccess: res => {
                      if (res.inviteLink) setInviteLink(res.inviteLink);
                      else onClose();
                    },
                    onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that login.'),
                  }
                );
              }}
            >
              {form.mode === 'invite' ? 'Send invite' : 'Create login'}
            </Button>
          </>
        )
      }
    >
      {inviteLink ? (
        <InviteLinkBox link={inviteLink} onDone={() => { setInviteLink(null); onClose(); }} />
      ) : (
        <div className="space-y-3">
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden w-fit">
            {(['invite', 'password'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setForm({ ...form, mode: m })}
                className={`px-3 py-1.5 text-[12.5px] font-medium ${
                  form.mode === m ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900' : 'text-gray-600 dark:text-gray-300'
                }`}
              >
                {m === 'invite' ? 'Send an invite' : 'Set a password'}
              </button>
            ))}
          </div>
          <div>
            <Label required>Work email</Label>
            <input className={field} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <Label>Role</Label>
            <select className={field} value={form.roleId} onChange={e => setForm({ ...form, roleId: e.target.value })}>
              <option value="">Employee (self-service only)</option>
              {(roles?.data ?? []).filter(r => r.isActive).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          {form.mode === 'password' && (
            <div>
              <Label required>Password</Label>
              <input type="password" className={field} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
            </div>
          )}
          {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: '', label: 'Everyone' },
  { key: 'yes', label: 'Can sign in' },
  { key: 'no', label: 'No login' },
] as const;

export default function PeoplePage() {
  const { user: currentUser } = useAuth();
  const fmt = useFormat();

  const [login, setLogin] = useState<'' | 'yes' | 'no'>('');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [granting, setGranting] = useState<Person | null>(null);
  const [error, setError] = useState('');

  const { data, isLoading } = usePeople({
    login: login || undefined,
    search: search || undefined,
    departmentId: departmentId || undefined,
  });
  const { data: stats } = usePeopleStats();
  const { data: departments } = useDepartments();
  const { data: roles } = useRoles();

  const revoke = useRevokeLogin();
  const assignRole = useAssignPersonRole();
  const repair = useRepairUnlinked();

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="People"
        subtitle="Everyone in the organization — staff who sign in, and staff who don't."
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus size={14} /> Add person
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total people', value: stats.total },
              { label: 'Can sign in', value: stats.canSignIn },
              { label: 'No login', value: stats.noLogin },
              { label: 'On notice', value: stats.onNotice },
            ].map(s => (
              <div key={s.label} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-3.5">
                <p className="text-xs text-gray-500 dark:text-gray-400">{s.label}</p>
                <p className="text-xl font-bold text-gray-900 dark:text-white mt-0.5">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Logins that never got an employee record — one click to repair. */}
        {!!stats?.unlinkedLogins && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-[13px] font-medium text-amber-900 dark:text-amber-200">
                {stats.unlinkedLogins} login{stats.unlinkedLogins === 1 ? '' : 's'} without a person record
              </p>
              <p className="text-[12px] text-amber-800/80 dark:text-amber-300/80 mt-0.5">
                They can sign in but are missing from the directory and org chart. Creating the records takes a second
                and needs no re-typing.
              </p>
            </div>
            <Button size="sm" variant="secondary" loading={repair.isPending} onClick={() => repair.mutate()}>
              <Link2 size={13} /> Fix {stats.unlinkedLogins}
            </Button>
          </div>
        )}

        {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setLogin(t.key)}
                className={`px-3 py-1.5 text-[12.5px] font-medium ${
                  login === t.key
                    ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                    : 'text-gray-600 dark:text-gray-300'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, email…" />
          <select className={`${field} w-auto`} value={departmentId} onChange={e => setDepartmentId(e.target.value)}>
            <option value="">All departments</option>
            {(departments?.data ?? []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        {isLoading ? (
          <Spinner />
        ) : !data?.data.length ? (
          <EmptyState
            icon={<UserSquare2 />}
            title="Nobody here yet"
            description="Add your first person — you can decide whether they need a login."
            action={{ label: 'Add person', onClick: () => setAddOpen(true) }}
          />
        ) : (
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            {data.data.map(p => (
              <div
                key={p.id}
                className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50/70 dark:hover:bg-gray-800/40 transition-colors"
              >
                <div className="w-9 h-9 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 flex items-center justify-center text-[12px] font-semibold shrink-0">
                  {p.displayName.slice(0, 2).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-gray-900 dark:text-white truncate">{p.displayName}</p>
                  <div className="flex items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500 flex-wrap">
                    {p.employeeCode && <span>{p.employeeCode}</span>}
                    {p.designation && <span>· {p.designation}</span>}
                    {p.department && (
                      <span className="inline-flex items-center gap-1">· <Building2 size={10} /> {p.department.name}</span>
                    )}
                    {p.email && (
                      <span className="inline-flex items-center gap-1">· <Mail size={10} /> {p.email}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {/* Access state, said plainly rather than in table terms. */}
                  {!p.hasLogin ? (
                    <Badge variant="gray">No login</Badge>
                  ) : !p.loginActive ? (
                    <Badge variant="red">Access revoked</Badge>
                  ) : p.employeeId ? (
                    <select
                      aria-label={`Role for ${p.displayName}`}
                      value={p.roleId ?? ''}
                      onChange={e => {
                        setError('');
                        assignRole.mutate(
                          { id: p.employeeId!, roleId: e.target.value },
                          { onError: (err: any) => setError(err?.response?.data?.error || 'Could not change that role.') }
                        );
                      }}
                      className="px-2 py-1 text-[11.5px] border border-gray-200 dark:border-gray-700 rounded-md bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 max-w-[150px]"
                    >
                      {!p.roleId && <option value="">{p.role?.replace(/_/g, ' ') ?? 'No role'}</option>}
                      {(roles?.data ?? []).filter(r => r.isActive).map(r => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  ) : (
                    <Badge variant="blue">{p.roleName ?? 'Login'}</Badge>
                  )}

                  {p.employmentStatus && (
                    <Badge variant={STATUS_VARIANT[p.employmentStatus] ?? 'gray'}>
                      {p.employmentStatus.replace(/_/g, ' ')}
                    </Badge>
                  )}

                  {!p.employeeId && <Badge variant="orange">Not in directory</Badge>}

                  <span className="text-[11px] text-gray-400 dark:text-gray-500 hidden lg:block w-20 text-right">
                    {p.joiningDate ? fmt.date(p.joiningDate) : ''}
                  </span>

                  <RowActions
                    items={[
                      ...(p.employeeId && !p.hasLogin
                        ? [{ label: 'Give a login', icon: <KeyRound size={13} />, onClick: () => setGranting(p) }]
                        : []),
                      ...(p.employeeId && p.hasLogin && p.userId !== currentUser?.id
                        ? [{
                            label: 'Revoke access',
                            icon: <ShieldOff size={13} />,
                            variant: 'danger' as const,
                            onClick: () => {
                              setError('');
                              revoke.mutate(p.employeeId!, {
                                onError: (err: any) =>
                                  setError(err?.response?.data?.error || 'Could not revoke access.'),
                              });
                            },
                          }]
                        : []),
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {!!data?.data.some(p => p.hasLogin) && (
          <p className="text-[11.5px] text-gray-400 dark:text-gray-500">
            Change a role from the selector on any row. Create and edit the roles themselves under{' '}
            <span className="font-medium">Administration → Roles &amp; Permissions</span>.
          </p>
        )}
      </div>

      <AddPersonModal open={addOpen} onClose={() => setAddOpen(false)} />
      <GrantLoginModal person={granting} onClose={() => setGranting(null)} />
    </div>
  );
}
