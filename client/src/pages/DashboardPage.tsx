import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  Ticket, TrendingUp, Users, Target, AlertCircle,
  CheckCircle, DollarSign, Clock, Sparkles, Send,
  ArrowUpRight, ArrowRight, Plus, BarChart2, FileText,
} from 'lucide-react';
import { useDealReports } from '../api/crm';
import { useContacts, useLeads } from '../api/crm';
import { useTicketReports } from '../api/itdesk';
import { useNLQuery } from '../api/ai';
import { Spinner } from '../shared/components';
import { AiInsightsWidget } from '../shared/components/AiInsightsWidget';
import { MeetingNotesModal } from '../shared/components/MeetingNotesModal';
import { useFormat } from '../hooks/useFormat';

const ICON_COLORS = {
  blue:    { bg: 'bg-blue-50 dark:bg-blue-500/10',       icon: 'text-blue-600 dark:text-blue-400' },
  emerald: { bg: 'bg-emerald-50 dark:bg-emerald-500/10', icon: 'text-emerald-600 dark:text-emerald-400' },
  violet:  { bg: 'bg-violet-50 dark:bg-violet-500/10',   icon: 'text-violet-600 dark:text-violet-400' },
  indigo:  { bg: 'bg-indigo-50 dark:bg-indigo-500/10',   icon: 'text-indigo-600 dark:text-indigo-400' },
  orange:  { bg: 'bg-orange-50 dark:bg-orange-500/10',   icon: 'text-orange-600 dark:text-orange-400' },
  amber:   { bg: 'bg-amber-50 dark:bg-amber-500/10',     icon: 'text-amber-600 dark:text-amber-400' },
  red:     { bg: 'bg-red-50 dark:bg-red-500/10',         icon: 'text-red-600 dark:text-red-400' },
  gray:    { bg: 'bg-gray-50 dark:bg-gray-800',          icon: 'text-gray-500 dark:text-gray-400' },
} as const;
type IconColor = keyof typeof ICON_COLORS;

interface StatCardProps {
  label: string;
  value: string | number | undefined;
  icon: React.ElementType;
  color: IconColor;
  trend?: string;
  trendUp?: boolean;
  onClick?: () => void;
}

