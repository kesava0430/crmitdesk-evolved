import { useEffect, useState } from 'react';
import { Building2, Users as UsersIcon, CheckCircle2, XCircle, LogOut, X, HardDrive, Pencil, Check, Loader2, Mail, MessageCircle, Settings as SettingsIcon } from 'lucide-react';
import {
  usePlatformOrgs,
  usePlatformOrg,
  useUpdatePlatformOrg,
  useUpdatePlatformSubscription,
  useUpdatePlatformBranding,
  usePlatformSettings,
  useUpdatePlatformSettings,
  type PlatformOrgDetail,
  type SendCounts,
  type PlatformSecretStatus,
  type PlatformSettingsUpdate,
} from '../api/platformAdmin';
import { Spinner } from '../shared/components';
import { useAuth } from '../contexts/AuthContext';

const GB = 1024 * 1024 * 1024;
const gbLabel = (bytes: number) => `${(bytes / GB).toFixed(bytes < GB ? 2 : 1)}GB`;

function UsageBar({ label, usedBytes, quotaBytes, colorClass }: { label: string; usedBytes: number; quotaBytes: number; colorClass: string }) {
  const pct = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 100;
  return (
    <div className="flex flex-col gap-1 min-w-[120px]">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-700">
        <HardDrive size={12} className={colorClass} /> {label} · {gbLabel(usedBytes)} / {gbLabel(quotaBytes)}
      </span>
      <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-violet-500'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Storage provider label + (for hosted S3, explicit or auto-fallback) quota/usage bar — used in both the table row and the detail panel. */
function StorageBadge({ provider, quotaBytes, usedBytes, connectedEmail }: { provider: 'GOOGLE_DRIVE' | 'HOSTED_S3' | null; quotaBytes: number; usedBytes: number; connectedEmail?: string | null }) {
  if (provider === 'GOOGLE_DRIVE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
        <HardDrive size={12} /> Own Google Drive{connectedEmail ? ` (${connectedEmail})` : ''}
      </span>
    );
  }
  if (provider === 'HOSTED_S3') {
    return <UsageBar label="Hosted S3" usedBytes={usedBytes} quotaBytes={quotaBytes} colorClass="text-violet-600" />;
  }
  // No StorageConfig row — but storage.ts auto-falls-back unconnected orgs
  // straight to our hosted S3, so there may still be real usage here.
  if (usedBytes > 0) {
    return <UsageBar label="Platform default" usedBytes={usedBytes} quotaBytes={quotaBytes} colorClass="text-gray-500" />;
  }
  return quotaBytes > 0
    ? <span className="text-xs text-gray-500">Not connected · uses platform default ({gbLabel(quotaBytes)} quota) automatically</span>
    : <span className="text-xs text-gray-500">Not connected · plan has no hosted quota</span>;
}

/** Compact "how many sends went through our infrastructure" badge for the orgs table. */
function PlatformSendBadge({ sendCounts }: { sendCounts: SendCounts }) {
  const platformTotal = sendCounts.email.platform + sendCounts.whatsapp.platform;
  if (platformTotal === 0) return <span className="text-xs text-gray-400">—</span>;
  return (
    <span className="inline-flex items-center gap-2.5 text-xs text-gray-700">
      {sendCounts.email.platform > 0 && (
        <span className="inline-flex items-center gap-1" title={`${sendCounts.email.platform} emails sent via the platform`}>
          <Mail size={12} className="text-gray-400" />{sendCounts.email.platform}
        </span>
      )}
      {sendCounts.whatsapp.platform > 0 && (
        <span className="inline-flex items-center gap-1" title={`${sendCounts.whatsapp.platform} WhatsApp messages sent via the platform`}>
          <MessageCircle size={12} className="text-gray-400" />{sendCounts.whatsapp.platform}
        </span>
      )}
    </span>
  );
}

/** Full own-vs-platform-vs-total breakdown for the detail panel. */
function SendCountsSection({ sendCounts }: { sendCounts: SendCounts }) {
  return (
    <section>
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Sending activity (all time)</h3>
      <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-gray-500 inline-flex items-center gap-1"><Mail size={12} /> Email</span>
          <span className="font-medium">{sendCounts.email.own} own · {sendCounts.email.platform} via us · {sendCounts.email.total} total</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-500 inline-flex items-center gap-1"><MessageCircle size={12} /> WhatsApp</span>
          <span className="font-medium">{sendCounts.whatsapp.own} own · {sendCounts.whatsapp.platform} via us · {sendCounts.whatsapp.total} total</span>
        </div>
      </div>
    </section>
  );
}

function ConnectionBadge({ connected, label }: { connected: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
      connected ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
    }`}>
      {connected ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {label}
    </span>
  );
}

/** Small inline field-edit control: click the pencil to reveal Save/Cancel, shared by all sections below. */
function SectionEditToggle({ editing, onEdit, onCancel, onSave, saving }: { editing: boolean; onEdit: () => void; onCancel: () => void; onSave: () => void; saving: boolean }) {
  if (!editing) {
    return (
      <button onClick={onEdit} className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-700" title="Edit">
        <Pencil size={12} />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <button onClick={onCancel} disabled={saving} className="px-2 py-0.5 text-xs rounded text-gray-500 hover:bg-gray-200">Cancel</button>
      <button onClick={onSave} disabled={saving} className="px-2 py-0.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-700 inline-flex items-center gap-1">
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
      </button>
    </div>
  );
}

const inputCls = 'w-full px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500';

/** Org display name — the one field on Organization itself (PATCH /platform/orgs/:id). */
function OrgNameEditor({ org }: { org: PlatformOrgDetail }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.name);
  const mutation = useUpdatePlatformOrg();

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xl font-bold text-gray-900">{org.branding?.companyName || org.name}</div>
          <div className="text-sm text-gray-500">{org.slug}</div>
        </div>
        <button onClick={() => { setName(org.name); setEditing(true); }} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 mt-1" title="Edit org name">
          <Pencil size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="Organization name" />
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
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-500 uppercase">License / plan</h3>
        <SectionEditToggle
          editing={editing}
          onEdit={startEdit}
          onCancel={() => setEditing(false)}
          saving={mutation.isPending}
          onSave={() => mutation.mutate({ id: org.id, plan: plan as 'FREE' | 'PRO' | 'ENTERPRISE', seats, status, cancelAtPeriodEnd }, { onSuccess: () => setEditing(false) })}
        />
      </div>
      {editing ? (
        <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-2">
          <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Plan</span>
            <select className={inputCls + ' max-w-[160px]'} value={plan} onChange={e => setPlan(e.target.value)}>
              <option value="FREE">FREE</option>
              <option value="PRO">PRO</option>
              <option value="ENTERPRISE">ENTERPRISE</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Seats</span>
            <input type="number" min={1} className={inputCls + ' max-w-[160px]'} value={seats} onChange={e => setSeats(Number(e.target.value))} />
          </label>
          <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Status</span>
            <input className={inputCls + ' max-w-[160px]'} value={status} onChange={e => setStatus(e.target.value)} />
          </label>
          <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Cancel at period end</span>
            <input type="checkbox" checked={cancelAtPeriodEnd} onChange={e => setCancelAtPeriodEnd(e.target.checked)} />
          </label>
        </div>
      ) : (
        <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-gray-500">Plan</span><span className="font-medium">{org.subscription?.plan ?? org.plan}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Status</span><span className="font-medium">{org.subscription?.status ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Seats</span><span className="font-medium">{org.subscription?.seats ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Renews</span><span className="font-medium">{org.subscription?.currentPeriodEnd ? new Date(org.subscription.currentPeriodEnd).toLocaleDateString() : '—'}{org.subscription?.cancelAtPeriodEnd ? ' (cancelling)' : ''}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Stripe customer</span><span className="font-mono text-xs">{org.subscription?.stripeCustomerId ?? 'not connected'}</span></div>
        </div>
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
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-500 uppercase">Branding</h3>
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
      </div>
      {editing ? (
        <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-2">
          <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Company name</span>
            <input className={inputCls + ' max-w-[180px]'} value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder={org.name} />
          </label>
          <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Support email</span>
            <input type="email" className={inputCls + ' max-w-[180px]'} value={supportEmail} onChange={e => setSupportEmail(e.target.value)} placeholder="support@…" />
          </label>
          <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Primary color</span>
            <input type="color" className="w-10 h-7 p-0.5 border border-gray-200 rounded-lg" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} />
          </label>
        </div>
      ) : (
        <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-gray-500">Company name</span><span className="font-medium">{org.branding?.companyName ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Support email</span><span className="font-medium">{org.branding?.supportEmail ?? '—'}</span></div>
          <div className="flex items-center justify-between"><span className="text-gray-500">Primary color</span><span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full border" style={{ background: org.branding?.primaryColor }} />{org.branding?.primaryColor ?? '—'}</span></div>
        </div>
      )}
    </section>
  );
}

function SecretFieldStatus({ status }: { status: PlatformSecretStatus }) {
  if (!status.configured) return <span className="text-xs text-gray-400">Not configured</span>;
  return (
    <span className="text-xs text-green-600 inline-flex items-center gap-1">
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
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white h-full shadow-xl overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-gray-900">Platform settings</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={18} /></button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          The shared sending account used when an org hasn't connected its own. Changes here take effect immediately — no redeploy needed. Leave a field blank to keep using its Render env var.
        </p>

        {isLoading || !settings || !form ? (
          <div className="flex justify-center py-12"><Spinner label="Loading settings…" /></div>
        ) : (
          <div className="space-y-6">
            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2 inline-flex items-center gap-1"><Mail size={12} /> Email fallback</h3>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1"><span className="text-gray-500">Resend API key</span><SecretFieldStatus status={settings.resendApiKey} /></div>
                  <div className="flex gap-1.5">
                    <input type="password" className={inputCls} placeholder={settings.resendApiKey.configured ? '•••••••••• (leave blank to keep)' : 're_...'} value={form.resendApiKey} onChange={set('resendApiKey')} />
                    {settings.resendApiKey.source === 'database' && (
                      <button onClick={() => clearSecret('resendApiKey')} className="px-2 text-xs text-gray-500 hover:text-red-600 whitespace-nowrap">Clear</button>
                    )}
                  </div>
                </div>
                <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Resend "From" address</span>
                  <input className={inputCls + ' max-w-[220px]'} value={form.resendFrom} onChange={set('resendFrom')} placeholder="Name <noreply@yourdomain.com>" />
                </label>
                <div className="border-t border-gray-200 pt-2 text-xs text-gray-400">SMTP fallback (used only if no Resend key is configured)</div>
                <label className="flex items-center justify-between gap-2"><span className="text-gray-500">SMTP host</span>
                  <input className={inputCls + ' max-w-[220px]'} value={form.smtpHost} onChange={set('smtpHost')} placeholder="smtp.gmail.com" />
                </label>
                <label className="flex items-center justify-between gap-2"><span className="text-gray-500">SMTP port</span>
                  <input type="number" className={inputCls + ' max-w-[220px]'} value={form.smtpPort} onChange={set('smtpPort')} placeholder="587" />
                </label>
                <label className="flex items-center justify-between gap-2"><span className="text-gray-500">SMTP user</span>
                  <input className={inputCls + ' max-w-[220px]'} value={form.smtpUser} onChange={set('smtpUser')} />
                </label>
                <div>
                  <div className="flex items-center justify-between mb-1"><span className="text-gray-500">SMTP password</span><SecretFieldStatus status={settings.smtpPass} /></div>
                  <div className="flex gap-1.5">
                    <input type="password" className={inputCls} placeholder={settings.smtpPass.configured ? '•••••••••• (leave blank to keep)' : ''} value={form.smtpPass} onChange={set('smtpPass')} />
                    {settings.smtpPass.source === 'database' && (
                      <button onClick={() => clearSecret('smtpPass')} className="px-2 text-xs text-gray-500 hover:text-red-600 whitespace-nowrap">Clear</button>
                    )}
                  </div>
                </div>
                <label className="flex items-center justify-between gap-2"><span className="text-gray-500">SMTP "From" address</span>
                  <input className={inputCls + ' max-w-[220px]'} value={form.smtpFrom} onChange={set('smtpFrom')} />
                </label>
              </div>
            </section>

            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2 inline-flex items-center gap-1"><MessageCircle size={12} /> WhatsApp fallback (Twilio)</h3>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-3">
                <label className="flex items-center justify-between gap-2"><span className="text-gray-500">Account SID</span>
                  <input className={inputCls + ' max-w-[220px]'} value={form.twilioAccountSid} onChange={set('twilioAccountSid')} placeholder="AC..." />
                </label>
                <div>
                  <div className="flex items-center justify-between mb-1"><span className="text-gray-500">Auth token</span><SecretFieldStatus status={settings.twilioAuthToken} /></div>
                  <div className="flex gap-1.5">
                    <input type="password" className={inputCls} placeholder={settings.twilioAuthToken.configured ? '•••••••••• (leave blank to keep)' : ''} value={form.twilioAuthToken} onChange={set('twilioAuthToken')} />
                    {settings.twilioAuthToken.source === 'database' && (
                      <button onClick={() => clearSecret('twilioAuthToken')} className="px-2 text-xs text-gray-500 hover:text-red-600 whitespace-nowrap">Clear</button>
                    )}
                  </div>
                </div>
                <label className="flex items-center justify-between gap-2"><span className="text-gray-500">From number</span>
                  <input className={inputCls + ' max-w-[220px]'} value={form.twilioFromNumber} onChange={set('twilioFromNumber')} placeholder="whatsapp:+1415..." />
                </label>
              </div>
            </section>

            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">{settings.updatedAt ? `Last saved ${new Date(settings.updatedAt).toLocaleString()}` : 'Never saved — using env vars only'}</span>
              <button onClick={save} disabled={mutation.isPending} className="px-4 py-2 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 inline-flex items-center gap-1.5 disabled:opacity-60">
                {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save changes
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OrgDetailPanel({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const { data: org, isLoading } = usePlatformOrg(orgId);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white h-full shadow-xl overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Organization detail</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={18} /></button>
        </div>

        {isLoading || !org ? (
          <div className="flex justify-center py-12"><Spinner label="Loading org…" /></div>
        ) : (
          <div className="space-y-6">
            <OrgNameEditor org={org} />

            <SubscriptionEditor org={org} />

            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Email sending</h3>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
                {org.emailAccount ? (
                  <>
                    <div className="flex justify-between"><span className="text-gray-500">Account</span><span className="font-medium">{org.emailAccount.email}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">SMTP host</span><span className="font-medium">{org.emailAccount.smtpHost}:{org.emailAccount.smtpPort}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Last sync</span><span className="font-medium">{org.emailAccount.lastSyncAt ? new Date(org.emailAccount.lastSyncAt).toLocaleString() : 'never'}</span></div>
                  </>
                ) : (
                  <div className="text-gray-500">No org-owned SMTP connected — sends through the platform mailer instead, branded with this org's name/logo (Tier 1 white-label).</div>
                )}
              </div>
            </section>

            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">WhatsApp sending</h3>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
                {org.whatsAppConfig ? (
                  <>
                    <div className="flex justify-between"><span className="text-gray-500">Sender number</span><span className="font-medium">{org.whatsAppConfig.phoneNumber}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Notify number</span><span className="font-medium">{org.whatsAppConfig.notifyNumber ?? 'same as sender'}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Connected</span><span className="font-medium">{new Date(org.whatsAppConfig.createdAt).toLocaleDateString()}</span></div>
                  </>
                ) : (
                  <div className="text-gray-500">No WhatsApp number connected — sends through the platform's own Twilio number instead, when one is configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER).</div>
                )}
              </div>
            </section>

            <SendCountsSection sendCounts={org.sendCounts} />

            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Attachment storage license</h3>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-2">
                <StorageBadge
                  provider={org.storageConfig?.provider ?? null}
                  quotaBytes={org.storageLicense.quotaBytes}
                  usedBytes={org.storageLicense.usedBytes}
                  connectedEmail={org.storageConfig?.connectedEmail}
                />
                {org.storageConfig?.provider === 'HOSTED_S3' && (
                  <div className="flex justify-between text-xs text-gray-500"><span>Last updated</span><span>{new Date(org.storageConfig.updatedAt).toLocaleDateString()}</span></div>
                )}
                {!org.storageConfig && (
                  <p className="text-xs text-gray-500">No storage connected yet — org can bring their own Google Drive for free, or use {gbLabel(org.storageLicense.quotaBytes)} of hosted storage included in their plan{org.storageLicense.quotaBytes === 0 ? ' once they upgrade' : ''}.</p>
                )}
              </div>
            </section>

            <BrandingEditor org={org} />

            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Usage</h3>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-gray-50 rounded-xl p-3"><div className="text-lg font-bold">{org.users.length}</div><div className="text-xs text-gray-500">Users</div></div>
                <div className="bg-gray-50 rounded-xl p-3"><div className="text-lg font-bold">{org._count.contacts}</div><div className="text-xs text-gray-500">Contacts</div></div>
                <div className="bg-gray-50 rounded-xl p-3"><div className="text-lg font-bold">{org._count.tickets}</div><div className="text-xs text-gray-500">Tickets</div></div>
              </div>
            </section>

            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Staff</h3>
              <div className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
                {org.users.map(u => (
                  <div key={u.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium text-gray-900">{u.name}</div>
                      <div className="text-xs text-gray-500">{u.email}</div>
                    </div>
                    <span className="text-xs text-gray-500">{u.role}{!u.isActive && ' · inactive'}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export function PlatformAdminPage() {
  const { data: orgs, isLoading } = usePlatformOrgs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { logout, user } = useAuth();

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="border-b border-gray-200 bg-white px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 size={20} className="text-brand-600" />
          <div>
            <h1 className="text-lg font-bold text-gray-900">Platform Admin</h1>
            <p className="text-xs text-gray-500">{user?.email} · cross-org license &amp; sending overview</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => setSettingsOpen(true)} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900">
            <SettingsIcon size={14} /> Platform settings
          </button>
          <button onClick={logout} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900">
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </div>

      <div className="p-6 max-w-7xl mx-auto">
        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner label="Loading organizations…" /></div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <div className="table-container">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-3">Organization</th>
                  <th className="text-left px-4 py-3">Plan</th>
                  <th className="text-left px-4 py-3">Users</th>
                  <th className="text-left px-4 py-3">Email sending</th>
                  <th className="text-left px-4 py-3">WhatsApp sending</th>
                  <th className="text-left px-4 py-3">Attachment storage</th>
                  <th className="text-left px-4 py-3">Sent via us</th>
                  <th className="text-left px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orgs?.map(org => (
                  <tr key={org.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedId(org.id)}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{org.branding?.companyName || org.name}</div>
                      <div className="text-xs text-gray-500">{org.slug}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700">
                        {org.subscription?.plan ?? org.plan}
                      </span>
                      {org.subscription?.status && org.subscription.status !== 'active' && (
                        <span className="ml-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">{org.subscription.status}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700"><span className="inline-flex items-center gap-1"><UsersIcon size={13} className="text-gray-400" />{org.counts.users}</span></td>
                    <td className="px-4 py-3"><ConnectionBadge connected={org.emailSending.connected} label={org.emailSending.connected ? 'Connected' : 'Platform fallback'} /></td>
                    <td className="px-4 py-3">
                      {org.whatsappSending.connected
                        ? <ConnectionBadge connected label={org.whatsappSending.phoneNumber ?? 'Connected'} />
                        : <ConnectionBadge connected={false} label="Not connected" />}
                    </td>
                    <td className="px-4 py-3">
                      <StorageBadge
                        provider={org.storageLicense.provider}
                        quotaBytes={org.storageLicense.quotaBytes}
                        usedBytes={org.storageLicense.usedBytes}
                        connectedEmail={org.storageLicense.connectedEmail}
                      />
                    </td>
                    <td className="px-4 py-3"><PlatformSendBadge sendCounts={org.sendCounts} /></td>
                    <td className="px-4 py-3 text-gray-500">{new Date(org.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {orgs?.length === 0 && (
              <div className="p-12 text-center text-gray-500 text-sm">No organizations yet.</div>
            )}
          </div>
        )}
      </div>

      {selectedId && <OrgDetailPanel key={selectedId} orgId={selectedId} onClose={() => setSelectedId(null)} />}
      {settingsOpen && <PlatformSettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
