import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, KeyRound, Eye, EyeOff } from 'lucide-react';
import { api } from '../api/client';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setLoading(true); setError('');
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.message || 'This reset link is invalid or has expired.');
    } finally { setLoading(false); }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
          <p className="text-sm text-gray-600">This reset link is missing its token.</p>
          <Link to="/forgot-password" className="mt-4 inline-block text-sm text-brand-600 hover:underline font-medium">Request a new link</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          <div className="w-11 h-11 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center mb-5">
            <KeyRound size={18} />
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Choose a new password</h1>

          {done ? (
            <p className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2 mt-4">
              Password reset. Redirecting you to sign in…
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'} required minLength={8} value={password}
                  onChange={e => setPassword(e.target.value)} placeholder="New password" autoComplete="new-password"
                  className="w-full px-3.5 py-2.5 text-sm border border-gray-200 rounded-xl bg-white placeholder-gray-400 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
                <button type="button" onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" tabIndex={-1}>
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <input
                type={showPw ? 'text' : 'password'} required minLength={8} value={confirm}
                onChange={e => setConfirm(e.target.value)} placeholder="Confirm new password" autoComplete="new-password"
                className="w-full px-3.5 py-2.5 text-sm border border-gray-200 rounded-xl bg-white placeholder-gray-400 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
              <button
                type="submit" disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl text-sm transition-colors"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                {loading ? 'Resetting…' : 'Reset password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
