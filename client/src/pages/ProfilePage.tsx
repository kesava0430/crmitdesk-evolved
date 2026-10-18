import { useModules } from '../shared/modules';
import { useState, FormEvent, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { User, Mail, Briefcase, Lock, CheckCircle2, AlertCircle, Eye, EyeOff, Camera, Link2, CalendarDays, Download, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import {
  PageHeader, PageBody, Card, Tabs, Button, IconButton, Badge, Alert, Avatar,
  Field, Input, FormGrid,
} from '../shared/components';
import { useMyDetails, useUpdateMyDetails, type MyDetails } from '../api/people';
import { useFormat } from '../hooks/useFormat';
import { GoogleSignInButton } from '../shared/components/GoogleSignInButton';
import { saveOrShareBlob } from '../native/download';
import { MessagingConnections } from './MessagingConnections';

/* ── tiny helpers ── */
function Toast({ type, msg, onDismiss }: { type: 'ok' | 'err'; msg: string; onDismiss: () => void }) {
  return (
    <Alert
      tone={type === 'ok' ? 'success' : 'danger'}
      icon={type === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      onDismiss={onDismiss}
      className="animate-slide-down font-medium"
    >
      {msg}
    </Alert>
  );
}

/* ── Avatar section ── */
function AvatarSection({ user }: { user: { name: string; avatarUrl?: string } }) {
  return (
    <div className="flex items-center gap-5">
      <div className="relative">
        <Avatar name={user.name} src={user.avatarUrl} size="lg" />
        <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-surface shadow border border-line flex items-center justify-center cursor-default" title="Avatar editing via URL below">
          <Camera size={13} className="text-fg-muted" />
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-[17px] font-semibold text-fg tracking-tight truncate" title={user.name}>
          {user.name}
        </p>
        <p className="text-[13px] text-fg-muted mt-0.5">Update your name, email and department below</p>
      </div>
    </div>
  );
}

/* ── Profile form ── */
function ProfileForm() {
  const { user, updateProfile } = useAuth();
  // With an employee record, department is HR's to set (People → Edit) —
  // shown here for reference rather than as a second, disconnected copy.
  const { data: mine } = useMyDetails(useModules().isModuleOn('hr_core'));
  const hrDepartment = mine?.data ? mine.data.department?.name ?? '' : null;
  const [form, setForm] = useState({
    name:       user?.name       ?? '',
    email:      user?.email      ?? '',
    department: user?.department ?? '',
    avatarUrl:  user?.avatarUrl  ?? '',
  });
  const [busy, setBusy]   = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setToast(null);
    try {
      await updateProfile(form);
      setToast({ type: 'ok', msg: 'Profile updated successfully!' });
    } catch (err: any) {
      setToast({ type: 'err', msg: err?.response?.data?.error ?? err?.response?.data?.message ?? 'Failed to update profile.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {toast && <Toast type={toast.type} msg={toast.msg} onDismiss={() => setToast(null)} />}

      <Field label="Full name">
        <Input
          icon={<User size={15} />}
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          required minLength={2}
          placeholder="Your full name"
        />
      </Field>

      <Field label="Email address">
        <Input
          type="email"
          icon={<Mail size={15} />}
          value={form.email}
          onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
          required
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Department" hint={hrDepartment !== null ? 'Set by HR. Ask them if it needs changing.' : undefined}>
        <Input
          icon={<Briefcase size={15} />}
          value={hrDepartment ?? form.department}
          disabled={hrDepartment !== null}
          onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
          placeholder="e.g. Engineering, Finance"
        />
      </Field>

      <Field label="Avatar URL (optional)">
        <Input
          type="url"
          value={form.avatarUrl}
          onChange={e => setForm(f => ({ ...f, avatarUrl: e.target.value }))}
          placeholder="https://..."
        />
      </Field>

      <div className="pt-1">
        <Button type="submit" size="lg" loading={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

/* ── Work details (read-only) + own contact details (editable) ── */
const MY_FIELDS = [
  'phone', 'alternatePhone', 'personalEmail', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
] as const;
type MyKey = (typeof MY_FIELDS)[number] | 'ecName' | 'ecRelationship' | 'ecPhone';

function myForm(d: MyDetails): Record<MyKey, string> {
  const out = {} as Record<MyKey, string>;
  for (const k of MY_FIELDS) out[k] = (d[k] as string | null | undefined) ?? '';
  out.ecName = d.emergencyContact?.name ?? '';
  out.ecRelationship = d.emergencyContact?.relationship ?? '';
  out.ecPhone = d.emergencyContact?.phone ?? '';
  return out;
}

function Info({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-fg-subtle">{label}</p>
      <p className="text-[12.5px] text-fg break-words">{value || '—'}</p>
    </div>
  );
}

function MyDetailsSection() {
  const { data, isLoading } = useMyDetails();
  const save = useUpdateMyDetails();
  const fmt = useFormat();
  const details = data?.data ?? null;
  const [initial, setInitial] = useState<Record<MyKey, string> | null>(null);
  const [form, setForm] = useState<Record<MyKey, string> | null>(null);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  useEffect(() => {
    if (details) { const f = myForm(details); setInitial(f); setForm(f); }
  }, [details]);

  if (isLoading) return <div className="skeleton h-40 w-full" aria-hidden="true" />;
  if (!details || !form || !initial) {
    return (
      <p className="text-[12.5px] text-fg-muted">
        No employee record is linked to your login yet, so there are no work details to show. Ask HR to add you
        under People.
      </p>
    );
  }

  const set = (k: MyKey, v: string) => setForm(f => (f ? { ...f, [k]: v } : f));
  const ec = [form.ecName, form.ecRelationship, form.ecPhone].map(v => v.trim());
  const ecPartial = ec.some(Boolean) && !ec.every(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form || !initial) return;
    const body: Record<string, unknown> = {};
    for (const k of MY_FIELDS) if (form[k] !== initial[k]) body[k] = form[k].trim() || null;
    if (['ecName', 'ecRelationship', 'ecPhone'].some(k => form[k as MyKey] !== initial[k as MyKey])) {
      body.emergencyContact = ec.every(v => !v) ? null : { name: ec[0], relationship: ec[1], phone: ec[2] };
    }
    if (!Object.keys(body).length) { setToast({ type: 'ok', msg: 'Nothing to save.' }); return; }
    setToast(null);
    try {
      await save.mutateAsync(body);
      setToast({ type: 'ok', msg: 'Your details were updated.' });
    } catch (err: any) {
      setToast({ type: 'err', msg: err?.response?.data?.error ?? 'Could not save your details.' });
    }
  }

  const input = (k: MyKey, label: string, type = 'text', span = false) => (
    <Field label={label} className={span ? 'sm:col-span-2' : ''}>
      <Input aria-label={label} type={type} value={form[k]} onChange={e => set(k, e.target.value)} />
    </Field>
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">Work (managed by HR)</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
          <Info label="Employee ID" value={details.employeeCode} />
          <Info label="Designation" value={details.designation} />
          <Info label="Department" value={details.department?.name} />
          <Info label="Reports to" value={details.manager?.displayName} />
          <Info label="Location" value={details.location?.name} />
          <Info label="Joined" value={details.joiningDate ? fmt.date(details.joiningDate) : null} />
        </div>
      </div>

      <form onSubmit={submit} className="space-y-4 border-t border-line-subtle pt-5">
        {toast && <Toast type={toast.type} msg={toast.msg} onDismiss={() => setToast(null)} />}
        <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Contact &amp; address</p>
        <FormGrid>
          {input('phone', 'Phone', 'tel')}
          {input('alternatePhone', 'Alternate phone', 'tel')}
          {input('personalEmail', 'Personal email', 'email', true)}
          {input('addressLine1', 'Address line 1', 'text', true)}
          {input('addressLine2', 'Address line 2', 'text', true)}
          {input('city', 'City')}
          {input('state', 'State')}
          {input('postalCode', 'Postal code')}
          {input('country', 'Country')}
        </FormGrid>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle pt-1">Emergency contact</p>
        <FormGrid cols={3}>
          {input('ecName', 'Contact name')}
          {input('ecRelationship', 'Relationship')}
          {input('ecPhone', 'Contact phone', 'tel')}
        </FormGrid>
        {ecPartial && (
          <p className="text-[12px] text-danger">Fill in name, relationship and phone — or clear all three.</p>
        )}
        <Button type="submit" loading={save.isPending} disabled={ecPartial}>Save my details</Button>
      </form>
    </div>
  );
}

/* ── Password form ── */
function PasswordForm() {
  const { user, setSession } = useAuth();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [show, setShow]   = useState({ current: false, next: false });
  const [busy, setBusy]   = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) {
      setToast({ type: 'err', msg: 'New passwords do not match.' });
      return;
    }
    if (form.newPassword.length < 8) {
      setToast({ type: 'err', msg: 'New password must be at least 8 characters.' });
      return;
    }
    setBusy(true);
    setToast(null);
    try {
      const { data } = await api.put('/auth/me/password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      // The server revoked every session and issued this device a fresh
      // pair — adopt it, or the next refresh would sign this device out too.
      if (data?.access && data?.refresh && user) setSession(user, data.access, data.refresh);
      setToast({ type: 'ok', msg: 'Password changed! Other sessions have been signed out.' });
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (err: any) {
      setToast({ type: 'err', msg: err?.response?.data?.error ?? err?.response?.data?.message ?? 'Failed to change password.' });
    } finally {
      setBusy(false);
    }
  }

  const mismatch = !!form.confirm && form.confirm !== form.newPassword;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {toast && <Toast type={toast.type} msg={toast.msg} onDismiss={() => setToast(null)} />}

      <Field label="Current password">
        <div className="relative">
          <Input
            type={show.current ? 'text' : 'password'}
            icon={<Lock size={15} />}
            className="pr-10"
            value={form.currentPassword}
            onChange={e => setForm(f => ({ ...f, currentPassword: e.target.value }))}
            required
            placeholder="Your current password"
          />
          <IconButton
            label={show.current ? 'Hide password' : 'Show password'}
            icon={show.current ? <EyeOff size={14} /> : <Eye size={14} />}
            onClick={() => setShow(s => ({ ...s, current: !s.current }))}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
          />
        </div>
      </Field>

      <Field label="New password">
        <div className="relative">
          <Input
            type={show.next ? 'text' : 'password'}
            icon={<Lock size={15} />}
            className="pr-10"
            value={form.newPassword}
            onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))}
            required minLength={8}
            placeholder="Min 8 characters"
          />
          <IconButton
            label={show.next ? 'Hide password' : 'Show password'}
            icon={show.next ? <EyeOff size={14} /> : <Eye size={14} />}
            onClick={() => setShow(s => ({ ...s, next: !s.next }))}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
          />
        </div>
      </Field>

      <Field label="Confirm new password" error={mismatch ? "Passwords don't match" : null}>
        <Input
          type="password"
          icon={<Lock size={15} />}
          invalid={mismatch}
          value={form.confirm}
          onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))}
          required
          placeholder="Re-enter new password"
        />
      </Field>

      <div className="pt-1">
        <Button type="submit" size="lg" loading={busy}>
          {busy ? 'Updating…' : 'Change password'}
        </Button>
      </div>
    </form>
  );
}

