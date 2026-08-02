import { useState, useEffect } from 'react';
import { Layers, Plus, Trash2, Pencil, RefreshCw, CheckCircle2, XCircle, Clock, Zap } from 'lucide-react';
import {
  useCustomModules, useCustomModule, useCreateCustomModule, useDeleteCustomModule,
  useAddModuleField, useUpdateModuleField, useRemoveModuleField,
  useModuleRecords, useCreateModuleRecord, useUpdateModuleRecord, useDeleteModuleRecord,
  useSyncConfig, useSaveSyncConfig, useTriggerSync,
} from '../api/customModules';
import { PageHeader, Button, Modal, Spinner, EmptyState, SearchableSelect, RowActions } from '../shared/components';

const FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'CURRENCY', 'DATE', 'BOOLEAN', 'DROPDOWN', 'EMAIL', 'PHONE', 'URL'];
const TYPE_LABELS: Record<string, string> = {
  TEXT: 'Text', TEXTAREA: 'Long Text', NUMBER: 'Number', CURRENCY: 'Currency', DATE: 'Date',
  BOOLEAN: 'Yes/No', DROPDOWN: 'Dropdown', EMAIL: 'Email', PHONE: 'Phone', URL: 'URL',
};

function CreateModuleModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const create = useCreateCustomModule();
  const [form, setForm] = useState({ name: '', icon: 'Layers', description: '' });
  return (
    <Modal open={open} onClose={onClose} title="New Custom Module">
      <form
        className="space-y-4"
        onSubmit={async e => {
          e.preventDefault();
          const created = await create.mutateAsync(form);
          setForm({ name: '', icon: 'Layers', description: '' });
          onCreated(created.id);
        }}
      >
        <div>
          <label className="form-label">Module Name <span className="req">*</span></label>
          <input aria-label="Module Name" required className="ui-input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Warranty Claims" />
        </div>
        <div>
          <label className="form-label">Description</label>
          <textarea aria-label="Description" className="ui-input" rows={2} value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="What is this module for?" />
        </div>
        <p className="text-xs text-gray-400">You'll add fields to it on the next screen — nothing shows up for other users until you add at least one field.</p>
        <div className="flex justify-end pt-1"><Button type="submit" loading={create.isPending}>Create Module</Button></div>
      </form>
    </Modal>
  );
}

function FieldFormModal({ moduleId, field, onClose }: { moduleId: string; field: any | null; onClose: () => void }) {
  const add = useAddModuleField();
  const update = useUpdateModuleField();
  const [form, setForm] = useState(field
    ? { label: field.label, fieldType: field.fieldType, required: field.required, isPrimary: field.isPrimary, options: (field.options ?? []).join(', ') }
    : { label: '', fieldType: 'TEXT', required: false, isPrimary: false, options: '' });
  const loading = add.isPending || update.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload: any = {
      label: form.label,
      fieldType: form.fieldType,
      required: form.required,
      isPrimary: form.isPrimary,
      options: form.fieldType === 'DROPDOWN' ? form.options.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    };
    if (field) await update.mutateAsync({ moduleId, fieldId: field.id, ...payload });
    else await add.mutateAsync({ moduleId, ...payload });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={field ? 'Edit Field' : 'Add Field'}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="form-label">Label <span className="req">*</span></label>
          <input aria-label="Field Label" required className="ui-input" value={form.label} onChange={e => setForm(p => ({ ...p, label: e.target.value }))} placeholder="e.g. Claim Amount" />
        </div>
        <div>
          <label className="form-label">Type</label>
          <SearchableSelect ariaLabel="Field Type" value={form.fieldType} onChange={val => setForm(p => ({ ...p, fieldType: val }))} required options={FIELD_TYPES.map(t => ({ value: t, label: TYPE_LABELS[t] }))} />
        </div>
        {form.fieldType === 'DROPDOWN' && (
          <div>
            <label className="form-label">Options</label>
            <input aria-label="Dropdown Options" className="ui-input" value={form.options} onChange={e => setForm(p => ({ ...p, options: e.target.value }))} placeholder="Option A, Option B, Option C" />
            <p className="form-hint">Comma-separated</p>
          </div>
        )}
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={form.required} onChange={e => setForm(p => ({ ...p, required: e.target.checked }))} className="rounded" /> Required
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={form.isPrimary} onChange={e => setForm(p => ({ ...p, isPrimary: e.target.checked }))} className="rounded" /> Use as record title
          </label>
        </div>
        <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>{field ? 'Save Changes' : 'Add Field'}</Button></div>
      </form>
    </Modal>
  );
}

