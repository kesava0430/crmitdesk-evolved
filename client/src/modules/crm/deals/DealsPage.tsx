import { useModules } from '../../../shared/modules';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TrendingUp, Plus, Trash2, Sparkles, Activity, Mail, Pencil, Settings, GripVertical, ChevronUp, ChevronDown, AlertTriangle, ArrowDownUp } from 'lucide-react';
import { usePipeline, useDeal, useCreateDeal, useUpdateDeal, useMoveDealStage, useDeleteDeal, useDealReports, useDeals } from '../../../api/crm';
import { useLicense } from '../../../api/billing';
import { useContacts, useAccounts, usePipelines, useAddStage, useUpdateStage, useRemoveStage, useReorderStages } from '../../../api/crm';
import { useUsers } from '../../../api/users';
import { useDepartments } from '../../../api/people';
import { useWinProbability, usePipelineHealth } from '../../../api/ai';
import {
  PageHeader, PageBody, Button, Modal, SearchableSelect, CustomFieldsFormFields, CustomFieldsDisplay,
  RecordTemplatePicker, ScheduleReminderPanel, Card, StatTile, Tabs, Alert, IconButton, Field, Input,
  Label, FormGrid, FormActions, Avatar, AiInfo, AiNote, RecordTasks, RecordTags, Select, DataTable, StatusBadge, dealStatusVariant,
  AccessDenied, FollowUpStatusIcon, FOLLOWUP_FILTERS, matchesFollowUpFilter, FollowUpEmailComposer, NextStepChip} from '../../../shared/components';
import type { Column } from '../../../shared/components';
import { Comments } from '../../../shared/components/Comments';
import { Attachments } from '../../../shared/components/Attachments';
import { useCustomFieldDefs, useCustomFieldValues, useSaveCustomFieldValues, toValuesPayload, fromValueRecords } from '../../../api/customFields';
import { useLabels } from '../../../hooks/useLabels';
import { useAiPrefill } from '../../../hooks/useAiPrefill';
import { useFormat } from '../../../hooks/useFormat';
import { useAuth } from '../../../contexts/AuthContext';
import { useDebounce } from '../../../hooks/useDebounce';
import { useDealLinkRule, useRelatedPreview, useRelatedCounts } from '../../../api/dealLinks';
import { RelatedDealsPanel } from './RelatedDeals';
import { can } from '../../../shared/permissions';
import { useMediaQuery, MD_UP } from '../../../hooks/useMediaQuery';

