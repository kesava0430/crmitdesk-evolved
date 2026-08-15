import { useState, useMemo } from 'react';
import {
  useRoles,
  usePermissionCatalog,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
  useSetFieldPermission,
  useDeleteFieldPermission,
  type Role,
  type PermScope,
  type FieldAccess,
} from '../api/work';
import { PageHeader, Button, Modal, Badge, Spinner, EmptyState } from '../shared/components';
import { Shield, Plus, Trash2, Lock, Eye, EyeOff, Pencil } from 'lucide-react';

/**
 * Roles & permissions (§61, §66, §119).
 *
 * The mental model this screen has to teach in about five seconds:
 *
 *   - A **permission** is a verb on a resource ("read deals").
 *   - A **scope** answers *whose* records: none / own / team / department / all.
 *   - A **field rule** answers *which columns* — and is the only thing that
 *     stops a role that can read employees from also reading their salary.
 *
 * Scope is the part that didn't exist before: previously "can read deals"
 * always meant "can read every deal in the org".
 */

const SCOPES: PermScope[] = ['NONE', 'OWN', 'TEAM', 'DEPARTMENT', 'ALL'];

const SCOPE_HELP: Record<PermScope, string> = {
  NONE: 'No access at all',
  OWN: 'Only records they own or are assigned',
  TEAM: 'Their own, their team’s and their direct reports’',
  DEPARTMENT: 'Everything in their department',
  ALL: 'Every record in the organization',
};

const SCOPE_VARIANT: Record<PermScope, any> = {
  NONE: 'gray',
  OWN: 'blue',
  TEAM: 'teal',
  DEPARTMENT: 'indigo',
  ALL: 'orange',
};

const ACCESS_VARIANT: Record<FieldAccess, any> = {
  HIDDEN: 'red',
  MASKED: 'orange',
  READ: 'blue',
  WRITE: 'green',
};

const field =
  'w-full px-3 py-2 text-[13px] border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white';

// ─── Role editor ──────────────────────────────────────────────────────────────

