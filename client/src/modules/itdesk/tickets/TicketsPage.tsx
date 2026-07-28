import { useState, useEffect } from 'react';
import { Ticket, Plus, Clock, CheckCircle, AlertCircle, Pencil, Sparkles, Copy, Check, SmilePlus, Route, Layers, AlertTriangle, BookOpen } from 'lucide-react';
import { useTickets, useCreateTicket, useChangeTicketStatus, useAssignTicket, useTicketReports } from '../../../api/itdesk';
import { useCategories } from '../../../api/itdesk';
import { useUsers } from '../../../api/users';
import { useTicketReply, useTicketSentiment, useSummarizeThread, useEstimateResolution, useSlaRisk, useKbArticle, useDetectDuplicates } from '../../../api/ai';
import { PageHeader, Button, Modal, Badge, EmptyState, Spinner, SearchInput, SearchableSelect, CustomFieldsFormFields, CustomFieldsDisplay, RecordTemplatePicker, ScheduleReminderPanel } from '../../../shared/components';
import { useCustomFieldDefs, useSaveCustomFieldValues, toValuesPayload } from '../../../api/customFields';
import { Comments } from '../../../shared/components/Comments';
import { Attachments } from '../../../shared/components/Attachments';
import { TimeTrackingPanel } from './TimeTrackingPanel';
import { api } from '../../../api/client';
import { ticketStatusVariant, priorityVariant } from '../../../shared/components/Badge';
import { formatDistanceToNow } from 'date-fns';
import { useLabels } from '../../../hooks/useLabels';

const sentimentConfig: Record<string, { label: string; color: string }> = {
  POSITIVE:   { label: '😊 Positive',   color: 'text-green-600 bg-green-50 border-green-200' },
  NEUTRAL:    { label: '😐 Neutral',    color: 'text-gray-600 bg-gray-50 border-gray-200' },
  NEGATIVE:   { label: '😟 Negative',   color: 'text-orange-600 bg-orange-50 border-orange-200' },
  FRUSTRATED: { label: '😤 Frustrated', color: 'text-red-600 bg-red-50 border-red-200' },
};

const PRIORITIES = ['LOW','MEDIUM','HIGH','CRITICAL'];
const STATUSES = ['OPEN','IN_PROGRESS','PENDING','RESOLVED','CLOSED'];
const STATUS_LABELS: Record<string, string> = {
  OPEN: 'New', IN_PROGRESS: 'In Progress', PENDING: 'Pending', RESOLVED: 'Resolved', CLOSED: 'Closed',
};

