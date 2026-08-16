import { useState, useEffect } from 'react';
import { Ticket, Plus, Clock, CheckCircle, AlertCircle, Pencil, Sparkles, Copy, Check, SmilePlus, Route, Layers, AlertTriangle, BookOpen } from 'lucide-react';
import { useTickets, useTicket, useCreateTicket, useUpdateTicket, useChangeTicketStatus, useAssignTicket, useTicketReports } from '../../../api/itdesk';
import { useCategories } from '../../../api/itdesk';
import { useUsers } from '../../../api/users';
import { useContacts } from '../../../api/crm';
import { useAuth } from '../../../contexts/AuthContext';
import { useTicketReply, useTicketSentiment, useSummarizeThread, useEstimateResolution, useSlaRisk, useKbArticle, useDetectDuplicates } from '../../../api/ai';
import {
  PageHeader, Button, IconButton, Modal, Badge, EmptyState, Spinner, SearchInput, SearchableSelect,
  CustomFieldsFormFields, CustomFieldsDisplay, RecordTemplatePicker, ScheduleReminderPanel,
  Card, CardSection, StatTile, Alert, Tabs, DataTable, Field, Input, Textarea, Select,
  AiInfo, AiNote, AiGeneratedTag,
  type Column,
} from '../../../shared/components';
import { useCustomFieldDefs, useSaveCustomFieldValues, toValuesPayload } from '../../../api/customFields';
import { Comments } from '../../../shared/components/Comments';
import { Attachments } from '../../../shared/components/Attachments';
import { TimeTrackingPanel } from './TimeTrackingPanel';
import { api } from '../../../api/client';
import { ticketStatusVariant, priorityVariant } from '../../../shared/components/Badge';
import { formatDistanceToNow } from 'date-fns';
import { useLabels } from '../../../hooks/useLabels';
import { useAiPrefill } from '../../../hooks/useAiPrefill';

type BadgeVariant = 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'orange' | 'indigo' | 'teal' | 'accent';

/* Sentiment now reuses Badge's palette instead of carrying its own set of
   `bg-*-50 dark:bg-*-500/10 border-*` strings. */
const sentimentConfig: Record<string, { label: string; variant: BadgeVariant }> = {
  POSITIVE:   { label: '😊 Positive',   variant: 'green' },
  NEUTRAL:    { label: '😐 Neutral',    variant: 'gray' },
  NEGATIVE:   { label: '😟 Negative',   variant: 'orange' },
  FRUSTRATED: { label: '😤 Frustrated', variant: 'red' },
};

const PRIORITIES = ['LOW','MEDIUM','HIGH','CRITICAL'];
const STATUSES = ['OPEN','IN_PROGRESS','PENDING','RESOLVED','CLOSED'];
const STATUS_LABELS: Record<string, string> = {
  OPEN: 'New', IN_PROGRESS: 'In Progress', PENDING: 'Pending', RESOLVED: 'Resolved', CLOSED: 'Closed',
};

const FILING_TABS = [
  { key: 'self' as const, label: 'Myself' },
  { key: 'user' as const, label: 'A teammate' },
  { key: 'contact' as const, label: 'A contact' },
];

