import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { MessageSquare, Plus, ArrowLeft, Send, LogOut, Ticket, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { Spinner } from '../../shared/components';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PortalSession {
  token: string;
  user: { id: string; name: string; email: string; orgId: string };
}

interface PortalTicket {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  createdAt: string;
  category?: { name: string } | null;
}

// ─── Portal API ───────────────────────────────────────────────────────────────

// Same VITE_API_URL bug as api/client.ts's baseURL — hardcoded to a relative
// path, so on any host without a same-origin /api proxy (Netlify included)
// this hits the frontend's own domain instead of the backend.
const BASE = `${import.meta.env.VITE_API_URL || '/api'}/portal`;

function portalApi(token: string) {
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` } });
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    OPEN: 'bg-blue-50 text-blue-700',
    IN_PROGRESS: 'bg-yellow-50 text-yellow-700',
    PENDING: 'bg-orange-50 text-orange-600',
    RESOLVED: 'bg-green-50 text-green-700',
    CLOSED: 'bg-gray-100 text-gray-500',
  };
  const icons: Record<string, React.ReactNode> = {
    OPEN: <Clock size={11} />,
    IN_PROGRESS: <AlertCircle size={11} />,
    PENDING: <Clock size={11} />,
    RESOLVED: <CheckCircle size={11} />,
    CLOSED: <CheckCircle size={11} />,
  };
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${styles[status] || 'bg-gray-50 text-gray-600'}`}>
      {icons[status]} {status.replace('_', ' ')}
    </span>
  );
}

// ─── LOGIN VIEW ───────────────────────────────────────────────────────────────