function TicketForm({ categories, onSubmit, loading }: any) {
  const [form, setForm] = useState({ title: '', body: '', categoryId: '', priority: 'MEDIUM' });
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const aiDupes = useDetectDuplicates();
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: e.target.value }));
  const { entityLabel, fieldLabel } = useLabels();
  const singular = entityLabel('ticket', 'singular', 'Ticket');

  useEffect(() => {
    if (form.title.length >= 10) {
      aiDupes.mutate({ title: form.title });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.title]);

  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ ...form, __customFieldValues: customValues }); }} className="space-y-3">
      <RecordTemplatePicker
        entityType="TICKET"
        onApply={t => {
          setForm(p => ({ ...p, ...t.fieldValues }));
          if (t.customFieldValues) setCustomValues(p => ({ ...p, ...t.customFieldValues as Record<string, string> }));
        }}
      />
      <div className="form-section">
        <p className="form-section-title">{singular} Details</p>
        <div className="space-y-4">
          <div>
            <label className="form-label">{fieldLabel('ticket', 'title', 'Title')} <span className="req">*</span></label>
            {/* aria-label stays "Title" (fieldLabel falls back to it when
                unset) so getByLabel(/title/i) etc. across the e2e suite
                keeps matching for the seeded test org, which never sets
                labelOverrides. */}
            <input aria-label={fieldLabel('ticket', 'title', 'Title')} required className="ui-input" value={form.title} onChange={f('title')} placeholder="Brief description of the issue" />
            {aiDupes.data?.duplicates && aiDupes.data.duplicates.length > 0 && (
              <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 space-y-1">
                {aiDupes.data.duplicates.map((d: any) => (
                  <p key={d.id} className="text-xs text-amber-800">
                    <span className="font-semibold">Possible duplicate:</span> {d.title}{' '}
                    <span className="text-amber-600">({Math.round(d.confidence * 100)}% similar)</span>
                  </p>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="form-label">{fieldLabel('ticket', 'description', 'Description')} <span className="req">*</span></label>
            <textarea aria-label={fieldLabel('ticket', 'description', 'Description')} required rows={4} className="ui-input" value={form.body} onChange={f('body')} placeholder="Provide details about the issue, steps to reproduce, expected vs actual behaviour…" />
          </div>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Classification</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="form-label">Category</label>
<SearchableSelect ariaLabel="Category" value={form.categoryId} onChange={val => setForm((p: any) => ({ ...p, categoryId: val }))} options={(categories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
          </div>
          <div>
            <label className="form-label">{fieldLabel('ticket', 'priority', 'Priority')}</label>
<SearchableSelect ariaLabel={fieldLabel('ticket', 'priority', 'Priority')} value={form.priority} onChange={val => setForm((p: any) => ({ ...p, priority: val }))} required options={PRIORITIES.map(p => ({ value: p, label: p }))} />
          </div>
        </div>
      </div>
      <CustomFieldsFormFields
        entityType="TICKET"
        values={customValues}
        onChange={(key, value) => setCustomValues(p => ({ ...p, [key]: value }))}
      />
      <div className="flex justify-end pt-2"><Button type="submit" loading={loading}>Submit {singular}</Button></div>
    </form>
  );
}

function TicketDetailModal({ ticket, users }: any) {
  const changeStatus = useChangeTicketStatus();
  const assign = useAssignTicket();
  const aiReply = useTicketReply();
  const aiSentiment = useTicketSentiment();
  const aiSummary = useSummarizeThread();
  const aiEstimate = useEstimateResolution();
  const aiSlaRisk = useSlaRisk();
  const aiKb = useKbArticle();
  const [suggestedReply, setSuggestedReply] = useState('');
  const [copiedReply, setCopiedReply] = useState(false);
  const [autoRouteResult, setAutoRouteResult] = useState<{ categoryName: string | null; agentName: string | null; reason: string } | null>(null);
  const [autoRouting, setAutoRouting] = useState(false);

  if (!ticket) return null;
  const slaBreach = ticket.slaDueAt && new Date(ticket.slaDueAt) < new Date() && !['RESOLVED','CLOSED'].includes(ticket.status);
  const sentiment = ticket.sentiment && sentimentConfig[ticket.sentiment];

  async function handleAIReply() {
    const data = await aiReply.mutateAsync(ticket.id);
    setSuggestedReply(data.reply);
  }

  async function handleAutoRoute() {
    setAutoRouting(true);
    try {
      const data = await api.post(`/ai/ticket/${ticket.id}/auto-route`, { apply: true }).then(r => r.data);
      setAutoRouteResult(data);
    } catch { } finally { setAutoRouting(false); }
  }

  function copyReply() {
    navigator.clipboard.writeText(suggestedReply);
    setCopiedReply(true);
    setTimeout(() => setCopiedReply(false), 2000);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <Badge variant={ticketStatusVariant[ticket.status]}>{ticket.status.replace('_',' ')}</Badge>
            <Badge variant={priorityVariant[ticket.priority]}>{ticket.priority}</Badge>
            {slaBreach && <Badge variant="red">SLA BREACHED</Badge>}
            {sentiment ? (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${sentiment.color}`}>{sentiment.label}</span>
            ) : (
              <button
                onClick={() => aiSentiment.mutate(ticket.id)}
                disabled={aiSentiment.isPending}
                className="flex items-center gap-1 text-xs text-violet-500 hover:text-violet-700 font-medium disabled:opacity-40 border border-violet-200 rounded-full px-2 py-0.5 bg-violet-50"
              >
                <SmilePlus size={11} />
                {aiSentiment.isPending ? 'Analyzing...' : 'Detect Sentiment'}
              </button>
            )}
          </div>
          <p className="text-gray-600 text-sm leading-relaxed">{ticket.body}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-gray-50 rounded-xl p-3"><p className="text-gray-400 text-xs mb-1">Requester</p><p className="font-medium">{ticket.requester?.name}</p></div>
        <div className="bg-gray-50 rounded-xl p-3"><p className="text-gray-400 text-xs mb-1">Category</p><p className="font-medium">{ticket.category?.name || '--'}</p></div>
        <div className="bg-gray-50 rounded-xl p-3"><p className="text-gray-400 text-xs mb-1">Created</p><p className="font-medium">{formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true })}</p></div>
        <div className={`rounded-xl p-3 ${slaBreach ? 'bg-red-50' : 'bg-gray-50'}`}><p className="text-gray-400 text-xs mb-1">SLA Due</p><p className={`font-medium ${slaBreach ? 'text-red-600' : ''}`}>{ticket.slaDueAt ? formatDistanceToNow(new Date(ticket.slaDueAt), { addSuffix: true }) : '--'}</p></div>
      </div>

      <CustomFieldsDisplay entityType="TICKET" entityId={ticket.id} />

      <div className="border-t pt-4 space-y-3">
        <div><label className="form-label">Update Status</label>
          <div className="flex flex-wrap gap-2">
            {STATUSES.map(s => (
              <button key={s} onClick={() => changeStatus.mutate({ id: ticket.id, status: s })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${ticket.status === s ? 'bg-brand-600 text-white border-brand-600' : 'border-gray-200 text-gray-600 hover:border-brand-400 hover:text-brand-600'}`}>
                {s.replace('_',' ')}
              </button>
            ))}
          </div>
        </div>
        <div><label className="form-label">Assign To</label>
          <SearchableSelect ariaLabel="Assign To" value={ticket.assignedTo || ''} onChange={val => assign.mutate({ id: ticket.id, assignedTo: val })} options={(users ?? []).filter((u: any) => ['IT_AGENT','IT_MANAGER','SUPER_ADMIN'].includes(u.role)).map((u: any) => ({ value: u.id, label: u.name }))} placeholder="— unassigned —" />
        </div>
      </div>

      {ticket.history?.length > 0 && (
        <div className="border-t pt-4">
          <p className="text-sm font-medium text-gray-700 mb-2">History</p>
          <div className="space-y-1">
            {ticket.history.map((h: any) => (
              <div key={h.id} className="flex items-center gap-2 text-xs text-gray-400">
                <CheckCircle size={12} className="text-green-400" />
                <span>{h.fromStatus ? `${h.fromStatus} -> ` : ''}{h.toStatus}</span>
                <span>· {formatDistanceToNow(new Date(h.changedAt), { addSuffix: true })}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Reply Suggestion */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Sparkles size={14} className="text-violet-500" /> AI Reply Suggestion
          </p>
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={handleAIReply} loading={aiReply.isPending}>
            {suggestedReply ? 'Regenerate' : 'Suggest Reply'}
          </Button>
        </div>
        {suggestedReply && (
          <div className="relative bg-violet-50 border border-violet-100 rounded-xl p-3">
            <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed max-h-40 overflow-y-auto pr-8">{suggestedReply}</pre>
            <button onClick={copyReply} className="absolute top-2 right-2 p-1.5 hover:bg-violet-100 rounded-lg text-violet-400 hover:text-violet-700 transition-colors">
              {copiedReply ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
            </button>
          </div>
        )}
      </div>

      {/* AI Auto-Route */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Route size={14} className="text-indigo-500" /> AI Auto-Routing
          </p>
          <Button size="sm" variant="secondary" icon={<Route size={12} />} onClick={handleAutoRoute} loading={autoRouting}>
            {autoRouteResult ? 'Re-route' : 'Auto-Route'}
          </Button>
        </div>
        {autoRouteResult && (
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-3 text-sm">
            <p className="text-indigo-700 font-medium mb-1">Routing applied:</p>
            {autoRouteResult.categoryName && <p className="text-gray-600">Category -&gt; <span className="font-medium">{autoRouteResult.categoryName}</span></p>}
            {autoRouteResult.agentName && <p className="text-gray-600">Assigned -&gt; <span className="font-medium">{autoRouteResult.agentName}</span></p>}
            <p className="text-gray-400 text-xs mt-1">{autoRouteResult.reason}</p>
          </div>
        )}
      </div>

      {/* AI Thread Summary */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Layers size={14} className="text-blue-500" /> Thread Summary
          </p>
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => aiSummary.mutate(ticket.id)} loading={aiSummary.isPending}>
            Summarize
          </Button>
        </div>
        {aiSummary.data?.summary && (
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-gray-700 leading-relaxed">
            {aiSummary.data.summary}
          </div>
        )}
      </div>

      {/* Resolution Time Estimate */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Clock size={14} className="text-amber-500" /> Resolution Estimate
          </p>
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => aiEstimate.mutate(ticket.id)} loading={aiEstimate.isPending}>
            Estimate
          </Button>
        </div>
        {aiEstimate.data && (
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-sm">
            <p className="font-semibold text-amber-800">{aiEstimate.data.label}</p>
            <p className="text-gray-500 text-xs mt-0.5">{aiEstimate.data.reason}</p>
          </div>
        )}
      </div>

      {/* SLA Risk */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <AlertTriangle size={14} className="text-red-500" /> SLA Risk
          </p>
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => aiSlaRisk.mutate(ticket.id)} loading={aiSlaRisk.isPending}>
            Assess Risk
          </Button>
        </div>
        {aiSlaRisk.data && (
          <div className={`border rounded-xl p-3 text-sm ${aiSlaRisk.data.risk === 'HIGH' ? 'bg-red-50 border-red-200' : aiSlaRisk.data.risk === 'MEDIUM' ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`font-bold text-sm ${aiSlaRisk.data.risk === 'HIGH' ? 'text-red-700' : aiSlaRisk.data.risk === 'MEDIUM' ? 'text-amber-700' : 'text-green-700'}`}>
                {aiSlaRisk.data.risk} RISK
              </span>
              <span className="text-gray-400 text-xs">({aiSlaRisk.data.score}/100)</span>
            </div>
            <p className="text-gray-500 text-xs">{aiSlaRisk.data.reason}</p>
          </div>
        )}
      </div>

      {/* KB Article Generator */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <BookOpen size={14} className="text-emerald-500" /> Generate KB Article
          </p>
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => aiKb.mutate(ticket.id)} loading={aiKb.isPending}>
            Generate
          </Button>
        </div>
        {aiKb.data && (
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-sm space-y-2">
            <p className="font-semibold text-emerald-800">{aiKb.data.title}</p>
            <pre className="text-gray-600 text-xs whitespace-pre-wrap font-sans leading-relaxed max-h-32 overflow-y-auto">{aiKb.data.body}</pre>
            <button onClick={() => navigator.clipboard.writeText(`# ${aiKb.data!.title}\n\n${aiKb.data!.body}`)}
              className="text-xs text-emerald-600 hover:underline">Copy to clipboard</button>
          </div>
        )}
      </div>

      <TimeTrackingPanel ticketId={ticket.id} />
      <ScheduleReminderPanel entityType="TICKET" entityId={ticket.id} />
      <Comments entityType="TICKET" entityId={ticket.id} />
      <Attachments entityType="TICKET" entityId={ticket.id} />
    </div>
  );
}

export function TicketsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [createModal, setCreateModal] = useState(false);
  const [selected, setSelected] = useState<any>(null);

  const { data: tickets, isLoading } = useTickets({
    ...(statusFilter && { status: statusFilter }),
    ...(priorityFilter && { priority: priorityFilter }),
  });
  const { data: categories } = useCategories();
  const { data: users } = useUsers();
  const { data: reports } = useTicketReports();
  const create = useCreateTicket();
  const saveCustomFields = useSaveCustomFieldValues();
  const { data: ticketFieldDefs } = useCustomFieldDefs('TICKET');

  const filtered = tickets?.filter((t: any) => !search || t.title.toLowerCase().includes(search.toLowerCase()));
  const { entityLabel, fieldLabel } = useLabels();
  const singular = entityLabel('ticket', 'singular', 'Ticket');
  const plural = entityLabel('ticket', 'plural', 'Tickets');

  return (
    <div className="p-4 sm:p-6 space-y-5 animate-slide-up">
      {reports && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {[
            { label: 'Open', value: reports.open, color: 'text-blue-600', bg: 'bg-blue-50', icon: <Ticket size={18} /> },
            { label: 'In Progress', value: reports.inProgress, color: 'text-yellow-600', bg: 'bg-yellow-50', icon: <Clock size={18} /> },
            { label: 'SLA Breached', value: reports.slaBreached, color: 'text-red-600', bg: 'bg-red-50', icon: <AlertCircle size={18} /> },
            { label: 'Resolved', value: reports.resolved, color: 'text-green-600', bg: 'bg-green-50', icon: <CheckCircle size={18} /> },
          ].map(({ label, value, color, bg, icon }) => (
            <div key={label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4 flex items-center gap-3 card-hover shadow-sm">
              <div className={`w-10 h-10 rounded-xl ${bg} ${color} flex items-center justify-center shadow-sm`}>{icon}</div>
              <div>
                <p className="text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <PageHeader
        title={plural}
        subtitle={`${filtered?.length ?? 0} ${plural.toLowerCase()}`}
        actions={<>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            <SearchInput value={search} onChange={setSearch} placeholder={`Search ${plural.toLowerCase()}...`} />
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ui-input focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white">
              <option value="">All Statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s] ?? s.replace('_',' ')}</option>)}
            </select>
            <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} className="ui-input focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white">
              <option value="">All Priorities</option>
              {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <Button icon={<Plus size={15} />} onClick={() => setCreateModal(true)}>New {singular}</Button>
          </div>
        </>}
      />

      {isLoading ? <Spinner /> : filtered?.length === 0 ? (
        <EmptyState icon={<Ticket size={24} />} title={`No ${plural.toLowerCase()} found`} description="All clear! No tickets match your filters." action={{ label: `New ${singular}`, onClick: () => setCreateModal(true) }} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
          <div className="table-container">
            <table className="w-full text-sm min-w-[800px]">
              <thead><tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{fieldLabel('ticket', 'title', 'Title')}</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{fieldLabel('ticket', 'status', 'Status')}</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{fieldLabel('ticket', 'priority', 'Priority')}</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Sentiment</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">Category</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">Requester</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Assigned To</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">SLA</th>
                <th className="px-4 py-3"></th>
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {filtered?.map((t: any) => {
                  const slaBreach = t.slaDueAt && new Date(t.slaDueAt) < new Date() && !['RESOLVED','CLOSED'].includes(t.status);
                  return (
                    <tr key={t.id} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => setSelected(t)}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-[9px] font-bold flex-shrink-0 ${t.priority === 'CRITICAL' ? 'bg-red-500' : t.priority === 'HIGH' ? 'bg-orange-400' : t.priority === 'MEDIUM' ? 'bg-blue-400' : 'bg-gray-300'}`}>{t.priority[0]}</span>
                          <span className="font-medium text-gray-900 max-w-[180px] sm:max-w-xs truncate">{t.title}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3"><Badge variant={ticketStatusVariant[t.status]}>{STATUS_LABELS[t.status] ?? t.status.replace('_',' ')}</Badge></td>
                      <td className="px-4 py-3"><Badge variant={priorityVariant[t.priority]}>{t.priority}</Badge></td>
                      <td className="px-4 py-3">
                        {t.sentiment && sentimentConfig[t.sentiment]
                          ? <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${sentimentConfig[t.sentiment].color}`}>{sentimentConfig[t.sentiment].label}</span>
                          : <span className="text-gray-300 text-xs">--</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{t.category?.name || '--'}</td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{t.requester?.name}</td>
                      <td className="px-4 py-3 text-gray-500">{t.assignee?.name || <span className="text-gray-300">Unassigned</span>}</td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {t.slaDueAt ? (
                          <span className={`text-xs ${slaBreach ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                            {slaBreach ? 'Breached' : formatDistanceToNow(new Date(t.slaDueAt), { addSuffix: true })}
                          </span>
                        ) : <span className="text-gray-300 text-xs">--</span>}
                      </td>
                      <td className="px-4 py-3">
                        <Pencil size={14} className="text-gray-300 hover:text-gray-600" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={createModal} onClose={() => setCreateModal(false)} title={`Submit New ${singular}`} size="lg">
        <TicketForm categories={categories} loading={create.isPending}
          onSubmit={async (form: any) => {
            const { __customFieldValues, ...rest } = form;
            const created = await create.mutateAsync(rest);
            if (__customFieldValues && ticketFieldDefs?.length) {
              const values = toValuesPayload(ticketFieldDefs, __customFieldValues);
              if (values.length) await saveCustomFields.mutateAsync({ entityId: created.id, values });
            }
            setCreateModal(false);
          }} />
      </Modal>

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title || ''} size="lg">
        <TicketDetailModal ticket={selected} users={users} onClose={() => setSelected(null)} />
      </Modal>
    </div>
  );
}
