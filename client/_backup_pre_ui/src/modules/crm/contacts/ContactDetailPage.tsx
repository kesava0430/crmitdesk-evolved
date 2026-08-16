import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, Mail, Phone, Briefcase, Building2, Globe,
  TrendingUp, Calendar, CheckCircle, Clock, Plus, Pencil, Sparkles, ShieldAlert,
} from 'lucide-react';
import { SearchableSelect } from '../../../shared/components';
import { useContact, useUpdateContact, useAccounts, useCreateActivity } from '../../../api/crm';
import { useChurnRisk } from '../../../api/ai';
import { Badge, Button, Modal, Spinner, EmptyState, CustomFieldsDisplay, CustomFieldsFormFields } from '../../../shared/components';
import { Comments } from '../../../shared/components/Comments';
import { Attachments } from '../../../shared/components/Attachments';
import { useCustomFieldDefs, useCustomFieldValues, useSaveCustomFieldValues, toValuesPayload, fromValueRecords } from '../../../api/customFields';
import { useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useFormat } from '../../../hooks/useFormat';

const DEAL_STAGE_COLOR: Record<string, string> = {
  Prospecting: 'gray', Proposal: 'blue', Negotiation: 'yellow', Won: 'green', Lost: 'red',
};

const ACTIVITY_ICON: Record<string, React.ReactNode> = {
  CALL:    <Phone size={14} />,
  EMAIL:   <Mail size={14} />,
  MEETING: <Calendar size={14} />,
  TASK:    <CheckCircle size={14} />,
  NOTE:    <Briefcase size={14} />,
};

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="text-gray-400 dark:text-gray-500 flex-shrink-0">{icon}</div>
      <div>
        <p className="text-xs text-gray-400 dark:text-gray-500">{label}</p>
        <p className="text-gray-800 dark:text-gray-100 font-medium">{value}</p>
      </div>
    </div>
  );
}

function ActivityForm({ contactId, onSubmit, loading }: any) {
  // Field keys match the backend Activity schema (title/body), not the
  // display labels (Subject/Notes) — previously these were named
  // subject/notes here, which silently failed server-side validation
  // (title is a required field) since the mismatched keys were never
  // translated before being POSTed.
  const [form, setForm] = useState({ type: 'CALL', title: '', body: '', dueAt: '' });
  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target.value }));
  const inp = 'ui-input';
  const lbl = 'form-label';
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ ...form, contactId }); }} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={lbl}>Type</label>
<SearchableSelect ariaLabel="Type" value={form.type} onChange={val => setForm(p => ({ ...p, type: val }))} required options={['CALL','EMAIL','MEETING','TASK','NOTE'].map(t => ({ value: t, label: t }))} />
        </div>
        <div>
          <label className={lbl}>Due Date</label>
          <input type="datetime-local" className={inp} value={form.dueAt} onChange={f('dueAt')} />
        </div>
      </div>
      <div>
        <label className={lbl}>Subject *</label>
        <input aria-label="Subject" required className={inp} value={form.title} onChange={f('title')} placeholder="Call to discuss renewal..." />
      </div>
      <div>
        <label className={lbl}>Notes</label>
        <textarea rows={3} className={inp} value={form.body} onChange={f('body')} placeholder="Details..." />
      </div>
      <div className="flex justify-end pt-1">
        <Button type="submit" loading={loading}>Log Activity</Button>
      </div>
    </form>
  );
}

function EditContactForm({ contact, accounts, onSubmit, loading }: any) {
  const [form, setForm] = useState({
    name: contact.name || '',
    email: contact.email || '',
    phone: contact.phone || '',
    jobTitle: contact.jobTitle || '',
    source: contact.source || '',
    accountId: contact.account?.id || '',
  });
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const { data: existingValues } = useCustomFieldValues(contact.id);
  useEffect(() => {
    if (existingValues) setCustomValues(fromValueRecords(existingValues));
  }, [existingValues]);
  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target.value }));
  const inp = 'ui-input';
  const lbl = 'form-label';
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ ...form, __customFieldValues: customValues }); }} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label className={lbl}>Name *</label><input aria-label="Name" required className={inp} value={form.name} onChange={f('name')} /></div>
        <div><label className={lbl}>Email</label><input type="email" className={inp} value={form.email} onChange={f('email')} /></div>
        <div><label className={lbl}>Phone</label><input className={inp} value={form.phone} onChange={f('phone')} /></div>
        <div><label className={lbl}>Job Title</label><input className={inp} value={form.jobTitle} onChange={f('jobTitle')} /></div>
        <div>
          <label className={lbl}>Source</label>
