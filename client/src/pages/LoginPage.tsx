import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Ticket, TrendingUp, Users, Shield, Eye, EyeOff, Loader2, Sparkles, ArrowRight } from 'lucide-react';

type Tab = 'login' | 'register';

const FEATURES = [
  { icon: Users,      label: 'CRM',          desc: 'Contacts, leads and pipeline' },
  { icon: Ticket,     label: 'IT Desk',       desc: 'Tickets, SLA and knowledge base' },
  { icon: TrendingUp, label: 'Analytics',     desc: 'Reports and forecasting' },
  { icon: Shield,     label: 'Enterprise',    desc: 'Audit logs and 2FA security' },
];

function InputField({
  label, type = 'text', value, onChange, placeholder, required, minLength, autoComplete,
}: {
  label: string; type?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; required?: boolean; minLength?: number; autoComplete?: string;
}) {
  const [showPw, setShowPw] = useState(false);
  const isPw = type === 'password';
  const actualType = isPw ? (showPw ? 'text' : 'password') : type;

  return (
    <div className="space-y-1.5">
      <label className="form-label">{label}</label>
      <div className="relative">
        <input
          type={actualType}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          autoComplete={autoComplete}
          className="
            w-full px-3.5 py-2.5 text-sm border border-gray-200 rounded-xl bg-white
            placeholder-gray-400 text-gray-900
            focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent
            hover:border-gray-300 transition-all
          "
        />
        {isPw && (
          <button
            type="button"
            onClick={() => setShowPw(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            tabIndex={-1}
          >
            {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('login');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [regForm, setRegForm] = useState({ name: '', email: '', password: '', organizationName: '' });
  const [needsTotp, setNeedsTotp] = useState(false);
  const [totpToken, setTotpToken] = useState('');
  const [pendingMessage, setPendingMessage] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const result = await login(loginForm.email, loginForm.password, needsTotp ? totpToken : undefined);
      if (result.requires2FA) {
        setNeedsTotp(true);
      } else {
        navigate('/dashboard');
      }
    } catch {
      setError(needsTotp ? 'Invalid or expired code. Please try again.' : 'Invalid email or password. Please try again.');
    } finally { setLoading(false); }
  }

  function backToPassword() {
    setNeedsTotp(false);
    setTotpToken('');
    setError('');
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (regForm.password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setLoading(true); setError('');
    try {
      const { message } = await register(regForm.email, regForm.password, regForm.name, regForm.organizationName);
      setPendingMessage(message);
      setRegForm({ name: '', email: '', password: '', organizationName: '' });
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.response?.data?.error || 'Registration failed. Email may already be in use.');
    } finally { setLoading(false); }
  }

  const switchTab = (t: Tab) => { setTab(t); setError(''); setPendingMessage(''); };

  return (
    <div className="min-h-screen flex">
      {/* ── Left brand panel ──────────────────────────────────────── */}
      <div className="hidden lg:flex flex-col w-[480px] shrink-0 bg-slate-950 px-12 py-14 text-white relative overflow-hidden">
        {/* Subtle decorative circles */}
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-brand-600/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-80 h-80 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

        {/* Logo */}
        <div className="flex items-center gap-3 mb-16 relative z-10">
          <img src="/logo.svg" alt="Logo" className="w-10 h-10" />
          <div>
            <p className="font-bold text-lg leading-tight">CRM & IT Desk</p>
            <p className="text-slate-400 text-xs">All-in-one business platform</p>
          </div>
        </div>

        {/* Headline */}
        <div className="relative z-10 mb-12">
          <h2 className="text-3xl font-bold leading-tight mb-4 text-white">
            Run your business<br />
            from one place.
          </h2>
          <p className="text-slate-400 text-sm leading-relaxed">
            Manage customers, support tickets, analytics, and team workflows — unified in a single powerful platform.
          </p>
        </div>

        {/* Feature list */}
        <div className="relative z-10 space-y-5">
          {FEATURES.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="flex items-center gap-4">
              <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
                <Icon size={16} className="text-brand-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">{label}</p>
                <p className="text-xs text-slate-500">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Try Demo CTA */}
        <Link
          to="/demo"
          className="mt-auto relative z-10 flex items-center justify-between gap-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl px-5 py-4 transition-colors group"
        >
          <span className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-lg bg-brand-600/20 text-brand-400 flex items-center justify-center shrink-0">
              <Sparkles size={16} />
            </span>
            <span>
              <span className="block text-sm font-semibold text-white">Just exploring?</span>
              <span className="block text-xs text-slate-400">Try the live demo — no signup needed</span>
            </span>
          </span>
          <ArrowRight size={16} className="text-slate-400 group-hover:text-white group-hover:translate-x-0.5 transition-all shrink-0" />
        </Link>

        {/* Footer note */}
        <p className="pt-6 relative z-10 text-xs text-slate-600">
          Secure · Multi-tenant · Enterprise-ready
        </p>
      </div>

      {/* ── Right form panel ──────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center p-6 bg-slate-50">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-2 justify-center mb-6">
            <img src="/logo.svg" alt="Logo" className="w-9 h-9" />
            <span className="font-bold text-xl text-gray-900">CRM & IT Desk</span>
          </div>

          {/* Mobile Try Demo CTA */}
          <Link
            to="/demo"
            className="lg:hidden flex items-center justify-between gap-3 bg-white border border-gray-200 rounded-2xl px-4 py-3 mb-6 shadow-sm hover:border-brand-300 transition-colors group"
          >
            <span className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
                <Sparkles size={14} />
              </span>
              <span className="text-sm font-medium text-gray-800">Try the live demo</span>
            </span>
            <ArrowRight size={15} className="text-gray-400 group-hover:text-brand-600 group-hover:translate-x-0.5 transition-all" />
          </Link>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
            {/* Header */}
            <div className="mb-7">
              <h1 className="text-xl font-semibold text-gray-900">
                {tab === 'login' ? 'Welcome back' : 'Create your account'}
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                {tab === 'login'
                  ? 'Sign in to your workspace'
                  : 'Get started with a free workspace'}
              </p>
            </div>

            {/* Tab switcher */}
            <div className="flex rounded-xl bg-gray-100 p-1 mb-7">
              {(['login', 'register'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => switchTab(t)}
                  className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${
                    tab === t
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t === 'login' ? 'Sign in' : 'Create Account'}
                </button>
              ))}
            </div>

            {/* Error banner */}
            {error && (
              <div className="flex items-start gap-3 bg-red-50 border border-red-100 text-red-700 text-sm px-4 py-3 rounded-xl mb-5">
                <span className="w-4 h-4 rounded-full bg-red-200 text-red-700 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">!</span>
                {error}
              </div>
            )}

            {tab === 'login' ? (
              needsTotp ? (
                <form onSubmit={handleLogin} className="space-y-5">
                  <p className="text-sm text-gray-500 -mt-2">
                    Enter the 6-digit code from your authenticator app, or one of your backup codes.
                  </p>
                  <InputField
                    label="Authentication code" value={totpToken}
                    onChange={setTotpToken}
                    placeholder="123456" required autoComplete="one-time-code"
                  />
                  <button
                    type="submit" disabled={loading}
                    className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl text-sm transition-colors mt-2"
                  >
                    {loading && <Loader2 size={14} className="animate-spin" />}
                    {loading ? 'Verifying…' : 'Verify'}
                  </button>
                  <p className="text-center text-xs text-gray-400">
                    <button type="button" onClick={backToPassword} className="text-brand-600 hover:underline font-medium">
                      Back to sign in
                    </button>
                  </p>
                </form>
              ) : (
              <form onSubmit={handleLogin} className="space-y-5">
                <InputField
                  label="Email address" type="email" value={loginForm.email}
                  onChange={v => setLoginForm(f => ({ ...f, email: v }))}
                  placeholder="you@company.com" required autoComplete="email"
                />
                <InputField
                  label="Password" type="password" value={loginForm.password}
                  onChange={v => setLoginForm(f => ({ ...f, password: v }))}
                  placeholder="Enter your password" required autoComplete="current-password"
                />
                <button
                  type="submit" disabled={loading}
                  className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl text-sm transition-colors mt-2"
                >
                  {loading && <Loader2 size={14} className="animate-spin" />}
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
                <p className="text-center text-xs text-gray-400">
                  No account?{' '}
                  <button type="button" onClick={() => switchTab('register')} className="text-brand-600 hover:underline font-medium">
                    Create one free
                  </button>
                </p>
              </form>
              )
            ) : pendingMessage ? (
              <div className="text-center py-4">
                <div className="w-12 h-12 rounded-full bg-green-100 text-green-600 flex items-center justify-center mx-auto mb-4 text-2xl">
                  ✓
                </div>
                <p className="text-sm text-gray-700">{pendingMessage}</p>
                <button
                  type="button"
                  onClick={() => switchTab('login')}
                  className="mt-5 text-sm text-brand-600 hover:underline font-medium"
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <InputField
                  label="Company name" value={regForm.organizationName}
                  onChange={v => setRegForm(f => ({ ...f, organizationName: v }))}
                  placeholder="Acme Inc." required minLength={2}
                />
                <InputField
                  label="Your name" value={regForm.name}
                  onChange={v => setRegForm(f => ({ ...f, name: v }))}
                  placeholder="Jane Smith" required minLength={2}
                />
                <InputField
                  label="Work email" type="email" value={regForm.email}
                  onChange={v => setRegForm(f => ({ ...f, email: v }))}
                  placeholder="jane@acme.com" required autoComplete="email"
                />
                <InputField
                  label="Password" type="password" value={regForm.password}
                  onChange={v => setRegForm(f => ({ ...f, password: v }))}
                  placeholder="Min. 8 characters" required minLength={8} autoComplete="new-password"
                />
                <button
                  type="submit" disabled={loading}
                  className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-xl text-sm transition-colors mt-1"
                >
                  {loading && <Loader2 size={14} className="animate-spin" />}
                  {loading ? 'Creating account…' : 'Create account'}
                </button>
                <p className="text-center text-xs text-gray-400">
                  Already registered?{' '}
                  <button type="button" onClick={() => switchTab('login')} className="text-brand-600 hover:underline font-medium">
                    Sign in
                  </button>
                </p>
              </form>
            )}
          </div>

          <p className="text-center text-xs text-gray-400 mt-6">
            By signing in you agree to our Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  );
}
