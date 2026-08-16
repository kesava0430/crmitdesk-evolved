import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Mail, ArrowLeft } from 'lucide-react';
import { api } from '../api/client';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch {
      // Server always returns a generic success message for this endpoint —
      // a request failure here means something else (network, 429, etc).
      setError('Something went wrong. Please try again in a moment.');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          <div className="w-11 h-11 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center mb-5">
            <Mail size={18} />
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Reset your password</h1>

          {sent ? (
            <div className="mt-4">
              <p className="text-sm text-gray-600">
                If an account exists for <strong>{email}</strong>, a password reset link has been sent. Check your inbox — the link expires in 30 minutes.
              </p>
              <Link to="/login" className="mt-5 inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline font-medium">
                <ArrowLeft size={13} /> Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <p className="text-sm text-gray-500">
                Enter your account email and we'll send you a link to reset your password.
              </p>
              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
              <input
                type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com" autoComplete="email"
                className="w-full px-3.5 py-2.5 text-sm border border-gray-200 rounded-xl bg-white placeholder-gray-400 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
              <button
                type="submit" disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl text-sm transition-colors"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
                <ArrowLeft size={13} /> Back to sign in
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
