import { useModules } from '../../shared/modules';
import { useEffect, useMemo, useState } from 'react';
import {
  useCreatePerson,
  useUpdatePerson,
  usePerson,
  usePeopleStats,
  useDepartments,
  useLocations,
  useEmployees,
  type Person,
  type PersonProfile,
} from '../../api/people';
import { useRoles } from '../../api/work';
import {
  Button, Modal, Tabs, Field, Input, Select, Alert, FormError, FormGrid, addToast,
} from '../../shared/components';
import { UserSquare2, UserCog, Copy, Check } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { can } from '../../shared/permissions';

/**
 * The one Add-person form and the one Edit-person form.
 *
 * Every screen that adds someone — People, Org Chart, Org Structure (per
 * department) and Administration → Logins & Invites — opens AddPersonModal,
 * which posts to POST /people. Entry points may pre-fill context (the
 * department you clicked, or "send an invite") but the fields, validation and
 * result are identical everywhere: one employee record, plus a login when
 * access is granted.
 *
 * EditPersonModal is the single edit path (PATCH /people/:id) — opened from
 * the person's profile and from the row actions on every list. It sends only
 * the fields that changed, so an untouched field is never rewritten and a
 * cleared one is sent as null.
 */

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT', 'TEMPORARY'];
export const EMPLOYMENT_STATUSES = ['PROBATION', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'SUSPENDED', 'EXITED'];
const WORK_MODES = ['ONSITE', 'HYBRID', 'REMOTE'];
const label = (v: string) => v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
const optionsOf = (values: string[]) => values.map(v => ({ value: v, label: label(v) }));

/* Mirrors server/src/utils/roleRank.ts so the role picker only offers roles
   the server will accept from this caller. The server re-checks every one. */
const ROLE_RANK: Record<string, number> = {
  SUPER_ADMIN: 3, CRM_MANAGER: 2, IT_MANAGER: 2, SALES_REP: 1, IT_AGENT: 1, EMPLOYEE: 0,
};
const rankOf = (r?: string | null) => ROLE_RANK[r ?? ''] ?? 0;

const errorText = (err: any, fallback: string) => err?.response?.data?.error || fallback;

/** Field wrapper whose control carries the label as its accessible name. */
function TextField({
  label: text, value, onChange, required, type = 'text', placeholder, disabled, hint, className,
}: {
  label: string; value: string; onChange: (v: string) => void; required?: boolean; type?: string;
  placeholder?: string; disabled?: boolean; hint?: React.ReactNode; className?: string;
}) {
  return (
    <Field label={text} required={required} hint={hint} className={className}>
      <Input
        aria-label={text}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
    </Field>
  );
}

