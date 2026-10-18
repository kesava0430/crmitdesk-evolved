import { useModules } from '../shared/modules';
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useEmployeeStats } from '../api/people';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  Ticket, TrendingUp, Users, Target, AlertCircle,
  CheckCircle, DollarSign, Clock, Sparkles, Send,
  ArrowUpRight, ArrowRight, Plus, BarChart2, FileText, CalendarCheck, Wallet, Home,
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
import { AnalyticsAnswer, answerViewFromAsk } from '../shared/components/AnalyticsAnswer';
import { MeetingNotesModal } from '../shared/components/MeetingNotesModal';
import { useFormat } from '../hooks/useFormat';
import { can } from '../shared/permissions';
import { useHomeDashboard, useDashboard, useSetHome } from '../api/dashboards';
import { useAnalyticsCatalog, type AnalyticsWidgetSpec } from '../api/analytics';
import { PinToDashboardDialog } from '../shared/components/dashboards/DashboardDialogs';
import { DashboardCanvas } from './DashboardViewPage';

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

/* Offered only when the org has the area and the asker's catalog has the data. */
const QUERIES = [
  { q: 'How many leads did we get each week for the last 12 weeks?', area: 'crm', dataset: 'leads' },
  { q: 'Project our leads for the next 30 days if things continue the same way', area: 'crm', dataset: 'leads' },
  { q: 'Top 5 agents by tickets resolved this month', area: 'itdesk', dataset: 'tickets' },
  { q: 'Open tickets by priority', area: 'itdesk', dataset: 'tickets' },
  { q: 'Who was absent yesterday?', area: 'hr', dataset: 'attendance' },
  { q: 'Total payroll cost last 3 months by department', area: 'hr', dataset: 'payslips' },
];

/** What the dashboard AI can see, naming only the areas the org has. */
function aiScope(areas: { crm: boolean; itdesk: boolean }) {
  return areas.crm && areas.itdesk ? 'your pipeline and help desk' : areas.crm ? 'your pipeline' : 'your help desk';
}

/** Areas the Ask card can talk about, in words. */
function askScope(areas: { crm: boolean; itdesk: boolean; hr: boolean }) {
  const parts = [areas.crm && 'sales', areas.itdesk && 'help desk', areas.hr && 'people, attendance and payroll'].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? 'your business';
}

function AIQueryBar({ areas }: { areas: { crm: boolean; itdesk: boolean; hr: boolean } }) {
  const { data: catalog } = useAnalyticsCatalog();
  const suggestions = QUERIES.filter(x => areas[x.area as 'crm' | 'itdesk' | 'hr'] && (!catalog || catalog.datasets.some(d => d.key === x.dataset))).map(x => x.q).slice(0, 4);
  const [question, setQuestion] = useState('');
  const nlQuery = useNLQuery();
  const [pin, setPin] = useState<AnalyticsWidgetSpec | null>(null);

  async function ask(q: string) {
    if (!q.trim()) return;
    setQuestion(q);
    try { await nlQuery.mutateAsync(q); } catch { /* handled via nlQuery.error */ }
  }

  /* "Full answer and chart" links from the WhatsApp/Slack assistant open
     /dashboard?ask=<question>: re-asked here as the viewer (cached plan). */
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const q = params.get('ask');
    if (!q) return;
    const next = new URLSearchParams(params);
    next.delete('ask');
    setParams(next, { replace: true });
    ask(q.slice(0, 500));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card padding="none" className="overflow-hidden min-w-0">
      <div className="px-5 py-4 border-b border-line-subtle">
        <CardHeader
          title="Ask AI about your data"
          icon={<Sparkles size={15} className="text-accent" />}
          actions={<Badge variant="accent" size="sm">Beta</Badge>}
        />
      </div>
      <div className="p-4 sm:p-5 space-y-4">
        <AiNote id="dashboard.query" does={`Answers questions about your ${askScope(areas)} from your own data, with a chart and how it was calculated.`} />
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ask(question)}
            placeholder={`e.g. ${suggestions[0] ?? 'What changed this week?'}`}
            aria-label="Ask AI about your data"
            className="flex-1 min-w-0"
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
            {suggestions.map(q => (
              <Button key={q} variant="secondary" size="xs" onClick={() => ask(q)} className="!rounded-badge !h-auto !py-1 text-left whitespace-normal">
                {q}
              </Button>
            ))}
          </div>
        )}
        {nlQuery.isPending && (
          <div className="flex items-center gap-2 text-sm text-accent animate-pulse py-1">
            <Sparkles size={13} /> Working it out from your data...
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
          <div className="space-y-2 min-w-0">
            <AiGeneratedTag />
            <AnalyticsAnswer view={answerViewFromAsk(nlQuery.data)} onPin={setPin} />
            <Button
              variant="ghost"
              size="xs"
              className="-ml-2.5"
              onClick={() => { nlQuery.reset(); setQuestion(''); }}
            >
              Ask another
            </Button>
          </div>
        )}
      </div>
      <PinToDashboardDialog spec={pin} open={!!pin} onClose={() => setPin(null)} />
    </Card>
  );
}