function LoginView({ orgId }: { orgId: string }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError('');
    try {
      await axios.post(`${BASE}/request-access`, { email, orgId });
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-brand-600 flex items-center justify-center mx-auto mb-4 shadow-lg">
            <MessageSquare size={24} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Support Portal</h1>
          <p className="text-sm text-gray-500 mt-1">Submit and track your support tickets</p>
        </div>

        {sent ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
            <CheckCircle size={40} className="text-green-500 mx-auto mb-3" />
            <h3 className="font-semibold text-gray-900 mb-2">Check your email</h3>
            <p className="text-sm text-gray-500">We sent a magic login link to <strong>{email}</strong>. The link expires in 30 minutes.</p>
            <button onClick={() => setSent(false)} className="mt-4 text-sm text-brand-600 hover:text-brand-700">Use a different email</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
            <label className="block text-sm font-medium text-gray-700 mb-2">Your email address</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@company.com" required
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-400 mb-4" />
            {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
            <button type="submit" disabled={loading || !email}
              className="w-full py-3 bg-brand-600 text-white rounded-xl font-medium text-sm hover:bg-brand-700 disabled:opacity-40 flex items-center justify-center gap-2">
              {loading ? <Spinner /> : <Send size={15} />}
              Send magic link
            </button>
            <p className="text-xs text-gray-400 text-center mt-4">No password needed — we'll email you a one-click login link.</p>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── VERIFY VIEW ─────────────────────────────────────────────────────────────

function VerifyView({ token, orgId, onLogin }: { token: string; orgId: string; onLogin: (s: PortalSession) => void }) {
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get(`${BASE}/verify?token=${token}&org=${orgId}`)
      .then(r => onLogin(r.data))
      .catch(() => setError('This link is invalid or has expired. Please request a new one.'));
  }, []);

  if (error) return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="text-center max-w-sm">
        <AlertCircle size={48} className="text-red-400 mx-auto mb-4" />
        <h2 className="font-semibold text-gray-900 mb-2">Link expired</h2>
        <p className="text-sm text-gray-500 mb-4">{error}</p>
        <a href={`/portal?org=${orgId}`} className="text-brand-600 text-sm hover:text-brand-700">Request a new link →</a>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <Spinner label="Signing you in…" />
      </div>
    </div>
  );
}

// ─── TICKET LIST ──────────────────────────────────────────────────────────────

function TicketListView({ session, onNew, onSelect }: { session: PortalSession; onNew: () => void; onSelect: (t: PortalTicket) => void }) {
  const [tickets, setTickets] = useState<PortalTicket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    portalApi(session.token).get('/tickets')
      .then(r => setTickets(r.data))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold text-gray-900">My Tickets</h2>
        <button onClick={onNew}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700">
          <Plus size={14} /> New Ticket
        </button>
      </div>

      {loading ? <Spinner label="Loading tickets…" /> : tickets.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-gray-200 rounded-2xl">
          <Ticket size={36} className="text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-600 mb-1">No tickets yet</p>
          <p className="text-xs text-gray-400 mb-4">Submit a ticket when you need help</p>
          <button onClick={onNew} className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm hover:bg-brand-700">
            <Plus size={13} /> Create first ticket
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map(t => (
            <button key={t.id} onClick={() => onSelect(t)}
              className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-brand-200 hover:shadow-sm transition-all">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 text-sm truncate">{t.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{t.body}</p>
                </div>
                <div className="flex-shrink-0">
                  <StatusBadge status={t.status} />
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2">
                {t.category && <span className="text-xs text-gray-400">{t.category.name}</span>}
                <span className="text-xs text-gray-300">{new Date(t.createdAt).toLocaleDateString()}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── NEW TICKET ───────────────────────────────────────────────────────────────

function NewTicketView({ session, onBack, onCreated }: { session: PortalSession; onBack: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !body) return;
    setLoading(true);
    setError('');
    try {
      await portalApi(session.token).post('/tickets', { title, body });
      onCreated();
    } catch {
      setError('Failed to submit ticket. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6">
        <ArrowLeft size={14} /> Back
      </button>
      <h2 className="text-lg font-bold text-gray-900 mb-6">Submit a Ticket</h2>
      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Subject *</label>
          <input value={title} onChange={e => setTitle(e.target.value)} required
            placeholder="Briefly describe your issue"
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-400" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Details *</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} required rows={6}
            placeholder="Describe your issue in detail. Include any steps to reproduce, error messages, or screenshots."
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none" />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-3">
          <button type="button" onClick={onBack} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-500 hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={loading || !title || !body}
            className="flex-1 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 disabled:opacity-40 flex items-center justify-center gap-2">
            {loading ? <Spinner /> : <Send size={14} />}
            Submit Ticket
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── TICKET DETAIL ────────────────────────────────────────────────────────────

function TicketDetailView({ ticket, onBack }: { ticket: PortalTicket; onBack: () => void }) {
  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6">
        <ArrowLeft size={14} /> Back to tickets
      </button>
      <div className="bg-white border border-gray-200 rounded-2xl p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <h2 className="text-base font-bold text-gray-900">{ticket.title}</h2>
          <StatusBadge status={ticket.status} />
        </div>
        {ticket.category && <p className="text-xs text-gray-400 mb-3">Category: {ticket.category.name}</p>}
        <div className="bg-gray-50 rounded-xl p-4 text-sm text-gray-700 whitespace-pre-wrap">{ticket.body}</div>
        <p className="text-xs text-gray-400 mt-4">Submitted on {new Date(ticket.createdAt).toLocaleString()}</p>
      </div>
    </div>
  );
}

// ─── MAIN PORTAL ─────────────────────────────────────────────────────────────

export function CustomerPortal() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const rawOrgId = searchParams.get('org') || '';
  const verifyToken = searchParams.get('token');
  const isVerify = !!verifyToken && window.location.pathname.includes('/portal/verify');

  const [session, setSession] = useState<PortalSession | null>(() => {
    try { return JSON.parse(sessionStorage.getItem('portalSession') || 'null'); } catch { return null; }
  });
  const [view, setView] = useState<'list' | 'new' | 'detail'>('list');
  const [selectedTicket, setSelectedTicket] = useState<PortalTicket | null>(null);

  const orgId = session?.user.orgId || rawOrgId;

  function login(s: PortalSession) {
    sessionStorage.setItem('portalSession', JSON.stringify(s));
    setSession(s);
    navigate(`/portal?org=${s.user.orgId}`, { replace: true });
  }

  function logout() {
    sessionStorage.removeItem('portalSession');
    setSession(null);
    setView('list');
  }

  if (isVerify && !session) {
    return <VerifyView token={verifyToken!} orgId={rawOrgId} onLogin={login} />;
  }

  if (!session) {
    return <LoginView orgId={orgId} />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-brand-600 flex items-center justify-center">
              <MessageSquare size={14} className="text-white" />
            </div>
            <span className="font-semibold text-gray-900 text-sm">Support Portal</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 hidden sm:block">{session.user.email}</span>
            <button onClick={logout} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg" title="Sign out">
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-4 py-8">
        {/* Welcome banner */}
        {view === 'list' && (
          <div className="bg-brand-600 text-white rounded-2xl p-5 mb-6">
            <p className="text-sm font-medium opacity-80">Welcome back</p>
            <p className="text-xl font-bold">{session.user.name}</p>
          </div>
        )}

        {view === 'list' && (
          <TicketListView
            session={session}
            onNew={() => setView('new')}
            onSelect={t => { setSelectedTicket(t); setView('detail'); }}
          />
        )}
        {view === 'new' && (
          <NewTicketView session={session} onBack={() => setView('list')} onCreated={() => setView('list')} />
        )}
        {view === 'detail' && selectedTicket && (
          <TicketDetailView ticket={selectedTicket} onBack={() => setView('list')} />
        )}
      </main>
    </div>
  );
}
