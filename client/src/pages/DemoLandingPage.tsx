import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import {
  Users, Ticket, Zap, Bot, Sparkles, Loader2, ArrowRight,
  TrendingUp, AlertTriangle, CheckCircle2, Clock, DollarSign,
} from 'lucide-react';

interface DemoVertical { slug: string; orgName: string; industry: string; primaryColor: string; currency?: string; available?: boolean }

const HIGHLIGHTS = [
  { icon: Users,  label: 'Full CRM',          desc: 'Contacts, leads, deals and a live sales pipeline' },
  { icon: Ticket, label: 'IT Help Desk',       desc: 'Tickets, SLAs, assets and change management' },
  { icon: Bot,    label: 'AI built in',        desc: 'Lead scoring, ticket triage, and an AI command bar' },
  { icon: Zap,    label: 'No-code workflows',  desc: 'Automations across CRM and IT Desk, no engineers needed' },
];

const TICKETS = [
  { title: 'Cannot connect to company VPN', priority: 'CRITICAL', color: 'bg-red-500/15 text-red-400 border-red-500/20' },
  { title: 'Laptop not turning on after update', priority: 'HIGH', color: 'bg-orange-500/15 text-orange-400 border-orange-500/20' },
  { title: 'Adobe Creative Cloud licence request', priority: 'LOW', color: 'bg-slate-500/15 text-slate-400 border-slate-500/20' },
];

const DEALS = [
  { title: 'Globex Platform Licence', value: '$120,000', stage: 'Closed Won' },
  { title: 'Acme ERP Implementation', value: '$85,000', stage: 'Proposal' },
  { title: 'Initech Analytics Suite', value: '$67,000', stage: 'Prospecting' },
];

