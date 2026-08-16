import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Settings2, Plus, Pencil, Trash2 } from 'lucide-react';
import { SearchableSelect, RowActions } from '../shared/components';

interface CustomField {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: string;
  entityType: string;
  required: boolean;
  options: string[] | null;
}

const FIELD_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'TEXTAREA', 'REFERENCE'];
const ENTITY_TYPES = ['TICKET', 'CONTACT', 'DEAL', 'LEAD'];

const TYPE_LABELS: Record<string, string> = {
  TEXT: 'Text', NUMBER: 'Number', DATE: 'Date', BOOLEAN: 'Yes/No', SELECT: 'Dropdown', TEXTAREA: 'Long Text',
  // Always resolves to a Contact today — see CustomFieldsFormFields.tsx's
  // picker and CustomFieldsDisplay.tsx's name lookup for the REFERENCE case.
  REFERENCE: 'Reference (Contact)',
};

const EMPTY_FORM = { fieldKey: '', label: '', fieldType: 'TEXT', entityType: 'TICKET', required: false, options: '' };

export default function CustomFieldsPage() {
  const qc = useQueryClient();
  const [entityType, setEntityType] = useState('TICKET');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: fields = [], isLoading } = useQuery<CustomField[]>({
    queryKey: ['custom-fields', entityType],
    queryFn: () => api.get(`/custom-fields?entityType=${entityType}`).then(r => Array.isArray(r.data) ? r.data : (r.data.data ?? [])),
  });

  const save = useMutation({
    mutationFn: (body: object) =>
      editing
        ? api.patch(`/custom-fields/${editing.id}`, body).then(r => r.data)
        : api.post('/custom-fields', body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-fields'] });
      closeModal();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/custom-fields/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-fields'] }),
  });

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM, entityType });
    setShowModal(true);
  }

  function openEdit(f: CustomField) {
    setEditing(f);
    setForm({ fieldKey: f.fieldKey, label: f.label, fieldType: f.fieldType, entityType: f.entityType, required: f.required, options: (f.options ?? []).join(', ') });
    setShowModal(true);
  }

  function closeModal() { setShowModal(false); setEditing(null); }

  function handleSubmit() {
    const body = {
      ...form,
      options: form.fieldType === 'SELECT' ? form.options.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    };
    save.mutate(body);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto animate-slide-up">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Settings2 size={24} className="text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Custom Fields</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Add extra fields to tickets, contacts, deals, and leads</p>
          </div>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium">
          <Plus size={16} /> Add Field
        </button>
      </div>

      {/* Entity type tabs */}
      <div role="tablist" className="flex gap-2 mb-4">
        {ENTITY_TYPES.map(t => (
          <button
            key={t}
            role="tab"
            aria-selected={entityType === t}
            onClick={() => setEntityType(t)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${entityType === t ? 'bg-brand-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
          >
            {t[0] + t.slice(1).toLowerCase()}s
          </button>
        ))}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        {isLoading ? (
          <div className="py-12 text-center text-gray-400 dark:text-gray-500">Loading…</div>
        ) : fields.length === 0 ? (
          <div className="py-16 text-center text-gray-400 dark:text-gray-500">
            <Settings2 size={40} className="mx-auto mb-3 opacity-30" />
            <p>No custom fields for {entityType.toLowerCase()}s yet.</p>
          </div>
        ) : (
          <div className="table-container">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Label</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">API Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide hidden sm:table-cell">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide hidden sm:table-cell">Required</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Options</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {fields.map(f => (
                <tr key={f.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{f.label}</td>
                  <td className="px-4 py-3"><code className="text-xs bg-gray-100 dark:bg-gray-800 dark:text-gray-300 px-1.5 py-0.5 rounded">{f.fieldKey}</code></td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className="px-2 py-0.5 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 rounded text-xs font-medium">{TYPE_LABELS[f.fieldType] ?? f.fieldType}</span>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    {f.required ? <span className="text-green-600 dark:text-green-400 font-medium">Yes</span> : <span className="text-gray-400 dark:text-gray-500">No</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                    {f.options?.join(', ') ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
<RowActions items={[
                        { label: 'Edit field', icon: <Pencil size={14} />, onClick: () => openEdit(f) },
                        { label: 'Delete field', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this field?')) remove.mutate(f.id); }, variant: 'danger' },
                      ]} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">{editing ? 'Edit Field' : 'Create Custom Field'}</h2>
            <div className="space-y-3">
              <div className="form-section">
                <p className="form-section-title">Field Identity</p>
                <div className="space-y-4">
                  <div>
                    <label className="form-label">Label <span className="req">*</span></label>
                    <input className="ui-input" aria-label="Label" placeholder="e.g. Customer Type" value={form.label}
                      onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">API Name <span className="req">*</span></label>
                    <input className="ui-input" aria-label="API Name" placeholder="e.g. customer_type" value={form.fieldKey}
                      onChange={e => setForm(f => ({ ...f, fieldKey: e.target.value }))} />
                    <p className="form-hint">Lowercase letters, numbers, and underscores only</p>
                  </div>
                </div>
              </div>
              <div className="form-section">
                <p className="form-section-title">Configuration</p>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="form-label">Type</label>
<SearchableSelect ariaLabel="Type" value={form.fieldType} onChange={val => setForm(f => ({ ...f, fieldType: val }))} required options={FIELD_TYPES.map(t => ({ value: t, label: TYPE_LABELS[t] }))} />
                    </div>
                    <div>
                      <label className="form-label">Entity</label>
<SearchableSelect ariaLabel="Entity" value={form.entityType} onChange={val => setForm(f => ({ ...f, entityType: val }))} required options={ENTITY_TYPES.map(t => ({ value: t, label: t[0] + t.slice(1).toLowerCase() + 's' }))} />
                    </div>
                  </div>
                  {form.fieldType === 'SELECT' && (
                    <div>
                      <label className="form-label">Options</label>
                      <input className="ui-input" placeholder="Option A, Option B, Option C" value={form.options}
                        onChange={e => setForm(f => ({ ...f, options: e.target.value }))} />
                      <p className="form-hint">Separate options with commas</p>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none text-gray-700 dark:text-gray-300">
                    <input type="checkbox" checked={form.required} onChange={e => setForm(f => ({ ...f, required: e.target.checked }))} className="rounded" />
                    Mark as required field
                  </label>
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={closeModal} className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
              <button
                disabled={!form.fieldKey || !form.label || save.isPending}
                onClick={handleSubmit}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {save.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Field'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