<SearchableSelect ariaLabel="Source" value={form.source} onChange={val => setForm(p => ({ ...p, source: val }))} options={['Web','Referral','Cold Outreach','Event','Social Media','Other'].map(s => ({ value: s, label: s }))} />
        </div>
        <div>
          <label className={lbl}>Account</label>
<SearchableSelect ariaLabel="Account" value={form.accountId} onChange={val => setForm(p => ({ ...p, accountId: val }))} options={(accounts ?? []).map((a: any) => ({ value: a.id, label: a.name }))} placeholder="— none —" />
        </div>
      </div>
      <CustomFieldsFormFields
        entityType="CONTACT"
        values={customValues}
        onChange={(key, value) => setCustomValues(p => ({ ...p, [key]: value }))}
      />
      <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>Save Changes</Button></div>
    </form>
  );
}

function ChurnRiskCard({ contactId }: { contactId: string }) {
  const churnRisk = useChurnRisk();

  const riskBorder = churnRisk.data
    ? churnRisk.data.risk === 'HIGH' ? 'bg-red-50 border-red-200 dark:bg-red-500/10 dark:border-red-500/30'
    : churnRisk.data.risk === 'MEDIUM' ? 'bg-amber-50 border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30'
    : 'bg-green-50 border-green-200 dark:bg-green-500/10 dark:border-green-500/30'
    : '';
  const badgeColor = churnRisk.data
    ? churnRisk.data.risk === 'HIGH' ? 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30'
    : churnRisk.data.risk === 'MEDIUM' ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30'
    : 'bg-green-100 text-green-800 border-green-300 dark:bg-green-500/10 dark:text-green-300 dark:border-green-500/30'
    : '';

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
          <ShieldAlert size={13} /> Churn Risk
        </p>
        <Button size="sm" variant="secondary" icon={<Sparkles size={12} />} onClick={() => churnRisk.mutate(contactId)} loading={churnRisk.isPending}>
          Assess
        </Button>
      </div>
      {churnRisk.data ? (
        <div className={`border rounded-xl p-3 ${riskBorder}`}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${badgeColor}`}>
              {churnRisk.data.risk} RISK
            </span>
            <span className="text-gray-400 dark:text-gray-500 text-xs">({churnRisk.data.score}/100)</span>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">{churnRisk.data.reason}</p>
        </div>
      ) : (
        <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">Click "Assess" to analyze churn risk for this contact.</p>
      )}
    </div>
  );
}

export function ContactDetailPage() {
  const { money, dateTime } = useFormat();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: contact, isLoading } = useContact(id!);
  const { data: accounts } = useAccounts();
  const update = useUpdateContact();
  const createActivity = useCreateActivity();
  const saveCustomFields = useSaveCustomFieldValues();
  const { data: contactFieldDefs } = useCustomFieldDefs('CONTACT');
  const [activityModal, setActivityModal] = useState(false);
  const [editModal, setEditModal] = useState(false);

  if (isLoading) return <div className="p-10 flex justify-center"><Spinner /></div>;
  if (!contact) return <div className="p-10 text-center text-gray-400 dark:text-gray-500">Contact not found</div>;

  const totalDealValue = contact.deals?.reduce((s: number, d: any) => s + Number(d.value || 0), 0) ?? 0;
  const openDeals = contact.deals?.filter((d: any) => !['Won','Lost'].includes(d.stage)) ?? [];

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6 animate-slide-up">
      <div>
        <button onClick={() => navigate('/crm/contacts')} className="flex items-center gap-1 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 mb-4">
          <ArrowLeft size={15} /> Back to Contacts
        </button>

        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-brand-100 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 flex items-center justify-center text-2xl font-bold flex-shrink-0">
              {contact.name[0]?.toUpperCase()}
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">{contact.name}</h1>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {contact.jobTitle && <span className="text-sm text-gray-500 dark:text-gray-400">{contact.jobTitle}</span>}
                {contact.account && (
                  <>
                    {contact.jobTitle && <span className="text-gray-300 dark:text-gray-600">&#183;</span>}
                    <Badge variant="blue">{contact.account.name}</Badge>
                  </>
                )}
                {contact.source && <Badge>{contact.source}</Badge>}
              </div>
            </div>
          </div>
          <Button variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditModal(true)}>Edit</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 space-y-4">
            <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Contact Info</p>
            <InfoRow icon={<Mail size={14} />} label="Email" value={contact.email} />
            <InfoRow icon={<Phone size={14} />} label="Phone" value={contact.phone} />
            <InfoRow icon={<Briefcase size={14} />} label="Job Title" value={contact.jobTitle} />
            <InfoRow icon={<Building2 size={14} />} label="Account" value={contact.account?.name} />
            <InfoRow icon={<Globe size={14} />} label="Source" value={contact.source} />
            <InfoRow icon={<Clock size={14} />} label="Added" value={formatDistanceToNow(new Date(contact.createdAt), { addSuffix: true })} />
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 space-y-3">
            <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Pipeline Summary</p>
            <div>
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{money(totalDealValue)}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">Total pipeline value</p>
            </div>
            <div className="flex gap-4">
              <div>
                <p className="text-lg font-bold text-gray-800 dark:text-gray-100">{contact.deals?.length ?? 0}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">Total deals</p>
              </div>
              <div>
                <p className="text-lg font-bold text-brand-600 dark:text-brand-400">{openDeals.length}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">Open deals</p>
              </div>
            </div>
          </div>

          <ChurnRiskCard contactId={contact.id} />
        </div>

        <div className="lg:col-span-2 space-y-5">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2"><TrendingUp size={15} /> Deals</p>
              <Link to="/crm/deals" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">View pipeline</Link>
            </div>
            {!contact.deals?.length ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">No deals linked to this contact</p>
            ) : (
              <div className="space-y-2">
                {contact.deals.map((deal: any) => (
                  <div key={deal.id} className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                    <div>
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{deal.title}</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500">{deal.assignee?.name || 'Unassigned'}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      {deal.value > 0 && <span className="text-sm font-semibold text-green-600 dark:text-green-400">{money(Number(deal.value))}</span>}
                      <Badge variant={DEAL_STAGE_COLOR[deal.stage] as any || 'gray'}>{deal.stage}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2"><Calendar size={15} /> Activity Timeline</p>
              <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setActivityModal(true)}>Log Activity</Button>
            </div>
            {!contact.activities?.length ? (
              <EmptyState icon={<Calendar size={20} />} title="No activities yet"
                description="Log a call, email, or meeting to start tracking"
                action={{ label: 'Add Activity', onClick: () => setActivityModal(true) }} />
            ) : (
              <div className="relative max-h-96 overflow-y-auto">
                <div className="absolute left-4 top-0 bottom-0 w-px bg-gray-100 dark:bg-gray-800" />
                <div className="space-y-4">
                  {contact.activities.map((a: any) => (
                    <div key={a.id} className="flex gap-4 relative">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 z-10 ${
                        a.status === 'DONE' ? 'bg-green-100 text-green-600 dark:bg-green-500/10 dark:text-green-400' : 'bg-brand-100 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400'
                      }`}>
                        {ACTIVITY_ICON[a.type] || <Briefcase size={14} />}
                      </div>
                      <div className="flex-1 min-w-0 pb-2">
                        <div className="flex flex-wrap items-center justify-between gap-1">
                          <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{a.title}</p>
                          <span className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">
                            {a.dueAt ? dateTime(a.dueAt) : formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}
                          </span>
                        </div>
                        {a.body && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{a.body}</p>}
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{a.createdByUser?.name} · <span className="uppercase">{a.type}</span></p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <CustomFieldsDisplay entityType="CONTACT" entityId={contact.id} card />

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
            <Comments entityType="CONTACT" entityId={contact.id} />
            <Attachments entityType="CONTACT" entityId={contact.id} />
          </div>
        </div>
      </div>

      <Modal open={activityModal} onClose={() => setActivityModal(false)} title="Log Activity">
        <ActivityForm contactId={contact.id} loading={createActivity.isPending}
          onSubmit={async (form: any) => {
            // Only close on success — previously a `finally` closed the modal
            // even when the create request failed, silently discarding the
            // error (and the activity) with no feedback to the user.
            await createActivity.mutateAsync({ ...form, dueAt: form.dueAt || undefined });
            setActivityModal(false);
          }} />
      </Modal>

      <Modal open={editModal} onClose={() => setEditModal(false)} title="Edit Contact">
        <EditContactForm contact={contact} accounts={accounts} loading={update.isPending}
          onSubmit={async (form: any) => {
            const { __customFieldValues, ...rest } = form;
            await update.mutateAsync({ id: contact.id, ...rest });
            if (__customFieldValues && contactFieldDefs?.length) {
              const values = toValuesPayload(contactFieldDefs, __customFieldValues);
              if (values.length) await saveCustomFields.mutateAsync({ entityId: contact.id, values });
            }
            setEditModal(false);
          }} />
      </Modal>
    </div>
  );
}
