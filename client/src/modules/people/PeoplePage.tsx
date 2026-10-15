import { useState } from 'react';
import {
  usePeople,
  usePeopleStats,
  useGrantLogin,
  useRevokeLogin,
  useAssignPersonRole,
  useRepairUnlinked,
  useDepartments,
  type Person,
} from '../../api/people';
import { useRoles } from '../../api/work';
import {
  PageHeader, PageBody, Toolbar, Card, StatTile, Tabs, Button, Modal, Badge, StatusBadge, Avatar,
  Field, Input, Select, Alert, FormError, EmptyState, SearchInput, RowActions,
  SkeletonTable,
} from '../../shared/components';
import { UserSquare2, Plus, KeyRound, ShieldOff, Link2, Building2, Mail, Eye, Pencil } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';
import { useAuth } from '../../contexts/AuthContext';
import { can, inGroup, ADMIN } from '../../shared/permissions';
import { FaceApprovals } from './FaceApprovals';
import { AddPersonModal, EditPersonModal, InviteLinkBox } from './PersonForms';
import { PersonDetailModal, STATUS_VARIANT } from './PersonDetail';

/**
 * People — one screen for everyone in the organization.
 *
 * Replaces the old split between Administration → Users and HR → Employees.
 * Underneath, User and Employee are still separate tables (a login costs a
 * metered seat, and bank/tax data has no business on an auth record), but that
 * is an implementation detail an admin should never have to hold in their head.
 * Here a person simply either can sign in or cannot.
 *
 * Add and Edit are the shared forms in PersonForms.tsx — the same ones the
 * Org Chart, Org Structure and Logins & Invites screens open.
 */

// ─── Grant login to an existing person ────────────────────────────────────────

