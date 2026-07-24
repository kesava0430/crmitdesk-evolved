import { useState, FormEvent } from 'react';
import { User, Mail, Briefcase, Lock, CheckCircle2, AlertCircle, Eye, EyeOff, Camera } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import { PageHeader } from '../shared/components/PageHeader';

/* ── tiny helpers ── */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12.5px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function Toast({ type, msg, onDismiss }: { type: 'ok' | 'err'; msg: string; onDismiss: () => void }) {
  return (
    <div
      className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium shadow-lg animate-slide-down ${
        type === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
      }`}
    >
      {type === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      <span className="flex-1">{msg}</span>
      <button onClick={onDismiss} className="opacity-60 hover:opacity-100 text-lg leading-none">&times;</button>
    </div>
  );
}

/* ── Avatar section ── */
function AvatarSection({ user }: { user: { name: string; avatarUrl?: string } }) {
  const initials = user.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="flex items-center gap-5">
      <div className="relative">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt={user.name} className="w-20 h-20 rounded-2xl object-cover ring-4 ring-white shadow-md" />
        ) : (
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-2xl font-bold shadow-md ring-4 ring-white">
            {initials}
          </div>
        )}
        <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-white shadow border border-gray-200 flex items-center justify-center cursor-default" title="Avatar editing via URL below">
          <Camera size={13} className="text-gray-500" />
        </div>
      </div>
      <div>
        <p className="text-xl font-bold text-gray-900">{user.name}</p>
        <p className="text-sm text-gray-500 mt-0.5">Update your name, email and department below</p>
      </div>
    </div>
  );
}

/* ── Profile form ── */
function ProfileForm() {
  const { user, updateProfile } = useAuth();
  const [form, setForm] = useState({
    name:       user?.name       ?? '',
    email:      user?.email      ?? '',
    department: user?.department ?? '',
    avatarUrl:  user?.avatarUrl  ?? '',
  });
  const [busy, setBusy]   = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setToast(null);
    try {
      await updateProfile(form);
      setToast({ type: 'ok', msg: 'Profile updated successfully!' });
    } catch (err: any) {
      setToast({ type: 'err', msg: err?.response?.data?.error ?? err?.response?.data?.message ?? 'Failed to update profile.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {toast && <Toast type={toast.type} msg={toast.msg} onDismiss={() => setToast(null)} />}

      <Field label="Full name">
        <div className="relative">
          <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            className="ui-input pl-9"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            required minLength={2}
            placeholder="Your full name"
          />
        </div>
      </Field>

      <Field label="Email address">
        <div className="relative">
          <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="email"
            className="ui-input pl-9"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            required
            placeholder="you@example.com"
          />
        </div>
      </Field>

      <Field label="Department">
        <div className="relative">
          <Briefcase size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            className="ui-input pl-9"
            value={form.department}
            onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
            placeholder="e.g. Engineering, Sales"
          />
        </div>
      </Field>

      <Field label="Avatar URL (optional)">
        <input
          type="url"
          className="ui-input"
          value={form.avatarUrl}
          onChange={e => setForm(f => ({ ...f, avatarUrl: e.target.value }))}
          placeholder="https://..."
        />
      </Field>

      <div className="pt-1">
        <button
          type="submit"
          disabled={busy}
          className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors active:scale-[0.98]"
        >
          {busy ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </form>
  );
}

/* ── Password form ── */
function PasswordForm() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [show, setShow]   = useState({ current: false, next: false });
  const [busy, setBusy]   = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) {
      setToast({ type: 'err', msg: 'New passwords do not match.' });
      return;
    }
    if (form.newPassword.length < 8) {
      setToast({ type: 'err', msg: 'New password must be at least 8 characters.' });
      return;
    }
    setBusy(true);
    setToast(null);
    try {
      await api.put('/auth/me/password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      setToast({ type: 'ok', msg: 'Password changed! Other sessions have been signed out.' });
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (err: any) {
      setToast({ type: 'err', msg: err?.response?.data?.error ?? err?.response?.data?.message ?? 'Failed to change password.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {toast && <Toast type={toast.type} msg={toast.msg} onDismiss={() => setToast(null)} />}

      <Field label="Current password">
        <div className="relative">
          <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type={show.current ? 'text' : 'password'}
            className="ui-input pl-9 pr-10"
            value={form.currentPassword}
            onChange={e => setForm(f => ({ ...f, currentPassword: e.target.value }))}
            required
            placeholder="Your current password"
          />
          <button type="button" onClick={() => setShow(s => ({ ...s, current: !s.current }))}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            {show.current ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </Field>

      <Field label="New password">
        <div className="relative">
          <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type={show.next ? 'text' : 'password'}
            className="ui-input pl-9 pr-10"
            value={form.newPassword}
            onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))}
            required minLength={8}
            placeholder="Min 8 characters"
          />
          <button type="button" onClick={() => setShow(s => ({ ...s, next: !s.next }))}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            {show.next ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </Field>

      <Field label="Confirm new password">
        <div className="relative">
          <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="password"
            className={`ui-input pl-9 ${form.confirm && form.confirm !== form.newPassword ? 'border-red-400' : ''}`}
            value={form.confirm}
            onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))}
            required
            placeholder="Re-enter new password"
          />
        </div>
        {form.confirm && form.confirm !== form.newPassword && (
          <p className="text-xs text-red-500 mt-1">Passwords don't match</p>
        )}
      </Field>

      <div className="pt-1">
        <button
          type="submit"
          disabled={busy}
          className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors active:scale-[0.98]"
        >
          {busy ? 'Updating…' : 'Change Password'}
        </button>
      </div>
    </form>
  );
}

/* ── Main page ── */
export default function ProfilePage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'profile' | 'security'>('profile');

  if (!user) return null;

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <PageHeader title="My Profile" subtitle="Manage your personal details and account security" />

      {/* Avatar hero */}
      <div className="card p-5">
        <AvatarSection user={user} />
        <div className="mt-4 flex items-center gap-1.5">
          <span className="text-xs text-gray-400">Role:</span>
          <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
            {user.role?.replace(/_/g, ' ')}
          </span>
          {user.org?.name && (
            <>
              <span className="text-gray-300 mx-1">·</span>
              <span className="text-xs text-gray-500">{user.org.name}</span>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {(['profile', 'security'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 text-[13px] font-semibold rounded-lg transition-all capitalize ${
              tab === t
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'profile' ? 'Profile Details' : 'Security'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="card p-6">
        {tab === 'profile' ? (
          <>
            <h2 className="text-[15px] font-semibold text-gray-800 mb-5">Personal Information</h2>
            <ProfileForm />
          </>
        ) : (
          <>
            <h2 className="text-[15px] font-semibold text-gray-800 mb-1">Change Password</h2>
            <p className="text-sm text-gray-500 mb-5">
              After changing your password, all other active sessions will be signed out.
            </p>
            <PasswordForm />
          </>
        )}
      </div>
    </div>
  );
}