function DealForm({ initial, entityId, contacts, accounts, users, stages, onSubmit, loading, aiPrefill }: any) {
  const [form, setForm] = useState(initial || { title: '', value: '', stage: stages?.[0] || '', probability: 20, contactId: '', accountId: '', assignedTo: '', departmentId: '', closeDate: '', ...aiPrefill });
  // Org Structure departments — the field only renders when some exist.
  // Departments are HR data — not asked for while HR is switched off (Platform Admin → Areas).
  const { data: departmentsRes } = useDepartments(useModules().isModuleOn('hr_core'));
  const departmentOptions = (departmentsRes?.data ?? [])
    .filter((d: any) => d.isActive !== false)
    .map((d: any) => ({ value: d.id, label: d.name }));
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const { data: existingValues } = useCustomFieldValues(entityId);
  useEffect(() => {
    if (existingValues) setCustomValues(fromValueRecords(existingValues));
  }, [existingValues]);
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: e.target.value }));
  const { entityLabel, fieldLabel } = useLabels();
  const { symbol } = useFormat();
  const singular = entityLabel('deal', 'singular', 'Deal');
  // "Deal Title"/"Value ($)" aria-labels fall back to their exact original
  // text when unset, so the e2e suite's getByLabel(/deal title/i) etc. keeps
  // matching for the seeded test org (which never sets labelOverrides) —
  // the ($) part still needs to reflect the org's actual currency though,
  // not always a literal dollar sign, so that piece is built separately
  // from the overridable fallback rather than baked into it.
  const titleLabel = fieldLabel('deal', 'title', 'Deal Title');
  // "2 earlier deals on this unit were lost" — once the matching fields are filled in.
  const { data: linkRule } = useDealLinkRule();
  // Debounced as a string: a fresh object every render would never settle.
  const previewKey = useDebounce(linkRule?.rule
    ? JSON.stringify({ excludeId: entityId, accountId: form.accountId || null, contactId: form.contactId || null, custom: customValues })
    : '', 500);
  const { data: related } = useRelatedPreview(previewKey ? JSON.parse(previewKey) : null);
  const valueLabel = `${fieldLabel('deal', 'value', 'Value')} (${symbol})`;
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ ...form, value: Number(form.value), probability: Number(form.probability), __customFieldValues: customValues }); }} className="space-y-3">
      {!initial && (
        <RecordTemplatePicker
          entityType="DEAL"
          onApply={t => {
            setForm((p: any) => ({ ...p, ...t.fieldValues }));
            if (t.customFieldValues) setCustomValues(p => ({ ...p, ...t.customFieldValues as Record<string, string> }));
          }}
        />
      )}
      <div className="form-section">
        <p className="form-section-title">{singular} Information</p>
        <div className="space-y-4">
          <Field label={titleLabel} required>
            <Input aria-label={titleLabel} required value={form.title} onChange={f('title')} placeholder="e.g. Enterprise License Q3" />
          </Field>
          <FormGrid cols={2}>
            <Field label={valueLabel}>
              <Input aria-label={valueLabel} type="number" min="0" value={form.value} onChange={f('value')} placeholder="0" />
            </Field>
            <Field label="Probability (%)">
              <Input type="number" min="0" max="100" value={form.probability} onChange={f('probability')} />
            </Field>
            <div>
              <Label>{fieldLabel('deal', 'stage', 'Stage')}</Label>
              <SearchableSelect ariaLabel={fieldLabel('deal', 'stage', 'Stage')} value={form.stage} onChange={val => setForm((p: any) => ({ ...p, stage: val }))} required options={(stages ?? []).map((s: string) => ({ value: s, label: s }))} />
            </div>
            <Field label="Expected Close">
              <Input type="date" value={form.closeDate} onChange={f('closeDate')} />
            </Field>
          </FormGrid>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Assignment</p>
        <FormGrid cols={2}>
          <div>
            <Label>Contact</Label>
            <SearchableSelect ariaLabel="Contact" value={form.contactId} onChange={val => setForm((p: any) => ({ ...p, contactId: val }))} options={(contacts ?? []).map((c: any) => ({ value: c.id, label: c.name }))} placeholder="— none —" />
          </div>
          <div>
            <Label>Account</Label>
            <SearchableSelect ariaLabel="Account" value={form.accountId} onChange={val => setForm((p: any) => ({ ...p, accountId: val }))} options={(accounts ?? []).map((a: any) => ({ value: a.id, label: a.name }))} placeholder="— none —" />
          </div>
          <div className={departmentOptions.length ? '' : 'sm:col-span-2'}>
            <Label>Assigned To</Label>
            <SearchableSelect ariaLabel="Assigned To" value={form.assignedTo} onChange={val => setForm((p: any) => ({ ...p, assignedTo: val }))} options={(users ?? []).map((u: any) => ({ value: u.id, label: u.name }))} placeholder="— select team member —" />
          </div>
          {departmentOptions.length > 0 && (
            <div>
              <Label>Department</Label>
              <SearchableSelect ariaLabel="Department" value={form.departmentId} onChange={val => setForm((p: any) => ({ ...p, departmentId: val }))} options={departmentOptions} placeholder="— none —" />
            </div>
          )}
        </FormGrid>
      </div>
      <CustomFieldsFormFields
        entityType="DEAL"
        values={customValues}
        onChange={(key, value) => setCustomValues(p => ({ ...p, [key]: value }))}
        isNew={!entityId}
      />
      {related?.configured && !!related.counts?.lost && (
        <Alert tone="warning" title={`${related.counts.lost} earlier ${related.counts.lost === 1 ? 'deal' : 'deals'} with ${related.sharedOn?.join(' and ')} ${related.counts.lost === 1 ? 'was' : 'were'} lost`}>
          <p className="text-xs">{related.counts.won ? `${related.counts.won} won. ` : ''}After saving, open this deal to see them and use “Analyse past deals” to see why.</p>
        </Alert>
      )}
      <FormActions><Button type="submit" loading={loading}>{initial ? 'Save Changes' : `Create ${singular}`}</Button></FormActions>
    </form>
  );
}

