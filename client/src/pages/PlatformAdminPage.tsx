import { useEffect, useState } from 'react';
import { Building2, Users as UsersIcon, CheckCircle2, XCircle, LogOut, HardDrive, Pencil, Check, Mail, MessageCircle, Settings as SettingsIcon } from 'lucide-react';
import {
  usePlatformOrgs,
  usePlatformOrg,
  useUpdatePlatformOrg,
  useUpdatePlatformSubscription,
  useUpdatePlatformBranding,
  usePlatformSettings,
  useUpdatePlatformSettings,
  type PlatformOrgDetail,
  type PlatformOrgSummary,
  type SendCounts,
  type PlatformSecretStatus,
  type PlatformSettingsUpdate,
} from '../api/platformAdmin';
import {
  PageHeader, PageBody, Card, StatTile, Modal, Button, IconButton, Badge, Checkbox,
  Field, Input, Select, DataTable, EmptyState, Spinner, type Column,
} from '../shared/components';
import { useAuth } from '../contexts/AuthContext';

const GB = 1024 * 1024 * 1024;
const gbLabel = (bytes: number) => `${(bytes / GB).toFixed(bytes < GB ? 2 : 1)}GB`;

function UsageBar({ label, usedBytes, quotaBytes, colorClass }: { label: string; usedBytes: number; quotaBytes: number; colorClass: string }) {
  const pct = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 100;
  return (
    <div className="flex flex-col gap-1 min-w-[120px]">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-fg">
        <HardDrive size={12} className={colorClass} /> {label} · {gbLabel(usedBytes)} / {gbLabel(quotaBytes)}
      </span>
      <div className="h-1.5 w-full bg-surface-sunken rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-violet-500'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Storage provider label + (for hosted S3, explicit or auto-fallback) quota/usage bar — used in both the table row and the detail panel. */
function StorageBadge({ provider, quotaBytes, usedBytes, connectedEmail }: { provider: 'GOOGLE_DRIVE' | 'HOSTED_S3' | null; quotaBytes: number; usedBytes: number; connectedEmail?: string | null }) {
  if (provider === 'GOOGLE_DRIVE') {
    return (
      <Badge variant="blue">
        <HardDrive size={12} /> Own Google Drive{connectedEmail ? ` (${connectedEmail})` : ''}
      </Badge>
    );
  }
  if (provider === 'HOSTED_S3') {
    return <UsageBar label="Hosted S3" usedBytes={usedBytes} quotaBytes={quotaBytes} colorClass="text-violet-600 dark:text-violet-400" />;
  }
  // No StorageConfig row — but storage.ts auto-falls-back unconnected orgs
  // straight to our hosted S3, so there may still be real usage here.
  if (usedBytes > 0) {
    return <UsageBar label="Platform default" usedBytes={usedBytes} quotaBytes={quotaBytes} colorClass="text-fg-muted" />;
  }
  return quotaBytes > 0
    ? <span className="text-xs text-fg-muted">Not connected · uses platform default ({gbLabel(quotaBytes)} quota) automatically</span>
    : <span className="text-xs text-fg-muted">Not connected · plan has no hosted quota</span>;
}

/** Compact "how many sends went through our infrastructure" badge for the orgs table. */
function PlatformSendBadge({ sendCounts }: { sendCounts: SendCounts }) {
  const platformTotal = sendCounts.email.platform + sendCounts.whatsapp.platform;
  if (platformTotal === 0) return <span className="text-xs text-fg-subtle">—</span>;
  return (
    <span className="inline-flex items-center gap-2.5 text-xs text-fg">
      {sendCounts.email.platform > 0 && (
        <span className="inline-flex items-center gap-1" title={`${sendCounts.email.platform} emails sent via the platform`}>
          <Mail size={12} className="text-fg-subtle" />{sendCounts.email.platform}
        </span>
      )}
      {sendCounts.whatsapp.platform > 0 && (
        <span className="inline-flex items-center gap-1" title={`${sendCounts.whatsapp.platform} WhatsApp messages sent via the platform`}>
          <MessageCircle size={12} className="text-fg-subtle" />{sendCounts.whatsapp.platform}
        </span>
      )}
    </span>
  );
}

/** Section heading inside the detail/settings panels. */
function PanelHeading({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-xs font-semibold text-fg-muted uppercase inline-flex items-center gap-1">{children}</h3>
      {actions}
    </div>
  );
}

/** Full own-vs-platform-vs-total breakdown for the detail panel. */
function SendCountsSection({ sendCounts }: { sendCounts: SendCounts }) {
  return (
    <section>
      <PanelHeading>Sending activity (all time)</PanelHeading>
      <Card tone="sunken" padding="sm" flat className="text-sm space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-fg-muted inline-flex items-center gap-1"><Mail size={12} /> Email</span>
          <span className="font-medium text-fg">{sendCounts.email.own} own · {sendCounts.email.platform} via us · {sendCounts.email.total} total</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-fg-muted inline-flex items-center gap-1"><MessageCircle size={12} /> WhatsApp</span>
          <span className="font-medium text-fg">{sendCounts.whatsapp.own} own · {sendCounts.whatsapp.platform} via us · {sendCounts.whatsapp.total} total</span>
        </div>
      </Card>
    </section>
  );
}

function ConnectionBadge({ connected, label }: { connected: boolean; label: string }) {
  return (
    <Badge variant={connected ? 'green' : 'gray'}>
      {connected ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {label}
    </Badge>
  );
}

/** Small inline field-edit control: click the pencil to reveal Save/Cancel, shared by all sections below. */
function SectionEditToggle({ editing, onEdit, onCancel, onSave, saving }: { editing: boolean; onEdit: () => void; onCancel: () => void; onSave: () => void; saving: boolean }) {
  if (!editing) {
    return <IconButton size="xs" label="Edit" icon={<Pencil size={12} />} onClick={onEdit} />;
  }
  return (
    <div className="flex items-center gap-1">
      <Button size="xs" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      <Button size="xs" icon={<Check size={12} />} loading={saving} onClick={onSave}>Save</Button>
    </div>
  );
}

/** Org display name — the one field on Organization itself (PATCH /platform/orgs/:id). */
function OrgNameEditor({ org }: { org: PlatformOrgDetail }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.name);
  const mutation = useUpdatePlatformOrg();

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xl font-bold text-fg">{org.branding?.companyName || org.name}</div>
          <div className="text-sm text-fg-muted">{org.slug}</div>
        </div>
        <IconButton
          label="Edit org name"
          icon={<Pencil size={13} />}
          className="mt-1"
          onClick={() => { setName(org.name); setEditing(true); }}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Organization name"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Organization name"
      />
      <SectionEditToggle
        editing
        onEdit={() => {}}
        onCancel={() => setEditing(false)}
        saving={mutation.isPending}
        onSave={() => mutation.mutate({ id: org.id, name }, { onSuccess: () => setEditing(false) })}
      />
    </div>
  );
}

/** License / plan section — plan/seats/status/renewal-cancel toggle (PATCH /platform/orgs/:id/subscription). */
function SubscriptionEditor({ org }: { org: PlatformOrgDetail }) {
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState(org.subscription?.plan ?? org.plan);
  const [seats, setSeats] = useState(org.subscription?.seats ?? 5);
  const [status, setStatus] = useState(org.subscription?.status ?? 'active');
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(org.subscription?.cancelAtPeriodEnd ?? false);
  const mutation = useUpdatePlatformSubscription();

  const startEdit = () => {
    setPlan(org.subscription?.plan ?? org.plan);
    setSeats(org.subscription?.seats ?? 5);
    setStatus(org.subscription?.status ?? 'active');
    setCancelAtPeriodEnd(org.subscription?.cancelAtPeriodEnd ?? false);
    setEditing(true);
  };

  return (
    <section>
      <PanelHeading
        actions={
          <SectionEditToggle
            editing={editing}
            onEdit={startEdit}
            onCancel={() => setEditing(false)}
            saving={mutation.isPending}
            onSave={() => mutation.mutate({ id: org.id, plan: plan as 'FREE' | 'PRO' | 'ENTERPRISE', seats, status, cancelAtPeriodEnd }, { onSuccess: () => setEditing(false) })}
          />
        }
      >
        License / plan
      </PanelHeading>
      {editing ? (
        <Card tone="sunken" padding="sm" flat className="space-y-3">
          <Field label="Plan">
            <Select
              value={plan}
              onChange={e => setPlan(e.target.value)}
              options={[
                { value: 'FREE', label: 'FREE' },
                { value: 'PRO', label: 'PRO' },
                { value: 'ENTERPRISE', label: 'ENTERPRISE' },
              ]}
            />
          </Field>
          <Field label="Seats">
            <Input type="number" min={1} value={seats} onChange={e => setSeats(Number(e.target.value))} />
          </Field>
          <Field label="Status">
            <Input value={status} onChange={e => setStatus(e.target.value)} />
          </Field>
          <Checkbox
            label="Cancel at period end"
            checked={cancelAtPeriodEnd}
            onChange={e => setCancelAtPeriodEnd(e.target.checked)}
          />
        </Card>
      ) : (
        <Card tone="sunken" padding="sm" flat className="text-sm space-y-1">
          <div className="flex justify-between"><span className="text-fg-muted">Plan</span><span className="font-medium text-fg">{org.subscription?.plan ?? org.plan}</span></div>
          <div className="flex justify-between"><span className="text-fg-muted">Status</span><span className="font-medium text-fg">{org.subscription?.status ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-fg-muted">Seats</span><span className="font-medium text-fg">{org.subscription?.seats ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-fg-muted">Renews</span><span className="font-medium text-fg">{org.subscription?.currentPeriodEnd ? new Date(org.subscription.currentPeriodEnd).toLocaleDateString() : '—'}{org.subscription?.cancelAtPeriodEnd ? ' (cancelling)' : ''}</span></div>
          <div className="flex justify-between"><span className="text-fg-muted">Stripe customer</span><span className="font-mono text-xs text-fg-muted">{org.subscription?.stripeCustomerId ?? 'not connected'}</span></div>
        </Card>
      )}
    </section>
  );
}

/** Branding section — companyName/supportEmail/primaryColor (PATCH /platform/orgs/:id/branding). */
function BrandingEditor({ org }: { org: PlatformOrgDetail }) {
  const [editing, setEditing] = useState(false);
  const [companyName, setCompanyName] = useState(org.branding?.companyName ?? '');
  const [supportEmail, setSupportEmail] = useState(org.branding?.supportEmail ?? '');
  const [primaryColor, setPrimaryColor] = useState(org.branding?.primaryColor ?? '#2563eb');
  const mutation = useUpdatePlatformBranding();

  const startEdit = () => {
    setCompanyName(org.branding?.companyName ?? '');
    setSupportEmail(org.branding?.supportEmail ?? '');
    setPrimaryColor(org.branding?.primaryColor ?? '#2563eb');
    setEditing(true);
  };

  return (
    <section>
      <PanelHeading
        actions={
          <SectionEditToggle
            editing={editing}
            onEdit={startEdit}
            onCancel={() => setEditing(false)}
            saving={mutation.isPending}
            onSave={() => mutation.mutate(
              { id: org.id, companyName: companyName || undefined, supportEmail: supportEmail || null, primaryColor },
              { onSuccess: () => setEditing(false) },
            )}
          />
        }
      >
        Branding
      </PanelHeading>
      {editing ? (
        <Card tone="sunken" padding="sm" flat className="space-y-3">
          <Field label="Company name">
            <Input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder={org.name} />
          </Field>
          <Field label="Support email">
            <Input type="email" value={supportEmail} onChange={e => setSupportEmail(e.target.value)} placeholder="support@…" />
          </Field>
          <Field label="Primary color">
            {/* A native colour swatch keeps its own sizing rather than the
                shared text-input geometry. */}
            <input
              type="color"
              aria-label="Primary color"
              className="w-10 h-7 p-0.5 border border-line rounded-input"
              value={primaryColor}
              onChange={e => setPrimaryColor(e.target.value)}
            />
          </Field>
        </Card>
      ) : (
        <Card tone="sunken" padding="sm" flat className="text-sm space-y-1">
          <div className="flex justify-between"><span className="text-fg-muted">Company name</span><span className="font-medium text-fg">{org.branding?.companyName ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-fg-muted">Support email</span><span className="font-medium text-fg">{org.branding?.supportEmail ?? '—'}</span></div>
          <div className="flex items-center justify-between"><span className="text-fg-muted">Primary color</span><span className="flex items-center gap-1.5 text-fg"><span className="w-3 h-3 rounded-full border border-line" style={{ background: org.branding?.primaryColor }} />{org.branding?.primaryColor ?? '—'}</span></div>
        </Card>
      )}
    </section>
  );
}

function SecretFieldStatus({ status }: { status: PlatformSecretStatus }) {
  if (!status.configured) return <span className="text-fg-subtle">Not configured</span>;
  return (
    <span className="text-success inline-flex items-center gap-1">
      <CheckCircle2 size={11} /> Configured ({status.source === 'database' ? 'set here' : 'from env var'})
    </span>
  );
}

interface SettingsFormState {
  resendFrom: string; smtpHost: string; smtpPort: string; smtpUser: string; smtpFrom: string;
  twilioAccountSid: string; twilioFromNumber: string;
  resendApiKey: string; smtpPass: string; twilioAuthToken: string;
}

/**
 * The platform-wide email/WhatsApp *fallback* config — the account used to
 * send on behalf of an org that hasn't connected its own (Tier 1
 * white-label mailer, Twilio WhatsApp fallback). Previously only settable
 * via Render env vars; this panel writes straight to the PlatformSettings
 * DB row, which takes effect immediately, no redeploy.
 */
function PlatformSettingsPanel({ onClose }: { onClose: () => void }) {
  const { data: settings, isLoading } = usePlatformSettings();
  const mutation = useUpdatePlatformSettings();
  const [form, setForm] = useState<SettingsFormState | null>(null);

  useEffect(() => {
    if (!settings) return;
    setForm({
      resendFrom: settings.resendFrom ?? '',
      smtpHost: settings.smtpHost ?? '',
      smtpPort: settings.smtpPort != null ? String(settings.smtpPort) : '',
      smtpUser: settings.smtpUser ?? '',
      smtpFrom: settings.smtpFrom ?? '',
      twilioAccountSid: settings.twilioAccountSid ?? '',
      twilioFromNumber: settings.twilioFromNumber ?? '',
      resendApiKey: '',
      smtpPass: '',
      twilioAuthToken: '',
    });
  }, [settings]);

  const set = (key: keyof SettingsFormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => (f ? { ...f, [key]: e.target.value } : f));

  const save = () => {
    if (!form) return;
    const payload: PlatformSettingsUpdate = {
      resendFrom: form.resendFrom,
      smtpHost: form.smtpHost,
      smtpPort: form.smtpPort === '' ? null : Number(form.smtpPort),
      smtpUser: form.smtpUser,
      smtpFrom: form.smtpFrom,
      twilioAccountSid: form.twilioAccountSid,
      twilioFromNumber: form.twilioFromNumber,
    };
    if (form.resendApiKey) payload.resendApiKey = form.resendApiKey;
    if (form.smtpPass) payload.smtpPass = form.smtpPass;
    if (form.twilioAuthToken) payload.twilioAuthToken = form.twilioAuthToken;
    mutation.mutate(payload, {
      onSuccess: () => setForm(f => (f ? { ...f, resendApiKey: '', smtpPass: '', twilioAuthToken: '' } : f)),
    });
  };

  const clearSecret = (field: 'resendApiKey' | 'smtpPass' | 'twilioAuthToken') => {
    mutation.mutate({ [field]: '' } as PlatformSettingsUpdate);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Platform settings"
      subtitle="The shared sending account used when an org hasn't connected its own. Changes here take effect immediately — no redeploy needed. Leave a field blank to keep using its Render env var."
      icon={<SettingsIcon size={16} />}
      size="lg"
      footer={
        settings && form ? (
          <>
            <span className="mr-auto text-xs text-fg-subtle">
              {settings.updatedAt ? `Last saved ${new Date(settings.updatedAt).toLocaleString()}` : 'Never saved — using env vars only'}
            </span>
            <Button icon={<Check size={14} />} loading={mutation.isPending} onClick={save}>
              Save changes
            </Button>
          </>
        ) : undefined
      }
    >
      {isLoading || !settings || !form ? (
        <Spinner label="Loading settings…" />
      ) : (
        <div className="space-y-6">
          <section>
            <PanelHeading><Mail size={12} /> Email fallback</PanelHeading>
            <Card tone="sunken" padding="sm" flat className="space-y-3">
              <Field label="Resend API key" hint={<SecretFieldStatus status={settings.resendApiKey} />}>
                <div className="flex gap-1.5">
                  <Input type="password" placeholder={settings.resendApiKey.configured ? '•••••••••• (leave blank to keep)' : 're_...'} value={form.resendApiKey} onChange={set('resendApiKey')} />
                  {settings.resendApiKey.source === 'database' && (
                    <Button size="sm" variant="ghost" onClick={() => clearSecret('resendApiKey')}>Clear</Button>
                  )}
                </div>
              </Field>
              <Field label='Resend "From" address'>
                <Input value={form.resendFrom} onChange={set('resendFrom')} placeholder="Name <noreply@yourdomain.com>" />
              </Field>
              <div className="border-t border-line pt-2 text-xs text-fg-subtle">SMTP fallback (used only if no Resend key is configured)</div>
              <Field label="SMTP host">
                <Input value={form.smtpHost} onChange={set('smtpHost')} placeholder="smtp.gmail.com" />
              </Field>
              <Field label="SMTP port">
                <Input type="number" value={form.smtpPort} onChange={set('smtpPort')} placeholder="587" />
              </Field>
              <Field label="SMTP user">
                <Input value={form.smtpUser} onChange={set('smtpUser')} />
              </Field>
              <Field label="SMTP password" hint={<SecretFieldStatus status={settings.smtpPass} />}>
                <div className="flex gap-1.5">
                  <Input type="password" placeholder={settings.smtpPass.configured ? '•••••••••• (leave blank to keep)' : ''} value={form.smtpPass} onChange={set('smtpPass')} />
                  {settings.smtpPass.source === 'database' && (
                    <Button size="sm" variant="ghost" onClick={() => clearSecret('smtpPass')}>Clear</Button>
                  )}
                </div>
              </Field>
              <Field label='SMTP "From" address'>
                <Input value={form.smtpFrom} onChange={set('smtpFrom')} />
              </Field>
            </Card>
          </section>

          <section>
            <PanelHeading><MessageCircle size={12} /> WhatsApp fallback (Twilio)</PanelHeading>
            <Card tone="sunken" padding="sm" flat className="space-y-3">
              <Field label="Account SID">
                <Input value={form.twilioAccountSid} onChange={set('twilioAccountSid')} placeholder="AC..." />
              </Field>
              <Field label="Auth token" hint={<SecretFieldStatus status={settings.twilioAuthToken} />}>
                <div className="flex gap-1.5">
                  <Input type="password" placeholder={settings.twilioAuthToken.configured ? '•••••••••• (leave blank to keep)' : ''} value={form.twilioAuthToken} onChange={set('twilioAuthToken')} />
                  {settings.twilioAuthToken.source === 'database' && (
                    <Button size="sm" variant="ghost" onClick={() => clearSecret('twilioAuthToken')}>Clear</Button>
                  )}
                </div>
              </Field>
              <Field label="From number">
                <Input value={form.twilioFromNumber} onChange={set('twilioFromNumber')} placeholder="whatsapp:+1415..." />
              </Field>
            </Card>
          </section>
        </div>
      )}
    </Modal>
  );
}

function OrgDetailPanel({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const { data: org, isLoading } = usePlatformOrg(orgId);

  return (
    <Modal
      open
      onClose={onClose}
      title="Organization detail"
      icon={<Building2 size={16} />}
      size="lg"
    >
      {isLoading || !org ? (
        <Spinner label="Loading org…" />
      ) : (
        <div className="space-y-6">
          <OrgNameEditor org={org} />

          <SubscriptionEditor org={org} />

          <section>
            <PanelHeading>Email sending</PanelHeading>
            <Card tone="sunken" padding="sm" flat className="text-sm space-y-1">
              {org.emailAccount ? (
                <>
                  <div className="flex justify-between"><span className="text-fg-muted">Account</span><span className="font-medium text-fg">{org.emailAccount.email}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">SMTP host</span><span className="font-medium text-fg">{org.emailAccount.smtpHost}:{org.emailAccount.smtpPort}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">Last sync</span><span className="font-medium text-fg">{org.emailAccount.lastSyncAt ? new Date(org.emailAccount.lastSyncAt).toLocaleString() : 'never'}</span></div>
                </>
              ) : (
                <div className="text-fg-muted">No org-owned SMTP connected — sends through the platform mailer instead, branded with this org's name/logo (Tier 1 white-label).</div>
              )}
            </Card>
          </section>

          <section>
            <PanelHeading>WhatsApp sending</PanelHeading>
            <Card tone="sunken" padding="sm" flat className="text-sm space-y-1">
              {org.whatsAppConfig ? (
                <>
                  <div className="flex justify-between"><span className="text-fg-muted">Sender number</span><span className="font-medium text-fg">{org.whatsAppConfig.phoneNumber}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">Notify number</span><span className="font-medium text-fg">{org.whatsAppConfig.notifyNumber ?? 'same as sender'}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">Connected</span><span className="font-medium text-fg">{new Date(org.whatsAppConfig.createdAt).toLocaleDateString()}</span></div>
                </>
              ) : (
                <div className="text-fg-muted">No WhatsApp number connected — sends through the platform's own Twilio number instead, when one is configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER).</div>
              )}
            </Card>
          </section>

          <SendCountsSection sendCounts={org.sendCounts} />

          <section>
            <PanelHeading>Attachment storage license</PanelHeading>
            <Card tone="sunken" padding="sm" flat className="text-sm space-y-2">
              <StorageBadge
                provider={org.storageConfig?.provider ?? null}
                quotaBytes={org.storageLicense.quotaBytes}
                usedBytes={org.storageLicense.usedBytes}
                connectedEmail={org.storageConfig?.connectedEmail}
              />
              {org.storageConfig?.provider === 'HOSTED_S3' && (
                <div className="flex justify-between text-xs text-fg-muted"><span>Last updated</span><span>{new Date(org.storageConfig.updatedAt).toLocaleDateString()}</span></div>
              )}
              {!org.storageConfig && (
                <p className="text-xs text-fg-muted">No storage connected yet — org can bring their own Google Drive for free, or use {gbLabel(org.storageLicense.quotaBytes)} of hosted storage included in their plan{org.storageLicense.quotaBytes === 0 ? ' once they upgrade' : ''}.</p>
              )}
            </Card>
          </section>

          <BrandingEditor org={org} />

          <section>
            <PanelHeading>Usage</PanelHeading>
            <div className="grid grid-cols-3 gap-2">
              <StatTile tone="sunken" label="Users" value={org.users.length} />
              <StatTile tone="sunken" label="Contacts" value={org._count.contacts} />
              <StatTile tone="sunken" label="Tickets" value={org._count.tickets} />
            </div>
          </section>

          <section>
            <PanelHeading>Staff</PanelHeading>
            <Card padding="none" flat className="divide-y divide-line-subtle overflow-hidden">
              {org.users.map(u => (
                <div key={u.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div>
                    <div className="font-medium text-fg">{u.name}</div>
                    <div className="text-xs text-fg-muted">{u.email}</div>
                  </div>
                  <span className="text-xs text-fg-muted">{u.role}{!u.isActive && ' · inactive'}</span>
                </div>
              ))}
            </Card>
          </section>
        </div>
      )}
    </Modal>
  );
}

export function PlatformAdminPage() {
  const { data: orgs, isLoading } = usePlatformOrgs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { logout, user } = useAuth();

  const columns: Column<PlatformOrgSummary>[] = [
    {
      key: 'org',
      header: 'Organization',
      cell: org => (
        <>
          <div className="font-medium text-fg">{org.branding?.companyName || org.name}</div>
          <div className="text-xs text-fg-muted">{org.slug}</div>
        </>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      cell: org => (
        <div className="flex items-center gap-1">
          <Badge variant="purple">{org.subscription?.plan ?? org.plan}</Badge>
          {org.subscription?.status && org.subscription.status !== 'active' && (
            <Badge variant="yellow">{org.subscription.status}</Badge>
          )}
        </div>
      ),
    },
    {
      key: 'users',
      header: 'Users',
      cell: org => (
        <span className="inline-flex items-center gap-1 text-fg">
          <UsersIcon size={13} className="text-fg-subtle" />{org.counts.users}
        </span>
      ),
    },
    {
      key: 'email',
      header: 'Email sending',
      cell: org => <ConnectionBadge connected={org.emailSending.connected} label={org.emailSending.connected ? 'Connected' : 'Platform fallback'} />,
    },
    {
      key: 'whatsapp',
      header: 'WhatsApp sending',
      cell: org => org.whatsappSending.connected
        ? <ConnectionBadge connected label={org.whatsappSending.phoneNumber ?? 'Connected'} />
        : <ConnectionBadge connected={false} label="Not connected" />,
    },
    {
      key: 'storage',
      header: 'Attachment storage',
      cell: org => (
        <StorageBadge
          provider={org.storageLicense.provider}
          quotaBytes={org.storageLicense.quotaBytes}
          usedBytes={org.storageLicense.usedBytes}
          connectedEmail={org.storageLicense.connectedEmail}
        />
      ),
    },
    { key: 'sent', header: 'Sent via us', cell: org => <PlatformSendBadge sendCounts={org.sendCounts} /> },
    {
      key: 'created',
      header: 'Created',
      muted: true,
      cell: org => new Date(org.createdAt).toLocaleDateString(),
    },
  ];

  return (
    <div className="min-h-screen bg-canvas">
      <PageHeader
        title="Platform Admin"
        subtitle={`${user?.email} · cross-org license & sending overview`}
        actions={
          <>
            <Button variant="ghost" icon={<SettingsIcon size={14} />} onClick={() => setSettingsOpen(true)}>
              Platform settings
            </Button>
            <Button variant="ghost" icon={<LogOut size={14} />} onClick={logout}>
              Sign out
            </Button>
          </>
        }
      />

      <PageBody>
        {isLoading ? (
          <Spinner label="Loading organizations…" />
        ) : (
          <Card padding="none">
            <DataTable
              columns={columns}
              rows={orgs ?? []}
              rowKey={org => org.id}
              minWidth={900}
              onRowClick={org => setSelectedId(org.id)}
              empty={<EmptyState icon={<Building2 />} title="No organizations yet." />}
            />
          </Card>
        )}
      </PageBody>

      {selectedId && <OrgDetailPanel key={selectedId} orgId={selectedId} onClose={() => setSelectedId(null)} />}
      {settingsOpen && <PlatformSettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
