import { useEffect, useState } from 'react';
import { TrendingUp, Plus, Trash2, DollarSign, Sparkles, Activity, Copy, Check, Mail, Pencil } from 'lucide-react';
import { usePipeline, useCreateDeal, useUpdateDeal, useMoveDealStage, useDeleteDeal, useDealReports } from '../../../api/crm';
import { useContacts, useAccounts } from '../../../api/crm';
import { useUsers } from '../../../api/users';
import { useWinProbability, usePipelineHealth, useDealFollowUp, useToneCheck } from '../../../api/ai';
import { PageHeader, Button, Modal, Spinner, SearchableSelect, CustomFieldsFormFields, CustomFieldsDisplay, RecordTemplatePicker, ScheduleReminderPanel } from '../../../shared/components';
import { Comments } from '../../../shared/components/Comments';
import { Attachments } from '../../../shared/components/Attachments';
import { useCustomFieldDefs, useCustomFieldValues, useSaveCustomFieldValues, toValuesPayload, fromValueRecords } from '../../../api/customFields';
import { useLabels } from '../../../hooks/useLabels';

const STAGE_COLORS: Record<string, string> = {
  Prospecting: 'bg-gray-100 border-gray-300',
  Proposal: 'bg-blue-50 border-blue-200',
  Negotiation: 'bg-yellow-50 border-yellow-200',
  Won: 'bg-green-50 border-green-200',
  Lost: 'bg-red-50 border-red-200',
};
const STAGE_HEADER: Record<string, string> = {
  Prospecting: 'bg-gray-500', Proposal: 'bg-blue-500', Negotiation: 'bg-yellow-500', Won: 'bg-green-500', Lost: 'bg-red-500',
};

function DealForm({ initial, entityId, contacts, accounts, users, stages, onSubmit, loading }: any) {
  const [form, setForm] = useState(initial || { title: '', value: '', stage: stages?.[0] || '', probability: 20, contactId: '', accountId: '', assignedTo: '', closeDate: '' });
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const { data: existingValues } = useCustomFieldValues(entityId);
  useEffect(() => {
    if (existingValues) setCustomValues(fromValueRecords(existingValues));
  }, [existingValues]);
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: e.target.value }));
  const { entityLabel, fieldLabel } = useLabels();
  const singular = entityLabel('deal', 'singular', 'Deal');
  // "Deal Title"/"Value ($)" aria-labels fall back to their exact original
  // text when unset, so the e2e suite's getByLabel(/deal title/i) etc. keeps
  // matching for the seeded test org (which never sets labelOverrides).
  const titleLabel = fieldLabel('deal', 'title', 'Deal Title');
  const valueLabel = fieldLabel('deal', 'value', 'Value ($)');
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
          <div>
            <label className="form-label">{titleLabel} <span className="req">*</span></label>
            <input aria-label={titleLabel} required className="ui-input" value={form.title} onChange={f('title')} placeholder="e.g. Enterprise License Q3" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">{valueLabel}</label>
              <input aria-label={valueLabel} type="number" min="0" className="ui-input" value={form.value} onChange={f('value')} placeholder="0" />
            </div>
            <div>
              <label className="form-label">Probability (%)</label>
              <input type="number" min="0" max="100" className="ui-input" value={form.probability} onChange={f('probability')} />
            </div>
            <div>
              <label className="form-label">{fieldLabel('deal', 'stage', 'Stage')}</label>
              <SearchableSelect ariaLabel={fieldLabel('deal', 'stage', 'Stage')} value={form.stage} onChange={val => setForm((p: any) => ({ ...p, stage: val }))} required options={(stages ?? []).map((s: string) => ({ value: s, label: s }))} />
            </div>
            <div>
              <label className="form-label">Expected Close</label>
              <input type="date" className="ui-input" value={form.closeDate} onChange={f('closeDate')} />
            </div>
          </div>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Assignment</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="form-label">Contact</label>
            <SearchableSelect ariaLabel="Contact" value={form.contactId} onChange={val => setForm((p: any) => ({ ...p, contactId: val }))} options={(contacts ?? []).map((c: any) => ({ value: c.id, label: c.name }))} placeholder="— none —" />
          </div>
          <div>
            <label className="form-label">Account</label>
            <SearchableSelect ariaLabel="Account" value={form.accountId} onChange={val => setForm((p: any) => ({ ...p, accountId: val }))} options={(accounts ?? []).map((a: any) => ({ value: a.id, label: a.name }))} placeholder="— none —" />
          </div>
          <div className="sm:col-span-2">
            <label className="form-label">Assigned To</label>
            <SearchableSelect ariaLabel="Assigned To" value={form.assignedTo} onChange={val => setForm((p: any) => ({ ...p, assignedTo: val }))} options={(users ?? []).map((u: any) => ({ value: u.id, label: u.name }))} placeholder="— select team member —" />
          </div>
        </div>
      </div>
      <CustomFieldsFormFields
        entityType="DEAL"
        values={customValues}
        onChange={(key, value) => setCustomValues(p => ({ ...p, [key]: value }))}
      />
      <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>{initial ? 'Save Changes' : `Create ${singular}`}</Button></div>
    </form>
  );
}