/* The user's chosen home dashboard (Dashboards → "Set as my home"), rendered
   with their own permissions, below the built-in dashboard or instead of it. */
function HomeDashboard({ id, replaceBuiltIn }: { id: string; replaceBuiltIn: boolean }) {
  const navigate = useNavigate();
  const { data: d } = useDashboard(id);
  const setHome = useSetHome();
  if (!d) return <div className="h-40 skeleton" />;
  return (
    <section className="space-y-3" data-testid="home-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-1 h-5 rounded-full bg-accent" />
          <h2 className="text-xs font-semibold text-fg-muted uppercase tracking-widest truncate">{d.title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="xs" onClick={() => setHome.mutate({ dashboardId: id, replaceBuiltIn: !replaceBuiltIn })}>
            {replaceBuiltIn ? 'Show the built-in dashboard too' : 'Show only this'}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => navigate(`/dashboards/${id}`)} iconRight={<ArrowRight size={12} />} className="!text-accent">Open</Button>
        </div>
      </div>
      {d.widgets.length ? <DashboardCanvas dashboard={d} /> : <p className="text-[13px] text-fg-muted">This dashboard has no widgets yet.</p>}
    </section>
  );
}

/* HR managers' snapshot: who's in today, working from home, leave waiting
   for a decision, and headcount — from the same endpoints the Attendance,
   Leave and People pages use. Each tile only asks when its module is on. */
