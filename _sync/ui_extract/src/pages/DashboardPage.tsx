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
import {
  AiGeneratedTag, AiInfo, AiNote,
  Alert, Badge, Button, Card, CardHeader, Input, PageBody, PageHeader, Spinner, StatTile,
} from '../shared/components';
import { AiInsightsWidget } from '../shared/components/AiInsightsWidget';
import { MeetingNotesModal } from '../shared/components/MeetingNotesModal';
import { useFormat } from '../hooks/useFormat';

/* Decorative icon tints for the quick-action tiles. `violet` and `indigo` used
   to be literal Tailwind hues, which made them a second accent competing with
   the brand scale — they now resolve to the theme's accent like everything else
   that means "this is us". The remaining hues are status-flavoured and keep
   their meaning. */
const ICON_COLORS = {
  blue:    { bg: 'bg-info-soft',    icon: 'text-info' },
  emerald: { bg: 'bg-success-soft', icon: 'text-success' },
  violet:  { bg: 'bg-accent-soft',  icon: 'text-accent' },
  indigo:  { bg: 'bg-accent-soft',  icon: 'text-accent' },
  orange:  { bg: 'bg-warning-soft', icon: 'text-warning' },
  amber:   { bg: 'bg-warning-soft', icon: 'text-warning' },
  red:     { bg: 'bg-danger-soft',  icon: 'text-danger' },
  gray:    { bg: 'bg-surface-sunken', icon: 'text-fg-muted' },
} as const;
type IconColor = keyof typeof ICON_COLORS;

interface StatCardProps {
  label: string;
  value: string | number | undefined;
  icon: React.ElementType;
  trend?: string;
  trendUp?: boolean;
  onClick?: () => void;
}

function StatCard({ label, value, icon: Icon, trend, trendUp, onClick }: StatCardProps) {
  return (
    <StatTile
      label={label}
      value={value ?? '--'}
      icon={<Icon size={18} />}
      onClick={onClick}
      hint={trend && (
        <span className={`font-medium ${trendUp ? 'text-success' : 'text-danger'}`}>
          {trendUp ? 'Up' : 'Down'} {trend}
        </span>
      )}
    />
  );
}

function SectionTitle({ color, label, action, onAction, infoId }: { color: string; label: string; action?: string; onAction?: () => void; infoId?: string }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2.5">
        <span className={`w-1 h-5 rounded-full ${color}`} />
        <h2 className="text-xs font-semibold text-fg-muted uppercase tracking-widest">{label}</h2>
        {infoId && <AiInfo id={infoId} />}
      </div>
      {action && onAction && (
        <Button variant="ghost" size="xs" onClick={onAction} iconRight={<ArrowRight size={12} />} className="!text-accent">
          {action}
        </Button>
      )}
    </div>
  );
}

function QuickAction({ label, icon: Icon, color, onClick }: { label: string; icon: React.ElementType; color: IconColor; onClick: () => void }) {
  const c = ICON_COLORS[color];
  return (
    <Card padding="sm" interactive onClick={onClick} className="flex items-center gap-3 text-left">
      <div className={`w-9 h-9 rounded-btn ${c.bg} flex items-center justify-center shrink-0`}>
        <Icon size={16} className={c.icon} />
      </div>
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="text-xs text-fg-subtle">Click to open</p>
      </div>
      <Plus size={15} className="text-fg-subtle ml-auto" />
    </Card>
  );
}

/* ── "What needs my attention today?" ──────────────────────────────────
   The first thing on the dashboard is work, not vanity numbers: SLA
   breaches, open tickets and leads awaiting follow-up, each clickable.
   Rendered only when the underlying count is non-zero; when everything is
   clear it collapses to a single quiet all-caught-up line. */
