import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Building2, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

type Status = 'validating' | 'ready' | 'invalid' | 'success';

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const { setSession } = useAuth();

  const [status, setStatus] = useState<Status>('validating');
  const [inviteInfo, setInviteInfo] = useState<{ email: string; orgName?: string } | null>(null);
  const [form, setForm] = useState({ name: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Validate the token on mount
  useEffect(() => {
    if (!token) { setStatus('invalid'); return; }
    api.get(`/auth/invite-info?token=${token}`)
      .then(r => {
        setInviteInfo(r.data);
        setStatus('ready');
      })
      .catch(() => setStatus('invalid'));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    setError('');
    try {
      // Backend errors come back as { error }, not { message } — this was
      // reading the wrong key, so any real failure here (invite already
      // used, expired, seat limit hit, email already registered) silently
      // fell through to the generic "Something went wrong" text instead of
      // telling the person what actually happened.
      const res = await api.post('/auth/accept-invite', { token, name: form.name, password: form.password });
      setStatus('success');
      // The endpoint already returns a fresh session — sign the person in
      // immediately and drop them on the dashboard instead of bouncing them
      // to /login to re-type the password they just set a second ago.
      const { user, access, refresh } = res.data;
      setSession(user, access, refresh);
      setTimeout(() => navigate('/dashboard'), 1200);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Something went wrong. The invite may have expired.');
    } finally {
      setLoading(false);
    }
  }

  const inp = 'ui-input';
  const lbl = 'form-label';

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-blue-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="flex items-center justify-center gap-2 mb-6">
          <Building2 className="text-brand-600" size={28} />
          <h1 className="text-2xl font-bold text-gray-900">CRM & IT Desk</h1>
        </div>

        {status === 'validating' && (
          <div className="flex flex-col items-center gap-3 py-8 text-gray-500">
            <Loader2 size={28} className="animate-spin text-brand-500" />
            <p className="text-sm">Validating your invite...</p>
          </div>
        )}

        {status === 'invalid' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertCircle size={36} className="text-red-400" />
            <h2 className="font-semibold text-gray-900">Invalid or expired invite</h2>
            <p className="text-sm text-gray-500">This invite link is no longer valid. Ask your admin to send a new one.</p>
            <button
              onClick={() => navigate('/login')}
              className="mt-2 text-sm text-brand-600 hover:underline font-medium"
            >
              Back to sign in
            </button>
          </div>
        )}

        {status === 'success' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle size={36} className="text-green-500" />
            <h2 className="font-semibold text-gray-900">Account created!</h2>
            <p className="text-sm text-gray-500">Redirecting you to sign in...</p>
          </div>
        )}

        {status === 'ready' && (
          <>
            <div className="mb-6 text-center">
              <h2 className="text-lg font-semibold text-gray-900">You've been invited</h2>
              {inviteInfo?.orgName && (
                <p className="text-sm text-gray-500 mt-1">
                  Join <span className="font-medium text-gray-700">{inviteInfo.orgName}</span>
                </p>
              )}
              <p className="text-sm text-brand-600 font-medium mt-1">{inviteInfo?.email}</p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg mb-4">{error}</div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className={lbl}>Your Name <span className="text-red-500">*</span></label>
                <input
                  type="text" required minLength={2} value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className={inp} placeholder="Jane Smith"
                />
              </div>
              <div>
                <label className={lbl}>Password <span className="text-red-500">*</span></label>
                <input
                  type="password" required minLength={8} value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className={inp} placeholder="Min 8 characters"
                />
              </div>
              <div>
                <label className={lbl}>Confirm Password <span className="text-red-500">*</span></label>
                <input
                  type="password" required value={form.confirmPassword}
                  onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))}
                  className={inp} placeholder="••••••••"
                />
              </div>
              <button
                type="submit" disabled={loading}
                className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
              >
                {loading ? 'Creating account...' : 'Set Up Account'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