function StatCard({ label, value, icon: Icon, color, trend, trendUp, onClick }: StatCardProps) {
  const c = ICON_COLORS[color];
  return (
    <div onClick={onClick} className={`bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-5 flex flex-col gap-4 hover:border-gray-200 dark:hover:border-gray-700 hover:shadow-card-hover card-hover transition-all ${onClick ? 'cursor-pointer' : ''}`}>
      <div className="flex items-start justify-between">
        <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center shrink-0`}>
          <Icon size={18} className={c.icon} />
        </div>
        {onClick && <ArrowUpRight size={15} className="text-gray-300 dark:text-gray-600 group-hover:text-gray-400" />}
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900 dark:text-white tabular-nums">{value ?? '--'}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{label}</p>
        {trend && (
          <p className={`text-xs mt-1.5 font-medium ${trendUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
            {trendUp ? 'Up' : 'Down'} {trend}
          </p>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ color, label, action, onAction }: { color: string; label: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2.5">
        <span className={`w-1 h-5 rounded-full ${color}`} />
        <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-widest">{label}</h2>
      </div>
      {action && onAction && (
        <button onClick={onAction} className="flex items-center gap-1 text-xs text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 font-medium">
          {action} <ArrowRight size={12} />
        </button>
      )}
    </div>
  );
}

function QuickAction({ label, icon: Icon, color, onClick }: { label: string; icon: React.ElementType; color: IconColor; onClick: () => void }) {
  const c = ICON_COLORS[color];
  return (
    <button onClick={onClick} className="flex items-center gap-3 p-4 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 hover:border-gray-200 dark:hover:border-gray-700 hover:shadow-card-hover transition-all text-left">
      <div className={`w-9 h-9 rounded-lg ${c.bg} flex items-center justify-center shrink-0`}>
        <Icon size={16} className={c.icon} />
      </div>
      <div>
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500">Click to open</p>
      </div>
      <Plus size={15} className="text-gray-300 dark:text-gray-600 ml-auto" />
    </button>
  );
}

const PRIORITY_CFG: Record<string, { label: string; bg: string; bar: string }> = {
  CRITICAL: { label: 'Critical', bg: 'bg-red-50',    bar: 'bg-red-500' },
  HIGH:     { label: 'High',     bg: 'bg-orange-50', bar: 'bg-orange-400' },
  MEDIUM:   { label: 'Medium',   bg: 'bg-blue-50',   bar: 'bg-blue-400' },
  LOW:      { label: 'Low',      bg: 'bg-gray-50',   bar: 'bg-gray-300' },
};

const QUERIES = [
  'How many deals are open?',
  'What is my forecasted revenue?',
  'How many tickets need attention?',
  'Summarise my pipeline.',
];

function AIQueryBar() {
  const [question, setQuestion] = useState('');
  const nlQuery = useNLQuery();

  async function ask(q: string) {
    if (!q.trim()) return;
    setQuestion(q);
    try { await nlQuery.mutateAsync(q); } catch { /* handled via nlQuery.error */ }
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-50 dark:border-gray-800 flex items-center gap-2">
        <Sparkles size={15} className="text-violet-500 dark:text-violet-400" />
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Ask AI about your data</span>
        <span className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-300">Beta</span>
      </div>
      <div className="p-5 space-y-4">
        <div className="flex gap-2">
          <input value={question} onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ask(question)}
            placeholder="e.g. How many tickets are SLA-breached today?"
            className="flex-1 px-3.5 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-xl bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent focus:bg-white dark:focus:bg-gray-800 placeholder-gray-400 dark:placeholder-gray-500 transition-all" />
          <button onClick={() => ask(question)} disabled={nlQuery.isPending || !question.trim()}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors shrink-0">
            {nlQuery.isPending ? <Spinner /> : <Send size={13} />}
            Ask
          </button>
        </div>
        {!nlQuery.data && !nlQuery.isPending && (
          <div className="flex flex-wrap gap-2">
            {QUERIES.map(q => (
              <button key={q} onClick={() => ask(q)}
                className="text-xs px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full text-gray-600 dark:text-gray-300 hover:bg-violet-600 hover:text-white hover:border-violet-600 transition-all">
                {q}
              </button>
            ))}
          </div>
        )}
        {nlQuery.isPending && (
          <div className="flex items-center gap-2 text-sm text-violet-600 dark:text-violet-400 animate-pulse py-1">
            <Sparkles size={13} /> Thinking...
          </div>
        )}
        {nlQuery.isError && (
          <div className="flex items-center justify-between bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/20 rounded-xl px-4 py-3">
            <p className="text-sm text-red-600 dark:text-red-400">{(nlQuery.error as any)?.response?.data?.error || 'AI request failed.'}</p>
            <button onClick={() => nlQuery.reset()} className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300 ml-3 shrink-0">Dismiss</button>
          </div>
        )}
        {nlQuery.data && (
          <div className="bg-violet-50 dark:bg-violet-500/10 border border-violet-100 dark:border-violet-500/20 rounded-xl p-4">
            <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider mb-2">AI Answer</p>
            <p className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed">{nlQuery.data.answer}</p>
            <button onClick={() => { nlQuery.reset(); setQuestion(''); }} className="text-xs text-violet-500 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 mt-3 font-medium">
              Ask another
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const { money, timezone } = useFormat();
  const navigate = useNavigate();
  const [meetingNotesOpen, setMeetingNotesOpen] = useState(false);
  const { data: dealReports, isLoading: dealsLoading } = useDealReports();
  const { data: contacts } = useContacts();
  const { data: leads } = useLeads();
  const { data: ticketReports, isLoading: ticketsLoading } = useTicketReports();

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = user?.name?.split(' ')[0];

  const totalOpenDeals = dealReports?.funnel?.reduce((s: number, f: any) => s + f.count, 0);
  const activeLeads = leads?.filter((l: any) => !['CONVERTED', 'UNQUALIFIED'].includes(l.status)).length;
  const totalPriority = ticketReports?.byPriority?.reduce((s: number, b: any) => s + (b._count || 0), 0) || 1;

  return (
    <div className="p-4 sm:p-6 space-y-5 animate-slide-up max-w-screen-xl mx-auto">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-0 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white" aria-label="Dashboard">{greeting}, {firstName}!</h1>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
            {new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setMeetingNotesOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <FileText size={14} /> Parse Meeting Notes
          </button>
          <button onClick={() => navigate('/crm/contacts')}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <Plus size={14} /> Contact
          </button>
          <button onClick={() => navigate('/itdesk/tickets')}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand-600 text-sm text-white hover:bg-brand-700 transition-colors">
            <Plus size={14} /> Ticket
          </button>
        </div>
      </div>

      {/* CRM stats */}
      <section>
        <SectionTitle color="bg-brand-600" label="CRM" action="View all" onAction={() => navigate('/crm/deals')} />
        {dealsLoading ? (
          <div className="h-32 flex items-center"><Spinner label="Loading CRM..." /></div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Open Deals" value={totalOpenDeals} icon={TrendingUp} color="blue" onClick={() => navigate('/crm/deals')} />
            <StatCard label="Forecast Revenue" value={dealReports?.forecast != null ? money(dealReports.forecast) : '--'} icon={DollarSign} color="emerald" onClick={() => navigate('/crm/deals')} />
            <StatCard label="Contacts" value={contacts?.length ?? '--'} icon={Users} color="violet" onClick={() => navigate('/crm/contacts')} />
            <StatCard label="Active Leads" value={activeLeads ?? '--'} icon={Target} color="indigo" onClick={() => navigate('/crm/leads')} />
          </div>
        )}
      </section>

      {/* IT Desk stats */}
      <section>
        <SectionTitle color="bg-orange-400" label="IT Desk" action="View tickets" onAction={() => navigate('/itdesk/tickets')} />
        {ticketsLoading ? (
          <div className="h-32 flex items-center"><Spinner label="Loading IT Desk..." /></div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="grid grid-cols-2 gap-4 lg:col-span-2">
              <StatCard label="Open" value={ticketReports?.open} icon={Ticket} color="orange" onClick={() => navigate('/itdesk/tickets')} />
              <StatCard label="In Progress" value={ticketReports?.inProgress} icon={Clock} color="amber" onClick={() => navigate('/itdesk/tickets')} />
              <StatCard label="SLA Breached" value={ticketReports?.slaBreached} icon={AlertCircle} color="red" onClick={() => navigate('/itdesk/tickets')} />
              <StatCard label="Resolved" value={ticketReports?.resolved} icon={CheckCircle} color="emerald" onClick={() => navigate('/itdesk/tickets')} />
            </div>
            {ticketReports?.byPriority?.length > 0 && (
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-5">
                <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-4">By Priority</p>
                <div className="space-y-3">
                  {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(p => {
                    const entry = ticketReports.byPriority.find((b: any) => b.priority === p);
                    const count = entry?._count ?? 0;
                    const pct = Math.round((count / totalPriority) * 100);
                    const cfg = PRIORITY_CFG[p];
                    return (
                      <div key={p}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{cfg.label}</span>
                          <span className="text-xs font-bold text-gray-800 dark:text-gray-200 tabular-nums">{count}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${cfg.bar} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* AI query + Quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <AIQueryBar />
        <div className="space-y-3">
          <SectionTitle color="bg-gray-300" label="Quick Actions" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <QuickAction label="New Contact"  icon={Users}       color="violet"  onClick={() => navigate('/crm/contacts')} />
            <QuickAction label="New Lead"     icon={Target}      color="indigo"  onClick={() => navigate('/crm/leads')} />
            <QuickAction label="New Deal"     icon={TrendingUp}  color="blue"    onClick={() => navigate('/crm/deals')} />
            <QuickAction label="New Ticket"   icon={Ticket}      color="orange"  onClick={() => navigate('/itdesk/tickets')} />
            <QuickAction label="Reports"      icon={BarChart2}   color="emerald" onClick={() => navigate('/reports')} />
            <QuickAction label="Import CSV"   icon={ArrowUpRight} color="gray"   onClick={() => navigate('/import')} />
          </div>
        </div>
      </div>

      {/* AI Insights */}
      <section className="w-full">
        <SectionTitle color="bg-violet-500" label="AI Insights" />
        <AiInsightsWidget />
      </section>

      <MeetingNotesModal open={meetingNotesOpen} onClose={() => setMeetingNotesOpen(false)} />
    </div>
  );
}
