import { useState } from 'react';
import { LayoutTemplate, Plus, Pencil, Trash2 } from 'lucide-react';
import { SearchableSelect, RowActions, CustomFieldsFormFields } from '../shared/components';
import { useAccounts } from '../api/crm';
import { useCategories } from '../api/itdesk';
import {
  RecordTemplate, useRecordTemplates, useCreateRecordTemplate, useUpdateRecordTemplate, useDeleteRecordTemplate,
  ReplyTemplate, useReplyTemplates, useCreateReplyTemplate, useUpdateReplyTemplate, useDeleteReplyTemplate,
  EmailTemplate, useEmailTemplates, useCreateEmailTemplate, useUpdateEmailTemplate, useDeleteEmailTemplate,
  QuoteTemplate, useQuoteTemplates, useCreateQuoteTemplate, useUpdateQuoteTemplate, useDeleteQuoteTemplate,
} from '../api/templates';

const TOP_TABS = ['Records', 'Replies', 'Emails', 'Quotes'] as const;
type TopTab = typeof TOP_TABS[number];

const ENTITY_TYPES = ['TICKET', 'CONTACT', 'DEAL', 'LEAD'] as const;
const SOURCES = ['Web', 'Referral', 'Cold Outreach', 'Event', 'Social Media', 'Other'];
const STAGES = ['Prospecting', 'Proposal', 'Negotiation', 'Won', 'Lost'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED'];

// ─── Record Templates (Ticket/Contact/Deal/Lead form pre-fill) ────────────────

const RECORD_TEMPLATE_EMPTY_FORM = { name: '', description: '', entityType: 'TICKET' as string, fieldValues: {} as Record<string, any> };

function RecordTemplatesTab() {
  const [entityType, setEntityType] = useState<string>('TICKET');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<RecordTemplate | null>(null);
  const [form, setForm] = useState(RECORD_TEMPLATE_EMPTY_FORM);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  const { data: templates = [], isLoading } = useRecordTemplates(entityType);
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();
  const create = useCreateRecordTemplate();
  const update = useUpdateRecordTemplate();
  const remove = useDeleteRecordTemplate();

  function openCreate() {
    setEditing(null);
    setForm({ ...RECORD_TEMPLATE_EMPTY_FORM, entityType });
    setCustomValues({});
    setShowModal(true);
  }
  function openEdit(t: RecordTemplate) {
    setEditing(t);
    setForm({ name: t.name, description: t.description ?? '', entityType: t.entityType, fieldValues: t.fieldValues ?? {} });
    setCustomValues((t.customFieldValues as Record<string, string>) ?? {});
    setShowModal(true);
  }
  function closeModal() { setShowModal(false); setEditing(null); }

  function handleSubmit() {
    const body = {
      name: form.name,
      description: form.description || undefined,
      entityType: form.entityType,
      fieldValues: form.fieldValues,
      customFieldValues: Object.keys(customValues).length ? customValues : undefined,
    };
    const mutation = editing ? update.mutateAsync({ id: editing.id, ...body }) : create.mutateAsync(body);
    // .catch() here just prevents an unhandled promise rejection when the
    // save fails (e.g. duplicate name) — the api client's response
    // interceptor already shows the user a toast with the server's error.
    // Without it the dialog correctly stays open (so the admin can fix the
    // conflicting field), but the rejection was otherwise unhandled.
    mutation.then(closeModal).catch(() => {});
  }

  const fv = (k: string) => (v: any) => setForm(f => ({ ...f, fieldValues: { ...f.fieldValues, [k]: v } }));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div role="tablist" className="flex gap-2">
          {ENTITY_TYPES.map(t => (
            <button key={t} role="tab" aria-selected={entityType === t} onClick={() => setEntityType(t)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${entityType === t ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {t[0] + t.slice(1).toLowerCase()}s
            </button>
          ))}
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium">
          <Plus size={16} /> New Template
        </button>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        {isLoading ? (
          <div className="py-12 text-center text-gray-400">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <LayoutTemplate size={40} className="mx-auto mb-3 opacity-30" />
            <p>No templates for {entityType.toLowerCase()}s yet.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm min-w-[500px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {templates.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{t.name}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{t.description || '—'}</td>
                    <td className="px-4 py-3">
                      <RowActions items={[
                        { label: 'Edit template', icon: <Pencil size={14} />, onClick: () => openEdit(t) },
                        { label: 'Delete template', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this template?')) remove.mutate(t.id); }, variant: 'danger' },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-xl font-bold mb-4">{editing ? 'Edit Template' : 'Create Record Template'}</h2>
            <div className="space-y-3">
              <div className="form-section">
                <p className="form-section-title">Template Identity</p>
                <div className="space-y-4">
                  <div>
                    <label className="form-label">Name <span className="req">*</span></label>
                    <input className="ui-input" aria-label="Name" placeholder="e.g. VIP Onboarding Deal" value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Description</label>
                    <input className="ui-input" aria-label="Description" placeholder="Optional note for other admins" value={form.description}
                      onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                  </div>
                  {!editing && (
                    <div>
                      <label className="form-label">Entity</label>
                      <SearchableSelect ariaLabel="Entity" value={form.entityType} onChange={val => setForm(f => ({ ...f, entityType: val, fieldValues: {} }))}
                        required options={ENTITY_TYPES.map(t => ({ value: t, label: t[0] + t.slice(1).toLowerCase() + 's' }))} />
                    </div>
                  )}
                </div>
              </div>

              <div className="form-section">
                <p className="form-section-title">Default Values</p>
                <div className="space-y-4">
                  {form.entityType === 'TICKET' && (
                    <>
                      <div>
                        <label className="form-label">Priority</label>
                        <SearchableSelect ariaLabel="Priority" value={form.fieldValues.priority ?? ''} onChange={fv('priority')}
                          options={PRIORITIES.map(p => ({ value: p, label: p }))} placeholder="— none —" />
                      </div>
                      <div>
                        <label className="form-label">Category</label>
                        <SearchableSelect ariaLabel="Category" value={form.fieldValues.categoryId ?? ''} onChange={fv('categoryId')}
                          options={(categories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} placeholder="— none —" />
                      </div>
                      <div>
                        <label className="form-label">Description boilerplate</label>
                        <textarea aria-label="Description boilerplate" rows={3} className="ui-input" value={form.fieldValues.body ?? ''}
                          onChange={e => fv('body')(e.target.value)} placeholder="Pre-filled description text agents can edit further…" />
                      </div>
                    </>
                  )}
                  {form.entityType === 'CONTACT' && (
                    <>
                      <div>
                        <label className="form-label">Job Title</label>
                        <input aria-label="Job Title" className="ui-input" value={form.fieldValues.jobTitle ?? ''} onChange={e => fv('jobTitle')(e.target.value)} />
                      </div>
                      <div>
                        <label className="form-label">Source</label>
                        <SearchableSelect ariaLabel="Source" value={form.fieldValues.source ?? ''} onChange={fv('source')}
                          options={SOURCES.map(s => ({ value: s, label: s }))} placeholder="— none —" />
                      </div>
                      <div>
                        <label className="form-label">Account</label>
                        <SearchableSelect ariaLabel="Account" value={form.fieldValues.accountId ?? ''} onChange={fv('accountId')}
                          options={(accounts ?? []).map((a: any) => ({ value: a.id, label: a.name }))} placeholder="— none —" />
                      </div>
                    </>
                  )}
                  {form.entityType === 'DEAL' && (
                    <>
                      <div>
                        <label className="form-label">Stage</label>
                        <SearchableSelect ariaLabel="Stage" value={form.fieldValues.stage ?? ''} onChange={fv('stage')}
                          options={STAGES.map(s => ({ value: s, label: s }))} placeholder="— none —" />
                      </div>
                      <div>
                        <label className="form-label">Probability (%)</label>
                        <input aria-label="Probability (%)" type="number" min="0" max="100" className="ui-input" value={form.fieldValues.probability ?? ''}
                          onChange={e => fv('probability')(e.target.value)} />
                      </div>
                      <div>
                        <label className="form-label">Account</label>
                        <SearchableSelect ariaLabel="Account" value={form.fieldValues.accountId ?? ''} onChange={fv('accountId')}
                          options={(accounts ?? []).map((a: any) => ({ value: a.id, label: a.name }))} placeholder="— none —" />
                      </div>
                    </>
                  )}
                  {form.entityType === 'LEAD' && (
                    <>
                      <div>
                        <label className="form-label">Source</label>
                        <SearchableSelect ariaLabel="Source" value={form.fieldValues.source ?? ''} onChange={fv('source')}
                          options={SOURCES.map(s => ({ value: s, label: s }))} placeholder="— none —" />
                      </div>
                      <div>
                        <label className="form-label">Status</label>
                        <SearchableSelect ariaLabel="Status" value={form.fieldValues.status ?? ''} onChange={fv('status')}
                          options={LEAD_STATUSES.map(s => ({ value: s, label: s }))} placeholder="— none —" />
                      </div>
                      <div>
                        <label className="form-label">Notes boilerplate</label>
                        <textarea aria-label="Notes boilerplate" rows={3} className="ui-input" value={form.fieldValues.notes ?? ''}
                          onChange={e => fv('notes')(e.target.value)} />
                      </div>
                    </>
                  )}
                </div>
              </div>

              <CustomFieldsFormFields
                entityType={form.entityType}
                values={customValues}
                onChange={(key, value) => setCustomValues(p => ({ ...p, [key]: value }))}
              />
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={closeModal} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button
                disabled={!form.name || create.isPending || update.isPending}
                onClick={handleSubmit}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {create.isPending || update.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Reply Templates (ticket canned responses) ────────────────────────────────

function ReplyTemplatesTab() {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ReplyTemplate | null>(null);
  const [form, setForm] = useState({ name: '', body: '' });

  const { data: templates = [], isLoading } = useReplyTemplates();
  const create = useCreateReplyTemplate();
  const update = useUpdateReplyTemplate();
  const remove = useDeleteReplyTemplate();

  function openCreate() { setEditing(null); setForm({ name: '', body: '' }); setShowModal(true); }
  function openEdit(t: ReplyTemplate) { setEditing(t); setForm({ name: t.name, body: t.body }); setShowModal(true); }
  function closeModal() { setShowModal(false); setEditing(null); }
  function handleSubmit() {
    const mutation = editing ? update.mutateAsync({ id: editing.id, ...form }) : create.mutateAsync(form);
    // .catch() here just prevents an unhandled promise rejection when the
    // save fails (e.g. duplicate name) — the api client's response
    // interceptor already shows the user a toast with the server's error.
    // Without it the dialog correctly stays open (so the admin can fix the
    // conflicting field), but the rejection was otherwise unhandled.
    mutation.then(closeModal).catch(() => {});
  }

  return (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium">
          <Plus size={16} /> New Reply Template
        </button>
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        {isLoading ? (
          <div className="py-12 text-center text-gray-400">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <LayoutTemplate size={40} className="mx-auto mb-3 opacity-30" />
            <p>No canned responses yet.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm min-w-[500px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Preview</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {templates.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{t.name}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs truncate max-w-xs">{t.body}</td>
                    <td className="px-4 py-3">
                      <RowActions items={[
                        { label: 'Edit template', icon: <Pencil size={14} />, onClick: () => openEdit(t) },
                        { label: 'Delete template', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this template?')) remove.mutate(t.id); }, variant: 'danger' },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <h2 className="text-xl font-bold mb-4">{editing ? 'Edit Reply Template' : 'Create Reply Template'}</h2>
            <div className="space-y-4">
              <div>
                <label className="form-label">Name <span className="req">*</span></label>
                <input className="ui-input" aria-label="Name" placeholder="e.g. Password Reset Instructions" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Message <span className="req">*</span></label>
                <textarea className="ui-input" aria-label="Message" rows={6} placeholder="Hi there, thanks for reaching out…" value={form.body}
                  onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={closeModal} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button
                disabled={!form.name || !form.body || create.isPending || update.isPending}
                onClick={handleSubmit}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {create.isPending || update.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Email Templates (campaigns) ──────────────────────────────────────────────

function EmailTemplatesTab() {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [form, setForm] = useState({ name: '', subject: '', body: '' });

  const { data: templates = [], isLoading } = useEmailTemplates();
  const create = useCreateEmailTemplate();
  const update = useUpdateEmailTemplate();
  const remove = useDeleteEmailTemplate();

  function openCreate() { setEditing(null); setForm({ name: '', subject: '', body: '' }); setShowModal(true); }
  function openEdit(t: EmailTemplate) { setEditing(t); setForm({ name: t.name, subject: t.subject, body: t.body }); setShowModal(true); }
  function closeModal() { setShowModal(false); setEditing(null); }
  function handleSubmit() {
    const mutation = editing ? update.mutateAsync({ id: editing.id, ...form }) : create.mutateAsync(form);
    // .catch() here just prevents an unhandled promise rejection when the
    // save fails (e.g. duplicate name) — the api client's response
    // interceptor already shows the user a toast with the server's error.
    // Without it the dialog correctly stays open (so the admin can fix the
    // conflicting field), but the rejection was otherwise unhandled.
    mutation.then(closeModal).catch(() => {});
  }

  return (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium">
          <Plus size={16} /> New Email Template
        </button>
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        {isLoading ? (
          <div className="py-12 text-center text-gray-400">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <LayoutTemplate size={40} className="mx-auto mb-3 opacity-30" />
            <p>No email templates yet.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm min-w-[500px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Subject</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {templates.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{t.name}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs truncate max-w-xs">{t.subject}</td>
                    <td className="px-4 py-3">
                      <RowActions items={[
                        { label: 'Edit template', icon: <Pencil size={14} />, onClick: () => openEdit(t) },
                        { label: 'Delete template', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this template?')) remove.mutate(t.id); }, variant: 'danger' },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-xl font-bold mb-4">{editing ? 'Edit Email Template' : 'Create Email Template'}</h2>
            <div className="space-y-4">
              <div>
                <label className="form-label">Name <span className="req">*</span></label>
                <input className="ui-input" aria-label="Name" placeholder="e.g. Q1 Lead Nurture" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Subject <span className="req">*</span></label>
                <input className="ui-input" aria-label="Subject" placeholder="e.g. Exclusive offer just for you" value={form.subject}
                  onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Body <span className="req">*</span></label>
                <textarea className="ui-input" aria-label="Body" rows={8} placeholder="Write your email content here…" value={form.body}
                  onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={closeModal} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button
                disabled={!form.name || !form.subject || !form.body || create.isPending || update.isPending}
                onClick={handleSubmit}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {create.isPending || update.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Quote Templates ───────────────────────────────────────────────────────────

const QUOTE_EMPTY_LINE = { description: '', quantity: 1, unitPrice: 0 };

function QuoteTemplatesTab() {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<QuoteTemplate | null>(null);
  const [form, setForm] = useState({ name: '', description: '', lines: [{ ...QUOTE_EMPTY_LINE }] });

  const { data: templates = [], isLoading } = useQuoteTemplates();
  const create = useCreateQuoteTemplate();
  const update = useUpdateQuoteTemplate();
  const remove = useDeleteQuoteTemplate();

  function openCreate() { setEditing(null); setForm({ name: '', description: '', lines: [{ ...QUOTE_EMPTY_LINE }] }); setShowModal(true); }
  function openEdit(t: QuoteTemplate) {
    setEditing(t);
    setForm({ name: t.name, description: t.description ?? '', lines: t.lines.map(l => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })) });
    setShowModal(true);
  }
  function closeModal() { setShowModal(false); setEditing(null); }
  function handleSubmit() {
    const body = { name: form.name, description: form.description || undefined, lines: form.lines };
    const mutation = editing ? update.mutateAsync({ id: editing.id, ...body }) : create.mutateAsync(body);
    // .catch() here just prevents an unhandled promise rejection when the
    // save fails (e.g. duplicate name) — the api client's response
    // interceptor already shows the user a toast with the server's error.
    // Without it the dialog correctly stays open (so the admin can fix the
    // conflicting field), but the rejection was otherwise unhandled.
    mutation.then(closeModal).catch(() => {});
  }
  function updateLine(i: number, field: string, value: string | number) {
    setForm(f => { const lines = [...f.lines]; lines[i] = { ...lines[i], [field]: value }; return { ...f, lines }; });
  }
  function addLine() { setForm(f => ({ ...f, lines: [...f.lines, { ...QUOTE_EMPTY_LINE }] })); }
  function removeLine(i: number) { setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) })); }

  return (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium">
          <Plus size={16} /> New Quote Template
        </button>
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        {isLoading ? (
          <div className="py-12 text-center text-gray-400">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <LayoutTemplate size={40} className="mx-auto mb-3 opacity-30" />
            <p>No quote templates yet.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm min-w-[500px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Line Items</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {templates.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{t.name}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{t.lines.length} item{t.lines.length === 1 ? '' : 's'}</td>
                    <td className="px-4 py-3">
                      <RowActions items={[
                        { label: 'Edit template', icon: <Pencil size={14} />, onClick: () => openEdit(t) },
                        { label: 'Delete template', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this template?')) remove.mutate(t.id); }, variant: 'danger' },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-xl font-bold mb-4">{editing ? 'Edit Quote Template' : 'Create Quote Template'}</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Name <span className="req">*</span></label>
                  <input className="ui-input" aria-label="Name" placeholder="e.g. Standard Support Package" value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <label className="form-label">Description</label>
                  <input className="ui-input" aria-label="Template Description" value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
              <div className="form-section">
                <p className="form-section-title">Line Items</p>
                <div className="space-y-2">
                  <div className="grid grid-cols-12 gap-2 text-xs font-semibold text-gray-500 uppercase px-1">
                    <div className="col-span-6">Description</div>
                    <div className="col-span-2">Qty</div>
                    <div className="col-span-3">Unit Price</div>
                    <div className="col-span-1"></div>
                  </div>
                  {form.lines.map((line, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2">
                      <input className="col-span-6 border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
                        aria-label="Description" placeholder="Service description" value={line.description}
                        onChange={e => updateLine(i, 'description', e.target.value)} />
                      <input type="number" min="1" aria-label="Qty" className="col-span-2 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center"
                        value={line.quantity} onChange={e => updateLine(i, 'quantity', Number(e.target.value))} />
                      <input type="number" min="0" step="0.01" className="col-span-3 border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
                        aria-label="Price" placeholder="0.00" value={line.unitPrice}
                        onChange={e => updateLine(i, 'unitPrice', Number(e.target.value))} />
                      <button onClick={() => removeLine(i)} disabled={form.lines.length === 1}
                        className="col-span-1 p-1 text-gray-300 hover:text-red-500 disabled:opacity-0">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button onClick={addLine} className="text-sm text-brand-600 hover:underline flex items-center gap-1 mt-1">
                    <Plus size={14} /> Add line
                  </button>
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={closeModal} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button
                disabled={!form.name || form.lines.length === 0 || create.isPending || update.isPending}
                onClick={handleSubmit}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {create.isPending || update.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function TemplatesPage() {
  const [tab, setTab] = useState<TopTab>('Records');

  return (
    <div className="p-6 max-w-4xl mx-auto animate-slide-up">
      <div className="flex items-center gap-3 mb-6">
        <LayoutTemplate size={24} className="text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Templates</h1>
          <p className="text-sm text-gray-500">Speed up record creation, ticket replies, campaigns, and quotes</p>
        </div>
      </div>

      <div role="tablist" className="flex gap-2 mb-6 border-b border-gray-100 pb-3">
        {TOP_TABS.map(t => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${tab === t ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Records' && <RecordTemplatesTab />}
      {tab === 'Replies' && <ReplyTemplatesTab />}
      {tab === 'Emails' && <EmailTemplatesTab />}
      {tab === 'Quotes' && <QuoteTemplatesTab />}
    </div>
  );
}