function TicketForm({ categories, users, contacts, canFileOnBehalf, onSubmit, loading, initialValues }: any) {
  const [form, setForm] = useState({ title: '', body: '', categoryId: '', priority: 'MEDIUM', ...initialValues });
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  // "On behalf of" — staff-only (see canFileOnBehalf, gated server-side too
  // in tickets.controller.ts's create()). 'self' sends neither field, so a
  // ticket filed normally is unaffected.
  const [requesterMode, setRequesterMode] = useState<'self' | 'user' | 'contact'>('self');
  const [requesterId, setRequesterId] = useState('');
  const [contactId, setContactId] = useState('');
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
    <form onSubmit={e => {
      e.preventDefault();
      const onBehalf = requesterMode === 'user' ? { requesterId } : requesterMode === 'contact' ? { contactId } : {};
      onSubmit({ ...form, ...onBehalf, __customFieldValues: customValues });
    }} className="space-y-3">
      <RecordTemplatePicker
        entityType="TICKET"
        onApply={t => {
          setForm((p: any) => ({ ...p, ...t.fieldValues }));
          if (t.customFieldValues) setCustomValues(p => ({ ...p, ...t.customFieldValues as Record<string, string> }));
        }}
      />
      {canFileOnBehalf && (
        <div className="form-section">
          <p className="form-section-title">Filing For</p>
          <Tabs
            aria-label="Filing For"
            variant="pill"
            className="mb-3"
            value={requesterMode}
            onChange={setRequesterMode}
            items={FILING_TABS}
          />
          {requesterMode === 'user' && (
            <SearchableSelect ariaLabel="Teammate" value={requesterId} onChange={setRequesterId} required
              options={(users ?? []).map((u: any) => ({ value: u.id, label: u.name }))} placeholder="— select a teammate —" />
          )}
          {requesterMode === 'contact' && (
            <SearchableSelect ariaLabel="Contact" value={contactId} onChange={setContactId} required
              options={(contacts ?? []).map((c: any) => ({ value: c.id, label: c.name }))} placeholder="— select a contact —" />
          )}
        </div>
      )}
      <div className="form-section">
        <p className="form-section-title">{singular} Details</p>
        <div className="space-y-4">
          {/* aria-label stays "Title" (fieldLabel falls back to it when
              unset) so getByLabel(/title/i) etc. across the e2e suite
              keeps matching for the seeded test org, which never sets
              labelOverrides. */}
          <Field label={fieldLabel('ticket', 'title', 'Title')} required>
            <Input aria-label={fieldLabel('ticket', 'title', 'Title')} required value={form.title} onChange={f('title')} placeholder="Brief description of the issue" />
            <AiNote id="ticket.duplicate" className="mt-1.5" />
            {aiDupes.data?.duplicates && aiDupes.data.duplicates.length > 0 && (
              <Alert tone="warning" className="mt-2">
                <div className="space-y-1">
                  {aiDupes.data.duplicates.map((d: any) => (
                    <p key={d.id}>
                      <span className="font-semibold">Possible duplicate:</span> {d.title}{' '}
                      <span className="opacity-80">({Math.round(d.confidence * 100)}% similar)</span>
                    </p>
                  ))}
                </div>
              </Alert>
            )}
          </Field>
          <Field label={fieldLabel('ticket', 'description', 'Description')} required>
            <Textarea aria-label={fieldLabel('ticket', 'description', 'Description')} required rows={4} value={form.body} onChange={f('body')} placeholder="Provide details about the issue, steps to reproduce, expected vs actual behaviour…" />
          </Field>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Classification</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Category">
            <SearchableSelect ariaLabel="Category" value={form.categoryId} onChange={val => setForm((p: any) => ({ ...p, categoryId: val }))} options={(categories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label={fieldLabel('ticket', 'priority', 'Priority')}>
            <SearchableSelect ariaLabel={fieldLabel('ticket', 'priority', 'Priority')} value={form.priority} onChange={val => setForm((p: any) => ({ ...p, priority: val }))} required options={PRIORITIES.map(p => ({ value: p, label: p }))} />
          </Field>
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

function TicketEditForm({ ticket, categories, onSaved, onCancel }: any) {
  const updateTicket = useUpdateTicket();
  const [form, setForm] = useState({
    title: ticket.title || '',
    body: ticket.body || '',
    categoryId: ticket.categoryId || ticket.category?.id || '',
    priority: ticket.priority || 'MEDIUM',
  });
  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target.value }));

  async function save() {
    await updateTicket.mutateAsync({ id: ticket.id, ...form });
    onSaved();
  }

  return (
    <Card tone="sunken" padding="sm" flat className="space-y-3">
      <Field label="Title">
        <Input aria-label="Edit title" value={form.title} onChange={f('title')} />
      </Field>
      <Field label="Description">
        <Textarea aria-label="Edit description" rows={3} value={form.body} onChange={f('body')} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Category">
          <SearchableSelect ariaLabel="Edit category" value={form.categoryId} onChange={val => setForm(p => ({ ...p, categoryId: val }))} options={(categories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} placeholder="— none —" />
        </Field>
        <Field label="Priority">
          <SearchableSelect ariaLabel="Edit priority" value={form.priority} onChange={val => setForm(p => ({ ...p, priority: val }))} options={PRIORITIES.map(p => ({ value: p, label: p }))} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={save} loading={updateTicket.isPending}>Save Changes</Button>
      </div>
    </Card>
  );
}

function TicketDetailModal({ id, users, categories }: any) {
  // Own live query keyed by id (not a snapshot prop from the list row) so
  // status/assignee/etc. update in-place the moment a mutation invalidates
  // ['tickets', id] — previously this took `ticket` as a prop sourced from
  // the list array, which only ever refreshed on remount (close + reopen).
  const { data: ticket, isLoading } = useTicket(id);
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
  const [autoRouteError, setAutoRouteError] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'history'>('details');
  const [editingDetails, setEditingDetails] = useState(false);

  if (isLoading || !ticket) return <Spinner />;
  const slaBreach = ticket.slaDueAt && new Date(ticket.slaDueAt) < new Date() && !['RESOLVED','CLOSED'].includes(ticket.status);
  const sentiment = ticket.sentiment && sentimentConfig[ticket.sentiment];

  async function handleAIReply() {
    const data = await aiReply.mutateAsync(ticket.id);
    setSuggestedReply(data.reply);
  }

  async function handleAutoRoute() {
    setAutoRouting(true);
    setAutoRouteError(null);
    try {
      const data = await api.post(`/ai/ticket/${ticket.id}/auto-route`, { apply: true }).then(r => r.data);
      setAutoRouteResult(data);
    } catch (err: any) {
      // Auto-routing used to fail completely silently: the button simply
      // stopped spinning and the ticket was left untouched with no
      // explanation, which is indistinguishable from "the AI had nothing to
      // change". Surface whatever the server said instead.
      setAutoRouteResult(null);
      setAutoRouteError(
        err?.response?.data?.error ||
        err?.message ||
        'Auto-routing failed. The ticket was not changed — try again.'
      );
    } finally { setAutoRouting(false); }
  }

  function copyReply() {
    navigator.clipboard.writeText(suggestedReply);
    setCopiedReply(true);
    setTimeout(() => setCopiedReply(false), 2000);
  }

  return (
    <div className="space-y-4">
      <Tabs
        aria-label="Ticket sections"
        variant="underline"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'details', label: 'Details' },
          { key: 'history', label: `History${ticket.history?.length ? ` (${ticket.history.length})` : ''}` },
        ]}
      />

      {tab === 'history' ? (
        !ticket.history?.length ? (
          <p className="text-sm text-fg-subtle text-center py-8">No status changes recorded yet.</p>
        ) : (
          <div className="space-y-1">
            {ticket.history.map((h: any) => (
              <div key={h.id} className="flex items-center gap-2 text-xs text-fg-subtle py-1">
                <CheckCircle size={12} className="text-success" />
                <span>{h.fromStatus ? `${h.fromStatus} -> ` : ''}{h.toStatus}</span>
                <span>· {formatDistanceToNow(new Date(h.changedAt), { addSuffix: true })}</span>
              </div>
            ))}
          </div>
        )
      ) : (
      <>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <Badge variant={ticketStatusVariant[ticket.status]}>{ticket.status.replace('_',' ')}</Badge>
            <Badge variant={priorityVariant[ticket.priority]}>{ticket.priority}</Badge>
            {slaBreach && <Badge variant="red">SLA BREACHED</Badge>}
            {sentiment ? (
              <Badge variant={sentiment.variant}>{sentiment.label}</Badge>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="subtle"
                  icon={<SmilePlus size={11} />}
                  onClick={() => aiSentiment.mutate(ticket.id)}
                  loading={aiSentiment.isPending}
                >
                  {aiSentiment.isPending ? 'Analyzing...' : 'Detect Sentiment'}
                </Button>
                <AiInfo id="ticket.sentiment" />
              </>
            )}
            {!editingDetails && (
              <Button size="xs" variant="secondary" className="ml-auto" icon={<Pencil size={11} />} onClick={() => setEditingDetails(true)}>
                Edit
              </Button>
            )}
          </div>
          {editingDetails ? (
            <TicketEditForm ticket={ticket} categories={categories} onSaved={() => setEditingDetails(false)} onCancel={() => setEditingDetails(false)} />
          ) : (
            <p className="text-fg-muted text-sm leading-relaxed">{ticket.body}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatTile tone="sunken" label="Requester" value={ticket.requester?.name} />
        {ticket.contact && (
          <StatTile tone="sunken" label="On behalf of (Contact)" value={ticket.contact.name} />
        )}
        <StatTile tone="sunken" label="Category" value={ticket.category?.name || '--'} />
        <StatTile tone="sunken" label="Created" value={formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true })} />
        <StatTile
          tone="sunken"
          label="SLA Due"
          value={
            <span className={slaBreach ? 'text-danger' : undefined}>
              {ticket.slaDueAt ? formatDistanceToNow(new Date(ticket.slaDueAt), { addSuffix: true }) : '--'}
            </span>
          }
        />
      </div>

      <CustomFieldsDisplay entityType="TICKET" entityId={ticket.id} />

      <CardSection title="Update Status">
        <Tabs
          aria-label="Update Status"
          variant="pill"
          value={ticket.status}
          onChange={s => changeStatus.mutate({ id: ticket.id, status: s })}
          items={STATUSES.map(s => ({ key: s, label: s.replace('_',' ') }))}
        />
      </CardSection>
      <CardSection title="Assign To">
        <SearchableSelect ariaLabel="Assign To" value={ticket.assignedTo || ''} onChange={val => assign.mutate({ id: ticket.id, assignedTo: val })} options={(users ?? []).filter((u: any) => ['IT_AGENT','IT_MANAGER','SUPER_ADMIN'].includes(u.role)).map((u: any) => ({ value: u.id, label: u.name }))} placeholder="— unassigned —" />
      </CardSection>

      {/* AI Reply Suggestion */}
      <CardSection
        title="AI Reply Suggestion"
        icon={<Sparkles size={14} className="text-accent" />}
        actions={
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={handleAIReply} loading={aiReply.isPending}>
            {suggestedReply ? 'Regenerate' : 'Suggest Reply'}
          </Button>
        }
      >
        <AiNote id="ticket.reply" className="mb-2.5" />
        {suggestedReply && (
          <Alert
            tone="accent"
            icon={null}
            actions={
              <IconButton
                label="Copy reply"
                tone="accent"
                icon={copiedReply ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                onClick={copyReply}
              />
            }
          >
            <div className="mb-1.5"><AiGeneratedTag /></div>
            <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed max-h-40 overflow-y-auto">{suggestedReply}</pre>
          </Alert>
        )}
      </CardSection>

      {/* AI Auto-Route */}
      <CardSection
        title="AI Auto-Routing"
        icon={<Route size={14} className="text-info" />}
        actions={
          <Button size="sm" variant="secondary" icon={<Route size={12} />} onClick={handleAutoRoute} loading={autoRouting}>
            {autoRouteResult ? 'Re-route' : 'Auto-Route'}
          </Button>
        }
      >
        {/* Auto-routing reassigns the ticket the moment the button is
            clicked, with no confirmation step — so the explanation is a
            highlighted block rather than a quiet line of helper text. */}
        <div className="rounded-card border border-warning/30 bg-warning-soft px-3 py-2.5 mb-2.5">
          <AiNote id="ticket.autoRoute" />
        </div>
        {autoRouteError && (
          <Alert tone="danger" title="Auto-routing failed" className="mb-2.5" onDismiss={() => setAutoRouteError(null)}>
            {autoRouteError}
          </Alert>
        )}
        {autoRouteResult && (
          <Alert tone="info" title="Routing applied:">
            {autoRouteResult.categoryName && <p>Category -&gt; <span className="font-medium">{autoRouteResult.categoryName}</span></p>}
            {autoRouteResult.agentName && <p>Assigned -&gt; <span className="font-medium">{autoRouteResult.agentName}</span></p>}
            <p className="text-xs mt-1 opacity-80">{autoRouteResult.reason}</p>
          </Alert>
        )}
      </CardSection>

      {/* AI Thread Summary */}
      <CardSection
        title="Thread Summary"
        icon={<Layers size={14} className="text-info" />}
        actions={
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => aiSummary.mutate(ticket.id)} loading={aiSummary.isPending}>
            Summarize
          </Button>
        }
      >
        <AiNote id="ticket.summarize" className="mb-2.5" />
        {aiSummary.data?.summary && (
          <Alert tone="info" icon={null}>
            <div className="mb-1.5"><AiGeneratedTag /></div>
            {aiSummary.data.summary}
          </Alert>
        )}
      </CardSection>

      {/* Resolution Time Estimate */}
      <CardSection
        title={<>Resolution Estimate <AiInfo id="ticket.estimate" /></>}
        icon={<Clock size={14} className="text-warning" />}
        actions={
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => aiEstimate.mutate(ticket.id)} loading={aiEstimate.isPending}>
            Estimate
          </Button>
        }
      >
        {aiEstimate.data && (
          <Alert tone="warning" title={aiEstimate.data.label}>
            <p className="text-xs opacity-80">{aiEstimate.data.reason}</p>
          </Alert>
        )}
      </CardSection>

      {/* SLA Risk */}
      <CardSection
        title={<>SLA Risk <AiInfo id="ticket.slaRisk" /></>}
        icon={<AlertTriangle size={14} className="text-danger" />}
        actions={
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => aiSlaRisk.mutate(ticket.id)} loading={aiSlaRisk.isPending}>
            Assess Risk
          </Button>
        }
      >
        {aiSlaRisk.data && (
          <Alert tone={aiSlaRisk.data.risk === 'HIGH' ? 'danger' : aiSlaRisk.data.risk === 'MEDIUM' ? 'warning' : 'success'}>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-bold text-sm">{aiSlaRisk.data.risk} RISK</span>
              <span className="text-xs opacity-70">({aiSlaRisk.data.score}/100)</span>
            </div>
            <p className="text-xs opacity-90">{aiSlaRisk.data.reason}</p>
          </Alert>
        )}
      </CardSection>

      {/* KB Article Generator */}
      <CardSection
        title="Generate KB Article"
        icon={<BookOpen size={14} className="text-success" />}
        actions={
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => aiKb.mutate(ticket.id)} loading={aiKb.isPending}>
            Generate
          </Button>
        }
      >
        <AiNote id="ticket.kbArticle" className="mb-2.5" />
        {aiKb.data && (
          <Alert tone="success" title={aiKb.data.title}>
            <div className="mb-1.5"><AiGeneratedTag /></div>
            <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed max-h-32 overflow-y-auto my-2 opacity-90">{aiKb.data.body}</pre>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => navigator.clipboard.writeText(`# ${aiKb.data!.title}\n\n${aiKb.data!.body}`)}
            >
              Copy to clipboard
            </Button>
          </Alert>
        )}
      </CardSection>

      <TimeTrackingPanel ticketId={ticket.id} />
      <ScheduleReminderPanel entityType="TICKET" entityId={ticket.id} />
      <Comments entityType="TICKET" entityId={ticket.id} />
      <Attachments entityType="TICKET" entityId={ticket.id} />
      </>
      )}
    </div>
  );
}