export function DemoLandingPage() {
  const { demoLogin } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [vertical, setVertical] = useState<string>('');

  const { data: verticals } = useQuery<DemoVertical[]>({
    queryKey: ['demo-verticals'],
    queryFn: () => api.get('/demo/verticals').then(r => r.data),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (vertical || !verticals?.length) return;
    // Default to something that can actually be entered, rather than whatever
    // happens to be first in the list.
    setVertical((verticals.find(v => v.available !== false) ?? verticals[0]).slug);
  }, [verticals, vertical]);

  const selected = verticals?.find(v => v.slug === vertical);
  const nothingSeeded = !!verticals?.length && verticals.every(v => v.available === false);

  async function handleTryDemo() {
    setLoading(true);
    setError('');
    try {
      await demoLogin(vertical);
      navigate('/dashboard');
    } catch (err: any) {
      // The server knows exactly why this failed — a missing demo org needs a
      // seed run, not patience. Swallowing that behind "warming up" sent people
      // away to wait for something that was never going to fix itself.
      setError(
        err?.response?.data?.error ||
          'Could not start the demo. Check the server is running, then try again.'
      );
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white relative overflow-hidden">
      {/* Decorative glow */}
      <div className="absolute -top-40 -left-40 w-[32rem] h-[32rem] rounded-full bg-brand-600/20 blur-3xl pointer-events-none" />
      <div className="absolute top-1/3 -right-40 w-[28rem] h-[28rem] rounded-full bg-indigo-500/15 blur-3xl pointer-events-none" />

      {/* Top bar */}
      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-10 pt-8 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="CRMITdesk Evolved" className="w-8 h-8" />
          <span className="font-semibold text-white">CRMITdesk Evolved</span>
        </div>
        <Link to="/login" className="text-sm text-slate-400 hover:text-white transition-colors">
          Sign in
        </Link>
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-10 py-16 lg:py-20 grid lg:grid-cols-2 gap-16 items-center">
        {/* ── Left: pitch + CTA ──────────────────────────────────────── */}
        <div>
          <span className="inline-flex items-center gap-1.5 text-brand-400 text-xs font-semibold tracking-wide uppercase bg-brand-500/10 border border-brand-500/20 rounded-full px-3 py-1 mb-6">
            <Sparkles size={12} /> Live Product Demo
          </span>
          <h1 className="text-4xl sm:text-5xl font-bold leading-[1.1] mb-6">
            See CRMITdesk Evolved<br />running with real data
          </h1>
          <p className="text-slate-400 text-base leading-relaxed max-w-md mb-9">
            One click drops you into a fully populated workspace &mdash; real contacts, deals, support
            tickets and dashboards &mdash; so you can explore the product the way your team actually
            would. Nothing to set up.
          </p>

          {verticals && verticals.length > 0 && (
            <div className="mb-6">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">See it set up for your industry</p>
              <div className="flex flex-wrap gap-2">
                {verticals.map(v => {
                  const unavailable = v.available === false;
                  return (
                    <button
                      key={v.slug}
                      type="button"
                      onClick={() => setVertical(v.slug)}
                      disabled={unavailable}
                      aria-pressed={vertical === v.slug}
                      title={unavailable ? 'This industry demo has not been seeded on this server yet' : undefined}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                        unavailable
                          ? 'bg-white/[0.02] border-white/5 text-slate-600 cursor-not-allowed line-through'
                          : vertical === v.slug
                            ? 'bg-brand-600 border-brand-600 text-white'
                            : 'bg-white/5 border-white/10 text-slate-300 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      {v.industry}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {nothingSeeded && (
            <div className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3">
              <p className="text-amber-300 text-sm font-medium">No demo workspaces have been set up yet</p>
              <p className="text-amber-200/70 text-xs mt-1 leading-relaxed">
                Run <code className="font-mono bg-black/30 px-1 py-0.5 rounded">npm run db:seed</code> in the server
                directory to create them. <code className="font-mono bg-black/30 px-1 py-0.5 rounded">GET /api/demo/status</code>{' '}
                reports the current state.
              </p>
            </div>
          )}

          <button
            onClick={handleTryDemo}
            disabled={loading || selected?.available === false}
            className="inline-flex items-center gap-2 px-7 py-3.5 bg-brand-600 hover:bg-brand-700 text-white rounded-xl font-semibold text-base shadow-lg shadow-brand-600/30 transition-colors disabled:opacity-60"
          >
            {loading ? (
              <><Loader2 size={20} className="animate-spin" /> Loading your demo workspace&hellip;</>
            ) : (
              <><Sparkles size={20} /> Try the Live Demo <ArrowRight size={18} /></>
            )}
          </button>

          {error && <p className="text-red-400 text-sm mt-4">{error}</p>}

          <p className="text-slate-500 text-xs mt-5 max-w-sm leading-relaxed">
            You'll be signed in as a Super Admin on a shared showcase workspace. Feel free to click
            around &mdash; nothing here belongs to a real customer, and it resets automatically every night.
          </p>

          <div className="grid grid-cols-2 gap-4 mt-12">
            {HIGHLIGHTS.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="bg-white/5 border border-white/10 rounded-xl p-4">
                <Icon size={17} className="text-brand-400 mb-2" />
                <p className="text-sm font-semibold text-white">{label}</p>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right: mocked product preview ─────────────────────────── */}
        <div className="hidden lg:block relative">
          <div className="absolute -inset-6 bg-gradient-to-br from-brand-500/10 to-indigo-500/10 rounded-[2rem] blur-2xl pointer-events-none" />
          <div className="relative bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            {/* Window chrome */}
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/10 bg-slate-900/80">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
              <span className="ml-3 text-xs text-slate-500">app.quantiqsystems.com/dashboard</span>
            </div>

            <div className="p-5 space-y-5">
              {/* Stat tiles */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 text-slate-500 text-xs mb-1.5"><Ticket size={12} /> Open Tickets</div>
                  <p className="text-xl font-bold text-white">7</p>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 text-slate-500 text-xs mb-1.5"><DollarSign size={12} /> Pipeline</div>
                  <p className="text-xl font-bold text-white">$450K</p>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 text-slate-500 text-xs mb-1.5"><TrendingUp size={12} /> Win Rate</div>
                  <p className="text-xl font-bold text-white">64%</p>
                </div>
              </div>

              {/* Tickets list */}
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5"><AlertTriangle size={13} className="text-amber-400" /> Recent Tickets</p>
                  <span className="text-[10px] text-slate-500">Live</span>
                </div>
                <div className="space-y-2">
                  {TICKETS.map(t => (
                    <div key={t.title} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-300 truncate">{t.title}</span>
                      <span className={`shrink-0 px-2 py-0.5 rounded-md border text-[10px] font-medium ${t.color}`}>{t.priority}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Deals list */}
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5"><CheckCircle2 size={13} className="text-emerald-400" /> Deal Pipeline</p>
                  <span className="text-[10px] text-slate-500 flex items-center gap-1"><Clock size={10} /> Updated now</span>
                </div>
                <div className="space-y-2">
                  {DEALS.map(d => (
                    <div key={d.title} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-300 truncate">{d.title}</span>
                      <span className="shrink-0 flex items-center gap-2">
                        <span className="text-slate-500">{d.stage}</span>
                        <span className="text-emerald-400 font-semibold">{d.value}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
