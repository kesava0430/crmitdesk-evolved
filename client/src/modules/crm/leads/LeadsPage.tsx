import { useState, useEffect } from 'react';
import { Target, Plus, ArrowRight, Trash2, CheckCircle2, Sparkles, Mail, Copy, Check, Zap, Calendar, Pencil } from 'lucide-react';
import { useLeads, useCreateLead, useUpdateLead, useConvertLead, useDeleteLead } from '../../../api/crm';
import { useScoreLead, useLeadFollowUp, useNurtureSequence } from '../../../api/ai';
import { PageHeader, Button, Modal, Badge, SearchInput, EmptyState, Spinner, SearchableSelect , RowActions, CustomFieldsFormFields, RecordTemplatePicker } from '../../../shared/components';
import { leadStatusVariant } from '../../../shared/components/Badge';
import { useCustomFieldDefs, useCustomFieldValues, useSaveCustomFieldValues, toValuesPayload, fromValueRecords } from '../../../api/customFields';

const STATUSES = ['NEW','CONTACTED','QUALIFIED','UNQUALIFIED','CONVERTED'];
const SOURCES = ['Web','Referral','Cold Outreach','Event','Social Media','Other'];
const STAGES = ['Prospecting','Proposal','Negotiation','Won','Lost'];

function scoreColor(score: number) {
  if (score >= 75) return 'bg-green-100 text-green-700 border-green-200';
  if (score >= 50) return 'bg-yellow-100 text-yellow-700 border-yellow-200';
  return 'bg-red-100 text-red-700 border-red-200';
}

function LeadForm({ initial, entityId, onSubmit, loading }: any) {
  const [form, setForm] = useState(initial || { name: '', email: '', source: '', notes: '', status: 'NEW' });
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const { data: existingValues } = useCustomFieldValues(entityId);
  useEffect(() => {
    if (existingValues) setCustomValues(fromValueRecords(existingValues));
  }, [existingValues]);
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: e.target.value }));
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ ...form, __customFieldValues: customValues }); }} className="space-y-3">
      {!initial && (
        <RecordTemplatePicker
          entityType="LEAD"
          onApply={t => {
            setForm((p: any) => ({ ...p, ...t.fieldValues }));
            if (t.customFieldValues) setCustomValues(p => ({ ...p, ...t.customFieldValues as Record<string, string> }));
          }}
        />
      )}
      <div className="form-section">
        <p className="form-section-title">Lead Information</p>
        <div className="space-y-4">
          <div>
            <label className="form-label">Full Name <span className="req">*</span></label>
            <input aria-label="Full Name" required className="ui-input" value={form.name} onChange={f('name')} placeholder="e.g. John Doe" />
          </div>
          <div>
            <label className="form-label">Email</label>
            <input aria-label="Email" type="email" className="ui-input" value={form.email} onChange={f('email')} placeholder="john@company.com" />
          </div>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Classification</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="form-label">Source</label>
            <SearchableSelect ariaLabel="Source" value={form.source} onChange={val => setForm((p: any) => ({ ...p, source: val }))} options={SOURCES.map(s => ({ value: s, label: s }))} />
          </div>
          <div>
            <label className="form-label">Status</label>
            <SearchableSelect ariaLabel="Status" value={form.status} onChange={val => setForm((p: any) => ({ ...p, status: val }))} required options={STATUSES.filter(s => s !== 'CONVERTED').map(s => ({ value: s, label: s }))} />
          </div>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Notes</p>
        <textarea aria-label="Notes" rows={3} className="ui-input" value={form.notes} onChange={f('notes')} placeholder="Any relevant background or context…" />
      </div>
      <CustomFieldsFormFields
        entityType="LEAD"
        values={customValues}
        onChange={(key, value) => setCustomValues(p => ({ ...p, [key]: value }))}
      />
      <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>{initial ? 'Save Changes' : 'Create Lead'}</Button></div>
    </form>
  );
}

function ConvertLeadModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const convert = useConvertLead();
  const contactName = lead.contact?.name || 'New Deal';
  const [form, setForm] = useState({
    dealTitle: `Deal - ${contactName}`,
    dealValue: '',
    dealStage: 'Prospecting',
    dealProbability: '20',
  });
  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target.value }));

  async function handleConvert(e: React.FormEvent) {
    e.preventDefault();
    await convert.mutateAsync({ id: lead.id, ...form });
    onClose();
  }

  return (
    <form onSubmit={handleConvert} className="space-y-5">
      <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold text-sm flex-shrink-0">
          {contactName[0]?.toUpperCase()}
        </div>
        <div>
          <p className="font-semibold text-gray-900">{contactName}</p>
          <p className="text-xs text-gray-500">{lead.contact?.email} · {lead.source || 'Unknown source'}</p>
        </div>
        <ArrowRight size={18} className="text-indigo-400 ml-auto" />
      </div>
      <div className="form-section">
        <p className="form-section-title">New Deal Details</p>
        <div className="space-y-4">
          <div>
            <label className="form-label">Deal Title <span className="req">*</span></label>
            <input aria-label="Deal Title" required className="ui-input" value={form.dealTitle} onChange={f('dealTitle')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">Value ($)</label>
              <input aria-label="Value ($)" type="number" min="0" className="ui-input" value={form.dealValue} onChange={f('dealValue')} placeholder="0" />
            </div>
            <div>
              <label className="form-label">Probability (%)</label>
              <input aria-label="Probability (%)" type="number" min="0" max="100" className="ui-input" value={form.dealProbability} onChange={f('dealProbability')} />
            </div>
          </div>
          <div>
            <label className="form-label">Stage</label>
            <SearchableSelect ariaLabel="Stage" value={form.dealStage} onChange={val => setForm(p => ({ ...p, dealStage: val }))} required options={STAGES.map(s => ({ value: s, label: s }))} />
          </div>
        </div>
      </div>
      <div className="bg-green-50 border border-green-100 rounded-xl p-3 text-sm text-green-700 flex items-start gap-2">
        <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
        <span>Converting will mark this lead as <strong>Converted</strong> and create the deal in your pipeline.</span>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={convert.isPending}>Convert Lead</Button>
      </div>
    </form>
  );
}

function FollowUpModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const followUp = useLeadFollowUp();
  const [result, setResult] = useState<{ subject: string; body: string } | null>(null);
  const [copied, setCopied] = useState<'subject' | 'body' | null>(null);

  async function generate() {
    const data = await followUp.mutateAsync(lead.id);
    setResult(data);
  }

  function copy(text: string, field: 'subject' | 'body') {
    navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="space-y-4">
      <div className="bg-violet-50 border border-violet-100 rounded-xl p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center">
          <Sparkles size={18} className="text-violet-600" />
        </div>
        <div>
          <p className="font-semibold text-gray-900">{lead.contact?.name || 'Lead'}</p>
          <p className="text-xs text-gray-500">{lead.contact?.email} · {lead.source || 'Unknown source'}</p>
        </div>
      </div>

      {!result ? (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500 mb-4">AI will write a personalized follow-up email based on this lead's data, source, and notes.</p>
          <Button icon={<Sparkles size={15} />} onClick={generate} loading={followUp.isPending}>
            Generate Follow-up Email
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 flex items-center justify-between border-b border-gray-100">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Subject</span>
              <button onClick={() => copy(result.subject, 'subject')} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700">
                {copied === 'subject' ? <><Check size={12} className="text-green-500" /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
            <p className="px-4 py-3 text-sm font-medium text-gray-800">{result.subject}</p>
          </div>

          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 flex items-center justify-between border-b border-gray-100">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Email Body</span>
              <button onClick={() => copy(result.body, 'body')} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700">
                {copied === 'body' ? <><Check size={12} className="text-green-500" /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
            <pre className="px-4 py-3 text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed max-h-64 overflow-y-auto">{result.body}</pre>
          </div>

          <div className="flex justify-between pt-1">
            <Button variant="secondary" icon={<Sparkles size={14} />} onClick={generate} loading={followUp.isPending}>Regenerate</Button>
            <Button icon={<Mail size={14} />} onClick={() => { copy(result.body, 'body'); onClose(); }}>Copy &amp; Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NurtureSequenceModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const nurture = useNurtureSequence();

  return (
    <div className="space-y-4">
      <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-indigo-100 flex items-center justify-center">
          <Calendar size={18} className="text-indigo-600" />
        </div>
        <div>
          <p className="font-semibold text-gray-900">{lead.contact?.name || 'Lead'}</p>
          <p className="text-xs text-gray-500">{lead.source || 'Unknown source'}</p>
        </div>
      </div>

      {!nurture.data ? (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500 mb-4">AI will generate a personalized 3-step nurture email sequence for this lead.</p>
          <Button icon={<Sparkles size={15} />} onClick={() => nurture.mutate(lead.id)} loading={nurture.isPending}>
            Generate Nurture Sequence
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {nurture.data.sequence.map((step: { day: number; subject: string; body: string }, i: number) => (
            <div key={i} className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="bg-gray-50 px-4 py-2 flex items-center gap-2 border-b border-gray-100">
                <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold flex-shrink-0">{i + 1}</div>
                <span className="text-xs font-semibold text-indigo-600">Day {step.day}</span>
                <span className="text-xs text-gray-500 ml-auto truncate max-w-xs">{step.subject}</span>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs font-semibold text-gray-500 mb-1">Subject: {step.subject}</p>
                <pre className="text-xs text-gray-600 whitespace-pre-wrap font-sans leading-relaxed max-h-24 overflow-y-auto">{step.body}</pre>
              </div>
            </div>
          ))}
          <div className="flex justify-between pt-1">
            <Button variant="secondary" icon={<Sparkles size={14} />} onClick={() => nurture.mutate(lead.id)} loading={nurture.isPending}>Regenerate</Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function LeadsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [modal, setModal] = useState<null | 'create' | { type: 'edit'; lead: any } | { type: 'convert'; lead: any } | { type: 'followup'; lead: any } | { type: 'nurture'; lead: any }>(null);
  const { data: leads, isLoading } = useLeads({ ...(search && { search }), ...(statusFilter && { status: statusFilter }) });
  const create = useCreateLead();
  const update = useUpdateLead();
  const del = useDeleteLead();
  const score = useScoreLead();
  const saveCustomFields = useSaveCustomFieldValues();
  const { data: leadFieldDefs } = useCustomFieldDefs('LEAD');

  async function handleSubmit(form: any) {
    const { __customFieldValues, ...rest } = form;
    let leadId: string;
    if (modal === 'create') {
      const created = await create.mutateAsync(rest);
      leadId = created.id;
    } else if (modal && typeof modal === 'object' && (modal as any).type === 'edit') {
      leadId = (modal as any).lead.id;
      await update.mutateAsync({ id: leadId, ...rest });
    } else {
      setModal(null);
      return;
    }
    if (__customFieldValues && leadFieldDefs?.length) {
      const values = toValuesPayload(leadFieldDefs, __customFieldValues);
      if (values.length) await saveCustomFields.mutateAsync({ entityId: leadId, values });
    }
    setModal(null);
  }

  return (
    <div className="p-4 sm:p-6 animate-slide-up">
      <PageHeader
        title="Leads"
        subtitle={`${leads?.length ?? 0} leads`}
        actions={
          <div className="flex flex-wrap gap-2">
            <SearchInput value={search} onChange={setSearch} placeholder="Search leads..." />
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="ui-input focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white">
              <option value="">All Statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <Button icon={<Plus size={15} />} onClick={() => setModal('create')}>New Lead</Button>
          </div>
        }
      />

      {isLoading ? <Spinner /> : leads?.length === 0 ? (
        <EmptyState icon={<Target size={24} />} title="No leads yet" description="Capture your first lead to start the pipeline" action={{ label: 'New Lead', onClick: () => setModal('create') }} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead><tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                <th className="hidden sm:table-cell text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                <th className="hidden sm:table-cell text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Source</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">AI Score</th>
                <th className="hidden sm:table-cell text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Notes</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {leads?.map((lead: any) => (
                  <tr key={lead.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors duration-150">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                          lead.status === 'CONVERTED' ? 'bg-green-100 text-green-600' : 'bg-indigo-100 text-indigo-600'
                        }`}>
                          {(lead.contact?.name || '?')[0]?.toUpperCase()}
                        </div>
                        <span className="font-medium text-gray-900">{lead.contact?.name || '--'}</span>
                      </div>
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-500">{lead.contact?.email || '--'}</td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-500">{lead.source || '--'}</td>
                    <td className="px-4 py-3"><Badge variant={leadStatusVariant[lead.status]}>{lead.status}</Badge></td>
                    <td className="px-4 py-3">
                      {lead.aiScore != null ? (
                        <div className="flex items-center gap-1.5">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${scoreColor(lead.aiScore)}`}>
                            {lead.aiScore}
                          </span>
                          <button title={lead.aiScoreReason || 'Re-score'} onClick={() => score.mutate(lead.id)} className="text-gray-300 hover:text-violet-500 transition-colors">
                            <Zap size={12} />
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => score.mutate(lead.id)} disabled={score.isPending}
                          className="flex items-center gap-1 text-xs text-violet-500 hover:text-violet-700 font-medium disabled:opacity-40">
                          <Sparkles size={12} />
                          {score.isPending ? 'Scoring...' : 'Score'}
                        </button>
                      )}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-400 text-xs max-w-xs truncate">{lead.notes}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 flex-wrap">
                        <button onClick={() => setModal({ type: 'followup', lead })} title="AI follow-up email"
                          className="p-1.5 hover:bg-violet-50 rounded-lg text-gray-400 hover:text-violet-600 transition-colors">
                          <Mail size={14} />
                        </button>
                        <button onClick={() => setModal({ type: 'nurture', lead })} title="AI nurture sequence"
                          className="p-1.5 hover:bg-indigo-50 rounded-lg text-gray-400 hover:text-indigo-600 transition-colors">
                          <Calendar size={14} />
                        </button>
                        {lead.status !== 'CONVERTED' ? (
                          <Button size="sm" variant="secondary" icon={<ArrowRight size={13} />} onClick={() => setModal({ type: 'convert', lead })}>
                            Convert
                          </Button>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-green-600 font-medium px-2">
                            <CheckCircle2 size={13} /> Converted
                          </span>
                        )}
                        <RowActions items={[
                          { label: 'Edit lead', icon: <Pencil size={14} />, onClick: () => setModal({ type: 'edit', lead }) },
                          { label: 'Delete lead', icon: <Trash2 size={14} />, onClick: () => del.mutate(lead.id), variant: 'danger' },
                        ]} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={modal === 'create' || (typeof modal === 'object' && modal !== null && (modal as any).type === 'edit')}
        onClose={() => setModal(null)} title={modal === 'create' ? 'New Lead' : 'Edit Lead'}>
        <LeadForm
          initial={modal && typeof modal === 'object' && (modal as any).type === 'edit'
            ? {
                name: (modal as any).lead.contact?.name || '',
                email: (modal as any).lead.contact?.email || '',
                source: (modal as any).lead.source || '',
                notes: (modal as any).lead.notes || '',
                status: (modal as any).lead.status || 'NEW',
              }
            : null}
          entityId={modal && typeof modal === 'object' && (modal as any).type === 'edit' ? (modal as any).lead.id : undefined}
          onSubmit={handleSubmit} loading={create.isPending || update.isPending} />
      </Modal>

      <Modal open={typeof modal === 'object' && modal !== null && (modal as any).type == 'convert'}
        onClose={() => setModal(null)}
        title="Convert Lead to Deal"
      >
        {modal && typeof modal === 'object' && (modal as any).type === 'convert' && (
          <ConvertLeadModal lead={(modal as any).lead} onClose={() => setModal(null)} />
        )}
      </Modal>

      <Modal
        open={typeof modal === 'object' && modal !== null && (modal as any).type === 'followup'}
        onClose={() => setModal(null)}
        title="AI Follow-up Email"
      >
        {modal && typeof modal === 'object' && (modal as any).type === 'followup' && (
          <FollowUpModal lead={(modal as any).lead} onClose={() => setModal(null)} />
        )}
      </Modal>

      <Modal
        open={typeof modal === 'object' && modal !== null && (modal as any).type === 'nurture'}
        onClose={() => setModal(null)}
        title="AI Nurture Sequence"
      >
        {modal && typeof modal === 'object' && (modal as any).type === 'nurture' && (
          <NurtureSequenceModal lead={(modal as any).lead} onClose={() => setModal(null)} />
        )}
      </Modal>
    </div>
  );
}
