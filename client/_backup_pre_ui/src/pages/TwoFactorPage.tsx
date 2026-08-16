import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Shield, ShieldCheck, ShieldOff, Copy, CheckCircle, AlertCircle } from 'lucide-react';
import { useFormat } from '../hooks/useFormat';

interface TotpStatus { enabled: boolean; setupAt: string | null; }
interface SetupData { secret: string; uri: string; }

export default function TwoFactorPage() {
  const { date } = useFormat();
  const qc = useQueryClient();
  const [step, setStep] = useState<'idle' | 'setup' | 'backup'>('idle');
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [token, setToken] = useState('');
  const [disableToken, setDisableToken] = useState('');
  const [showDisable, setShowDisable] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery<TotpStatus>({
    queryKey: ['2fa-status'],
    queryFn: () => api.get('/2fa/status').then(r => r.data),
  });

  const setup = useMutation({
    mutationFn: () => api.post('/2fa/setup').then(r => r.data),
    onSuccess: (data: SetupData) => { setSetupData(data); setStep('setup'); setError(null); },
  });

  const enable = useMutation({
    mutationFn: (t: string) => api.post('/2fa/enable', { token: t }).then(r => r.data),
    onSuccess: (data: { backupCodes: string[] }) => {
      setBackupCodes(data.backupCodes);
      setStep('backup');
      setError(null);
      qc.invalidateQueries({ queryKey: ['2fa-status'] });
    },
    onError: () => setError('Invalid code. Try again.'),
  });

  const disable = useMutation({
    mutationFn: (t: string) => api.post('/2fa/disable', { token: t }).then(r => r.data),
    onSuccess: () => {
      setShowDisable(false);
      setDisableToken('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['2fa-status'] });
    },
    onError: () => setError('Invalid code. Try again.'),
  });

  function copyText(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  if (isLoading) return <div className="p-8 text-gray-500">Loading…</div>;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        {status?.enabled ? (
          <ShieldCheck size={24} className="text-green-600" />
        ) : (
          <Shield size={24} className="text-brand-600" />
        )}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Two-Factor Authentication</h1>
          <p className="text-sm text-gray-500">Protect your account with an authenticator app</p>
        </div>
      </div>

      {/* Status card */}
      <div className={`rounded-xl border p-5 mb-6 ${status?.enabled ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {status?.enabled ? (
              <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                <ShieldCheck size={20} className="text-green-600" />
              </div>
            ) : (
              <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                <ShieldOff size={20} className="text-gray-400" />
              </div>
            )}
            <div>
              <p className="font-semibold text-gray-900">2FA is {status?.enabled ? 'enabled' : 'disabled'}</p>
              {status?.enabled && status.setupAt && (
                <p className="text-xs text-green-600">Enabled {date(status.setupAt)}</p>
              )}
              {!status?.enabled && (
                <p className="text-sm text-gray-500">Your account is not protected with 2FA</p>
              )}
            </div>
          </div>
          {status?.enabled ? (
            <button onClick={() => { setShowDisable(true); setError(null); }}
              className="px-4 py-2 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50">
              Disable 2FA
            </button>
          ) : (
            <button onClick={() => setup.mutate()}
              disabled={setup.isPending || step !== 'idle'}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
              {setup.isPending ? 'Setting up…' : 'Enable 2FA'}
            </button>
          )}
        </div>
      </div>

      {/* Setup flow */}
      {step === 'setup' && setupData && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-brand-600 rounded-full flex items-center justify-center text-white text-xs font-bold">1</div>
            <p className="font-medium text-gray-800">Scan with your authenticator app</p>
          </div>

          {/* QR code via URL - use a QR code service */}
          <div className="flex justify-center">
            <div className="bg-white border-2 border-gray-200 rounded-xl p-3">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(setupData.uri)}`}
                alt="QR Code"
                className="w-48 h-48"
              />
            </div>
          </div>

          <div>
            <p className="text-sm text-gray-500 mb-2">Or enter the code manually:</p>
            <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
              <code className="flex-1 text-sm font-mono text-gray-800 tracking-widest">{setupData.secret}</code>
              <button onClick={() => copyText(setupData.secret, 'secret')}
                className="p-1 hover:bg-gray-200 rounded">
                {copied === 'secret' ? <CheckCircle size={14} className="text-green-600" /> : <Copy size={14} className="text-gray-400" />}
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 bg-brand-600 rounded-full flex items-center justify-center text-white text-xs font-bold">2</div>
              <p className="font-medium text-gray-800">Enter the 6-digit code</p>
            </div>
            <input
              className="ui-input text-center text-2xl font-mono tracking-[0.5em]"
              placeholder="000000"
              maxLength={6}
              value={token}
              onChange={e => setToken(e.target.value.replace(/\D/g, ''))}
            />
            {error && (
              <div className="flex items-center gap-1.5 mt-2 text-sm text-red-600">
                <AlertCircle size={13} /> {error}
              </div>
            )}
            <button
              disabled={token.length !== 6 || enable.isPending}
              onClick={() => enable.mutate(token)}
              className="w-full mt-3 bg-brand-600 text-white rounded-lg py-2.5 font-medium text-sm hover:bg-brand-700 disabled:opacity-50"
            >
              {enable.isPending ? 'Verifying…' : 'Verify & Enable'}
            </button>
          </div>
        </div>
      )}

      {/* Backup codes */}
      {step === 'backup' && backupCodes.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle size={20} className="text-green-600" />
            <h3 className="font-semibold text-gray-900">2FA Enabled! Save your backup codes</h3>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Store these codes somewhere safe. Each can be used once if you lose access to your authenticator.
          </p>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {backupCodes.map((code, i) => (
              <div key={i} className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 font-mono text-sm text-center text-gray-800">
                {code}
              </div>
            ))}
          </div>
          <button
            onClick={() => copyText(backupCodes.join('\n'), 'backup')}
            className="w-full flex items-center justify-center gap-2 border border-gray-200 rounded-lg py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            {copied === 'backup' ? <CheckCircle size={14} className="text-green-600" /> : <Copy size={14} />}
            {copied === 'backup' ? 'Copied!' : 'Copy all codes'}
          </button>
          <button onClick={() => setStep('idle')} className="w-full mt-2 text-sm text-brand-600 hover:underline">
            Done
          </button>
        </div>
      )}

      {/* Disable modal */}
      {showDisable && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <h3 className="text-lg font-bold mb-2">Disable 2FA</h3>
            <p className="text-sm text-gray-500 mb-4">Enter your authenticator code to confirm.</p>
            <input
              className="ui-input text-center text-2xl font-mono tracking-[0.5em] mb-2"
              placeholder="000000"
              maxLength={6}
              value={disableToken}
              onChange={e => setDisableToken(e.target.value.replace(/\D/g, ''))}
            />
            {error && <p className="text-sm text-red-500 mb-2">{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => { setShowDisable(false); setError(null); }}
                className="flex-1 border border-gray-200 rounded-lg py-2 text-sm text-gray-600">Cancel</button>
              <button
                disabled={disableToken.length !== 6 || disable.isPending}
                onClick={() => disable.mutate(disableToken)}
                className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {disable.isPending ? 'Disabling…' : 'Disable'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
