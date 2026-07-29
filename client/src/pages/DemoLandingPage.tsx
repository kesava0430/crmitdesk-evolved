import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Users, Ticket, Zap, Bot, Sparkles, Loader2, ArrowRight } from 'lucide-react';

const HIGHLIGHTS = [
  { icon: Users,  label: 'Full CRM',       desc: 'Contacts, leads, deals and a live sales pipeline' },
  { icon: Ticket, label: 'IT Help Desk',   desc: 'Tickets, SLAs, assets and change management' },
  { icon: Bot,    label: 'AI built in',    desc: 'Lead scoring, ticket triage, and an AI command bar' },
  { icon: Zap,    label: 'No-code workflows', desc: 'Automations across CRM and IT Desk, no engineers needed' },
];

export function DemoLandingPage() {
  const { demoLogin } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleTryDemo() {
    setLoading(true);
    setError('');
    try {
      await demoLogin();
      navigate('/dashboard');
    } catch {
      setError("The demo is warming up — please try again in a moment.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white relative overflow-hidden flex items-center justify-center px-6 py-16">
      {/* Decorative glow */}
      <div className="absolute -top-40 -left-40 w-[32rem] h-[32rem] rounded-full bg-brand-600/20 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -right-32 w-[28rem] h-[28rem] rounded-full bg-indigo-500/20 blur-3xl pointer-events-none" />

      <div className="relative z-10 w-full max-w-2xl text-center">
        <img src="/logo.svg" alt="CRMITdesk Evolved" className="w-14 h-14 mx-auto mb-6" />

        <p className="text-brand-400 text-sm font-semibold tracking-wide uppercase mb-3">Live Product Demo</p>
        <h1 className="text-4xl sm:text-5xl font-bold leading-tight mb-5">
          See CRMITdesk Evolved<br />running with real data
        </h1>
        <p className="text-slate-400 text-base leading-relaxed max-w-lg mx-auto mb-10">
          One click drops you straight into a fully populated workspace &mdash; real contacts, deals,
          support tickets and dashboards &mdash; so you can explore the product the way your team
          actually would, with nothing to set up.
        </p>

        <button
          onClick={handleTryDemo}
          disabled={loading}
          className="inline-flex items-center gap-2 px-7 py-3.5 bg-brand-600 hover:bg-brand-700 text-white rounded-xl font-semibold text-base shadow-lg shadow-brand-600/30 transition-colors disabled:opacity-60"
        >
          {loading ? (
            <><Loader2 size={20} className="animate-spin" /> Loading your demo workspace&hellip;</>
          ) : (
            <><Sparkles size={20} /> Try the Live Demo <ArrowRight size={18} /></>
          )}
        </button>

        {error && <p className="text-red-400 text-sm mt-4">{error}</p>}

        <p className="text-slate-500 text-xs mt-6 max-w-md mx-auto">
          You'll be signed in as a Super Admin on a shared showcase workspace with realistic sample data.
          Feel free to click around &mdash; nothing here belongs to a real customer, and it resets automatically every night.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-14 text-left">
          {HIGHLIGHTS.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="bg-white/5 border border-white/10 rounded-xl p-4">
              <Icon size={18} className="text-brand-400 mb-2" />
              <p className="text-sm font-semibold text-white">{label}</p>
              <p className="text-xs text-slate-500 mt-1">{desc}</p>
            </div>
          ))}
        </div>

        <p className="text-slate-600 text-xs mt-12">
          Already have an account?{' '}
          <Link to="/login" className="text-slate-400 hover:text-white underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