function DealCard({ deal, onDelete, onSelect }: any) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      draggable
      onDragStart={e => { setDragging(true); e.dataTransfer.setData('dealId', deal.id); e.dataTransfer.setData('fromStage', deal.stage); }}
      onDragEnd={() => setDragging(false)}
      className={`bg-white border border-gray-200 rounded-xl p-3 shadow-sm cursor-grab active:cursor-grabbing hover:shadow-md transition-all group w-full ${dragging ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <p onClick={() => onSelect(deal)} className="font-medium text-gray-900 text-sm leading-snug hover:text-brand-600 cursor-pointer">{deal.title}</p>
        <button onClick={() => onDelete(deal.id)} className="opacity-0 group-hover:opacity-100 p-1 text-gray-300 hover:text-red-500 transition-all flex-shrink-0">
          <Trash2 size={12} />
        </button>
      </div>
      {deal.value > 0 && (
        <div className="flex items-center gap-1 text-green-600 font-semibold text-sm mb-2">
          <DollarSign size={13} />{Number(deal.value).toLocaleString()}
        </div>
      )}
      <div className="flex items-center justify-between">
        {deal.contact && <span className="text-xs text-gray-400">{deal.contact.name}</span>}
        <span className="text-xs text-gray-400 ml-auto">{deal.probability}%</span>
      </div>
      {deal.assignee && <div className="mt-2 flex items-center gap-1">
        <div className="w-5 h-5 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center text-xs font-bold">{deal.assignee.name[0]}</div>
        <span className="text-xs text-gray-400">{deal.assignee.name}</span>
      </div>}
    </div>
  );
}

function DealDetailPanel({ deal }: { deal: any }) {
  const winProb = useWinProbability();
  const followUp = useDealFollowUp();
  const toneCheck = useToneCheck();
  const [copied, setCopied] = useState<'subject' | 'body' | null>(null);

  function copy(text: string, field: 'subject' | 'body') {
    navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  }

  const probColor = winProb.data
    ? winProb.data.probability >= 70 ? 'text-green-600' : winProb.data.probability >= 40 ? 'text-amber-600' : 'text-red-600'
    : '';
  const probBg = winProb.data
    ? winProb.data.probability >= 70 ? 'bg-green-50 border-green-200' : winProb.data.probability >= 40 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'
    : '';

  return (
    <div className="space-y-4">
      {/* Win Probability */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Activity size={14} className="text-brand-500" /> Win Probability
          </p>
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => winProb.mutate(deal.id)} loading={winProb.isPending}>
            Analyze
          </Button>
        </div>
        {winProb.data && (
          <div className={`border rounded-xl p-4 ${probBg}`}>
            <p className={`text-4xl font-bold mb-3 ${probColor}`}>{winProb.data.probability}%</p>
            {winProb.data.factors?.length > 0 && (
              <ul className="space-y-1 mb-3">
                {winProb.data.factors.map((factor: string, i: number) => (
                  <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                    <span className="text-gray-400 mt-0.5">&#8226;</span>{factor}
                  </li>
                ))}
              </ul>
            )}
            {winProb.data.recommendation && (
              <div className="border-t border-gray-200 pt-2 mt-2">
                <p className="text-xs font-semibold text-gray-500 mb-1">Recommendation</p>
                <p className="text-xs text-gray-700">{winProb.data.recommendation}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Follow-up Email */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Mail size={14} className="text-violet-500" /> Follow-up Email
          </p>
          <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => followUp.mutate(deal.id)} loading={followUp.isPending}>
            {followUp.data ? 'Regenerate' : 'Generate'}
          </Button>
        </div>
        {followUp.data && (
          <div className="space-y-2">
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="bg-gray-50 px-3 py-2 flex items-center justify-between border-b border-gray-100">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Subject</span>
                <button onClick={() => copy(followUp.data!.subject, 'subject')} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700">
                  {copied === 'subject' ? <><Check size={12} className="text-green-500" /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
              </div>
              <p className="px-3 py-2 text-sm font-medium text-gray-800">{followUp.data.subject}</p>
            </div>
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="bg-gray-50 px-3 py-2 flex items-center justify-between border-b border-gray-100">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Email Body</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toneCheck.mutate({ subject: followUp.data!.subject, body: followUp.data!.body })}
                    disabled={toneCheck.isPending}
                    className="flex items-center gap-1 text-xs text-violet-500 hover:text-violet-700 disabled:opacity-40"
                  >
                    <Sparkles size={11} />
                    {toneCheck.isPending ? 'Checking...' : 'Tone Check'}
                  </button>
                  <button onClick={() => copy(followUp.data!.body, 'body')} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700">
                    {copied === 'body' ? <><Check size={12} className="text-green-500" /> Copied</> : <><Copy size={12} /> Copy</>}
                  </button>
                </div>
              </div>
              <pre className="px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto">{followUp.data.body}</pre>
            </div>
            {toneCheck.data && (
              <div className="bg-violet-50 border border-violet-100 rounded-xl p-3 text-sm">
                <p className="text-xs font-semibold text-violet-600 mb-1">Tone Analysis</p>
                <p className="text-gray-700 text-xs leading-relaxed">{typeof toneCheck.data === 'string' ? toneCheck.data : JSON.stringify(toneCheck.data)}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PipelineHealthModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const health = usePipelineHealth();
  return (
    <Modal open={open} onClose={onClose} title="Pipeline Health" size="md">
      <div className="space-y-4">
        <div className="text-center py-2">
          <Button icon={<Sparkles size={15} />} onClick={() => health.mutate()} loading={health.isPending}>
            {health.data ? 'Refresh Analysis' : 'Analyze Pipeline'}
          </Button>
        </div>
        {health.data && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-2">Summary</p>
              <p className="text-sm text-gray-700 leading-relaxed">{health.data.summary}</p>
            </div>
            {health.data.risks?.length > 0 && (
              <div className="bg-red-50 border border-red-100 rounded-xl p-4">
                <p className="text-xs font-semibold text-red-600 uppercase tracking-wider mb-2">Risks</p>
                <ul className="space-y-1.5">
                  {health.data.risks.map((r: string, i: number) => (
                    <li key={i} className="text-xs text-gray-700 flex items-start gap-1.5">
                      <span className="text-red-400 mt-0.5 flex-shrink-0">&#8226;</span>{r}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {health.data.opportunities?.length > 0 && (
              <div className="bg-green-50 border border-green-100 rounded-xl p-4">
                <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-2">Opportunities</p>
                <ul className="space-y-1.5">
                  {health.data.opportunities.map((o: string, i: number) => (
                    <li key={i} className="text-xs text-gray-700 flex items-start gap-1.5">
                      <span className="text-green-500 mt-0.5 flex-shrink-0">&#8226;</span>{o}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function DealsPage() {
  const [modal, setModal] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState<any>(null);
  const [editingDeal, setEditingDeal] = useState<any>(null);
  const [view, setView] = useState<'kanban' | 'reports'>('kanban');
  const [pipelineHealthOpen, setPipelineHealthOpen] = useState(false);
  const { data: pipelineData, isLoading } = usePipeline();
  const { data: reports } = useDealReports();
  const { data: contacts } = useContacts();
  const { data: accounts } = useAccounts();
  const { data: users } = useUsers();
  const create = useCreateDeal();
  const update = useUpdateDeal();
  const moveStage = useMoveDealStage();
  const del = useDeleteDeal();
  const saveCustomFields = useSaveCustomFieldValues();
  const { data: dealFieldDefs } = useCustomFieldDefs('DEAL');

  const stages = pipelineData?.pipeline?.stages as string[] | undefined;
  const { entityLabel } = useLabels();
  const pageSingular = entityLabel('deal', 'singular', 'Deal');
  const pagePlural = entityLabel('deal', 'plural', 'Pipeline');

  function handleDrop(e: React.DragEvent, toStage: string) {
    const dealId = e.dataTransfer.getData('dealId');
    const fromStage = e.dataTransfer.getData('fromStage');
    if (dealId && fromStage !== toStage) moveStage.mutate({ id: dealId, stage: toStage });
    e.currentTarget.classList.remove('bg-brand-50');
  }

  return (
    <div className="p-4 sm:p-6 h-full flex flex-col animate-slide-up">
      <PageHeader
        title={pagePlural}
        subtitle={pipelineData?.pipeline?.name}
        actions={
          <div className="flex flex-wrap gap-2">
            <div className="flex rounded-lg border border-gray-200 overflow-hidden">
              <button onClick={() => setView('kanban')} className={`px-3 py-1.5 text-sm ${view === 'kanban' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>Board</button>
              <button onClick={() => setView('reports')} className={`px-3 py-1.5 text-sm ${view === 'reports' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>Reports</button>
            </div>
            <Button variant="secondary" icon={<Sparkles size={14} />} onClick={() => setPipelineHealthOpen(true)}>Pipeline Health</Button>
            <Button icon={<Plus size={15} />} onClick={() => setModal(true)}>New {pageSingular}</Button>
          </div>
        }
      />

      {isLoading ? <Spinner /> : view === 'kanban' ? (
        <div className="flex gap-4 overflow-x-auto pb-4 flex-1 -mx-1 px-1">
          {pipelineData?.columns?.map(({ stage, deals }: any) => {
            const _total = deals.reduce((s: number, d: any) => s + Number(d.value), 0); void _total;
            return (
              <div key={stage} className="flex-shrink-0 min-w-[260px] max-w-[300px] flex flex-col"
                onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('bg-brand-50'); }}
                onDragLeave={e => e.currentTarget.classList.remove('bg-brand-50')}
                onDrop={e => handleDrop(e, stage)}>
                <div className={`rounded-t-xl px-3 py-2 ${STAGE_HEADER[stage] || 'bg-gray-500'}`}>
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <span className="text-white font-semibold text-sm">{stage}</span>
                    <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{deals.length}</span>
                  </div>
                </div>
                <div className={`flex-1 rounded-b-xl border-2 border-t-0 p-2 space-y-2 min-h-32 transition-colors ${STAGE_COLORS[stage] || 'bg-gray-50 border-gray-200'}`}>
                  {deals.length === 0 && <p className="text-xs text-gray-300 text-center py-4">Drop deals here</p>}
                  {deals.map((deal: any) => (
                    <DealCard key={deal.id} deal={deal} onDelete={(id: string) => del.mutate(id)} onSelect={setSelectedDeal} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
            <h3 className="font-semibold text-gray-700 mb-4">Pipeline Funnel</h3>
            {reports?.funnel?.map((s: any) => (
              <div key={s.stage} className="mb-3">
                <div className="flex justify-between text-sm mb-1"><span className="text-gray-600">{s.stage}</span><span className="font-medium">{s.count} deals · ${s.value.toLocaleString()}</span></div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-brand-500 rounded-full" style={{ width: `${Math.min(100, (s.count / (reports.funnel[0]?.count || 1)) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-4">
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-green-100 flex items-center justify-center text-green-600"><TrendingUp size={22} /></div>
              <div><p className="text-2xl font-bold text-gray-900">${reports?.forecast?.toLocaleString()}</p><p className="text-sm text-gray-500">Weighted Forecast</p></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-green-50 rounded-xl border border-green-100 p-4 text-center"><p className="text-2xl font-bold text-green-700">{reports?.won}</p><p className="text-sm text-green-600">Won</p></div>
              <div className="bg-red-50 rounded-xl border border-red-100 p-4 text-center"><p className="text-2xl font-bold text-red-700">{reports?.lost}</p><p className="text-sm text-red-600">Lost</p></div>
            </div>
          </div>
        </div>
      )}

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
          } : null}
          entityId={editingDeal?.id}
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

      <Modal open={!!selectedDeal} onClose={() => setSelectedDeal(null)} title={selectedDeal?.title || ''} size="lg">
        {selectedDeal && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => { setEditingDeal(selectedDeal); setSelectedDeal(null); }}>
                Edit {pageSingular}
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-gray-400 text-xs mb-1">Stage</p><p className="font-medium">{selectedDeal.stage}</p></div>
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-gray-400 text-xs mb-1">Value</p><p className="font-medium text-green-600">${Number(selectedDeal.value).toLocaleString()}</p></div>
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-gray-400 text-xs mb-1">Contact</p><p className="font-medium">{selectedDeal.contact?.name || '--'}</p></div>
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-gray-400 text-xs mb-1">Assigned To</p><p className="font-medium">{selectedDeal.assignee?.name || '--'}</p></div>
            </div>
            <DealDetailPanel deal={selectedDeal} />
            <CustomFieldsDisplay entityType="DEAL" entityId={selectedDeal.id} card />
            <ScheduleReminderPanel entityType="DEAL" entityId={selectedDeal.id} />
            <Comments entityType="DEAL" entityId={selectedDeal.id} />
            <Attachments entityType="DEAL" entityId={selectedDeal.id} />
          </div>
        )}
      </Modal>

      <PipelineHealthModal open={pipelineHealthOpen} onClose={() => setPipelineHealthOpen(false)} />
    </div>
  );
}
