import { useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { HardDrive, CheckCircle, AlertCircle, ExternalLink, Unplug, Cloud, ArrowRightLeft } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useStorageStatus, useConnectGoogleDrive, useConnectHostedStorage, useDisconnectStorage } from '../api/storage';
import { Button, Spinner } from '../shared/components';
import { addToast } from '../shared/components/toastStore';

function formatGB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(bytes > 0 && bytes < 1024 * 1024 * 1024 ? 2 : 0);
}

export default function StoragePage() {
  const { user } = useAuth();
  const isOwner = user?.role === 'SUPER_ADMIN';
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: status, isLoading, error, refetch } = useStorageStatus();
  // GET /storage/status is MANAGERS-only (SUPER_ADMIN, IT_MANAGER,
  // CRM_MANAGER). Anyone else reaches this page — there is no route guard —
  // gets a 403, which left `status` undefined and made every card below fall
  // into its `!status?.configured` branch: the page told them Google Drive was
  // "not set up on this deployment (missing GOOGLE_CLIENT_ID/SECRET)" when the
  // real answer was that they were not allowed to ask. Two very different
  // problems that looked identical.
  const forbidden = (error as any)?.response?.status === 403;
  const connect = useConnectGoogleDrive();
  const connectHosted = useConnectHostedStorage();
  const disconnect = useDisconnectStorage();
  const hostedQuotaBytes = status?.hosted.quotaBytes ?? 0;

  // The OAuth callback (storage.controller.ts) redirects the browser straight
  // back to this page with ?connected=1 or ?error=... — surface it once,
  // then strip the query param so a refresh doesn't re-show the same toast.
  useEffect(() => {
    if (searchParams.get('connected')) {
      addToast('Google Drive connected. Attachments will now upload there.', 'success');
      setSearchParams({}, { replace: true });
    } else if (searchParams.get('error')) {
      addToast(`Couldn't connect Google Drive: ${searchParams.get('error')}`, 'error', 10000);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <HardDrive size={24} className="text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-fg">Storage</h1>
          <p className="text-sm text-fg-muted">Connect where file attachments on records get uploaded.</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Spinner label="Checking storage connection…" /></div>
      ) : forbidden ? (
        <div className="bg-surface rounded-2xl border border-line shadow-sm p-6">
          <div className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl">
            <AlertCircle size={18} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                Your role can’t view storage settings
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                Storage is visible to Super Admin, IT Manager and CRM Manager, and only a Super Admin
                can connect or change a provider. You are signed in as <strong>{user?.role?.replace(/_/g, ' ').toLowerCase()}</strong>.
              </p>
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="bg-surface rounded-2xl border border-line shadow-sm p-6">
          <div className="flex items-start gap-3 p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-xl">
            <AlertCircle size={18} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-800 dark:text-red-300">Couldn’t load storage settings</p>
              <p className="text-sm text-red-700 dark:text-red-400 mt-1">
                {(error as any)?.response?.data?.error || (error as any)?.message || 'The server did not respond.'}
              </p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => refetch()}>Try again</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-surface rounded-2xl border border-line shadow-sm p-6 space-y-5">
          {status?.connected && (
            <div className="space-y-4">
              {status.provider === 'GOOGLE_DRIVE' ? (
                <>
                  <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-xl">
                    <CheckCircle size={18} className="text-green-600 dark:text-green-400 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-green-800 dark:text-green-300">Google Drive connected</p>
                      <p className="text-sm text-green-700 dark:text-green-400">{status.connectedEmail}</p>
                    </div>
                  </div>
                  <p className="text-sm text-fg-muted">
                    Every attachment uploaded on a record is saved to a "CRMITdesk Evolved Attachments" folder in this Drive account.
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-xl">
                    <CheckCircle size={18} className="text-green-600 dark:text-green-400 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-green-800 dark:text-green-300">Hosted storage connected</p>
                      <p className="text-sm text-green-700 dark:text-green-400">Attachments are stored on our infrastructure.</p>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-fg-muted mb-1">
                      <span>{formatGB(status.hosted.usedBytes)} GB used</span>
                      <span>{formatGB(status.hosted.quotaBytes)} GB quota</span>
                    </div>
                    <div className="h-2 bg-surface-sunken rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${status.hosted.quotaBytes > 0 && status.hosted.usedBytes / status.hosted.quotaBytes > 0.9 ? 'bg-red-500' : 'bg-brand-500'}`}
                        style={{ width: `${status.hosted.quotaBytes > 0 ? Math.min(100, (status.hosted.usedBytes / status.hosted.quotaBytes) * 100) : 100}%` }}
                      />
                    </div>
                  </div>
                </>
              )}
              {isOwner ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    icon={<Unplug size={14} />}
                    loading={disconnect.isPending}
                    onClick={() => {
                      if (confirm('Disconnect storage? Existing attachments already uploaded stay where they are until deleted individually — new uploads will fail until a storage provider is reconnected.')) {
                        disconnect.mutate();
                      }
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-fg-subtle">Only the org owner (Super Admin) can change storage settings.</p>
              )}
            </div>
          )}

          {/* Options to connect or switch — shown even when already connected, so switching provider doesn't require disconnecting first */}
          <div className={status?.connected ? 'pt-5 border-t border-line-subtle' : ''}>
            {status?.connected && (
              <p className="text-xs font-medium text-fg-muted uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <ArrowRightLeft size={12} /> Switch provider
              </p>
            )}
            <div className="grid sm:grid-cols-2 gap-3">
              {/* Google Drive (bring-your-own) */}
              <div className="border border-line rounded-xl p-4">
                <p className="text-sm font-semibold text-fg mb-1">Your own Google Drive</p>
                <p className="text-xs text-fg-muted mb-3">Free on every plan — no storage limit from us, since it's your own account.</p>
                {!status?.configured ? (
                  <div className="flex items-start gap-2 p-2.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                    <AlertCircle size={14} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700 dark:text-amber-400">Not available on this deployment yet — whoever runs this server needs to add Google OAuth credentials (<code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code>) and restart it.</p>
                  </div>
                ) : !isOwner ? (
                  <p className="text-xs text-fg-subtle">Only the org owner can connect this.</p>
                ) : status?.provider === 'GOOGLE_DRIVE' ? (
                  <p className="text-xs text-green-600 dark:text-green-400 font-medium">Currently active</p>
                ) : (
                  <Button size="sm" icon={<ExternalLink size={13} />} loading={connect.isPending} onClick={() => connect.mutate()}>
                    Connect Google Drive
                  </Button>
                )}
              </div>

              {/* Our hosted storage */}
              <div className="border border-line rounded-xl p-4">
                <p className="text-sm font-semibold text-fg mb-1 flex items-center gap-1.5"><Cloud size={14} /> Our hosted storage</p>
                <p className="text-xs text-fg-muted mb-3">
                  {hostedQuotaBytes > 0
                    ? `Included with your plan: ${formatGB(hostedQuotaBytes)}GB, no Google account needed.`
                    : "Not included on your current plan — upgrade to Pro (5GB) or Enterprise (50GB)."}
                </p>
                {!status?.hosted.available ? (
                  <div className="flex items-start gap-2 p-2.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg">
                    <AlertCircle size={14} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700 dark:text-amber-400">Not available on this deployment yet — whoever runs this server needs to configure a storage bucket (<code>S3_BUCKET</code> and keys) and restart it.</p>
                  </div>
                ) : hostedQuotaBytes === 0 ? (
                  <Link to="/billing" className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline">Upgrade plan →</Link>
                ) : !isOwner ? (
                  <p className="text-xs text-fg-subtle">Only the org owner can connect this.</p>
                ) : status?.provider === 'HOSTED_S3' ? (
                  <p className="text-xs text-green-600 dark:text-green-400 font-medium">Currently active</p>
                ) : (
                  <Button size="sm" icon={<Cloud size={13} />} loading={connectHosted.isPending} onClick={() => connectHosted.mutate(undefined, {
                    onSuccess: () => addToast('Hosted storage connected. New attachments will upload here.', 'success'),
                    onError: (err: any) => addToast(err?.response?.data?.error || 'Failed to connect hosted storage', 'error'),
                  })}>
                    Use hosted storage
                  </Button>
                )}
              </div>
            </div>
          </div>

          {!status?.connected && (
            <p className="text-xs text-fg-subtle">No storage is connected yet — uploading an attachment to any record will show an error until you connect one above.</p>
          )}
        </div>
      )}
    </div>
  );
}
