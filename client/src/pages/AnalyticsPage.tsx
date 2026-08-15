import { useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area
} from 'recharts';
import { TrendingUp, TrendingDown, Minus, Download, BarChart2, Clock, Target, DollarSign } from 'lucide-react';
import { useAnalyticsOverview, useTicketAnalytics, useCrmAnalytics } from '../api/analytics';
import { Spinner } from '../shared/components';
import { useFormat } from '../hooks/useFormat';

// ─── Colors ───────────────────────────────────────────────────────────────────

const COLORS = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
const STATUS_COLORS: Record<string, string> = {
  OPEN: '#4f46e5', IN_PROGRESS: '#f59e0b', PENDING: '#f97316', RESOLVED: '#10b981', CLOSED: '#6b7280',
};
const PRIORITY_COLORS: Record<string, string> = {
  LOW: '#6b7280', MEDIUM: '#4f46e5', HIGH: '#f59e0b', CRITICAL: '#ef4444',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const shortDate = (s: string) => s.slice(5); // MM-DD from YYYY-MM-DD

function downloadCsv(data: any[], filename: string) {
  if (!data.length) return;
  const keys = Object.keys(data[0]);
  const rows = [keys.join(','), ...data.map(r => keys.map(k => String(r[k] ?? '')).join(','))];
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, change, prefix = '', suffix = '', icon: Icon }: {
  label: string; value: number | string; change?: number; prefix?: string; suffix?: string; icon: React.ElementType;
}) {
  const isPos = change !== undefined && change > 0;
  const isNeg = change !== undefined && change < 0;
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-4 sm:p-5 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
        <div className="w-8 h-8 rounded-xl bg-brand-50 dark:bg-brand-500/10 flex items-center justify-center">
          <Icon size={15} className="text-brand-600 dark:text-brand-400" />
        </div>
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{prefix}{value}{suffix}</p>
      {change !== undefined && (
        <div className={`flex items-center gap-1 mt-2 text-xs font-medium ${isPos ? 'text-green-600 dark:text-green-400' : isNeg ? 'text-red-500 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`}>
          {isPos ? <TrendingUp size={12} /> : isNeg ? <TrendingDown size={12} /> : <Minus size={12} />}
          {isPos ? '+' : ''}{change}% vs prev 30d
        </div>
      )}
    </div>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children, onExport }: { title: string; children: React.ReactNode; onExport?: () => void }) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-4 sm:p-5 overflow-hidden">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-semibold text-gray-900 dark:text-white text-sm">{title}</h2>
        {onExport && (
          <button onClick={onExport} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400">
            <Download size={11} /> Export CSV
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const { symbol } = useFormat();
  const fmt = (n: number) => n >= 1000 ? `${symbol}${(n / 1000).toFixed(1)}k` : `${symbol}${n}`;
  const [days, setDays] = useState(30);

  const { data: overview } = useAnalyticsOverview();
  const { data: tickets, isLoading: ticketsLoading } = useTicketAnalytics(days);
  const { data: crm, isLoading: crmLoading } = useCrmAnalytics(days);

  const volumeData = tickets?.volume.labels.map((label, i) => ({
    date: shortDate(label),
    Created: tickets.volume.created[i],
    Resolved: tickets.volume.resolved[i],
  })) || [];

  const forecastData = (() => {
    if (!tickets) return [];
    const last7 = tickets.volume.labels.slice(-7).map((label, i) => ({
      date: shortDate(label), Actual: tickets.volume.created[tickets.volume.labels.length - 7 + i], Forecast: undefined as undefined | number,
    }));
    const futureDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() + i + 1);
      return d.toISOString().slice(5, 10);
    });
    const future = futureDates.map((date, i) => ({ date, Actual: undefined as undefined | number, Forecast: tickets.volume.forecast[i] }));
    return [...last7, ...future];
  })();

  const statusData = tickets?.byStatus.map(s => ({ name: s.status.replace('_', ' '), value: s.count })) || [];
  const priorityData = tickets?.byPriority.map(p => ({ name: p.priority, value: p.count })) || [];
  const pipelineData = crm?.deals.pipeline.map(p => ({ stage: p.stage, Count: p.count, Value: p.value })) || [];
  const leadStatusData = crm?.leads.byStatus.map(l => ({ name: l.status, value: l.count })) || [];

  const revenueData = crm?.deals.revenue.labels.map((label, i) => ({
    date: shortDate(label),
    Revenue: crm.deals.revenue.values[i],
  })) || [];

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto animate-slide-up">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <BarChart2 size={20} className="text-brand-600" />
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Analytics</h1>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Performance metrics, trends, and forecasts.</p>
        </div>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          className="px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-400 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 self-start sm:self-auto">
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard label="Open Tickets" value={overview?.tickets.current ?? '—'} change={overview?.tickets.change} icon={BarChart2} />
        <KpiCard label="New Leads" value={overview?.leads.current ?? '—'} change={overview?.leads.change} icon={Target} />
        <KpiCard label="Revenue Won" value={overview?.revenue.current ? fmt(overview.revenue.current) : '—'} change={overview?.revenue.change} icon={DollarSign} />
        <KpiCard label="Avg Resolution" value={overview?.avgResolutionHours != null ? `${overview.avgResolutionHours}h` : '—'} icon={Clock} />
      </div>

      {/* SLA + win rate badges */}
      {(tickets?.slaCompliance != null || crm?.deals.winRate != null) && (
        <div className="flex flex-wrap gap-3 mb-6">
          {tickets?.slaCompliance != null && (
            <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border ${tickets.slaCompliance >= 90 ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30 text-green-800 dark:text-green-300' : tickets.slaCompliance >= 70 ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-800 dark:text-amber-300' : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-800 dark:text-red-300'}`}>
              SLA Compliance: <strong>{tickets.slaCompliance}%</strong>
            </div>
          )}
          {crm?.deals.winRate != null && (
            <div className="flex items-center gap-2 px-4 py-2 bg-brand-50 dark:bg-brand-500/10 border border-brand-200 dark:border-brand-500/30 text-brand-800 dark:text-brand-300 rounded-xl text-sm font-medium">
              Deal Win Rate: <strong>{crm.deals.winRate}%</strong>
            </div>
          )}
          {crm?.leads.conversionRate != null && (
            <div className="flex items-center gap-2 px-4 py-2 bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/30 text-violet-800 dark:text-violet-300 rounded-xl text-sm font-medium">
              Lead Conversion: <strong>{crm.leads.conversionRate}%</strong>
            </div>
          )}
        </div>
      )}

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Ticket volume */}
        <Section title="Ticket Volume (Created vs. Resolved)"
          onExport={() => downloadCsv(volumeData, 'ticket_volume.csv')}>
          {ticketsLoading ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={volumeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Legend />
                <Area type="monotone" dataKey="Created" stroke="#4f46e5" fill="#ede9fe" strokeWidth={2} />
                <Area type="monotone" dataKey="Resolved" stroke="#10b981" fill="#d1fae5" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Section>

        {/* Forecast */}
        <Section title="7-Day Ticket Forecast">
          {ticketsLoading ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={forecastData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="Actual" stroke="#4f46e5" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="Forecast" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 5" dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Section>

        {/* Ticket status donut */}
        <Section title="Tickets by Status" onExport={() => downloadCsv(statusData, 'ticket_status.csv')}>
          {ticketsLoading ? <Spinner /> : statusData.length === 0 ? <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">No data yet</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={e => `${e.name} (${e.value})`} labelLine={false}>
                  {statusData.map(s => <Cell key={s.name} fill={STATUS_COLORS[s.name.replace(' ', '_')] || '#ccc'} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Section>

        {/* Priority bar */}
        <Section title="Tickets by Priority" onExport={() => downloadCsv(priorityData, 'ticket_priority.csv')}>
          {ticketsLoading ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={priorityData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {priorityData.map(p => <Cell key={p.name} fill={PRIORITY_COLORS[p.name] || '#ccc'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Section>

        {/* Deal pipeline */}
        <Section title="Deal Pipeline by Stage" onExport={() => downloadCsv(pipelineData, 'deal_pipeline.csv')}>
          {crmLoading ? <Spinner /> : pipelineData.length === 0 ? <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">No open deals</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={pipelineData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis dataKey="stage" type="category" tick={{ fontSize: 10 }} width={90} />
                <Tooltip formatter={(v: any, name: string) => name === 'Value' ? fmt(Number(v)) : v} />
                <Legend />
                <Bar dataKey="Count" fill="#4f46e5" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Section>

        {/* Won revenue over time */}
        <Section title="Won Deal Revenue" onExport={() => downloadCsv(revenueData, 'revenue.csv')}>
          {crmLoading ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={v => `${symbol}${v}`} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: any) => fmt(Number(v))} />
                <Area type="monotone" dataKey="Revenue" stroke="#10b981" fill="#d1fae5" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Section>

        {/* Lead status */}
        <Section title="Lead Status Distribution" onExport={() => downloadCsv(leadStatusData, 'lead_status.csv')}>
          {crmLoading ? <Spinner /> : leadStatusData.length === 0 ? <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">No leads yet</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={leadStatusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={e => `${e.name} (${e.value})`}>
                  {leadStatusData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Section>

        {/* Tickets by category */}
        {tickets?.byCategory && tickets.byCategory.length > 0 && (
          <Section title="Tickets by Category" onExport={() => downloadCsv(tickets.byCategory, 'ticket_category.csv')}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={tickets.byCategory}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Section>
        )}
      </div>
    </div>
  );
}
