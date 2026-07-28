import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { HardDrive, CheckCircle, AlertCircle, ExternalLink, Unplug } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useStorageStatus, useConnectGoogleDrive, useDisconnectStorage } from '../api/storage';
import { Button, Spinner } from '../shared/components';
import { addToast } from '../shared/components/toastStore';

export default function StoragePage() {
  const { user } = useAuth();
  const isOwner = user?.role === 'SUPER_ADMIN';
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: status, isLoading } = useStorageStatus();
  const connect = useConnectGoogleDrive();
  const disconnect = useDisconnectStorage();

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
          <h1 className="text-2xl font-bold text-gray-900">Storage</h1>
          <p className="text-sm text-gray-500">Connect where file attachments on records get uploaded.</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Spinner label="Checking storage connection…" /></div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          {!status?.configured ? (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <AlertCircle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-800">Google Drive isn't set up on this deployment yet</p>
                <p className="text-sm text-amber-700 mt-1">An administrator needs to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server's environment before anyone can connect a drive.</p>
              </div>
            </div>
          ) : status?.connected ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
                <CheckCircle size={18} className="text-green-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-800">Google Drive connected</p>
                  <p className="text-sm text-green-700">{status.connectedEmail}</p>
                </div>
              </div>
              <p className="text-sm text-gray-500">
                Every attachment uploaded on a record (contacts, deals, tickets, leads, accounts, change requests, quotes, assets, campaigns) is saved to a "CRMITdesk Evolved Attachments" folder in this Drive account.
              </p>
              {isOwner ? (
                <Button
                  variant="secondary"
                  icon={<Unplug size={14} />}
                  loading={disconnect.isPending}
                  onClick={() => {
                    if (confirm('Disconnect Google Drive? Existing attachments already uploaded stay where they are until deleted individually — new uploads will fail until a storage provider is reconnected.')) {
                      disconnect.mutate();
                    }
                  }}
                >
                  Disconnect
                </Button>
              ) : (
                <p className="text-xs text-gray-400">Only the org owner (Super Admin) can disconnect storage.</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">No storage is connected yet. Until you connect one, uploading an attachment to any record will show an error asking to connect storage here first.</p>
              {isOwner ? (
                <Button icon={<ExternalLink size={14} />} loading={connect.isPending} onClick={() => connect.mutate()}>
                  Connect Google Drive
                </Button>
              ) : (
                <p className="text-xs text-gray-400">Only the org owner (Super Admin) can connect storage.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
