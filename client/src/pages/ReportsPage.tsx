import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Star, MessageSquare } from 'lucide-react';
import { api } from '../api/client';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Spinner } from '../shared/components';
import { useCsatResponses, useCsatStats } from '../api/csat';

const PRIORITY_COLORS: Record<string, string> = { CRITICAL: '#ef4444', HIGH: '#f97316', MEDIUM: '#3b82f6', LOW: '#9ca3af' };
const STATUS_COLORS = ['#3b82f6','#f59e0b','#f97316','#22c55e','#6b7280'];

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <div className="w-1 h-5 bg-brand-600 rounded-full" />
      <div>
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
        {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
      </div>
    </div>
  );
}

function Card({ children, className = '' }: any) {
  return <div className={`bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4 sm:p-5 overflow-hidden ${className}`}>{children}</div>;
}

function StarRow({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <Star key={n} size={13} className={n <= rating ? 'fill-amber-400 text-amber-400' : 'text-gray-200'} />
      ))}
    </span>
  );
}

export function ReportsPage() {
  const [tab, setTab] = useState<'tickets' | 'crm' | 'csat'>('tickets');
  const [csatPage, setCsatPage] = useState(1);

  const { data: ticketData, isLoading: ticketsLoading } = useQuery({
    queryKey: ['reports-tickets'],
    queryFn: () => api.get('/reports/tickets').then(r => r.data),
    enabled: tab === 'tickets',
  });

  const { data: crmData, isLoading: crmLoading } = useQuery({
    queryKey: ['reports-crm'],
    queryFn: () => api.get('/reports/crm').then(r => r.data),
    enabled: tab === 'crm',
  });

  const { data: csatStats, isLoading: csatStatsLoading } = useCsatStats(tab === 'csat');
  const { data: csatResponses, isLoading: csatResponsesLoading } = useCsatResponses(csatPage, tab === 'csat');

  return (
    <div className="p-4 sm:p-6 space-y-6 animate-slide-up">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Reports & Analytics</h1>
          <p className="text-sm text-gray-400 mt-0.5">Last 30 days</p>
        </div>
        <div className="flex flex-wrap rounded-lg border border-gray-200 overflow-hidden self-start sm:self-auto">
          <button onClick={() => setTab('tickets')} className={`px-4 py-2 text-sm font-medium ${tab === 'tickets' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>IT Desk</button>
          <button onClick={() => setTab('crm')} className={`px-4 py-2 text-sm font-medium ${tab === 'crm' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>CRM</button>
          <button onClick={() => setTab('csat')} className={`px-4 py-2 text-sm font-medium ${tab === 'csat' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>Feedback</button>
        </div>
      </div>

      {tab === 'tickets' && (
        ticketsLoading ? <Spinner /> : (
          <div className="space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card>
                <p className="text-3xl font-bold text-brand-600">{ticketData?.slaCompliance ?? '—'}%</p>
                <p className="text-sm text-gray-500 mt-1">SLA Compliance Rate</p>
                <div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-brand-500 rounded-full transition-all" style={{ width: `${ticketData?.slaCompliance || 0}%` }} />
                </div>
              </Card>
              <Card>
                <p className="text-3xl font-bold text-green-600">{ticketData?.statusBreakdown?.find((s: any) => s.status === 'RESOLVED')?._count ?? 0}</p>
                <p className="text-sm text-gray-500 mt-1">Total Resolved</p>
              </Card>
              <Card>
                <p className="text-3xl font-bold text-orange-600">{ticketData?.statusBreakdown?.find((s: any) => s.status === 'OPEN')?._count ?? 0}</p>
                <p className="text-sm text-gray-500 mt-1">Currently Open</p>
              </Card>
            </div>

            {/* Ticket volume */}
            <Card>
              <SectionHeader title="Ticket Volume" subtitle="New tickets created per day (last 30 days)" />
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={ticketData?.volume || []} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip labelFormatter={(v: string) => `Date: ${v}`} />
                  <Line type="monotone" dataKey="count" stroke="#2563eb" strokeWidth={2} dot={false} name="Tickets" />
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Avg resolution time */}
              <Card>
                <SectionHeader title="Avg Resolution Time by Priority" subtitle="Hours to resolve" />
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={ticketData?.resolutionTime || []} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="priority" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} unit="h" />
                    <Tooltip formatter={(v: any) => [`${v}h`, 'Avg Time']} />
                    <Bar dataKey="avgHours" radius={[4,4,0,0]}>
                      {(ticketData?.resolutionTime || []).map((e: any) => (
                        <Cell key={e.priority} fill={PRIORITY_COLORS[e.priority] || '#6b7280'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              {/* Status breakdown pie */}
              <Card>
                <SectionHeader title="Status Breakdown" subtitle="Current ticket distribution" />
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={ticketData?.statusBreakdown || []} dataKey="_count" nameKey="status" cx="50%" cy="50%" outerRadius={75} label={({ status, _count }: { status: string; _count: number }) => `${status}: ${_count}`} labelLine={false} fontSize={10}>
                      {(ticketData?.statusBreakdown || []).map((_: any, i: number) => (
                        <Cell key={i} fill={STATUS_COLORS[i % STATUS_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: any, name: any) => [v, name]} />
                  </PieChart>
                </ResponsiveContainer>
              </Card>
            </div>
          </div>
        )
      )}

      {tab === 'crm' && (
        crmLoading ? <Spinner /> : (
          <div className="space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card>
                <p className="text-3xl font-bold text-green-600">{crmData?.winRate ?? '—'}%</p>
                <p className="text-sm text-gray-500 mt-1">Win Rate</p>
                <div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full" style={{ width: `${crmData?.winRate || 0}%` }} />
                </div>
              </Card>
              <Card>
                <p className="text-3xl font-bold text-brand-600">{crmData?.won ?? '—'}</p>
                <p className="text-sm text-gray-500 mt-1">Deals Won</p>
              </Card>
              <Card>
                <p className="text-3xl font-bold text-red-500">{crmData?.lost ?? '—'}</p>
                <p className="text-sm text-gray-500 mt-1">Deals Lost</p>
              </Card>
            </div>

            {/* Deal volume */}
            <Card>
              <SectionHeader title="New Deals" subtitle="Deals created per day (last 30 days)" />
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={crmData?.dealVolume || []} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip labelFormatter={(v: string) => `Date: ${v}`} />
                  <Bar dataKey="count" fill="#2563eb" radius={[4,4,0,0]} name="Deals" />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Forecast by stage */}
              <Card>
                <SectionHeader title="Weighted Forecast by Stage" subtitle="Probability-adjusted revenue ($)" />
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={crmData?.forecastByStage || []} layout="vertical" margin={{ top: 4, right: 16, left: 60, bottom: 0 }}>
                    <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${(v/1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="stage" tick={{ fontSize: 11 }} width={60} />
                    <Tooltip formatter={(v: any) => [`$${Number(v).toLocaleString()}`, 'Weighted']} />
                    <Bar dataKey="weighted" fill="#7c3aed" radius={[0,4,4,0]} name="Weighted Forecast" />
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              {/* Top contacts by deal value */}
              <Card>
                <SectionHeader title="Top Contacts by Pipeline Value" />
                {crmData?.contactsByValue?.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">No deal data yet</p>
                ) : (
                  <div className="space-y-3 mt-2">
                    {(crmData?.contactsByValue || []).map((c: any, i: number) => (
                      <div key={c.name} className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 text-xs font-bold flex items-center justify-center flex-shrink-0">{i + 1}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between text-sm mb-1">
                            <span className="font-medium text-gray-800 truncate">{c.name}</span>
                            <span className="text-green-600 font-semibold ml-2">${c.value.toLocaleString()}</span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-brand-400 rounded-full" style={{ width: `${(c.value / (crmData.contactsByValue[0]?.value || 1)) * 100}%` }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
        )
      )}

      {tab === 'csat' && (
        csatStatsLoading ? <Spinner /> : (
          <div className="space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card>
                <p className="text-3xl font-bold text-amber-500">{csatStats?.avg ?? '—'}<span className="text-lg text-gray-300">/5</span></p>
                <p className="text-sm text-gray-500 mt-1">Average Rating</p>
                {typeof csatStats?.avg === 'number' && <div className="mt-2"><StarRow rating={Math.round(csatStats.avg)} /></div>}
              </Card>
              <Card>
                <p className="text-3xl font-bold text-green-600">{csatStats?.satisfactionRate ?? '—'}%</p>
                <p className="text-sm text-gray-500 mt-1">Satisfied (4-5 stars)</p>
              </Card>
              <Card>
                <p className="text-3xl font-bold text-brand-600">{csatStats?.total ?? 0}</p>
                <p className="text-sm text-gray-500 mt-1">Total Responses</p>
              </Card>
            </div>

            {/* Rating distribution */}
            <Card>
              <SectionHeader title="Rating Distribution" subtitle="How many responses landed at each star rating" />
              {!csatStats?.total ? (
                <p className="text-sm text-gray-400 text-center py-8">No feedback submitted yet</p>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={[...(csatStats?.dist || [])].reverse()} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="rating" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v}★`} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip formatter={(v: any) => [v, 'Responses']} labelFormatter={(v: number) => `${v} star${v === 1 ? '' : 's'}`} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {[...(csatStats?.dist || [])].reverse().map((d: any) => (
                        <Cell key={d.rating} fill={d.rating >= 4 ? '#22c55e' : d.rating === 3 ? '#f59e0b' : '#ef4444'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>

            {/* Recent responses */}
            <Card>
              <SectionHeader title="Recent Feedback" subtitle="Star rating + optional comment left by the ticket requester" />
              {csatResponsesLoading ? <Spinner /> : !csatResponses?.data.length ? (
                <p className="text-sm text-gray-400 text-center py-8">No feedback submitted yet</p>
              ) : (
                <div className="space-y-3">
                  {csatResponses.data.map(r => (
                    <div key={r.id} className="flex items-start gap-3 p-3 rounded-lg bg-gray-50">
                      <StarRow rating={r.rating} />
                      <div className="flex-1 min-w-0">
                        {r.ticket && (
                          <Link to="/itdesk/tickets" className="text-sm font-medium text-gray-800 hover:text-brand-600 hover:underline truncate block">
                            {r.ticket.title}
                          </Link>
                        )}
                        {r.comment && (
                          <p className="text-xs text-gray-500 mt-1 flex items-start gap-1"><MessageSquare size={12} className="mt-0.5 flex-shrink-0" />{r.comment}</p>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0">{new Date(r.submittedAt).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              )}
              {csatResponses && csatResponses.total > csatResponses.limit && (
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
                  <button disabled={csatPage <= 1} onClick={() => setCsatPage(p => p - 1)} className="text-xs text-brand-600 disabled:text-gray-300 font-medium">Previous</button>
                  <span className="text-xs text-gray-400">Page {csatResponses.page} of {Math.ceil(csatResponses.total / csatResponses.limit)}</span>
                  <button disabled={csatPage >= Math.ceil(csatResponses.total / csatResponses.limit)} onClick={() => setCsatPage(p => p + 1)} className="text-xs text-brand-600 disabled:text-gray-300 font-medium">Next</button>
                </div>
              )}
            </Card>
          </div>
        )
      )}
    </div>
  );
}