function GrantLoginModal({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const grant = useGrantLogin();
  // Mounted with `person === null` until someone picks a row, so gate the
  // MANAGERS-only role lookup rather than firing it on every page load.
  const { user } = useAuth();
  const { data: roles } = useRoles(can.readRoles(user?.role));
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
          <Tabs
            variant="segmented"
            aria-label="Login mode"
            value={form.mode}
            onChange={mode => setForm({ ...form, mode })}
            items={[
              { key: 'invite' as const, label: 'Send an invite' },
              { key: 'password' as const, label: 'Set a password' },
            ]}
          />
          <Field label="Work email" required>
            <Input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Role">
            <Select value={form.roleId} onChange={e => setForm({ ...form, roleId: e.target.value })}>
              <option value="">Employee (self-service only)</option>
              {(roles?.data ?? []).filter(r => r.isActive).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </Select>
          </Field>
          {form.mode === 'password' && (
            <Field label="Password" required>
              <Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
            </Field>
          )}
          <FormError>{error}</FormError>
        </div>
      )}
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/* The first three filter the people list; 'face' is a different view
   entirely (the Face ID re-enrolment queue) and is only offered to Super
   Admins, who are the only role the review endpoints accept. */
const TABS = [
  { key: '', label: 'Everyone' },
  { key: 'yes', label: 'Can sign in' },
  { key: 'no', label: 'No login' },
  { key: 'face', label: 'Face Approvals' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function PeoplePage() {
  const { user: currentUser } = useAuth();
  const fmt = useFormat();

  const [tab, setTab] = useState<TabKey>('');
  const login = tab === 'face' ? '' : tab;
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [granting, setGranting] = useState<Person | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const { data, isLoading } = usePeople({
    login: login || undefined,
    search: search || undefined,
    departmentId: departmentId || undefined,
  });
  const { data: stats } = usePeopleStats();
  /* Add / Edit visibility comes from the server's permission engine (an HR
     Manager custom role can add people even though its enum is EMPLOYEE). */
  const access = data?.access ?? stats?.access;
  const { data: departments } = useDepartments();
  /* The role list drives the per-row role selector, and both it and the
     assignment endpoint behind that selector are MANAGERS-only. For everyone
     else the row shows the person's role as plain text instead. */
  const canReadRoles = can.readRoles(currentUser?.role);
  const canManagePeople = can.managePeople(currentUser?.role);
  /* Face ID re-enrolments are decided by Super Admins only — not MANAGERS,
     which is where most of this page's gating sits. */
  const isSuperAdmin = inGroup(currentUser?.role, ADMIN);
  const { data: roles } = useRoles(canReadRoles);

  const revoke = useRevokeLogin();
  const assignRole = useAssignPersonRole();
  const repair = useRepairUnlinked();

  const rowActions = (p: Person) => (
    <RowActions
      triggerLabel={`Actions for ${p.displayName}`}
      items={[
        ...(p.employeeId
          ? [{ label: 'View profile', icon: <Eye size={13} />, onClick: () => setDetailId(p.employeeId) }]
          : []),
        ...(p.employeeId && access?.canEdit
          ? [{ label: 'Edit details', icon: <Pencil size={13} />, onClick: () => setEditId(p.employeeId) }]
          : []),
        ...(p.employeeId && !p.hasLogin && canManagePeople
          ? [{ label: 'Give a login', icon: <KeyRound size={13} />, onClick: () => setGranting(p) }]
          : []),
        ...(p.employeeId && p.hasLogin && p.loginActive && p.userId !== currentUser?.id && canManagePeople
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
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="People"
        subtitle="Everyone in the organization — staff who sign in, and staff who don't."
        actions={
          access?.canCreate ? (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
              Add person
            </Button>
          ) : undefined
        }
      />

      <div className="flex-1 overflow-auto">
        <PageBody>
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total people', value: stats.total },
                { label: 'Can sign in', value: stats.canSignIn },
                { label: 'No login', value: stats.noLogin },
                { label: 'On notice', value: stats.onNotice },
              ].map(s => (
                <StatTile key={s.label} label={s.label} value={s.value} />
              ))}
            </div>
          )}

          {/* Logins that never got an employee record — one click to repair. */}
          {!!stats?.unlinkedLogins && (
            <Alert
              tone="warning"
              title={`${stats.unlinkedLogins} login${stats.unlinkedLogins === 1 ? '' : 's'} without a person record`}
              actions={
                <Button size="sm" variant="secondary" icon={<Link2 size={13} />} loading={repair.isPending} onClick={() => repair.mutate()}>
                  Fix {stats.unlinkedLogins}
                </Button>
              }
            >
              They can sign in but are missing from the directory and org chart. Creating the records takes a second
              and needs no re-typing.
            </Alert>
          )}

          <FormError>{error}</FormError>

          <Toolbar>
            <Tabs
              variant="segmented"
              aria-label="Filter by login"
              value={tab}
              onChange={setTab}
              items={TABS.filter(t => t.key !== 'face' || isSuperAdmin).map(t => ({ key: t.key, label: t.label }))}
            />
            {/* Search and department filter belong to the people list; the
                approvals queue has its own status filter. */}
            {tab !== 'face' && (
              <>
                <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, email…" />
                <Select
                  className="w-auto"
                  aria-label="Filter by department"
                  value={departmentId}
                  onChange={e => setDepartmentId(e.target.value)}
                >
                  <option value="">All departments</option>
                  {(departments?.data ?? []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </>
            )}
          </Toolbar>

          {tab === 'face' && isSuperAdmin ? (
            <FaceApprovals />
          ) : isLoading ? (
            <SkeletonTable rows={6} />
          ) : !data?.data.length ? (
            <EmptyState
              icon={<UserSquare2 />}
              title="Nobody here yet"
              description="Add your first person — you can decide whether they need a login."
              action={access?.canCreate ? { label: 'Add person', onClick: () => setAddOpen(true) } : undefined}
            />
          ) : (
            <Card padding="none" className="overflow-hidden">
              {data.data.map(p => (
                <div
                  key={p.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3 border-b border-line-subtle last:border-0 hover:bg-surface-hover transition-colors"
                >
                  {/* Phones: avatar + name + code on top, role/status/actions
                      on their own row below so the name keeps the full width. */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                  <Avatar name={p.displayName} size="md" />

                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                    disabled={!p.employeeId}
                    onClick={() => p.employeeId && setDetailId(p.employeeId)}
                  >
                    <p className="text-[13.5px] font-medium text-fg truncate" title={p.displayName}>{p.displayName}</p>
                    <div className="flex items-center gap-2 text-[11px] text-fg-subtle flex-wrap">
                      {p.employeeCode && <span>{p.employeeCode}</span>}
                      {p.designation && <span>· {p.designation}</span>}
                      {p.department && (
                        <span className="inline-flex items-center gap-1">· <Building2 size={10} /> {p.department.name}</span>
                      )}
                      {p.email && (
                        <span className="inline-flex items-center gap-1 min-w-0 break-all">· <Mail size={10} /> {p.email}</span>
                      )}
                    </div>
                  </button>
                  <div className="sm:hidden">{rowActions(p)}</div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap sm:shrink-0 pl-[52px] sm:pl-0">
                    {/* Access state, said plainly rather than in table terms. */}
                    {!p.hasLogin ? (
                      <Badge variant="gray">No login</Badge>
                    ) : !p.loginActive ? (
                      <Badge variant="red">Access revoked</Badge>
                    ) : p.employeeId && canManagePeople ? (
                      <Select
                        selectSize="sm"
                        className="min-w-0 max-w-[150px]"
                        aria-label={`Role for ${p.displayName}`}
                        value={p.roleId ?? ''}
                        onChange={e => {
                          setError('');
                          assignRole.mutate(
                            { id: p.employeeId!, roleId: e.target.value },
                            { onError: (err: any) => setError(err?.response?.data?.error || 'Could not change that role.') }
                          );
                        }}
                      >
                        {!p.roleId && <option value="">{p.role?.replace(/_/g, ' ') ?? 'No role'}</option>}
                        {(roles?.data ?? []).filter(r => r.isActive).map(r => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </Select>
                    ) : (
                      <Badge variant="blue">{p.roleName ?? 'Login'}</Badge>
                    )}

                    {p.employmentStatus && (
                      <StatusBadge value={p.employmentStatus} map={STATUS_VARIANT} dot />
                    )}

                    {!p.employeeId && <Badge variant="orange">Not in directory</Badge>}

                    <span className="text-[11px] text-fg-subtle tabular-nums hidden lg:block w-20 text-right">
                      {p.joiningDate ? fmt.date(p.joiningDate) : ''}
                    </span>

                    <div className="hidden sm:block">{rowActions(p)}</div>
                  </div>
                </div>
              ))}
            </Card>
          )}

          {canManagePeople && tab !== 'face' && !!data?.data.some(p => p.hasLogin) && (
            <p className="text-[11.5px] text-fg-subtle">
              Change a role from the selector on any row. Create and edit the roles themselves under{' '}
              <span className="font-medium">Administration → Roles &amp; Permissions</span>.
            </p>
          )}
        </PageBody>
      </div>

      <AddPersonModal open={addOpen} onClose={() => setAddOpen(false)} />
      <PersonDetailModal id={detailId} onClose={() => setDetailId(null)} />
      <EditPersonModal personId={editId} onClose={() => setEditId(null)} />
      <GrantLoginModal person={granting} onClose={() => setGranting(null)} />
    </div>
  );
}