function FieldsTab({ module_ }: { module_: any }) {
  const removeField = useRemoveModuleField();
  const [fieldModal, setFieldModal] = useState<null | 'new' | any>(null);
  const fields = module_.fields ?? [];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setFieldModal('new')}>Add Field</Button>
      </div>
      {fields.length === 0 ? (
        <EmptyState icon={<Layers size={22} />} title="No fields yet" description="Add fields to define this module's shape" />
      ) : (
        <div className="table-container">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Label</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Key</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Required</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Title Field</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fields.map((f: any) => (
                <tr key={f.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{f.label}</td>
                  <td className="px-4 py-3"><code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{f.fieldKey}</code></td>
                  <td className="px-4 py-3"><span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">{TYPE_LABELS[f.fieldType] ?? f.fieldType}</span></td>
                  <td className="px-4 py-3">{f.required ? <span className="text-green-600 font-medium">Yes</span> : <span className="text-gray-400">No</span>}</td>
                  <td className="px-4 py-3">{f.isPrimary ? <CheckCircle2 size={14} className="text-brand-500" /> : <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-3">
                    <RowActions items={[
                      { label: 'Edit field', icon: <Pencil size={14} />, onClick: () => setFieldModal(f) },
                      { label: 'Delete field', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this field? Existing record data for it is kept but hidden.')) removeField.mutate({ moduleId: module_.id, fieldId: f.id }); }, variant: 'danger' },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fieldModal && <FieldFormModal moduleId={module_.id} field={fieldModal === 'new' ? null : fieldModal} onClose={() => setFieldModal(null)} />}
    </div>
  );
}

function RecordFieldInput({ field, value, onChange }: { field: any; value: any; onChange: (v: any) => void }) {
  const label = field.label;
  if (field.fieldType === 'BOOLEAN') {
    return <label className="flex items-center gap-2 text-sm cursor-pointer select-none"><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} className="rounded" /> {label}</label>;
  }
  if (field.fieldType === 'DROPDOWN') {
    return <SearchableSelect ariaLabel={label} value={value ?? ''} onChange={onChange} options={(field.options ?? []).map((o: string) => ({ value: o, label: o }))} placeholder={`Select ${label}…`} />;
  }
  if (field.fieldType === 'DATE') {
    return <input aria-label={label} type="date" className="ui-input" value={value ? String(value).slice(0, 10) : ''} onChange={e => onChange(e.target.value)} />;
  }
  if (field.fieldType === 'NUMBER' || field.fieldType === 'CURRENCY') {
    return <input aria-label={label} type="number" className="ui-input" value={value ?? ''} onChange={e => onChange(e.target.value)} />;
  }
  if (field.fieldType === 'TEXTAREA') {
    return <textarea aria-label={label} className="ui-input" rows={2} value={value ?? ''} onChange={e => onChange(e.target.value)} />;
  }
  return <input aria-label={label} type={field.fieldType === 'EMAIL' ? 'email' : 'text'} className="ui-input" value={value ?? ''} onChange={e => onChange(e.target.value)} />;
}

function RecordFormModal({ module_, record, onClose }: { module_: any; record: any | null; onClose: () => void }) {
  const create = useCreateModuleRecord();
  const update = useUpdateModuleRecord();
  const [data, setData] = useState<Record<string, unknown>>(record?.data ?? {});
  const loading = create.isPending || update.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (record) await update.mutateAsync({ moduleId: module_.id, recordId: record.id, data });
    else await create.mutateAsync({ moduleId: module_.id, data });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={record ? 'Edit Record' : `New ${module_.name} Record`}>
      <form onSubmit={submit} className="space-y-4">
        {(module_.fields ?? []).map((f: any) => (
          <div key={f.id}>
            {f.fieldType !== 'BOOLEAN' && <label className="form-label">{f.label}{f.required && <span className="req"> *</span>}</label>}
            <RecordFieldInput field={f} value={data[f.fieldKey]} onChange={v => setData(p => ({ ...p, [f.fieldKey]: v }))} />
          </div>
        ))}
        <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>{record ? 'Save Changes' : 'Create Record'}</Button></div>
      </form>
    </Modal>
  );
}

function RecordsTab({ module_ }: { module_: any }) {
  const { data: records, isLoading } = useModuleRecords(module_.id);
  const deleteRecord = useDeleteModuleRecord();
  const [recordModal, setRecordModal] = useState<null | 'new' | any>(null);
  const fields = (module_.fields ?? []).slice(0, 5); // keep the table readable — full record shown in the edit modal

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setRecordModal('new')} disabled={!module_.fields?.length}>Add Record</Button>
      </div>
      {!module_.fields?.length ? (
        <EmptyState icon={<Layers size={22} />} title="Add fields first" description="Define at least one field before creating records" />
      ) : isLoading ? <Spinner /> : !records?.data?.length ? (
        <EmptyState icon={<Layers size={22} />} title="No records yet" description="Add one manually, or connect a sync in the Sync tab" />
      ) : (
        <div className="table-container">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {fields.map((f: any) => <th key={f.id} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{f.label}</th>)}
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {records.data.map((r: any) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  {fields.map((f: any) => (
                    <td key={f.id} className="px-4 py-3 text-gray-700">
                      {f.fieldType === 'BOOLEAN' ? (r.data[f.fieldKey] ? 'Yes' : 'No') : String(r.data[f.fieldKey] ?? '—')}
                    </td>
                  ))}
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${r.source === 'SYNC' ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-500'}`}>{r.source}</span>
                  </td>
                  <td className="px-4 py-3">
                    <RowActions items={[
                      { label: 'Edit record', icon: <Pencil size={14} />, onClick: () => setRecordModal(r) },
                      { label: 'Delete record', icon: <Trash2 size={14} />, onClick: () => deleteRecord.mutate({ moduleId: module_.id, recordId: r.id }), variant: 'danger' },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {recordModal && <RecordFormModal module_={module_} record={recordModal === 'new' ? null : recordModal} onClose={() => setRecordModal(null)} />}
    </div>
  );
}

function SyncTab({ module_ }: { module_: any }) {
  const { data: config, isLoading } = useSyncConfig(module_.id);
  const save = useSaveSyncConfig();
  const trigger = useTriggerSync();
  const fields = module_.fields ?? [];

  const [form, setForm] = useState({
    url: '', method: 'GET', authType: 'NONE', authHeaderName: '', authValue: '',
    pollIntervalMin: 15, recordPath: '', externalIdField: '',
    fieldMapping: {} as Record<string, string>,
  });

  useEffect(() => {
    if (config) {
      setForm({
        url: config.url, method: config.method, authType: config.authType,
        authHeaderName: config.authHeaderName ?? '', authValue: '', // never echo back a stored secret
        pollIntervalMin: config.pollIntervalMin, recordPath: config.recordPath ?? '', externalIdField: config.externalIdField ?? '',
        fieldMapping: config.fieldMapping ?? {},
      });
    }
  }, [config?.id]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload: any = { ...form, pollIntervalMin: Number(form.pollIntervalMin) };
    if (!payload.authValue) delete payload.authValue; // keep existing secret if left blank
    save.mutate({ moduleId: module_.id, ...payload });
  }

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 text-xs text-indigo-700 leading-relaxed">
        Polls an external REST API on a schedule, validates each record against this module's fields, and upserts it —
        deduped on the field you pick as the external ID (if any). Runs automatically once saved; use "Sync now" to test immediately.
      </div>

      {config && (
        <div className="flex flex-wrap items-center gap-3 border border-gray-200 rounded-xl p-3">
          <div className="flex items-center gap-1.5 text-sm">
            {config.lastStatus === 'SUCCESS' ? <CheckCircle2 size={15} className="text-green-500" /> : config.lastStatus === 'FAILED' ? <XCircle size={15} className="text-red-500" /> : <Clock size={15} className="text-gray-300" />}
            <span className="font-medium text-gray-700">{config.lastStatus ? `Last sync: ${config.lastStatus}` : 'Never synced'}</span>
          </div>
          {config.lastSyncAt && <span className="text-xs text-gray-400">{new Date(config.lastSyncAt).toLocaleString()}</span>}
          {config.lastRecordCount != null && <span className="text-xs text-gray-400">· {config.lastRecordCount} record(s)</span>}
          {config.lastError && <span className="text-xs text-red-500">· {config.lastError}</span>}
          <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={() => trigger.mutate(module_.id)} loading={trigger.isPending} className="ml-auto">Sync Now</Button>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="form-label">API URL <span className="req">*</span></label>
          <input aria-label="API URL" required type="url" className="ui-input" value={form.url} onChange={e => setForm(p => ({ ...p, url: e.target.value }))} placeholder="https://api.example.com/records" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="form-label">Method</label>
            <SearchableSelect ariaLabel="Method" value={form.method} onChange={val => setForm(p => ({ ...p, method: val }))} options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} />
          </div>
          <div>
            <label className="form-label">Poll every (minutes)</label>
            <input aria-label="Poll interval" type="number" min={1} max={1440} className="ui-input" value={form.pollIntervalMin} onChange={e => setForm(p => ({ ...p, pollIntervalMin: Number(e.target.value) }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="form-label">Auth Type</label>
            <SearchableSelect ariaLabel="Auth Type" value={form.authType} onChange={val => setForm(p => ({ ...p, authType: val }))} options={[{ value: 'NONE', label: 'None' }, { value: 'API_KEY', label: 'API Key Header' }, { value: 'BEARER', label: 'Bearer Token' }]} />
          </div>
          {form.authType === 'API_KEY' && (
            <div>
              <label className="form-label">Header Name</label>
              <input aria-label="Auth Header Name" className="ui-input" value={form.authHeaderName} onChange={e => setForm(p => ({ ...p, authHeaderName: e.target.value }))} placeholder="X-API-Key" />
            </div>
          )}
        </div>
        {form.authType !== 'NONE' && (
          <div>
            <label className="form-label">{form.authType === 'BEARER' ? 'Bearer Token' : 'API Key Value'}</label>
            <input aria-label="Auth Value" type="password" className="ui-input" value={form.authValue} onChange={e => setForm(p => ({ ...p, authValue: e.target.value }))} placeholder={config ? 'Leave blank to keep existing' : ''} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="form-label">Record Path</label>
            <input aria-label="Record Path" className="ui-input" value={form.recordPath} onChange={e => setForm(p => ({ ...p, recordPath: e.target.value }))} placeholder="e.g. data.items (blank = response is the array)" />
          </div>
          <div>
            <label className="form-label">External ID Field</label>
            <input aria-label="External ID Field" className="ui-input" value={form.externalIdField} onChange={e => setForm(p => ({ ...p, externalIdField: e.target.value }))} placeholder="e.g. id (blank = never dedupe)" />
          </div>
        </div>

        <div className="form-section">
          <p className="form-section-title">Field Mapping</p>
          <p className="text-xs text-gray-400 mb-2">For each module field, the key to read from each external record.</p>
          <div className="space-y-2">
            {fields.map((f: any) => (
              <div key={f.id} className="flex items-center gap-2">
                <span className="text-sm text-gray-600 w-40 flex-shrink-0 truncate">{f.label}</span>
                <input
                  aria-label={`Mapping for ${f.label}`}
                  className="ui-input flex-1"
                  value={form.fieldMapping[f.fieldKey] ?? ''}
                  onChange={e => setForm(p => ({ ...p, fieldMapping: { ...p.fieldMapping, [f.fieldKey]: e.target.value } }))}
                  placeholder={`external.${f.fieldKey}`}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end pt-1"><Button type="submit" loading={save.isPending}>Save Sync Config</Button></div>
      </form>
    </div>
  );
}

export default function CustomModulesPage() {
  const { data: modules, isLoading } = useCustomModules();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: module_ } = useCustomModule(selectedId ?? undefined);
  const deleteModule = useDeleteCustomModule();
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState<'fields' | 'records' | 'sync'>('records');

  useEffect(() => {
    if (!selectedId && modules?.length) setSelectedId(modules[0].id);
  }, [modules, selectedId]);

  return (
    <div className="p-4 sm:p-6 h-full flex flex-col animate-slide-up">
      <PageHeader
        title="Custom Modules"
        subtitle="Build your own objects — fields, records, and real-time API sync"
        actions={<Button icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New Module</Button>}
      />

      {isLoading ? <Spinner /> : !modules?.length ? (
        <EmptyState icon={<Layers size={24} />} title="No custom modules yet" description="Create your first module to model data that doesn't fit CRM/IT Desk out of the box" action={{ label: 'New Module', onClick: () => setCreateOpen(true) }} />
      ) : (
        <div className="flex gap-4 flex-1 min-h-0">
          <div className="w-60 flex-shrink-0 bg-white border border-gray-100 rounded-xl overflow-y-auto p-2 space-y-1">
            {modules.map((m: any) => (
              <button
                key={m.id}
                onClick={() => setSelectedId(m.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between gap-2 group ${selectedId === m.id ? 'bg-brand-50 text-brand-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                <span className="truncate">{m.name}</span>
                <span className="flex items-center gap-1 flex-shrink-0">
                  {m.syncConfig?.isActive && <Zap size={11} className="text-indigo-400" title="Sync enabled" />}
                  <span className="text-xs text-gray-400">{m._count?.records ?? 0}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0 bg-white border border-gray-100 rounded-xl p-4 overflow-y-auto">
            {!module_ ? <Spinner /> : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="font-semibold text-gray-900">{module_.name}</h2>
                    {module_.description && <p className="text-xs text-gray-400">{module_.description}</p>}
                  </div>
                  <button
                    onClick={() => { if (confirm(`Delete "${module_.name}" and all its records? This can't be undone.`)) { deleteModule.mutate(module_.id); setSelectedId(null); } }}
                    className="p-1.5 text-gray-300 hover:text-red-500"
                  ><Trash2 size={15} /></button>
                </div>
                <div role="tablist" className="flex gap-2 mb-4">
                  {(['records', 'fields', 'sync'] as const).map(t => (
                    <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                      className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors capitalize ${tab === t ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                      {t}
                    </button>
                  ))}
                </div>
                {tab === 'fields' && <FieldsTab module_={module_} />}
                {tab === 'records' && <RecordsTab module_={module_} />}
                {tab === 'sync' && <SyncTab module_={module_} />}
              </>
            )}
          </div>
        </div>
      )}

      <CreateModuleModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={id => { setSelectedId(id); setCreateOpen(false); setTab('fields'); }} />
    </div>
  );
}