function DealCard({ deal, onDelete, onSelect, related, relatedLabel }: any) {
  const [dragging, setDragging] = useState(false);
  const { money, timezone } = useFormat();
  return (
    <Card
      padding="sm"
      draggable
      onDragStart={e => { setDragging(true); e.dataTransfer.setData('dealId', deal.id); e.dataTransfer.setData('fromStage', deal.stage); }}
      onDragEnd={() => setDragging(false)}
      className={`cursor-grab active:cursor-grabbing card-hover transition-all group w-full ${dragging ? 'opacity-50 rotate-1' : ''}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <p onClick={() => onSelect(deal)} title={deal.title} className="font-medium text-fg text-sm leading-snug hover:text-accent cursor-pointer transition-colors min-w-0 truncate">{deal.title}</p>
        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton
            label="Delete deal"
            size="xs"
            tone="danger"
            revealOnRowHover
            icon={<Trash2 size={12} />}
            onClick={() => onDelete(deal.id)}
          />
          <GripVertical size={12} className="text-fg-subtle opacity-0 group-hover:opacity-60 transition-opacity" aria-hidden="true" />
        </div>
      </div>
      {deal.value > 0 && (
        <div className="flex items-center gap-1 text-success font-semibold text-sm mb-2 tabular-nums">
          {money(deal.value)}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        {deal.contact && <span className="text-xs text-fg-subtle truncate" title={deal.contact.name}>{deal.contact.name}</span>}
        <span className="text-xs text-fg-subtle ml-auto tabular-nums shrink-0">{deal.probability}%</span>
      </div>
      {deal.followUp && (
        <div className="mt-2">
          <FollowUpStatusIcon summary={deal.followUp} closed={deal.status !== 'OPEN'} timezone={timezone} onClick={() => onSelect(deal)} />
        </div>
      )}
      {deal.assignee && <div className="mt-2 flex items-center gap-1.5 min-w-0">
        <Avatar name={deal.assignee.name} size="xs" tone="accent" />
        <span className="text-xs text-fg-subtle truncate" title={deal.assignee.name}>{deal.assignee.name}</span>
      </div>}
      {related?.lost > 0 && (
        <button type="button" onClick={() => onSelect(deal)} className="mt-2 flex items-start gap-1 text-[11px] text-warning-fg text-left leading-snug">
          <AlertTriangle size={11} className="text-warning shrink-0 mt-px" aria-hidden="true" />
          <span>{related.lost} earlier {related.lost === 1 ? 'deal' : 'deals'} on this {relatedLabel} {related.lost === 1 ? 'was' : 'were'} lost</span>
        </button>
      )}
    </Card>
  );
}

function DealDetailPanel({ deal, aiEnabled, onSaved }: { deal: any; aiEnabled: boolean; onSaved: () => void }) {
  const winProb = useWinProbability();

  const probTone = winProb.data
    ? winProb.data.probability >= 70 ? 'success' : winProb.data.probability >= 40 ? 'warning' : 'danger'
    : 'success';

  return (
    <div className="space-y-4">
      {/* Win Probability */}
      <div className="border-t border-line pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-fg flex items-center gap-1.5">
            <Activity size={14} className="text-accent" /> Win Probability
            <AiInfo id="deal.winProbability" />
          </p>
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => winProb.mutate(deal.id)} loading={winProb.isPending}>
            Analyze
          </Button>
        </div>
        {winProb.data && (
          <Alert tone={probTone} icon={null}>
            <p className="text-4xl font-bold mb-3 tabular-nums tracking-tight">{winProb.data.probability}%</p>
            {winProb.data.factors?.length > 0 && (
              <ul className="space-y-1 mb-3">
                {winProb.data.factors.map((factor: string, i: number) => (
                  <li key={i} className="text-xs flex items-start gap-1.5">
                    <span className="opacity-60 mt-0.5">&#8226;</span>{factor}
                  </li>
                ))}
              </ul>
            )}
            {winProb.data.recommendation && (
              <div className="border-t border-line pt-2 mt-2">
                <p className="text-xs font-semibold mb-1">Recommendation</p>
                <p className="text-xs">{winProb.data.recommendation}</p>
              </div>
            )}
          </Alert>
        )}
      </div>

      {/* Follow-up Email: from the deal's real notes/quote/plan, fact-checked, sent + logged */}
      <div className="border-t border-line pt-4">
        <p className="text-sm font-medium text-fg flex items-center gap-1.5 mb-2">
          <Mail size={14} className="text-accent" /> Follow-up Email
        </p>
        {aiEnabled && <AiNote id="deal.followUp" className="mb-2" />}
        <FollowUpEmailComposer kind="DEAL" recordId={deal.id} aiEnabled={aiEnabled} onSent={onSaved} />
      </div>
    </div>
  );
}

function PipelineHealthModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const health = usePipelineHealth();
  return (
    <Modal open={open} onClose={onClose} title="Pipeline Health" size="md">
      <div className="space-y-4">
        <AiNote id="deal.pipelineHealth" />
        <div className="text-center py-2">
          <Button icon={<Sparkles size={15} />} onClick={() => health.mutate()} loading={health.isPending}>
            {health.data ? 'Refresh Analysis' : 'Analyze Pipeline'}
          </Button>
        </div>
        {health.data && (
          <div className="space-y-4">
            <Alert tone="info" title="Summary">
              <p className="text-sm leading-relaxed">{health.data.summary}</p>
            </Alert>
            {health.data.risks?.length > 0 && (
              <Alert tone="danger" title="Risks">
                <ul className="space-y-1.5">
                  {health.data.risks.map((r: string, i: number) => (
                    <li key={i} className="text-xs flex items-start gap-1.5">
                      <span className="opacity-60 mt-0.5 flex-shrink-0">&#8226;</span>{r}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {health.data.opportunities?.length > 0 && (
              <Alert tone="success" title="Opportunities">
                <ul className="space-y-1.5">
                  {health.data.opportunities.map((o: string, i: number) => (
                    <li key={i} className="text-xs flex items-start gap-1.5">
                      <span className="opacity-60 mt-0.5 flex-shrink-0">&#8226;</span>{o}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function StageRow({ pipelineId, stage, index, total, allLabels, onMoved }: any) {
  const updateStage = useUpdateStage();
  const removeStage = useRemoveStage();
  const reorder = useReorderStages();
  const [label, setLabel] = useState(stage.label);
  const [color, setColor] = useState(stage.color);
  const [probability, setProbability] = useState(stage.probability);
  const [reassignTo, setReassignTo] = useState('');
  const [blockedCount, setBlockedCount] = useState<string | null>(null);
  const dirty = label !== stage.label || color !== stage.color || probability !== stage.probability;

  function save() {
    updateStage.mutate({ pipelineId, label: stage.label, ...(label !== stage.label && { label }), color, probability: Number(probability) });
  }

  function move(dir: -1 | 1) {
    const newOrder = [...allLabels];
    const i = newOrder.indexOf(stage.label);
    const j = i + dir;
    if (j < 0 || j >= newOrder.length) return;
    [newOrder[i], newOrder[j]] = [newOrder[j], newOrder[i]];
    reorder.mutate({ pipelineId, labels: newOrder }, { onSuccess: onMoved });
  }

  function remove() {
    removeStage.mutate({ pipelineId, label: stage.label, reassignTo: reassignTo || undefined }, {
      onError: (err: any) => setBlockedCount(err?.response?.data?.error || 'This stage still has deals in it.'),
      onSuccess: () => setBlockedCount(null),
    });
  }

  return (
    <Card padding="sm" flat>
      {/* Wraps on phones: probability, Save and Remove drop to a second line
          instead of squeezing the stage name to a few characters. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-col">
          <IconButton
            label="Move stage up"
            size="xs"
            className="!h-4 !w-5"
            icon={<ChevronUp size={12} />}
            disabled={index === 0}
            onClick={() => move(-1)}
          />
          <IconButton
            label="Move stage down"
            size="xs"
            className="!h-4 !w-5"
            icon={<ChevronDown size={12} />}
            disabled={index === total - 1}
            onClick={() => move(1)}
          />
        </div>
        <GripVertical size={14} className="text-fg-subtle" />
        <Input type="color" aria-label={`Stage colour ${index + 1}`} value={color} onChange={e => setColor(e.target.value)} className="w-7 h-7 shrink-0 !p-0.5 cursor-pointer" />
        <Input className="flex-1 min-w-[9rem]" value={label} onChange={e => setLabel(e.target.value)} aria-label={`Stage name ${index + 1}`} />
        {/* Kept together so they wrap as one group on phones. */}
        <div className="flex items-center gap-2 ml-auto">
          <Input type="number" min={0} max={100} className="w-20" value={probability} onChange={e => setProbability(Number(e.target.value))} aria-label={`Stage probability ${index + 1}`} />
          <span className="text-xs text-fg-subtle">%</span>
          {dirty && <Button size="sm" onClick={save} loading={updateStage.isPending}>Save</Button>}
          <IconButton label="Remove stage" tone="danger" icon={<Trash2 size={14} />} onClick={remove} />
        </div>
      </div>
      {blockedCount && (
        <Alert
          tone="warning"
          icon={null}
          className="mt-2 items-center"
          onDismiss={() => setBlockedCount(null)}
          actions={
            <>
              <SearchableSelect ariaLabel="Reassign deals to" value={reassignTo} onChange={setReassignTo} options={allLabels.filter((l: string) => l !== stage.label).map((l: string) => ({ value: l, label: l }))} placeholder="Move deals to…" />
              <Button size="sm" variant="secondary" onClick={remove} disabled={!reassignTo}>Move &amp; Delete</Button>
            </>
          }
        >
          <span className="flex-1">{blockedCount}</span>
        </Alert>
      )}
    </Card>
  );
}

function PipelineStagesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: pipelines } = usePipelines();
  const addStage = useAddStage();
  const [newLabel, setNewLabel] = useState('');
  const pipeline = pipelines?.find((p: any) => p.isDefault) || pipelines?.[0];
  const stages = pipeline?.stages || [];

  return (
    <Modal open={open} onClose={onClose} title="Manage Pipeline Stages" size="lg">
      <div className="space-y-3">
        <p className="text-xs text-fg-muted">
          Rename, recolor, reorder, or remove stages on <strong>{pipeline?.name}</strong>. Renaming moves every deal
          currently in that stage along with it. Combine with a workflow automation (trigger: "Deal Stage Changed")
          to notify someone or send an email whenever a deal enters a specific stage.
        </p>
        {stages.map((s: any, i: number) => (
          <StageRow key={s.label} pipelineId={pipeline.id} stage={s} index={i} total={stages.length} allLabels={stages.map((x: any) => x.label)} onMoved={() => {}} />
        ))}
        <form
          onSubmit={e => { e.preventDefault(); if (!newLabel.trim()) return; addStage.mutate({ pipelineId: pipeline.id, label: newLabel.trim() }, { onSuccess: () => setNewLabel('') }); }}
          className="flex items-center gap-2 pt-1"
        >
          <Input className="flex-1" placeholder="New stage name…" value={newLabel} onChange={e => setNewLabel(e.target.value)} aria-label="New stage name" />
          <Button type="submit" size="sm" icon={<Plus size={13} />} loading={addStage.isPending}>Add Stage</Button>
        </form>
      </div>
    </Modal>
  );
}

// Own live query keyed by id (not a snapshot prop from the pipeline/kanban
// card) so stage/value/assignee/etc. update in-place the moment a mutation
// invalidates ['deals', id] — previously the detail panel took `deal` as a
// prop sourced from the pipeline column array, which only ever refreshed on
// remount (close + reopen the modal).
function DealDetailModalContent({ id, pageSingular, onEdit, onOpenDeal, onTitle, aiEnabled, followUp }: { id: string; pageSingular: string; onEdit: (deal: any) => void; onOpenDeal: (id: string, title: string) => void; onTitle: (title: string) => void; aiEnabled: boolean; followUp?: any }) {
  const { data: deal, isLoading } = useDeal(id);
  const { money, timezone } = useFormat();
  // Bumped when a note is posted or an email sent — the next-step chip then asks once.
  const [saved, setSaved] = useState(0);
  const bump = () => setSaved(n => n + 1);
  // Opened from a link (?deal=…) the modal has no title yet.
  useEffect(() => { if (deal?.title) onTitle(deal.title); }, [deal?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isLoading || !deal) {
    return (
      <div className="space-y-3" aria-hidden="true">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="skeleton h-16 w-full rounded-card" />
          <div className="skeleton h-16 w-full rounded-card" />
          <div className="skeleton h-16 w-full rounded-card" />
          <div className="skeleton h-16 w-full rounded-card" />
        </div>
        <div className="skeleton h-32 w-full rounded-card" />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => onEdit(deal)}>
          Edit {pageSingular}
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <StatTile tone="sunken" label="Stage" value={deal.stage} />
        <StatTile tone="sunken" label="Value" value={<span className="text-success tabular-nums">{money(deal.value)}</span>} />
        <StatTile tone="sunken" label="Contact" value={deal.contact?.name || '--'} />
        <StatTile tone="sunken" label="Assigned To" value={deal.assignee?.name || '--'} />
      </div>
      {deal.status !== 'OPEN' && (
        <Alert tone={deal.status === 'WON' ? 'success' : 'danger'} icon={null}>This deal is <strong>{deal.status === 'WON' ? 'won' : 'lost'}</strong>.</Alert>
      )}
      <div className="space-y-2">
        {followUp && followUp.status !== 'NONE' && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-fg-muted">
            <FollowUpStatusIcon summary={followUp} closed={deal.status !== 'OPEN'} timezone={timezone} />
            <span className="min-w-0 break-words">{followUp.label}</span>
          </div>
        )}
        {followUp?.status === 'NONE' && deal.status === 'OPEN' && (
          <p className="text-xs text-fg-subtle">No follow-up planned — add a task below{aiEnabled ? ' or ask for a suggestion' : ''}.</p>
        )}
        <NextStepChip kind="DEAL" recordId={deal.id} aiEnabled={aiEnabled} trigger={saved} />
      </div>
      <RelatedDealsPanel dealId={deal.id} onOpenDeal={onOpenDeal} />
      <DealDetailPanel deal={deal} aiEnabled={aiEnabled} onSaved={bump} />
      <RecordTags entityType="DEAL" entityId={deal.id} />
      <CustomFieldsDisplay entityType="DEAL" entityId={deal.id} card />
      <ScheduleReminderPanel entityType="DEAL" entityId={deal.id} />
      <Comments entityType="DEAL" entityId={deal.id} onPosted={bump} />
      <Attachments entityType="DEAL" entityId={deal.id} />
            <RecordTasks entityType="DEAL" entityId={deal.id} />
    </div>
  );
}

/** Deals as a table, with the follow-up filter and "overdue first" sort done on the server (org timezone). */
function DealsListView({ onOpen }: { onOpen: (d: any) => void }) {
  const { money, timezone } = useFormat();
  const isDesktop = useMediaQuery(MD_UP);
  const [status, setStatus] = useState('OPEN');
  const [followUp, setFollowUp] = useState('');
  const [sortFollowUp, setSortFollowUp] = useState(true);
  const { data: rows, isLoading } = useDeals({
    limit: '200', ...(status && { status }), ...(followUp && { followUp }), ...(sortFollowUp && { sort: 'followup' }),
  });
  const pill = (d: any, size: 'compact' | 'full') => (
    <FollowUpStatusIcon summary={d.followUp} closed={d.status !== 'OPEN'} timezone={timezone} size={size} onClick={() => onOpen(d)} />
  );
  const columns: Column<any>[] = [
    {
      key: 'title', header: 'Deal',
      cell: (d: any) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-fg truncate" title={d.title}>{d.title}</span>
          {!isDesktop && pill(d, 'compact')}
        </div>
      ),
    },
    { key: 'followUp', header: 'Follow-up', hideBelow: 'md', mobile: 'hidden', cell: (d: any) => pill(d, 'full') },
    { key: 'stage', header: 'Stage', muted: true, cell: (d: any) => d.stage },
    { key: 'value', header: 'Value', align: 'right', cell: (d: any) => <span className="tabular-nums">{money(d.value)}</span> },
    { key: 'contact', header: 'Contact', hideBelow: 'md', muted: true, cell: (d: any) => d.contact?.name || '--' },
    { key: 'assignee', header: 'Assigned to', hideBelow: 'lg', muted: true, cell: (d: any) => d.assignee?.name || '--' },
    { key: 'status', header: 'Status', hideBelow: 'sm', cell: (d: any) => <StatusBadge value={d.status} map={dealStatusVariant} dot /> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)} placeholder="All statuses"
          options={[{ value: 'OPEN', label: 'Open' }, { value: 'WON', label: 'Won' }, { value: 'LOST', label: 'Lost' }]} className="w-36" />
        <Select aria-label="Filter by follow-up" value={followUp} onChange={e => setFollowUp(e.target.value)} placeholder="All follow-ups" options={FOLLOWUP_FILTERS} className="w-48" />
        <Button variant={sortFollowUp ? 'primary' : 'secondary'} icon={<ArrowDownUp size={14} />} aria-pressed={sortFollowUp} onClick={() => setSortFollowUp(v => !v)}
          title="Sort by follow-up: overdue first, then due today, upcoming, none">Overdue first</Button>
      </div>
      <Card padding="none" className="overflow-hidden">
        <DataTable columns={columns} rows={rows ?? []} rowKey={(d: any) => d.id} onRowClick={onOpen} minWidth={640} loading={isLoading}
          empty={<p className="text-sm text-fg-subtle text-center py-8">No deals match these filters.</p>} />
      </Card>
    </div>
  );
}

export function DealsPage() {
  const { user } = useAuth();
  const role = user?.role;
  /* The board itself (/crm/deals/pipeline, /crm/contacts, /crm/accounts) is
     CRM_STAFF-only, while the Reports tab's /crm/deals/reports is narrower
     still — CRM_MANAGERS. A SALES_REP works the board every day but cannot
     read the reports, so the reports query and its tab are gated separately
     rather than taking the whole page away from them. */
  const canReadCrm = can.readCrm(role);
  const canReadReports = can.readCrmReports(role);
  const [modal, setModal] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // ?deal=<id> opens that deal (links from related deals, search, notifications).
  const [selectedDealId, setSelectedDealIdRaw] = useState<string | null>(() => searchParams.get('deal'));
  const [selectedDealTitle, setSelectedDealTitle] = useState('');
  function setSelectedDealId(id: string | null) {
    setSelectedDealIdRaw(id);
    if (!id && searchParams.has('deal')) { searchParams.delete('deal'); setSearchParams(searchParams, { replace: true }); }
  }
  const [editingDeal, setEditingDeal] = useState<any>(null);
  const [view, setView] = useState<'kanban' | 'list' | 'reports'>('kanban');
  // Board filter: the board already holds every open deal with its follow-up status.
  const [boardFollowUp, setBoardFollowUp] = useState('');
  const { data: lic } = useLicense(canReadCrm);
  const aiEnabled = !!lic?.features.includes('ai_advanced');
  const [pipelineHealthOpen, setPipelineHealthOpen] = useState(false);
  const [stagesOpen, setStagesOpen] = useState(false);
  const { data: pipelineData, isLoading } = usePipeline(canReadCrm);
  const { data: reports } = useDealReports(canReadReports);
  const { data: contacts } = useContacts(undefined, canReadCrm);
  const { data: accounts } = useAccounts(undefined, canReadCrm);
  const { data: users } = useUsers();
  const create = useCreateDeal();
  const update = useUpdateDeal();
  const moveStage = useMoveDealStage();
  const del = useDeleteDeal();
  const saveCustomFields = useSaveCustomFieldValues();
  const { data: dealFieldDefs } = useCustomFieldDefs('DEAL');
  const { data: linkRule } = useDealLinkRule(canReadCrm);
  const boardIds = useMemo(() => (pipelineData?.columns ?? []).flatMap((c: any) => c.deals.map((d: any) => d.id)), [pipelineData]);
  const boardById = useMemo(() => new Map<string, any>((pipelineData?.columns ?? []).flatMap((c: any) => c.deals.map((d: any) => [d.id, d]))), [pipelineData]);
  const { data: relatedCounts } = useRelatedCounts(boardIds, !!linkRule?.rule);
  const relatedLabel = linkRule?.rule?.fields.map(f => f.label).join(' + ') ?? '';

  // Backend now returns stages as rich objects ({ label, color, probability, ... })
  // so the stage manager can rename/recolor them — this form only needs the labels.
  const stages = (pipelineData?.pipeline?.stages as any[] | undefined)?.map(s => typeof s === 'string' ? s : s.label);
  const { entityLabel } = useLabels();
  const { money } = useFormat();
  const pageSingular = entityLabel('deal', 'singular', 'Deal');
  const pagePlural = entityLabel('deal', 'plural', 'Pipeline');
  const aiPrefill = useAiPrefill<{ title?: string; value?: number; stage?: string; probability?: number; contactId?: string }>();

  useEffect(() => {
    // Clear any other deal modal that might already be open (an existing
    // deal's Edit view or Detail view) so the AI's "Go Create" always lands
    // on a genuinely fresh "New Deal" form — otherwise `Modal open={modal ||
    // !!editingDeal}` could stay pinned to a stale editingDeal from before
    // and the create modal's own `modal` flag flipping true wouldn't matter,
    // since the title/initial values would still be the old edit's.
    if (aiPrefill) { setEditingDeal(null); setSelectedDealId(null); setModal(true); }
  }, [aiPrefill]);

  // After every hook.
  if (!canReadCrm) return <AccessDenied />;

  function handleDrop(e: React.DragEvent, toStage: string) {
    const dealId = e.dataTransfer.getData('dealId');
    const fromStage = e.dataTransfer.getData('fromStage');
    if (dealId && fromStage !== toStage) moveStage.mutate({ id: dealId, stage: toStage });
    e.currentTarget.classList.remove('ring-2', 'ring-accent/40', 'bg-accent-soft/40');
  }

  return (
    <div className="h-full flex flex-col animate-fade-in">
      <PageHeader
        title={pagePlural}
        subtitle={pipelineData?.pipeline?.name}
        actions={
          <div className="flex flex-wrap gap-2">
            {/* No Reports tab for roles that can't read /crm/deals/reports. */}
            <Tabs
              aria-label="Pipeline view"
              variant="segmented"
              value={view}
              onChange={setView}
              items={[{ key: 'kanban', label: 'Board' }, { key: 'list', label: 'List' }, ...(canReadReports ? [{ key: 'reports' as const, label: 'Reports' }] : [])]}
            />
            {view === 'kanban' && (
              <Select aria-label="Filter board by follow-up" value={boardFollowUp} onChange={e => setBoardFollowUp(e.target.value)} placeholder="All follow-ups" options={FOLLOWUP_FILTERS} className="w-48" />
            )}
            <Button variant="secondary" icon={<Sparkles size={14} />} onClick={() => setPipelineHealthOpen(true)}>Pipeline Health</Button>
            <Button variant="secondary" icon={<Settings size={14} />} onClick={() => setStagesOpen(true)}>Manage Stages</Button>
            <Button icon={<Plus size={15} />} onClick={() => setModal(true)}>New {pageSingular}</Button>
          </div>
        }
      />

      <PageBody width="full" className="flex-1 min-h-0 flex flex-col !space-y-0">
      {isLoading ? (
        <div className="flex gap-4 overflow-hidden flex-1" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-[85vw] max-w-[340px] md:w-[280px] space-y-2" style={{ opacity: 1 - i * 0.18 }}>
              <div className="skeleton h-10 w-full rounded-card" />
              <div className="skeleton h-28 w-full rounded-card" />
              <div className="skeleton h-28 w-full rounded-card" />
            </div>
          ))}
        </div>
      ) : view === 'list' ? (
        <DealsListView onOpen={(d: any) => { setSelectedDealId(d.id); setSelectedDealTitle(d.title); }} />
      ) : (view === 'kanban' || !canReadReports) ? (
        <div className="flex gap-3 md:gap-4 overflow-x-auto pb-4 flex-1 -mx-1 px-1 snap-x snap-mandatory scroll-px-1 overscroll-x-contain md:snap-none">
          {pipelineData?.columns?.map(({ stage, color, deals: allDeals }: any) => {
            const deals = boardFollowUp ? allDeals.filter((d: any) => matchesFollowUpFilter(d.followUp, boardFollowUp)) : allDeals;
            const total = deals.reduce((s: number, d: any) => s + Number(d.value), 0);
            // Stage colors now come from the pipeline's own stage config
            // (customizable via Manage Stages) rather than a hardcoded map —
            // a hardcoded map only covers the 5 original default stage
            // names, which breaks the moment a stage is renamed or added.
            const headerColor = color || '#6b7280';
            return (
              <div key={stage} className="flex-shrink-0 w-[85vw] max-w-[340px] snap-start md:w-auto md:min-w-[260px] md:max-w-[300px] flex flex-col rounded-card transition-all"
                onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('ring-2', 'ring-accent/40', 'bg-accent-soft/40'); }}
                onDragLeave={e => e.currentTarget.classList.remove('ring-2', 'ring-accent/40', 'bg-accent-soft/40')}
                onDrop={e => handleDrop(e, stage)}>
                <div className="rounded-t-card px-3 py-2.5 bg-surface border border-b-0 border-line">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: headerColor }} aria-hidden="true" />
                    <span className="text-[13px] font-semibold text-fg truncate" title={stage}>{stage}</span>
                    <span className="text-[11px] font-medium text-fg-muted bg-surface-sunken border border-line-subtle rounded-full px-1.5 py-px tabular-nums shrink-0">{deals.length}</span>
                    {total > 0 && <span className="ml-auto text-[11px] font-medium text-fg-muted tabular-nums shrink-0" title="Total value in this stage">{money(total)}</span>}
                  </div>
                </div>
                <div className="flex-1 rounded-b-card border border-t-0 border-line p-2 space-y-2 min-h-32 transition-colors bg-surface-sunken">
                  {deals.length === 0 && (
                    <p className="text-xs text-fg-subtle text-center py-6 border border-dashed border-line rounded-card">Drop deals here</p>
                  )}
                  {deals.map((deal: any) => (
                    <DealCard key={deal.id} deal={deal} related={relatedCounts?.counts?.[deal.id]} relatedLabel={relatedLabel} onDelete={(id: string) => del.mutate(id)} onSelect={(d: any) => { setSelectedDealId(d.id); setSelectedDealTitle(d.title); }} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card>
            <h3 className="text-[14px] font-semibold text-fg tracking-tight mb-4">Pipeline Funnel</h3>
            {reports?.funnel?.map((s: any) => (
              <div key={s.stage} className="mb-3">
                <div className="flex justify-between gap-2 text-sm mb-1">
                  <span className="text-fg-muted truncate" title={s.stage}>{s.stage}</span>
                  <span className="font-medium tabular-nums shrink-0">{s.count} deals · {money(s.value)}</span>
                </div>
                <div className="h-2 bg-surface-sunken rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all duration-200" style={{ width: `${Math.min(100, (s.count / (reports.funnel[0]?.count || 1)) * 100)}%` }} />
                </div>
              </div>
            ))}
          </Card>
          <div className="space-y-4">
            <StatTile
              label="Weighted Forecast"
              value={<span className="tabular-nums">{money(reports?.forecast)}</span>}
              icon={<TrendingUp size={22} />}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <StatTile label="Won" value={<span className="text-success tabular-nums">{reports?.won}</span>} />
              <StatTile label="Lost" value={<span className="text-danger tabular-nums">{reports?.lost}</span>} />
            </div>
          </div>
        </div>
      )}
      </PageBody>

      <Modal open={modal || !!editingDeal} onClose={() => { setModal(false); setEditingDeal(null); }} title={editingDeal ? `Edit ${pageSingular}` : `New ${pageSingular}`} size="lg">
        <DealForm contacts={contacts} accounts={accounts} users={users} stages={stages}
          initial={editingDeal ? {
            title: editingDeal.title,
            value: editingDeal.value,
            stage: editingDeal.stage,
            probability: editingDeal.probability,
            closeDate: editingDeal.closeDate ? editingDeal.closeDate.split('T')[0] : '',
            contactId: editingDeal.contactId ?? editingDeal.contact?.id ?? '',
            accountId: editingDeal.accountId ?? editingDeal.account?.id ?? '',
            assignedTo: editingDeal.assignedTo ?? editingDeal.assignee?.id ?? '',
            departmentId: editingDeal.departmentId ?? editingDeal.department?.id ?? '',
          } : null}
          entityId={editingDeal?.id}
          aiPrefill={!editingDeal ? aiPrefill : null}
          onSubmit={async (form: any) => {
            const { __customFieldValues, ...rest } = form;
            const saved = editingDeal
              ? await update.mutateAsync({ id: editingDeal.id, ...rest })
              : await create.mutateAsync(rest);
            if (__customFieldValues && dealFieldDefs?.length) {
              const values = toValuesPayload(dealFieldDefs, __customFieldValues);
              if (values.length) await saveCustomFields.mutateAsync({ entityId: saved.id, values });
            }
            setModal(false);
            setEditingDeal(null);
          }}
          loading={create.isPending || update.isPending} />
      </Modal>

      <Modal open={!!selectedDealId} onClose={() => setSelectedDealId(null)} title={selectedDealTitle} size="lg">
        {selectedDealId && (
          <DealDetailModalContent
            id={selectedDealId}
            pageSingular={pageSingular}
            onEdit={(deal) => { setEditingDeal(deal); setSelectedDealId(null); }}
            onOpenDeal={(id, title) => { setSelectedDealIdRaw(id); setSelectedDealTitle(title); }}
            onTitle={setSelectedDealTitle}
            aiEnabled={aiEnabled}
            followUp={boardById.get(selectedDealId)?.followUp}
          />
        )}
      </Modal>

      <PipelineHealthModal open={pipelineHealthOpen} onClose={() => setPipelineHealthOpen(false)} />
      <PipelineStagesModal open={stagesOpen} onClose={() => setStagesOpen(false)} />
    </div>
  );
}