function AttentionItem({ icon: Icon, label, count, tone, onClick }: {
  icon: React.ElementType; label: string; count: number;
  tone: 'danger' | 'warning' | 'info'; onClick: () => void;
}) {
  const tones = {
    danger:  { chip: 'bg-danger-soft text-danger',   ring: 'hover:border-danger/40' },
    warning: { chip: 'bg-warning-soft text-warning', ring: 'hover:border-warning/40' },
    info:    { chip: 'bg-info-soft text-info',       ring: 'hover:border-info/40' },
  }[tone];
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-3 px-4 py-3 rounded-card border border-line bg-surface shadow-ui-sm text-left transition-all hover:shadow-ui-md ${tones.ring}`}
    >
      <span className={`w-8 h-8 rounded-btn flex items-center justify-center shrink-0 ${tones.chip}`}>
        <Icon size={15} />
      </span>
      <span className="min-w-0">
        <span className="block text-[17px] font-semibold text-fg leading-none tabular-nums">{count}</span>
        <span className="block text-[11.5px] text-fg-muted mt-1 truncate">{label}</span>
      </span>
      <ArrowRight size={13} className="ml-auto text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

const PRIORITY_CFG: Record<string, { label: string; bar: string }> = {
  CRITICAL: { label: 'Critical', bar: 'bg-danger' },
  HIGH:     { label: 'High',     bar: 'bg-warning' },
  MEDIUM:   { label: 'Medium',   bar: 'bg-info' },
  LOW:      { label: 'Low',      bar: 'bg-line-strong' },
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
    <Card padding="none" className="overflow-hidden">
      <div className="px-5 py-4 border-b border-line-subtle">
        <CardHeader
          title="Ask AI about your data"
          icon={<Sparkles size={15} className="text-accent" />}
          actions={<Badge variant="accent" size="sm">Beta</Badge>}
        />
      </div>
      <div className="p-5 space-y-4">
        <AiNote id="dashboard.query" />
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ask(question)}
            placeholder="e.g. How many tickets are SLA-breached today?"
            aria-label="Ask AI about your data"
            className="flex-1"
          />
          <Button
            onClick={() => ask(question)}
            disabled={!question.trim()}
            loading={nlQuery.isPending}
            icon={<Send size={13} />}
          >
            Ask
          </Button>
        </div>
        {!nlQuery.data && !nlQuery.isPending && (
          <div className="flex flex-wrap gap-2">
            {QUERIES.map(q => (
              <Button key={q} variant="secondary" size="xs" onClick={() => ask(q)} className="!rounded-badge">
                {q}
              </Button>
            ))}
          </div>
        )}
        {nlQuery.isPending && (
          <div className="flex items-center gap-2 text-sm text-accent animate-pulse py-1">
            <Sparkles size={13} /> Thinking...
          </div>
        )}
        {nlQuery.isError && (
          <Alert
            tone="danger"
            actions={<Button variant="ghost" size="xs" onClick={() => nlQuery.reset()}>Dismiss</Button>}
          >
            {(nlQuery.error as any)?.response?.data?.error || 'AI request failed.'}
          </Alert>
        )}
        {nlQuery.data && (
          <div className="space-y-1.5">
            <AiGeneratedTag />
            <Alert tone="accent" title="AI Answer">
              <p className="leading-relaxed">{nlQuery.data.answer}</p>
              <Button
                variant="ghost"
                size="xs"
                className="mt-2 -ml-2.5"
                onClick={() => { nlQuery.reset(); setQuestion(''); }}
              >
                Ask another
              </Button>
            </Alert>
          </div>
        )}
      </div>
    </Card>
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
    <div className="animate-slide-up">
      <PageHeader
        title={`${greeting}, ${firstName}!`}
        subtitle={new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}
        actions={
          <>
            <Button variant="secondary" icon={<FileText size={14} />} onClick={() => setMeetingNotesOpen(true)}>
              Parse Meeting Notes
            </Button>
            <AiInfo id="meeting.notes" align="left" className="-ml-1" />
            <Button variant="secondary" icon={<Plus size={14} />} onClick={() => navigate('/crm/contacts')}>
              Contact
            </Button>
            <Button icon={<Plus size={14} />} onClick={() => navigate('/itdesk/tickets')}>
              Ticket
            </Button>
          </>
        }
      />

      <PageBody>
        {/* Needs attention */}
        {!ticketsLoading && ticketReports && (
          (() => {
            const attention = [
              { key: 'sla', count: ticketReports.slaBreached ?? 0, label: 'SLA-breached tickets', icon: AlertCircle, tone: 'danger' as const, to: '/itdesk/tickets' },
              { key: 'open', count: ticketReports.open ?? 0, label: 'Open tickets awaiting action', icon: Ticket, tone: 'info' as const, to: '/itdesk/tickets' },
              { key: 'leads', count: activeLeads ?? 0, label: 'Leads awaiting follow-up', icon: Target, tone: 'warning' as const, to: '/crm/leads' },
            ].filter(a => a.count > 0);
            return attention.length ? (
              <section>
                <SectionTitle color="bg-danger" label="Needs attention" />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {attention.map(a => (
                    <AttentionItem key={a.key} icon={a.icon} label={a.label} count={a.count} tone={a.tone} onClick={() => navigate(a.to)} />
                  ))}
                </div>
              </section>
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-fg-muted">
                <CheckCircle size={14} className="text-success" /> All caught up — nothing needs your attention right now.
              </div>
            );
          })()
        )}

        {/* CRM stats */}
        <section>
          <SectionTitle color="bg-accent" label="CRM" action="View all" onAction={() => navigate('/crm/deals')} />
          {dealsLoading ? (
            <div className="h-32 flex items-center"><Spinner label="Loading CRM..." /></div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Open Deals" value={totalOpenDeals} icon={TrendingUp} onClick={() => navigate('/crm/deals')} />
              <StatCard label="Forecast Revenue" value={dealReports?.forecast != null ? money(dealReports.forecast) : '--'} icon={DollarSign} onClick={() => navigate('/crm/deals')} />
              <StatCard label="Contacts" value={contacts?.length ?? '--'} icon={Users} onClick={() => navigate('/crm/contacts')} />
              <StatCard label="Active Leads" value={activeLeads ?? '--'} icon={Target} onClick={() => navigate('/crm/leads')} />
            </div>
          )}
        </section>

        {/* IT Desk stats */}
        <section>
          <SectionTitle color="bg-warning" label="IT Desk" action="View tickets" onAction={() => navigate('/itdesk/tickets')} />
          {ticketsLoading ? (
            <div className="h-32 flex items-center"><Spinner label="Loading IT Desk..." /></div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="grid grid-cols-2 gap-4 lg:col-span-2">
                <StatCard label="Open" value={ticketReports?.open} icon={Ticket} onClick={() => navigate('/itdesk/tickets')} />
                <StatCard label="In Progress" value={ticketReports?.inProgress} icon={Clock} onClick={() => navigate('/itdesk/tickets')} />
                <StatCard label="SLA Breached" value={ticketReports?.slaBreached} icon={AlertCircle} onClick={() => navigate('/itdesk/tickets')} />
                <StatCard label="Resolved" value={ticketReports?.resolved} icon={CheckCircle} onClick={() => navigate('/itdesk/tickets')} />
              </div>
              {ticketReports?.byPriority?.length > 0 && (
                <Card>
                  <p className="text-xs font-semibold text-fg-subtle uppercase tracking-widest mb-4">By Priority</p>
                  <div className="space-y-3">
                    {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(p => {
                      const entry = ticketReports.byPriority.find((b: any) => b.priority === p);
                      const count = entry?._count ?? 0;
                      const pct = Math.round((count / totalPriority) * 100);
                      const cfg = PRIORITY_CFG[p];
                      return (
                        <div key={p}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-fg-muted">{cfg.label}</span>
                            <span className="text-xs font-bold text-fg tabular-nums">{count}</span>
                          </div>
                          <div className="h-1.5 bg-surface-sunken rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${cfg.bar} transition-all`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}
            </div>
          )}
        </section>

        {/* AI query + Quick actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AIQueryBar />
          <div className="space-y-3">
            <SectionTitle color="bg-line-strong" label="Quick Actions" />
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
          <SectionTitle color="bg-accent" label="AI Insights" infoId="dashboard.insights" />
          <AiInsightsWidget />
        </section>
      </PageBody>

      <MeetingNotesModal open={meetingNotesOpen} onClose={() => setMeetingNotesOpen(false)} />
    </div>
  );
}