export function TicketsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [createModal, setCreateModal] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const aiPrefill = useAiPrefill<{ title?: string; body?: string; priority?: string; categoryId?: string }>();

  const { data: tickets, isLoading } = useTickets({
    ...(statusFilter && { status: statusFilter }),
    ...(priorityFilter && { priority: priorityFilter }),
  });
  const { data: categories } = useCategories();
  const { data: users } = useUsers();
  const { user } = useAuth();
  const canFileOnBehalf = !!user && ['SUPER_ADMIN', 'IT_MANAGER', 'IT_AGENT'].includes(user.role);
  const { data: contacts } = useContacts(undefined, canFileOnBehalf);
  const { data: reports } = useTicketReports();
  const create = useCreateTicket();
  const saveCustomFields = useSaveCustomFieldValues();
  const { data: ticketFieldDefs } = useCustomFieldDefs('TICKET');

  const filtered = tickets?.filter((t: any) => !search || t.title.toLowerCase().includes(search.toLowerCase()));
  const { entityLabel, fieldLabel } = useLabels();
  const singular = entityLabel('ticket', 'singular', 'Ticket');
  const plural = entityLabel('ticket', 'plural', 'Tickets');

  useEffect(() => {
    // Also close the ticket Detail modal if one happened to be open — it's a
    // separate `selectedId` state from `createModal`, so without this the AI's
    // "Go Create" could leave an existing ticket's detail/edit view stacked
    // on screen alongside (or instead of, visually) the new Create modal.
    if (aiPrefill) { setSelectedId(null); setCreateModal(true); }
  }, [aiPrefill]);

  const columns: Column<any>[] = [
    {
      key: 'title',
      header: fieldLabel('ticket', 'title', 'Title'),
      cell: t => (
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-[9px] font-bold shrink-0 ${t.priority === 'CRITICAL' ? 'bg-red-500' : t.priority === 'HIGH' ? 'bg-orange-400' : t.priority === 'MEDIUM' ? 'bg-blue-400' : 'bg-gray-400'}`}>{t.priority[0]}</span>
          <span className="font-medium text-fg max-w-[180px] sm:max-w-xs truncate">{t.title}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: fieldLabel('ticket', 'status', 'Status'),
      cell: t => <Badge variant={ticketStatusVariant[t.status]}>{STATUS_LABELS[t.status] ?? t.status.replace('_',' ')}</Badge>,
    },
    {
      key: 'priority',
      header: fieldLabel('ticket', 'priority', 'Priority'),
      cell: t => <Badge variant={priorityVariant[t.priority]}>{t.priority}</Badge>,
    },
    {
      key: 'sentiment',
      header: 'Sentiment',
      cell: t => (t.sentiment && sentimentConfig[t.sentiment]
        ? <Badge variant={sentimentConfig[t.sentiment].variant}>{sentimentConfig[t.sentiment].label}</Badge>
        : <span className="text-fg-subtle text-xs">--</span>),
    },
    { key: 'category', header: 'Category', hideBelow: 'md', muted: true, cell: t => t.category?.name || '--' },
    { key: 'requester', header: 'Requester', hideBelow: 'md', muted: true, cell: t => t.requester?.name },
    {
      key: 'assignee',
      header: 'Assigned To',
      muted: true,
      cell: t => t.assignee?.name || <span className="text-fg-subtle">Unassigned</span>,
    },
    {
      key: 'sla',
      header: 'SLA',
      hideBelow: 'md',
      cell: t => {
        const slaBreach = t.slaDueAt && new Date(t.slaDueAt) < new Date() && !['RESOLVED','CLOSED'].includes(t.status);
        return t.slaDueAt ? (
          <span className={`text-xs ${slaBreach ? 'text-danger font-semibold' : 'text-fg-subtle'}`}>
            {slaBreach ? 'Breached' : formatDistanceToNow(new Date(t.slaDueAt), { addSuffix: true })}
          </span>
        ) : <span className="text-fg-subtle text-xs">--</span>;
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: () => <Pencil size={14} className="text-fg-subtle" />,
    },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-5 animate-slide-up">
      {reports && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatTile label="Open" value={reports.open} icon={<Ticket size={18} />} />
          <StatTile label="In Progress" value={reports.inProgress} icon={<Clock size={18} />} />
          <StatTile label="SLA Breached" value={reports.slaBreached} icon={<AlertCircle size={18} />} />
          <StatTile label="Resolved" value={reports.resolved} icon={<CheckCircle size={18} />} />
        </div>
      )}

      <PageHeader
        title={plural}
        subtitle={`${filtered?.length ?? 0} ${plural.toLowerCase()}`}
        actions={<>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            <SearchInput value={search} onChange={setSearch} placeholder={`Search ${plural.toLowerCase()}...`} />
            <Select aria-label="Status filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All Statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s] ?? s.replace('_',' ')}</option>)}
            </Select>
            <Select aria-label="Priority filter" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
              <option value="">All Priorities</option>
              {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </Select>
            <Button icon={<Plus size={15} />} onClick={() => setCreateModal(true)}>New {singular}</Button>
          </div>
        </>}
      />

      {isLoading ? <Spinner /> : filtered?.length === 0 ? (
        <EmptyState icon={<Ticket size={24} />} title={`No ${plural.toLowerCase()} found`} description="All clear! No tickets match your filters." action={{ label: `New ${singular}`, onClick: () => setCreateModal(true) }} />
      ) : (
        <Card padding="none" className="overflow-hidden">
          <DataTable
            columns={columns}
            rows={filtered ?? []}
            rowKey={(t: any) => t.id}
            onRowClick={(t: any) => setSelectedId(t.id)}
            minWidth={800}
          />
        </Card>
      )}

      <Modal open={createModal} onClose={() => setCreateModal(false)} title={`Submit New ${singular}`} size="lg">
        <TicketForm categories={categories} users={users} contacts={contacts} canFileOnBehalf={canFileOnBehalf} loading={create.isPending}
          initialValues={aiPrefill}
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

      <Modal open={!!selectedId} onClose={() => setSelectedId(null)} title={filtered?.find((t: any) => t.id === selectedId)?.title || ''} size="lg">
        <TicketDetailModal id={selectedId} users={users} categories={categories} onClose={() => setSelectedId(null)} />
      </Modal>
    </div>
  );
}