function SelectField({
  label: text, value, onChange, children, disabled, hint, required, className,
}: {
  label: string; value: string; onChange: (v: string) => void; children: React.ReactNode;
  disabled?: boolean; hint?: React.ReactNode; required?: boolean; className?: string;
}) {
  return (
    <Field label={text} hint={hint} required={required} className={className}>
      <Select aria-label={text} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        {children}
      </Select>
    </Field>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle sm:col-span-2 pt-1">{children}</p>;
}

export function InviteLinkBox({ link, onDone }: { link: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="success" title="Invite created">
      <p className="mb-3">
        We emailed it too, but sending can fail quietly — copy the link so you have it either way.
      </p>
      <div className="flex items-center gap-2">
        <Input readOnly value={link} aria-label="Invite link" className="font-mono !text-[11.5px]" />
        <Button
          size="sm"
          variant="secondary"
          aria-label="Copy invite link"
          icon={copied ? <Check size={13} /> : <Copy size={13} />}
          onClick={() => {
            navigator.clipboard?.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        />
      </div>
      <div className="flex justify-end mt-3">
        <Button size="sm" onClick={onDone}>Done</Button>
      </div>
    </Alert>
  );
}

/** Roles this caller may hand out, for the login role pickers. */
function useAssignableRoles(enabled: boolean) {
  const { user } = useAuth();
  const { data } = useRoles(enabled && can.readRoles(user?.role));
  // Roles of an area switched off for the org aren't offered (an edit form
  // still lists the person's current role — see the Role field below).
  const modules = useModules();
  return (data?.data ?? []).filter(r => r.isActive && rankOf(r.legacyRole) <= rankOf(user?.role) && modules.isRoleOffered(r.legacyRole));
}

// ─── Add ──────────────────────────────────────────────────────────────────────

export interface AddPersonDefaults {
  departmentId?: string;
  managerId?: string;
  loginMode?: 'none' | 'password' | 'invite';
}

const LOGIN_MODES = [
  { key: 'invite' as const, label: 'Send an invite' },
  { key: 'password' as const, label: 'Set a password' },
  { key: 'none' as const, label: 'No login' },
];

const today = () => new Date().toISOString().slice(0, 10);

function blankAdd(defaults?: AddPersonDefaults) {
  return {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    employeeCode: '',
    designation: '',
    departmentId: defaults?.departmentId ?? '',
    locationId: '',
    managerId: defaults?.managerId ?? '',
    joiningDate: today(),
    employmentType: 'FULL_TIME',
    employmentStatus: 'ACTIVE',
    loginMode: (defaults?.loginMode ?? 'invite') as 'none' | 'password' | 'invite',
    password: '',
    roleId: '',
  };
}

export function AddPersonModal({
  open,
  onClose,
  defaults,
  onCreated,
  context,
}: {
  open: boolean;
  onClose: () => void;
  /** Context from the entry point — pre-fills, never changes the form. */
  defaults?: AddPersonDefaults;
  onCreated?: (person: Person) => void;
  /** One line telling the user where this person is being added, e.g. "to Sales". */
  context?: string;
}) {
  const create = useCreatePerson();
  // HR lookups (departments, locations, managers) only while HR is on — this
  // form is also how Logins & Invites adds people in a CRM / IT-only org.
  const hrOn = useModules().isModuleOn('hr_core');
  const { data: stats } = usePeopleStats(hrOn);
  const { data: departments } = useDepartments(hrOn);
  const { data: locations } = useLocations(hrOn);
  const { data: managers } = useEmployees({ limit: '200' }, hrOn);

  /* Login options appear only for callers who may create logins — an HR
     Manager adds staff, a user admin hands out access. Until the answer
     arrives, fall back to the role check so the form doesn't jump. */
  const { user } = useAuth();
  const canCreateLogin = stats?.access?.canCreateLogin ?? can.managePeople(user?.role);
  const roles = useAssignableRoles(open && canCreateLogin);

  const [form, setForm] = useState(() => blankAdd(defaults));
  const [error, setError] = useState('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  // Re-seed whenever the modal opens, so the context of THIS entry point
  // (e.g. the department row clicked) is what pre-fills it.
  useEffect(() => {
    if (open) {
      const next = blankAdd(defaults);
      if (!canCreateLogin) next.loginMode = 'none';
      setForm(next);
      setError('');
      setInviteLink(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof ReturnType<typeof blankAdd>>(k: K, v: ReturnType<typeof blankAdd>[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const needsEmail = form.loginMode !== 'none';
  const close = () => { setInviteLink(null); onClose(); };

  const invalid =
    !form.firstName.trim() ||
    !form.joiningDate ||
    (needsEmail && !form.email.trim()) ||
    (form.loginMode === 'password' && form.password.length < 8);

  const submit = () => {
    setError('');
    create.mutate(
      {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim() || undefined,
        designation: form.designation.trim() || undefined,
        departmentId: form.departmentId || null,
        locationId: form.locationId || null,
        managerId: form.managerId || null,
        phone: form.phone.trim() || undefined,
        joiningDate: form.joiningDate,
        employmentType: form.employmentType,
        employmentStatus: form.employmentStatus,
        employeeCode: form.employeeCode.trim() || undefined,
        loginMode: form.loginMode,
        email: form.email.trim() || undefined,
        password: form.loginMode === 'password' ? form.password : undefined,
        roleId: needsEmail ? form.roleId || undefined : undefined,
      },
      {
        onSuccess: res => {
          onCreated?.(res.person);
          if (res.inviteLink) setInviteLink(res.inviteLink);
          else {
            addToast(`${res.person.displayName} added`, 'success', 3000);
            close();
          }
        },
        onError: (err: any) => setError(errorText(err, 'Could not add that person.')),
      }
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a person"
      subtitle={context ?? 'Everyone who works here — whether or not they need to sign in.'}
      icon={<UserSquare2 size={16} />}
      size="lg"
      footer={
        inviteLink ? undefined : (
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button onClick={submit} loading={create.isPending} disabled={invalid}>
              {form.loginMode === 'invite' ? 'Add & send invite' : 'Add person'}
            </Button>
          </>
        )
      }
    >
      {inviteLink ? (
        <InviteLinkBox link={inviteLink} onDone={close} />
      ) : (
        <div className="space-y-4">
          <FormGrid>
            <TextField label="First name" required value={form.firstName} onChange={v => set('firstName', v)} />
            <TextField label="Last name" value={form.lastName} onChange={v => set('lastName', v)} />
            <TextField
              label="Work email"
              type="email"
              required={needsEmail}
              value={form.email}
              onChange={v => set('email', v)}
              placeholder="name@company.com"
            />
            <TextField label="Phone" type="tel" value={form.phone} onChange={v => set('phone', v)} placeholder="+91 98765 43210" />
            <TextField label="Designation" value={form.designation} onChange={v => set('designation', v)} placeholder="e.g. Account Executive" />
            <TextField
              label="Employee ID"
              value={form.employeeCode}
              onChange={v => set('employeeCode', v)}
              placeholder="Auto-generated (EMP-0001…)"
            />
            <SelectField label="Department" value={form.departmentId} onChange={v => set('departmentId', v)}>
              <option value="">—</option>
              {(departments?.data ?? []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </SelectField>
            <SelectField label="Reports to" value={form.managerId} onChange={v => set('managerId', v)}>
              <option value="">—</option>
              {(managers?.data ?? []).map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </SelectField>
            <SelectField label="Location" value={form.locationId} onChange={v => set('locationId', v)}>
              <option value="">—</option>
              {(locations?.data ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </SelectField>
            <TextField label="Joining date" type="date" required value={form.joiningDate} onChange={v => set('joiningDate', v)} />
            <SelectField label="Employment type" value={form.employmentType} onChange={v => set('employmentType', v)}>
              {optionsOf(EMPLOYMENT_TYPES).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </SelectField>
            <SelectField label="Status" value={form.employmentStatus} onChange={v => set('employmentStatus', v)}>
              <option value="ACTIVE">Active</option>
              <option value="PROBATION">Probation</option>
            </SelectField>
          </FormGrid>

          {/* ── Access ── */}
          <div className="border-t border-line-subtle pt-4">
            {canCreateLogin ? (
              <>
                <Field label="System access">
                  <Tabs
                    variant="segmented"
                    aria-label="System access"
                    className="mb-3 max-w-full"
                    value={form.loginMode}
                    onChange={key => set('loginMode', key)}
                    items={LOGIN_MODES}
                  />
                </Field>
                {form.loginMode === 'none' ? (
                  <p className="text-[12px] text-fg-muted">
                    They'll appear in the directory and org chart, can be assigned tasks and hold assets — but cannot
                    sign in, and don't use a licensed seat. You can give them a login later at any time.
                  </p>
                ) : (
                  <FormGrid>
                    <SelectField
                      label="Role"
                      value={form.roleId}
                      onChange={v => set('roleId', v)}
                      hint="Decides what they can see and do once they sign in."
                    >
                      <option value="">Employee (self-service only)</option>
                      {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </SelectField>
                    {form.loginMode === 'password' ? (
                      <TextField
                        label="Password"
                        type="password"
                        required
                        value={form.password}
                        onChange={v => set('password', v)}
                        placeholder="At least 8 characters"
                      />
                    ) : (
                      <p className="text-[12px] text-fg-muted self-center">
                        We'll email an invite link to the work email above. It expires in 7 days.
                      </p>
                    )}
                  </FormGrid>
                )}
              </>
            ) : (
              <p className="text-[12px] text-fg-muted">
                This adds them to the directory without a login. A user administrator can give them access later.
              </p>
            )}
          </div>

          <FormError>{error}</FormError>
        </div>
      )}
    </Modal>
  );
}

// ─── Edit ─────────────────────────────────────────────────────────────────────

/** Keys of the editable form; each maps 1:1 onto a PATCH /people/:id field. */
const EDIT_KEYS = [
  'firstName', 'lastName', 'employeeCode', 'designation', 'departmentId', 'managerId', 'locationId',
  'employmentType', 'employmentStatus', 'workMode', 'joiningDate', 'probationEndDate', 'confirmationDate',
  'costCenter', 'email', 'phone', 'alternatePhone', 'personalEmail', 'dateOfBirth', 'gender',
  'maritalStatus', 'bloodGroup', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
  'bankAccountName', 'bankAccountNumber', 'bankName', 'bankIfsc', 'taxId', 'nationalId', 'socialSecurityId',
  'roleId', 'policyGroupId', 'ecName', 'ecRelationship', 'ecPhone',
] as const;
type EditKey = (typeof EDIT_KEYS)[number];
type EditForm = Record<EditKey, string>;

const isMasked = (v: unknown) => typeof v === 'string' && v.includes('••••');
const day = (v?: string | null) => (v ? String(v).slice(0, 10) : '');

function formFromProfile(p: PersonProfile): { form: EditForm; masked: Partial<Record<EditKey, string>> } {
  const masked: Partial<Record<EditKey, string>> = {};
  const raw: Record<string, unknown> = {
    ...p,
    email: p.user?.email ?? p.workEmail ?? '',
    joiningDate: day(p.joiningDate),
    probationEndDate: day(p.probationEndDate),
    confirmationDate: day(p.confirmationDate),
    dateOfBirth: isMasked(p.dateOfBirth) ? p.dateOfBirth : day(p.dateOfBirth),
    roleId: p.user?.roleId ?? '',
    policyGroupId: p.attendancePolicy?.explicitId ?? '',
    ecName: p.emergencyContact?.name ?? '',
    ecRelationship: p.emergencyContact?.relationship ?? '',
    ecPhone: p.emergencyContact?.phone ?? '',
  };
  const form = {} as EditForm;
  for (const k of EDIT_KEYS) {
    const v = raw[k];
    // A masked value is shown as a placeholder, never as an editable value —
    // saving it would overwrite the real number with dots.
    if (isMasked(v)) {
      masked[k] = String(v);
      form[k] = '';
    } else {
      form[k] = v == null ? '' : String(v);
    }
  }
  return { form, masked };
}

/** The PATCH body: only fields that changed; '' is sent as null (cleared). */
export function buildPersonPatch(initial: EditForm, current: EditForm, masked: Partial<Record<EditKey, string>>) {
  const body: Record<string, unknown> = {};
  for (const k of EDIT_KEYS) {
    if (k.startsWith('ec')) continue;
    if (current[k] === initial[k]) continue;
    // A masked field left blank means "keep what's there".
    if (masked[k] !== undefined && current[k] === '') continue;
    const v = current[k].trim();
    body[k] = v === '' ? null : v;
  }
  const ecChanged = (['ecName', 'ecRelationship', 'ecPhone'] as const).some(k => current[k] !== initial[k]);
  if (ecChanged) {
    const name = current.ecName.trim();
    const relationship = current.ecRelationship.trim();
    const phone = current.ecPhone.trim();
    body.emergencyContact = !name && !relationship && !phone ? null : { name, relationship, phone };
  }
  return body;
}

const EDIT_TABS = [
  { key: 'job' as const, label: 'Job' },
  { key: 'contact' as const, label: 'Contact' },
  { key: 'personal' as const, label: 'Personal' },
  { key: 'pay' as const, label: 'Bank & IDs' },
];
type EditTab = (typeof EDIT_TABS)[number]['key'];

export function EditPersonModal({ personId, onClose }: { personId: string | null; onClose: () => void }) {
  const { data: profile, isLoading, error: loadError } = usePerson(personId);
  const update = useUpdatePerson();
  const hrOn = useModules().isModuleOn('hr_core');
  const { data: departments } = useDepartments(hrOn);
  const { data: locations } = useLocations(hrOn);
  const { data: managers } = useEmployees({ limit: '200' }, hrOn);
  const roles = useAssignableRoles(!!profile?.access.canEditRole);

  const [tab, setTab] = useState<EditTab>('job');
  const [error, setError] = useState('');
  const [state, setState] = useState<{ initial: EditForm; form: EditForm; masked: Partial<Record<EditKey, string>> } | null>(null);

  // Seed once per person; a background refetch must not wipe what's being typed.
  useEffect(() => {
    if (!personId) { setState(null); return; }
    if (profile && profile.id === personId && (!state || state.initial === null)) {
      const { form, masked } = formFromProfile(profile);
      setState({ initial: form, form, masked });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, profile?.id]);

  useEffect(() => {
    if (personId) { setTab('job'); setError(''); }
  }, [personId]);

  const close = () => { setState(null); onClose(); };

  const access = profile?.access;
  const readOnly = new Set(access?.readOnlyFields ?? []);
  const form = state?.form;
  const set = (k: EditKey, v: string) => setState(s => (s ? { ...s, form: { ...s.form, [k]: v } } : s));
  const field = (k: EditKey, text: string, opts: { type?: string; placeholder?: string; required?: boolean; hint?: React.ReactNode; className?: string } = {}) => (
    <TextField
      label={text}
      value={form?.[k] ?? ''}
      onChange={v => set(k, v)}
      type={opts.type}
      required={opts.required}
      className={opts.className}
      disabled={readOnly.has(k)}
      placeholder={state?.masked[k] ? `${state.masked[k]} — leave blank to keep` : opts.placeholder}
      hint={readOnly.has(k) ? 'Your role can view but not change this field.' : opts.hint}
    />
  );

  const patch = useMemo(
    () => (state ? buildPersonPatch(state.initial, state.form, state.masked) : {}),
    [state]
  );
  const dirty = Object.keys(patch).length > 0;
  const ecPartial = !!form && [form.ecName, form.ecRelationship, form.ecPhone].some(v => v.trim()) &&
    ![form.ecName, form.ecRelationship, form.ecPhone].every(v => v.trim());
  const invalid = !form || !form.firstName.trim() || !form.employeeCode.trim() || !form.joiningDate || ecPartial;

  const submit = () => {
    if (!profile) return;
    setError('');
    update.mutate(
      { id: profile.id, ...patch },
      {
        onSuccess: res => {
          if (res.ignoredFields?.length) {
            addToast(`Saved — ${res.ignoredFields.length} field(s) your role can't change were left as they were.`, 'warning');
          } else {
            addToast(`${res.displayName} updated`, 'success', 3000);
          }
          close();
        },
        onError: (err: any) => setError(errorText(err, 'Could not save those changes.')),
      }
    );
  };

  if (!personId) return null;

  const managerOptions = (managers?.data ?? []).filter(m => m.id !== personId);
  const hasLogin = !!profile?.user;

  return (
    <Modal
      open={!!personId}
      onClose={close}
      title={profile ? `Edit ${profile.displayName}` : 'Edit person'}
      subtitle={profile ? [profile.employeeCode, hasLogin ? 'can sign in' : 'no login'].join(' · ') : undefined}
      icon={<UserCog size={16} />}
      size="lg"
      footer={
        access?.canEdit ? (
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button onClick={submit} loading={update.isPending} disabled={!dirty || invalid}>
              Save changes
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={close}>Close</Button>
        )
      }
    >
      {isLoading || (!state && !loadError) ? (
        <div className="space-y-3" aria-hidden="true">
          <div className="skeleton h-8 w-full" />
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : loadError ? (
        <Alert tone="danger">{errorText(loadError, 'Could not load this person.')}</Alert>
      ) : !access?.canEdit ? (
        <Alert tone="warning">You can view this person but not change their details.</Alert>
      ) : form && (
        <div className="space-y-4">
          <Tabs variant="underline" aria-label="Sections" value={tab} onChange={setTab} items={EDIT_TABS} />

          {tab === 'job' && (
            <FormGrid>
              {field('firstName', 'First name', { required: true })}
              {field('lastName', 'Last name')}
              {field('employeeCode', 'Employee ID', { required: true })}
              {field('designation', 'Designation / job title')}
              <SelectField label="Department" value={form.departmentId} onChange={v => set('departmentId', v)}>
                <option value="">—</option>
                {(departments?.data ?? []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </SelectField>
              <SelectField label="Reports to" value={form.managerId} onChange={v => set('managerId', v)}>
                <option value="">— nobody (top of the chart) —</option>
                {/* Keep the current manager selectable even if outside the visible list. */}
                {profile?.manager && !managerOptions.some(m => m.id === profile.manager!.id) && (
                  <option value={profile.manager.id}>{profile.manager.displayName}</option>
                )}
                {managerOptions.map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </SelectField>
              <SelectField label="Location" value={form.locationId} onChange={v => set('locationId', v)}>
                <option value="">—</option>
                {(locations?.data ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </SelectField>
              <SelectField label="Work mode" value={form.workMode} onChange={v => set('workMode', v)}>
                {optionsOf(WORK_MODES).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </SelectField>
              <SelectField label="Employment type" value={form.employmentType} onChange={v => set('employmentType', v)}>
                {optionsOf(EMPLOYMENT_TYPES).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </SelectField>
              <SelectField
                label="Status"
                value={form.employmentStatus}
                onChange={v => set('employmentStatus', v)}
                hint={form.employmentStatus === 'EXITED' && state?.initial.employmentStatus !== 'EXITED'
                  ? 'Use "Record exit" on the profile to capture the last working day and reason.'
                  : undefined}
              >
                {optionsOf(EMPLOYMENT_STATUSES).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </SelectField>
              {field('joiningDate', 'Date of joining', { type: 'date', required: true })}
              {field('probationEndDate', 'Probation ends', { type: 'date' })}
              {field('confirmationDate', 'Confirmed on', { type: 'date' })}
              {field('costCenter', 'Cost centre')}

              {(access.canSetPolicyGroup || access.canEditRole) && <SectionTitle>Access &amp; attendance</SectionTitle>}
              {access.canEditRole && (
                <SelectField
                  label="Role"
                  value={form.roleId}
                  onChange={v => set('roleId', v)}
                  hint="What they can see and do when they sign in."
                >
                  {!form.roleId && <option value="">{profile?.user?.role?.replace(/_/g, ' ') ?? 'No role'}</option>}
                  {/* The current role stays listed even when this caller couldn't assign it. */}
                  {profile?.user?.roleRef && !roles.some(r => r.id === profile.user!.roleRef!.id) && (
                    <option value={profile.user.roleRef.id}>{profile.user.roleRef.name}</option>
                  )}
                  {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </SelectField>
              )}
              {access.canSetPolicyGroup && profile?.attendancePolicy && (
                <SelectField
                  label="Attendance policy"
                  value={form.policyGroupId}
                  onChange={v => set('policyGroupId', v)}
                  hint={form.policyGroupId
                    ? 'Pinned to this policy regardless of location or department.'
                    : `Picked by location, department or type — currently ${profile.attendancePolicy.effective?.name ?? 'none'}.`}
                >
                  <option value="">Automatic</option>
                  {(profile.attendancePolicy.options ?? []).filter(o => !o.isDefault).map(o => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </SelectField>
              )}
            </FormGrid>
          )}

          {tab === 'contact' && (
            <FormGrid>
              <TextField
                label={hasLogin ? 'Email (sign-in)' : 'Work email'}
                type="email"
                value={form.email}
                onChange={v => set('email', v)}
                disabled={!access.canEditEmail}
                hint={!access.canEditEmail
                  ? 'This is their sign-in address — only a user administrator can change it.'
                  : hasLogin ? 'They will sign in with the new address.' : undefined}
              />
              {field('phone', 'Phone', { type: 'tel' })}
              {field('alternatePhone', 'Alternate phone', { type: 'tel' })}
              {field('personalEmail', 'Personal email', { type: 'email' })}
              <SectionTitle>Emergency contact</SectionTitle>
              {field('ecName', 'Contact name')}
              {field('ecRelationship', 'Relationship', { placeholder: 'e.g. Spouse, Parent' })}
              {field('ecPhone', 'Contact phone', { type: 'tel' })}
              {ecPartial && (
                <p className="text-[12px] text-danger sm:col-span-2">
                  Fill in name, relationship and phone — or clear all three to remove the contact.
                </p>
              )}
            </FormGrid>
          )}

          {tab === 'personal' && (
            <FormGrid>
              {field('dateOfBirth', 'Date of birth', { type: state?.masked.dateOfBirth ? 'text' : 'date' })}
              {field('gender', 'Gender')}
              {field('maritalStatus', 'Marital status')}
              {field('bloodGroup', 'Blood group')}
              {field('addressLine1', 'Address line 1', { className: 'sm:col-span-2' })}
              {field('addressLine2', 'Address line 2', { className: 'sm:col-span-2' })}
              {field('city', 'City')}
              {field('state', 'State')}
              {field('postalCode', 'Postal code')}
              {field('country', 'Country')}
            </FormGrid>
          )}

          {tab === 'pay' && (
            <>
              <p className="text-[12px] text-fg-muted">
                Used by payroll for payslips and bank transfers. Stored encrypted; masked for roles without access.
              </p>
              <FormGrid>
                {field('bankAccountName', 'Account holder name')}
                {field('bankAccountNumber', 'Account number')}
                {field('bankName', 'Bank name')}
                {field('bankIfsc', 'IFSC / routing code')}
                {field('taxId', 'Tax ID (PAN)')}
                {field('nationalId', 'National ID')}
                {field('socialSecurityId', 'Social security / UAN')}
              </FormGrid>
            </>
          )}

          <FormError>{error}</FormError>
        </div>
      )}
    </Modal>
  );
}