/* ── Connections (Google SSO + Calendar sync) ── */
function ConnectionsPanel() {
  const modules = useModules();
  const [params] = useSearchParams();
  const [google, setGoogle] = useState<{ configured: boolean; linked: boolean } | null>(null);
  const [calendar, setCalendar] = useState<{ configured: boolean; connected: boolean; connectedEmail: string | null } | null>(null);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [g, c] = await Promise.all([
      api.get('/auth/google/status').then(r => r.data).catch(() => null),
      api.get('/calendar/status').then(r => r.data).catch(() => null),
    ]);
    setGoogle(g); setCalendar(c);
  }

  useEffect(() => {
    refresh();
    const calendarStatus = params.get('calendar');
    if (calendarStatus === 'connected') setToast({ type: 'ok', msg: 'Google Calendar connected!' });
    if (calendarStatus === 'error') setToast({ type: 'err', msg: 'Could not connect Google Calendar. Please try again.' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function linkGoogle(idToken: string) {
    setBusy(true);
    try {
      await api.post('/auth/google/link', { idToken });
      setToast({ type: 'ok', msg: 'Google account linked — you can now sign in with Google.' });
      refresh();
    } catch (err: any) {
      setToast({ type: 'err', msg: err?.response?.data?.error ?? 'Could not link Google account.' });
    } finally { setBusy(false); }
  }

  async function unlinkGoogle() {
    setBusy(true);
    try {
      await api.delete('/auth/google/link');
      setToast({ type: 'ok', msg: 'Google account unlinked.' });
      refresh();
    } catch { setToast({ type: 'err', msg: 'Could not unlink Google account.' }); } finally { setBusy(false); }
  }

  async function connectCalendar() {
    try {
      const { data } = await api.get('/calendar/oauth-url');
      window.location.href = data.url;
    } catch (err: any) {
      setToast({ type: 'err', msg: err?.response?.data?.error ?? 'Calendar sync is not configured on this server.' });
    }
  }

  async function disconnectCalendar() {
    setBusy(true);
    try {
      await api.delete('/calendar/connection');
      setToast({ type: 'ok', msg: 'Calendar disconnected.' });
      refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      {toast && <Toast type={toast.type} msg={toast.msg} onDismiss={() => setToast(null)} />}

      <div>
        <p className="text-[13px] font-semibold text-fg flex items-center gap-2"><Link2 size={15} className="text-accent" /> Google Sign-In</p>
        <p className="text-[11.5px] text-fg-muted mt-1 mb-3">Link your Google account to sign in without a password.</p>
        {!google?.configured ? (
          <p className="text-[11.5px] text-fg-subtle italic">Not set up for this workspace yet — an admin needs to configure Google SSO.</p>
        ) : google.linked ? (
          <div className="flex items-center gap-3">
            <Badge variant="green"><CheckCircle2 size={12} /> Linked</Badge>
            <Button size="xs" variant="ghost" className="!text-danger" disabled={busy} onClick={unlinkGoogle}>Unlink</Button>
          </div>
        ) : (
          <GoogleSignInButton onIdToken={linkGoogle} text="continue_with" />
        )}
      </div>

      {/* Calendar sync covers CRM activities and assigned tickets — nothing to
          sync for an org without either (Platform Admin → Areas). */}
      {(modules.isModuleOn('crm') || modules.isModuleOn('itdesk')) && (
      <div className="border-t border-line-subtle pt-5">
        <p className="text-[13px] font-semibold text-fg flex items-center gap-2"><CalendarDays size={15} className="text-accent" /> Google Calendar</p>
        <p className="text-[11.5px] text-fg-muted mt-1 mb-3">Sync your {[modules.isModuleOn('crm') && 'open activities', modules.isModuleOn('itdesk') && 'assigned tickets'].filter(Boolean).join(' and ')} to your Google Calendar.</p>
        {!calendar?.configured ? (
          <p className="text-[11.5px] text-fg-subtle italic">Not set up for this workspace yet — an admin needs to configure calendar sync.</p>
        ) : calendar.connected ? (
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="green">
              <CheckCircle2 size={12} /> Connected{calendar.connectedEmail ? ` (${calendar.connectedEmail})` : ''}
            </Badge>
            <Button size="xs" variant="ghost" className="!text-danger" disabled={busy} onClick={disconnectCalendar}>Disconnect</Button>
          </div>
        ) : (
          <Button size="sm" onClick={connectCalendar}>Connect Google Calendar</Button>
        )}
      </div>
      )}

      {/* Messaging assistant (WhatsApp / Slack) — only when the org switched a channel on. */}
      <MessagingConnections />
    </div>
  );
}

/* ── Privacy & Data (GDPR) ── */
function PrivacyPanel() {
  const modules = useModules();
  // Name only record types the org has (Platform Admin → Areas).
  const linked = [modules.isModuleOn('itdesk') && 'tickets', modules.isModuleOn('crm') && 'deals'].filter(Boolean) as string[];
  const { logout } = useAuth();
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function exportData() {
    try {
      const res = await api.get('/gdpr/export/me');
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      await saveOrShareBlob(blob, 'my-data-export.json');
    } catch { setToast({ type: 'err', msg: 'Could not export your data.' }); }
  }

  async function deleteMyData(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/gdpr/delete-request/me', { password, confirm: true });
      logout();
    } catch (err: any) {
      setToast({ type: 'err', msg: err?.response?.data?.error ?? 'Could not process this request.' });
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {toast && <Toast type={toast.type} msg={toast.msg} onDismiss={() => setToast(null)} />}

      <div>
        <p className="text-[13px] font-semibold text-fg flex items-center gap-2"><Download size={15} className="text-accent" /> Export your data</p>
        <p className="text-[11.5px] text-fg-muted mt-1 mb-3">Download a JSON copy of your profile, {linked.length ? `activities, comments, and ${linked.join('/')} you're linked to` : 'activity and comments'}.</p>
        <Button size="sm" variant="secondary" onClick={exportData}>Download my data</Button>
      </div>

      <div className="border-t border-line-subtle pt-5">
        <p className="text-[13px] font-semibold text-danger flex items-center gap-2"><Trash2 size={15} /> Delete my personal data</p>
        <p className="text-[11.5px] text-fg-muted mt-1 mb-3">
          Removes your name, email and phone from your account and deactivates it. Records you're linked to ({[...linked, 'comments'].join(', ')}) stay for your organization's continuity but no longer show your name. This can't be undone.
        </p>
        {!confirmDelete ? (
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>Delete my data</Button>
        ) : (
          <form onSubmit={deleteMyData} className="space-y-3 max-w-sm">
            <p className="text-[11.5px] text-fg-muted">Confirm your password to proceed.</p>
            <Input
              type="password" required value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Current password" aria-label="Current password"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="danger" loading={busy}>
                {busy ? 'Processing…' : 'Confirm deletion'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ── Main page ── */
const TABS = [
  { key: 'profile', label: 'Profile details' },
  { key: 'work', label: 'Work & contact' },
  { key: 'security', label: 'Security' },
  { key: 'connections', label: 'Connections' },
  { key: 'privacy', label: 'Privacy & Data' },
] as const;

type TabKey = typeof TABS[number]['key'];

export default function ProfilePage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>('profile');
  // "Work & contact" is the person's HR record — no tab while HR is off (Platform Admin → Areas).
  const hrOn = useModules().isModuleOn('hr_core');
  const tabs = TABS.filter(t => t.key !== 'work' || hrOn);

  if (!user) return null;

  return (
    <div>
      <PageHeader title="My Profile" subtitle="Manage your personal details and account security" />

      <PageBody width="narrow">
        {/* Avatar hero */}
        <Card>
          <AvatarSection user={user} />
          <div className="mt-4 flex items-center gap-1.5 flex-wrap">
            <span className="text-[11.5px] text-fg-subtle">Role:</span>
            <Badge variant="accent">{user.role?.replace(/_/g, ' ')}</Badge>
            {user.org?.name && (
              <>
                <span className="text-fg-subtle mx-1">·</span>
                <span className="text-[11.5px] text-fg-muted min-w-0 truncate" title={user.org.name}>
                  {user.org.name}
                </span>
              </>
            )}
          </div>
        </Card>

        {/* Tabs */}
        <Tabs
          variant="segmented"
          aria-label="Profile sections"
          value={tab}
          onChange={setTab}
          items={tabs.map(t => ({ key: t.key, label: t.label }))}
        />

        {/* Tab content */}
        <Card padding="lg">
          {tab === 'profile' && (
            <>
              <h2 className="text-[14px] font-semibold text-fg tracking-tight mb-5">Personal information</h2>
              <ProfileForm />
            </>
          )}
          {tab === 'work' && hrOn && (
            <>
              <h2 className="text-[14px] font-semibold text-fg tracking-tight mb-1">Work &amp; contact details</h2>
              <p className="text-[13px] text-fg-muted mb-5">
                Keep your phone, address and emergency contact current. Job details are maintained by HR.
              </p>
              <MyDetailsSection />
            </>
          )}
          {tab === 'security' && (
            <>
              <h2 className="text-[14px] font-semibold text-fg tracking-tight mb-1">Change password</h2>
              <p className="text-[13px] text-fg-muted mb-5">
                After changing your password, all other active sessions will be signed out.
              </p>
              <PasswordForm />
            </>
          )}
          {tab === 'connections' && (
            <>
              <h2 className="text-[14px] font-semibold text-fg tracking-tight mb-5">Connections</h2>
              <ConnectionsPanel />
            </>
          )}
          {tab === 'privacy' && (
            <>
              <h2 className="text-[14px] font-semibold text-fg tracking-tight mb-5">Privacy &amp; data</h2>
              <PrivacyPanel />
            </>
          )}
        </Card>
      </PageBody>
    </div>
  );
}