function RoleEditor({ role, onClose }: { role: Role | null; onClose: () => void }) {
  const { data: catalog } = usePermissionCatalog();
  const update = useUpdateRole();
  const setFieldPerm = useSetFieldPermission();
  const delFieldPerm = useDeleteFieldPermission();
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Record<string, PermScope>>({});
  const [newField, setNewField] = useState({ resource: 'employee', field: '', access: 'MASKED' as FieldAccess });

  const current = useMemo(() => {
    const map: Record<string, PermScope> = {};
    for (const p of role?.permissions ?? []) map[p.permissionKey] = p.scope;
    return { ...map, ...draft };
  }, [role, draft]);

  if (!role) return null;

  const save = () => {
    setError('');
    const permissions = Object.entries(current).map(([permissionKey, scope]) => ({ permissionKey, scope }));
    update.mutate(
      { id: role.id, permissions },
      {
        onSuccess: () => {
          setDraft({});
          onClose();
        },
        onError: (err: any) => setError(err?.response?.data?.error || 'Could not save those permissions.'),
      }
    );
  };

  return (
    <Modal
      open={!!role}
      onClose={onClose}
      title={`${role.name} permissions`}
      subtitle={
        role.orgId === null
          ? 'This is a built-in template — saving creates a copy for your organization.'
          : `${role._count?.users ?? 0} user(s) have this role`
      }
      icon={<Shield size={16} />}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={update.isPending}>
            Save permissions
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2 text-[11.5px]">
          {SCOPES.map(s => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <Badge variant={SCOPE_VARIANT[s]}>{s}</Badge>
              <span className="text-gray-400 dark:text-gray-500">{SCOPE_HELP[s]}</span>
            </span>
          ))}
        </div>

        {Object.entries(catalog?.data ?? {}).map(([module, perms]) => (
          <div key={module}>
            <p className="text-[12px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              {module}
            </p>
            <div className="space-y-1">
              {perms.map(p => (
                <div key={p.key} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-gray-800 dark:text-gray-200 truncate">
                      {p.label}
                      {p.isSensitive && <Lock size={10} className="inline ml-1 text-amber-500" />}
                    </p>
                    <p className="text-[10.5px] text-gray-400 font-mono">{p.key}</p>
                  </div>
                  <select
                    value={current[p.key] ?? 'NONE'}
                    onChange={e => setDraft(d => ({ ...d, [p.key]: e.target.value as PermScope }))}
                    className="px-2 py-1 text-[11.5px] border border-gray-200 dark:border-gray-700 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                  >
                    {SCOPES.map(s => (
                      <option key={s} value={s} disabled={!p.scopable && s !== 'NONE' && s !== 'ALL'}>
                        {s}
                        {!p.scopable && s !== 'NONE' && s !== 'ALL' ? ' (n/a)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Field rules */}
        <div>
          <p className="text-[12px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Field visibility
          </p>
          <p className="text-[11.5px] text-gray-400 dark:text-gray-500 mb-2">
            Applies everywhere — API responses, search, exports and anything sent to AI. A field with no rule is fully
            visible.
          </p>

          <div className="space-y-1 mb-3">
            {(role.fieldPermissions ?? []).map(fp => (
              <div key={fp.id} className="flex items-center gap-2 text-[12.5px]">
                <span className="font-mono text-gray-600 dark:text-gray-300">
                  {fp.resource}.{fp.field}
                </span>
                <Badge variant={ACCESS_VARIANT[fp.access]}>{fp.access}</Badge>
                <button
                  onClick={() => delFieldPerm.mutate({ roleId: role.id, fieldPermissionId: fp.id })}
                  className="text-gray-300 hover:text-red-500"
                  aria-label="Remove field rule"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {!role.fieldPermissions?.length && (
              <p className="text-[12px] text-gray-400">No field rules — every field this role can read is visible in full.</p>
            )}
          </div>

          <div className="grid grid-cols-4 gap-2">
            <input
              className={field}
              placeholder="resource"
              value={newField.resource}
              onChange={e => setNewField({ ...newField, resource: e.target.value })}
            />
            <input
              className={field}
              placeholder="field"
              value={newField.field}
              onChange={e => setNewField({ ...newField, field: e.target.value })}
            />
            <select
              className={field}
              value={newField.access}
              onChange={e => setNewField({ ...newField, access: e.target.value as FieldAccess })}
            >
              {(['HIDDEN', 'MASKED', 'READ', 'WRITE'] as FieldAccess[]).map(a => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!newField.field.trim()}
              loading={setFieldPerm.isPending}
              onClick={() => {
                setError('');
                setFieldPerm.mutate(
                  { roleId: role.id, ...newField },
                  {
                    onSuccess: () => setNewField({ ...newField, field: '' }),
                    onError: (err: any) => setError(err?.response?.data?.error || 'Could not set that field rule.'),
                  }
                );
              }}
            >
              Add rule
            </Button>
          </div>
        </div>

        {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * Seniority tiers, so "rank" is a choice rather than a number to guess at.
 *
 * Rank exists for one job: stopping privilege escalation. An admin cannot
 * create or edit a role more senior than their own, and cannot grant a
 * permission they do not hold themselves. Lower number = more senior.
 */
const RANK_TIERS = [
  { value: 10, label: 'Executive', hint: 'Cross-company visibility, usually read-only' },
  { value: 20, label: 'Department head', hint: 'Runs a function — sales, IT, HR, finance' },
  { value: 30, label: 'Team lead', hint: 'Owns a team and approves for it' },
  { value: 50, label: 'Individual contributor', hint: 'Works their own records' },
  { value: 90, label: 'Self-service only', hint: 'Own payslips, leave and requests' },
];

function NewRoleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateRole();
  const { data: roles } = useRoles();
  const [error, setError] = useState('');
  const [form, setForm] = useState({ key: '', name: '', description: '', rank: 50 });
  // Which existing role to copy permissions from. A role created with nothing
  // granted is useless, and setting ~130 permissions by hand to get to a
  // working starting point is not a reasonable ask — so copying is the
  // default path and "blank" is the deliberate exception.
  const [copyFromId, setCopyFromId] = useState('');

  const copyFrom = roles?.data.find(r => r.id === copyFromId);
  const copiedCount = copyFrom?.permissions.filter(p => p.scope !== 'NONE').length ?? 0;

  const reset = () => {
    setForm({ key: '', name: '', description: '', rank: 50 });
    setCopyFromId('');
  };

  const submit = () => {
    setError('');
    create.mutate(
      {
        ...form,
        description: form.description || undefined,
        // Copy only real grants; a NONE row is the same as no row.
        permissions: copyFrom?.permissions.filter(p => p.scope !== 'NONE'),
      },
      {
        onSuccess: () => {
          reset();
          onClose();
        },
        onError: (err: any) => setError(err?.response?.data?.error || 'Could not create that role.'),
      }
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New role"
      subtitle="A role is a set of permissions, each with a scope deciding whose records it covers."
      icon={<Shield size={16} />}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!form.key.trim() || !form.name.trim()} onClick={submit}>
            Create role
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">
            Display name <span className="text-red-500">*</span>
          </label>
          <input
            className={field}
            value={form.name}
            onChange={e =>
              setForm({
                ...form,
                name: e.target.value,
                // Only auto-fill the key while the admin hasn't typed their own.
                key: form.key || e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
              })
            }
            placeholder="e.g. Regional Sales Head"
          />
          <p className="text-[11px] text-gray-400 mt-1">What people see in the role picker.</p>
        </div>

        <div>
          <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">
            Key <span className="text-red-500">*</span>
          </label>
          <input
            className={`${field} font-mono`}
            value={form.key}
            onChange={e => setForm({ ...form, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
            placeholder="REGIONAL_SALES_HEAD"
          />
          <p className="text-[11px] text-gray-400 mt-1">
            Uppercase, digits and underscores. Approval policies reference roles by this key, so it is worth getting
            right — renaming it later breaks any policy pointing at it.
          </p>
        </div>

        <div>
          <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">Description</label>
          <input
            className={field}
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="Who this role is for and what they are expected to do"
          />
          <p className="text-[11px] text-gray-400 mt-1">
            Optional, but the next admin deciding whether to use this role will thank you.
          </p>
        </div>

        <div>
          <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">Seniority</label>
          <select className={field} value={form.rank} onChange={e => setForm({ ...form, rank: Number(e.target.value) })}>
            {RANK_TIERS.map(t => (
              <option key={t.value} value={t.value}>
                {t.label} — {t.hint}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            Used only to prevent privilege escalation: nobody can create or edit a role more senior than their own.
          </p>
        </div>

        <div>
          <label className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1 block">Start from</label>
          <select className={field} value={copyFromId} onChange={e => setCopyFromId(e.target.value)}>
            <option value="">Blank — no permissions at all</option>
            {(roles?.data ?? []).map(r => (
              <option key={r.id} value={r.id}>
                Copy of {r.name} ({r.permissions.filter(p => p.scope !== 'NONE').length} permissions)
              </option>
            ))}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            {copyFrom
              ? `Copies ${copiedCount} permission(s) with their scopes. Edit them after creating — field rules are not copied.`
              : 'A blank role can sign in but see nothing. Pick the closest existing role and trim it down instead.'}
          </p>
        </div>

        {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}

export default function RolesPermissionsPage() {
  const { data, isLoading } = useRoles();
  const del = useDeleteRole();
  const [editing, setEditing] = useState<Role | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [error, setError] = useState('');

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Roles & Permissions"
        subtitle="Who can do what, whose records they can do it to, and which fields they can see."
        actions={
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus size={14} /> New role
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-6 space-y-3">
        <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900 rounded-xl p-3.5">
          <p className="text-[12.5px] text-blue-900 dark:text-blue-200">
            Built-in roles start with exactly the access they had before permissions became configurable, so nothing
            changed when this shipped. Narrowing a scope from <strong>ALL</strong> to <strong>TEAM</strong> takes effect
            within a minute — no deploy needed.
          </p>
        </div>

        {error && <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}

        {isLoading ? (
          <Spinner />
        ) : !data?.data.length ? (
          <EmptyState
            icon={<Shield />}
            title="No roles found"
            description="Run the permission seed to create the built-in roles."
          />
        ) : (
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            {data.data.map(r => {
              const granted = r.permissions.filter(p => p.scope !== 'NONE');
              const widest = granted.some(p => p.scope === 'ALL')
                ? 'ALL'
                : granted.some(p => p.scope === 'DEPARTMENT')
                  ? 'DEPARTMENT'
                  : granted.some(p => p.scope === 'TEAM')
                    ? 'TEAM'
                    : granted.length
                      ? 'OWN'
                      : 'NONE';
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0 group"
                >
                  <Shield size={15} className="text-gray-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[13.5px] font-medium text-gray-900 dark:text-white truncate">{r.name}</p>
                      {r.isSystem && <Badge variant="gray">Built-in</Badge>}
                      {r.orgId === null && <Badge variant="blue">Template</Badge>}
                    </div>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">
                      <span className="font-mono">{r.key}</span> · rank {r.rank} · {granted.length} permission
                      {granted.length === 1 ? '' : 's'}
                      {r.fieldPermissions?.length ? ` · ${r.fieldPermissions.length} field rule(s)` : ''}
                      {r._count?.users != null ? ` · ${r._count.users} user(s)` : ''}
                    </p>
                  </div>
                  <Badge variant={SCOPE_VARIANT[widest as PermScope]}>
                    {widest === 'ALL' ? <Eye size={10} className="inline mr-1" /> : <EyeOff size={10} className="inline mr-1" />}
                    {widest}
                  </Badge>
                  <Button size="xs" variant="secondary" onClick={() => setEditing(r)}>
                    <Pencil size={11} /> Edit
                  </Button>
                  {!r.isSystem && (
                    <button
                      onClick={() => {
                        setError('');
                        del.mutate(r.id, {
                          onError: (err: any) => setError(err?.response?.data?.error || 'Could not delete that role.'),
                        });
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity"
                      aria-label="Delete role"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <RoleEditor role={editing} onClose={() => setEditing(null)} />
      <NewRoleModal open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}
