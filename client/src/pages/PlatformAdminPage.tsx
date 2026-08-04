import { useState } from 'react';
import { Building2, Users as UsersIcon, CheckCircle2, XCircle, LogOut, X } from 'lucide-react';
import { usePlatformOrgs, usePlatformOrg } from '../api/platformAdmin';
import { Spinner } from '../shared/components';
import { useAuth } from '../contexts/AuthContext';

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
            <div>
              <div className="text-xl font-bold text-gray-900">{org.branding?.companyName || org.name}</div>
              <div className="text-sm text-gray-500">{org.slug}</div>
            </div>

            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">License / plan</h3>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-gray-500">Plan</span><span className="font-medium">{org.subscription?.plan ?? org.plan}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Status</span><span className="font-medium">{org.subscription?.status ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Seats</span><span className="font-medium">{org.subscription?.seats ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Renews</span><span className="font-medium">{org.subscription?.currentPeriodEnd ? new Date(org.subscription.currentPeriodEnd).toLocaleDateString() : '—'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Stripe customer</span><span className="font-mono text-xs">{org.subscription?.stripeCustomerId ?? 'not connected'}</span></div>
              </div>
            </section>

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
                  <div className="text-gray-500">No org-owned SMTP connected — falls back to the platform mailer, unbranded.</div>
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
                  <div className="text-gray-500">No WhatsApp number connected.</div>
                )}
              </div>
            </section>

            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Branding</h3>
              <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-gray-500">Company name</span><span className="font-medium">{org.branding?.companyName ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Support email</span><span className="font-medium">{org.branding?.supportEmail ?? '—'}</span></div>
                <div className="flex items-center justify-between"><span className="text-gray-500">Primary color</span><span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full border" style={{ background: org.branding?.primaryColor }} />{org.branding?.primaryColor ?? '—'}</span></div>
              </div>
            </section>

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
        <button onClick={logout} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900">
          <LogOut size={14} /> Sign out
        </button>
      </div>

      <div className="p-6 max-w-7xl mx-auto">
        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner label="Loading organizations…" /></div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-3">Organization</th>
                  <th className="text-left px-4 py-3">Plan</th>
                  <th className="text-left px-4 py-3">Users</th>
                  <th className="text-left px-4 py-3">Email sending</th>
                  <th className="text-left px-4 py-3">WhatsApp sending</th>
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
                    <td className="px-4 py-3 text-gray-500">{new Date(org.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {orgs?.length === 0 && (
              <div className="p-12 text-center text-gray-500 text-sm">No organizations yet.</div>
            )}
          </div>
        )}
      </div>

      {selectedId && <OrgDetailPanel orgId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