function HrOverview({ attendanceOn }: { attendanceOn: boolean }) {
  const navigate = useNavigate();
  const { data: today } = useQuery<any[]>({
    queryKey: ['dashboard-attendance-today'],
    queryFn: () => api.get('/hr/attendance/today').then(r => r.data),
    enabled: attendanceOn, staleTime: 60_000,
  });
  const { data: pending } = useQuery<any[]>({
    queryKey: ['dashboard-leave-pending'],
    queryFn: () => api.get('/hr/leave/requests', { params: { scope: 'org', status: 'PENDING' } }).then(r => r.data),
    staleTime: 60_000,
  });
  const { data: stats } = useEmployeeStats();
  const checkedIn = today?.filter(r => r.isCheckedInNow).length;
  const wfh = today?.filter(r => r.wfh).length;
  return (
    <section>
      <SectionTitle color="bg-success" label="HR" action="People" onAction={() => navigate('/people')} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {attendanceOn && <StatCard label="Checked in now" value={today ? `${checkedIn} / ${today.length}` : '--'} icon={Clock} onClick={() => navigate('/hr/attendance')} />}
        {attendanceOn && <StatCard label="Working from home" value={wfh ?? '--'} icon={Home} onClick={() => navigate('/hr/attendance')} />}
        <StatCard label="Leave awaiting approval" value={pending?.length ?? '--'} icon={CalendarCheck} onClick={() => navigate('/hr/leave')} />
        <StatCard label="Headcount" value={stats?.total ?? '--'} icon={Users} onClick={() => navigate('/people')} />
      </div>
    </section>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const { money, timezone } = useFormat();
  const navigate = useNavigate();
  const [meetingNotesOpen, setMeetingNotesOpen] = useState(false);
  /* Which halves of this dashboard is this person allowed to see?
     The CRM and IT Desk report endpoints are manager-scoped, and the
     contact/lead lists are CRM-staff-scoped. Firing them regardless meant
     every role except SUPER_ADMIN hit a wall of refusals the moment they
     logged in — four for IT_AGENT and EMPLOYEE, three for IT_MANAGER, two for
     SALES_REP, one for CRM_MANAGER. Asking only for what this role can read
     means each person's dashboard is simply the part of it that applies to
     them. */
  const role = user?.role;
  /* …and which areas the org has at all (Platform Admin switches HR / CRM /
     IT Desk per org). Widgets and shortcuts of a switched-off area are
     simply not there. */
  const modules = useModules();
  const crmOn = modules.isModuleOn('crm');
  const itdeskOn = modules.isModuleOn('itdesk');
  const showCrm    = can.readCrm(role) && crmOn;
  const showCrmKpis = can.readCrmReports(role) && crmOn;
  const showItDesk = can.readTicketReports(role) && itdeskOn;

  const { data: dealReports, isLoading: dealsLoading } = useDealReports(showCrmKpis);
  const { data: contacts } = useContacts(undefined, showCrm);
  const { data: leads } = useLeads(undefined, showCrm);
  const { data: ticketReports, isLoading: ticketsLoading } = useTicketReports(showItDesk);

  /* POST /ai/query and POST /ai/insights are both MANAGERS-only — and they
     only know CRM and help-desk numbers, so an org without either (HR only)
     doesn't get them at all. */
  const showAiPanels = can.readAnalytics(role) && (crmOn || itdeskOn);
  const hrOn = modules.isModuleOn('hr_core');
  const attendanceOn = modules.isModuleOn('attendance');
  const payrollOn = modules.isModuleOn('payroll');
  const showHr = hrOn && can.readHrAdmin(role);
  /* Ask AI answers from the query layer with the asker's own permissions
     (POST /ai/query), in every area — HR-only orgs included. A "Full answer
     and chart" link from the WhatsApp/Slack assistant (/dashboard?ask=…) must
     open the answer for anyone who can message the assistant — employees
     included — and even when a home dashboard replaces the built-in one, so
     remember it was a deep link (the card strips the parameter on mount). */
  const [searchParams] = useSearchParams();
  const [askLink] = useState(() => searchParams.has('ask'));
  const showAsk = can.readStaffRecords(role) || askLink;

  /* Only offer shortcuts the user can actually follow. */
  const quickActions = [
    { label: 'New Contact', icon: Users,       color: 'violet'  as IconColor, to: '/crm/contacts',    show: showCrm },
    { label: 'New Lead',    icon: Target,      color: 'indigo'  as IconColor, to: '/crm/leads',       show: showCrm },
    { label: 'New Deal',    icon: TrendingUp,  color: 'blue'    as IconColor, to: '/crm/deals',       show: showCrm },
    { label: 'New Ticket',  icon: Ticket,      color: 'orange'  as IconColor, to: '/itdesk/tickets',  show: itdeskOn },
    { label: 'Attendance',  icon: Clock,       color: 'orange'  as IconColor, to: '/hr/attendance',   show: attendanceOn },
    { label: 'Leave',       icon: CalendarCheck, color: 'emerald' as IconColor, to: '/hr/leave',      show: hrOn },
    { label: 'People',      icon: Users,       color: 'violet'  as IconColor, to: '/people',          show: hrOn && !crmOn && !itdeskOn },
    { label: 'Payroll',     icon: Wallet,      color: 'blue'    as IconColor, to: '/hr/payroll',      show: payrollOn && !crmOn && !itdeskOn },
    { label: 'My Work',     icon: CheckCircle, color: 'emerald' as IconColor, to: '/my-work',         show: true },
    { label: 'Reports',     icon: BarChart2,   color: 'emerald' as IconColor, to: '/reports',         show: can.readAdmin(role) && (crmOn || itdeskOn) },
    { label: 'Import CSV',  icon: ArrowUpRight, color: 'gray'   as IconColor, to: '/import',          show: can.readCrmReports(role) && (crmOn || itdeskOn) },
  ].filter(a => a.show);

  const { data: homeData, isFetched: homeFetched } = useHomeDashboard();
  /* For a deep link, wait until we know where the card goes (above a home
     dashboard that replaces the built-in one, or in its usual place): it
     strips ?ask= and asks on mount, so mounting it twice would lose it. */
  const askReady = !askLink || homeFetched;
  const home = homeData?.home ?? null;
  const builtIn = !home?.replaceBuiltIn;

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
            {crmOn && (
              <>
                <Button variant="secondary" icon={<FileText size={14} />} onClick={() => setMeetingNotesOpen(true)}>
                  Parse Meeting Notes
                </Button>
                <AiInfo id="meeting.notes" align="left" className="-ml-1" />
              </>
            )}
            {crmOn && (
              <Button variant="secondary" icon={<Plus size={14} />} onClick={() => navigate('/crm/contacts')}>
                Contact
              </Button>
            )}
            {itdeskOn && (
              <Button icon={<Plus size={14} />} onClick={() => navigate('/itdesk/tickets')}>
                Ticket
              </Button>
            )}
          </>
        }
      />

      <PageBody>
        {home && !builtIn && askLink && askReady && <AIQueryBar areas={{ crm: crmOn, itdesk: itdeskOn, hr: hrOn }} />}
        {home && !builtIn && <HomeDashboard id={home.dashboardId} replaceBuiltIn />}
        {builtIn && <>
        {/* Needs attention */}
        {!ticketsLoading && ticketReports && (
          (() => {
            const attention = [
              { key: 'sla', count: ticketReports.slaBreached ?? 0, label: 'SLA-breached tickets', icon: AlertCircle, tone: 'danger' as const, to: '/itdesk/tickets' },
              { key: 'open', count: ticketReports.open ?? 0, label: 'Open tickets awaiting action', icon: Ticket, tone: 'info' as const, to: '/itdesk/tickets' },
              { key: 'leads', count: showCrm ? (activeLeads ?? 0) : 0, label: 'Leads awaiting follow-up', icon: Target, tone: 'warning' as const, to: '/crm/leads' },
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

        {/* CRM stats — only for roles that can read CRM data */}
        {(showCrm || showCrmKpis) && (
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
        )}

        {/* IT Desk stats — reports are IT_MANAGERS-only */}
        {showItDesk && (
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
        )}

        {/* HR at a glance — managers, when the org has HR. */}
        {showHr && <HrOverview attendanceOn={attendanceOn} />}

        {/* AI query + Quick actions. Ask AI is open to every staff role (its
            answers only use what the asker may see); AI Insights below still
            posts to a MANAGERS-only endpoint. Quick actions are filtered too:
            a shortcut to a page the user cannot open is not a shortcut. */}
        <div className={`grid grid-cols-1 gap-6 ${showAsk ? 'lg:grid-cols-2' : ''}`}>
          {showAsk && askReady && <AIQueryBar areas={{ crm: crmOn, itdesk: itdeskOn, hr: hrOn }} />}
          {quickActions.length > 0 && (
            <div className="space-y-3">
              <SectionTitle color="bg-line-strong" label="Quick Actions" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {quickActions.map(a => (
                  <QuickAction key={a.label} label={a.label} icon={a.icon} color={a.color} onClick={() => navigate(a.to)} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* AI Insights */}
        {showAiPanels && (
          <section className="w-full">
            <SectionTitle color="bg-accent" label="AI Insights" infoId="dashboard.insights" />
            <AiInsightsWidget note={`Looks across ${aiScope({ crm: crmOn, itdesk: itdeskOn })} numbers and flags three to five things worth attention.`} />
          </section>
        )}
        </>}
        {home && builtIn && <HomeDashboard id={home.dashboardId} replaceBuiltIn={false} />}
      </PageBody>

      <MeetingNotesModal open={meetingNotesOpen} onClose={() => setMeetingNotesOpen(false)} />
    </div>
  );
}
