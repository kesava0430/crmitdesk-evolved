import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Layers, Plus, Trash2, Pencil, RefreshCw, CheckCircle2, XCircle, Clock, Zap, Sparkles, FileEdit } from 'lucide-react';
import {
  useCustomModules, useCustomModule, useCreateCustomModule, useUpdateCustomModule, useDeleteCustomModule,
  useAddModuleField, useUpdateModuleField, useRemoveModuleField,
  useSyncConfig, useSaveSyncConfig, useTriggerSync, useModuleTemplates,
} from '../api/customModules';
import {
  PageHeader, PageBody, Button, Modal, EmptyState, SearchableSelect, RowActions,
  Card, Tabs, Field, Input, Textarea, Select, Checkbox, IconButton, FormGrid, FormActions,
  DataTable, Badge, Alert, type Column,
} from '../shared/components';
import { CustomModuleRecordsTab } from '../shared/components/CustomModuleRecords';
import { useFormat } from '../hooks/useFormat';

const FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'CURRENCY', 'DATE', 'BOOLEAN', 'DROPDOWN', 'EMAIL', 'PHONE', 'URL'];
const TYPE_LABELS: Record<string, string> = {
  TEXT: 'Text', TEXTAREA: 'Long Text', NUMBER: 'Number', CURRENCY: 'Currency', DATE: 'Date',
  BOOLEAN: 'Yes/No', DROPDOWN: 'Dropdown', EMAIL: 'Email', PHONE: 'Phone', URL: 'URL',
};

// Matches AppLayout.tsx's NAV_SECTIONS labels exactly — kept as a small
// lookup here (rather than importing from AppLayout, a layout component
// with its own heavy nav/auth dependencies) since it's just display text for
// the picker.
const NAV_SECTION_OPTIONS = [
  { value: 'CRM', label: 'CRM' },
  { value: 'IT_DESK', label: 'IT Desk' },
  { value: 'HR', label: 'HR' },
  { value: 'ADMIN', label: 'Admin' },
];

const CREATE_DEFAULT = { name: '', icon: 'Layers', description: '', navSection: 'CRM', templateId: undefined as string | undefined };

/** One selectable starting-point tile in the create-module dialog. */
function TemplateChoice({ selected, icon, title, hint, onClick }: {
  selected: boolean; icon: React.ReactNode; title: string; hint: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`text-left p-3 rounded-card border text-sm transition-colors ${
        selected ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-hover'
      }`}
    >
      <span className="flex items-center gap-1.5 font-medium text-fg">{icon} {title}</span>
      <span className="block text-xs text-fg-subtle mt-0.5">{hint}</span>
    </button>
  );
}

function CreateModuleModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const create = useCreateCustomModule();
  const { data: templates } = useModuleTemplates();
  const [form, setForm] = useState(CREATE_DEFAULT);

  function pickTemplate(t: any | null) {
    if (!t) { setForm(CREATE_DEFAULT); return; }
    setForm({ name: t.name, icon: t.icon, description: t.description, navSection: t.navSection, templateId: t.id });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const created = await create.mutateAsync(form);
    setForm(CREATE_DEFAULT);
    onCreated(created.id);
  }

  return (
    <Modal open={open} onClose={() => { setForm(CREATE_DEFAULT); onClose(); }} title="New Custom Module">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Start from a template">
          <div className="grid grid-cols-2 gap-2">
            <TemplateChoice
              selected={!form.templateId}
              icon={<FileEdit size={14} />}
              title="Start from scratch"
              hint="Add your own fields afterward"
              onClick={() => pickTemplate(null)}
            />
            {(templates ?? []).map((t: any) => (
              <TemplateChoice
                key={t.id}
                selected={form.templateId === t.id}
                icon={<Sparkles size={14} />}
                title={t.name}
                hint={`${t.fieldCount} pre-built field${t.fieldCount === 1 ? '' : 's'}`}
                onClick={() => pickTemplate(t)}
              />
            ))}
          </div>
        </Field>
        <Field label="Module Name" required>
          <Input aria-label="Module Name" required value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Warranty Claims" />
        </Field>
        <Field label="Description">
          <Textarea aria-label="Description" rows={2} value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="What is this module for?" />
        </Field>
        <Field
          label="Sidebar section"
          hint="Which part of the sidebar this module's link appears under, once it has at least one field."
        >
          <Select aria-label="Sidebar section" value={form.navSection} onChange={e => setForm(p => ({ ...p, navSection: e.target.value }))}
            options={NAV_SECTION_OPTIONS} />
        </Field>
        {!form.templateId && (
          <p className="form-hint">You'll add fields to it on the next screen — nothing shows up for other users until you add at least one field.</p>
        )}
        <FormActions><Button type="submit" loading={create.isPending}>Create Module</Button></FormActions>
      </form>
    </Modal>
  );
}

function EditModuleModal({ module_, onClose }: { module_: any; onClose: () => void }) {
  const update = useUpdateCustomModule();
  const [form, setForm] = useState({ name: module_.name, description: module_.description ?? '', navSection: module_.navSection ?? 'CRM' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await update.mutateAsync({ id: module_.id, ...form });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Edit Module">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Module Name" required>
          <Input aria-label="Module Name" required value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
        </Field>
        <Field label="Description">
          <Textarea aria-label="Description" rows={2} value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
        </Field>
        <Field label="Sidebar section">
          <Select aria-label="Sidebar section" value={form.navSection} onChange={e => setForm(p => ({ ...p, navSection: e.target.value }))}
            options={NAV_SECTION_OPTIONS} />
        </Field>
        <FormActions><Button type="submit" loading={update.isPending}>Save Changes</Button></FormActions>
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
      options: form.fieldType === 'DROPDOWN' ? form.options.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
    };
    if (field) await update.mutateAsync({ moduleId, fieldId: field.id, ...payload });
    else await add.mutateAsync({ moduleId, ...payload });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={field ? 'Edit Field' : 'Add Field'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Label" required>
          <Input aria-label="Field Label" required value={form.label} onChange={e => setForm(p => ({ ...p, label: e.target.value }))} placeholder="e.g. Claim Amount" />
        </Field>
        <Field label="Type">
          <SearchableSelect ariaLabel="Field Type" value={form.fieldType} onChange={val => setForm(p => ({ ...p, fieldType: val }))} required options={FIELD_TYPES.map(t => ({ value: t, label: TYPE_LABELS[t] }))} />
        </Field>
        {form.fieldType === 'DROPDOWN' && (
          <Field label="Options" hint="Comma-separated">
            <Input aria-label="Dropdown Options" value={form.options} onChange={e => setForm(p => ({ ...p, options: e.target.value }))} placeholder="Option A, Option B, Option C" />
          </Field>
        )}
        <div className="flex flex-wrap gap-4">
          <Checkbox label="Required" checked={form.required} onChange={e => setForm(p => ({ ...p, required: e.target.checked }))} />
          <Checkbox label="Use as record title" checked={form.isPrimary} onChange={e => setForm(p => ({ ...p, isPrimary: e.target.checked }))} />
        </div>
        <FormActions><Button type="submit" loading={loading}>{field ? 'Save Changes' : 'Add Field'}</Button></FormActions>
      </form>
    </Modal>
  );
}

function FieldsTab({ module_ }: { module_: any }) {
  const removeField = useRemoveModuleField();
  const [fieldModal, setFieldModal] = useState<null | 'new' | any>(null);
  const fields = module_.fields ?? [];

  const columns: Column<any>[] = [
    { key: 'label', header: 'Label', cell: f => <span className="font-medium text-fg">{f.label}</span> },
    { key: 'key', header: 'Key', cell: f => <code className="text-xs font-mono bg-surface-sunken text-fg px-1.5 py-0.5 rounded-badge" title={f.fieldKey}>{f.fieldKey}</code> },
    { key: 'type', header: 'Type', cell: f => <Badge variant="blue">{TYPE_LABELS[f.fieldType] ?? f.fieldType}</Badge> },
    {
      key: 'required', header: 'Required',
      cell: f => f.required ? <span className="text-success font-medium">Yes</span> : <span className="text-fg-subtle">No</span>,
    },
    {
      key: 'primary', header: 'Title Field',
      cell: f => f.isPrimary ? <CheckCircle2 size={14} className="text-accent" /> : <span className="text-fg-subtle">—</span>,
    },
    {
      key: 'actions', header: '', width: 56,
      cell: f => (
        <RowActions items={[
          { label: 'Edit field', icon: <Pencil size={14} />, onClick: () => setFieldModal(f) },
          { label: 'Delete field', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this field? Existing record data for it is kept but hidden.')) removeField.mutate({ moduleId: module_.id, fieldId: f.id }); }, variant: 'danger' },
        ]} />
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setFieldModal('new')}>Add Field</Button>
      </div>
      <DataTable
        columns={columns}
        rows={fields}
        rowKey={(f: any) => f.id}
        minWidth={560}
        empty={<EmptyState compact icon={<Layers size={22} />} title="No fields yet" description="Add fields to define this module's shape." action={{ label: 'Add Field', onClick: () => setFieldModal('new') }} />}
      />
      {fieldModal && <FieldFormModal moduleId={module_.id} field={fieldModal === 'new' ? null : fieldModal} onClose={() => setFieldModal(null)} />}
    </div>
  );
}

function SyncTab({ module_ }: { module_: any }) {
  const { dateTime } = useFormat();
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

  if (isLoading) {
    return (
      <div className="space-y-3" aria-hidden="true">
        <div className="skeleton h-16 w-full rounded-card" />
        <div className="skeleton h-10 w-full rounded-card" />
        <div className="skeleton h-10 w-full rounded-card" />
        <div className="skeleton h-10 w-2/3 rounded-card" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Alert tone="info" icon={null}>
        Polls an external REST API on a schedule, validates each record against this module's fields, and upserts it —
        deduped on the field you pick as the external ID (if any). Runs automatically once saved; use "Sync now" to test immediately.
      </Alert>

      {config && (
        <Card padding="sm" flat className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-sm">
            {config.lastStatus === 'SUCCESS' ? <CheckCircle2 size={15} className="text-success" /> : config.lastStatus === 'FAILED' ? <XCircle size={15} className="text-danger" /> : <Clock size={15} className="text-fg-subtle" />}
            <span className="font-medium text-fg">{config.lastStatus ? `Last sync: ${config.lastStatus}` : 'Never synced'}</span>
          </div>
          {config.lastSyncAt && <span className="text-xs text-fg-subtle">{dateTime(config.lastSyncAt)}</span>}
          {config.lastRecordCount != null && <span className="text-xs text-fg-subtle">· {config.lastRecordCount} record(s)</span>}
          {config.lastError && <span className="text-xs text-danger">· {config.lastError}</span>}
          <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={() => trigger.mutate(module_.id)} loading={trigger.isPending} className="ml-auto">Sync Now</Button>
        </Card>
      )}

      <form onSubmit={submit} className="space-y-3">
        <div className="form-section">
          <p className="form-section-title">Connection</p>
          <div className="space-y-4">
            <Field label="API URL" required>
              <Input aria-label="API URL" required type="url" value={form.url} onChange={e => setForm(p => ({ ...p, url: e.target.value }))} placeholder="https://api.example.com/records" />
            </Field>
            <FormGrid>
              <Field label="Method">
                <SearchableSelect ariaLabel="Method" value={form.method} onChange={val => setForm(p => ({ ...p, method: val }))} options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} />
              </Field>
              <Field label="Poll every (minutes)">
                <Input aria-label="Poll interval" type="number" min={1} max={1440} className="tabular-nums" value={form.pollIntervalMin} onChange={e => setForm(p => ({ ...p, pollIntervalMin: Number(e.target.value) }))} />
              </Field>
            </FormGrid>
          </div>
        </div>

        <div className="form-section">
          <p className="form-section-title">Authentication</p>
          <div className="space-y-4">
            <FormGrid>
              <Field label="Auth Type">
                <SearchableSelect ariaLabel="Auth Type" value={form.authType} onChange={val => setForm(p => ({ ...p, authType: val }))} options={[{ value: 'NONE', label: 'None' }, { value: 'API_KEY', label: 'API Key Header' }, { value: 'BEARER', label: 'Bearer Token' }]} />
              </Field>
              {form.authType === 'API_KEY' && (
                <Field label="Header Name">
                  <Input aria-label="Auth Header Name" value={form.authHeaderName} onChange={e => setForm(p => ({ ...p, authHeaderName: e.target.value }))} placeholder="X-API-Key" />
                </Field>
              )}
            </FormGrid>
            {form.authType !== 'NONE' && (
              <Field label={form.authType === 'BEARER' ? 'Bearer Token' : 'API Key Value'}>
                <Input aria-label="Auth Value" type="password" value={form.authValue} onChange={e => setForm(p => ({ ...p, authValue: e.target.value }))} placeholder={config ? 'Leave blank to keep existing' : ''} />
              </Field>
            )}
          </div>
        </div>

        <div className="form-section">
          <p className="form-section-title">Data Shape</p>
          <FormGrid>
            <Field label="Record Path">
              <Input aria-label="Record Path" value={form.recordPath} onChange={e => setForm(p => ({ ...p, recordPath: e.target.value }))} placeholder="e.g. data.items (blank = response is the array)" />
            </Field>
            <Field label="External ID Field">
              <Input aria-label="External ID Field" value={form.externalIdField} onChange={e => setForm(p => ({ ...p, externalIdField: e.target.value }))} placeholder="e.g. id (blank = never dedupe)" />
            </Field>
          </FormGrid>
        </div>

        <div className="form-section">
          <p className="form-section-title">Field Mapping</p>
          <p className="form-hint mb-2 mt-0">For each module field, the key to read from each external record.</p>
          <div className="space-y-2">
            {fields.map((f: any) => (
              <div key={f.id} className="flex items-center gap-2">
                <span className="text-sm text-fg-muted w-40 flex-shrink-0 truncate" title={f.label}>{f.label}</span>
                <Input
                  aria-label={`Mapping for ${f.label}`}
                  className="flex-1"
                  value={form.fieldMapping[f.fieldKey] ?? ''}
                  onChange={e => setForm(p => ({ ...p, fieldMapping: { ...p.fieldMapping, [f.fieldKey]: e.target.value } }))}
                  placeholder={`external.${f.fieldKey}`}
                />
              </div>
            ))}
          </div>
        </div>

        <FormActions><Button type="submit" loading={save.isPending}>Save Sync Config</Button></FormActions>
      </form>
    </div>
  );
}

export default function CustomModulesPage() {
  const { data: modules, isLoading } = useCustomModules();
  const [searchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: module_ } = useCustomModule(selectedId ?? undefined);
  const deleteModule = useDeleteCustomModule();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [tab, setTab] = useState<'fields' | 'records' | 'sync'>('records');

  // Deep-link support — the "Manage module" link on a module's own
  // nav-linked page (CustomModuleViewPage) sends managers here pre-selected
  // via ?module=<id>, instead of always landing on whichever module happens
  // to be first alphabetically/by creation order.
  // `?module=` is an ENTRY point, not a binding. The previous version re-ran
  // on every `selectedId` change and unconditionally reset the selection back
  // to the query param, so clicking any other module in the sidebar snapped
  // straight back and the list was effectively frozen. Honour the param once,
  // then leave the user's choice alone.
  const appliedDeepLink = useRef(false);
  useEffect(() => {
    if (!modules?.length) return;
    if (!appliedDeepLink.current) {
      const fromQuery = searchParams.get('module');
      if (fromQuery && modules.some((m: any) => m.id === fromQuery)) {
        appliedDeepLink.current = true;
        setSelectedId(fromQuery);
        return;
      }
      appliedDeepLink.current = true;
    }
    if (!selectedId) setSelectedId(modules[0].id);
  }, [modules, selectedId, searchParams]);

  return (
    <div className="h-full flex flex-col animate-slide-up">
      <PageHeader
        title="Custom Modules"
        subtitle="Build your own objects — fields, records, and real-time API sync"
        actions={<Button icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>New Module</Button>}
      />

      <PageBody width="full" className="flex-1 min-h-0 flex flex-col">
      {isLoading ? (
        <div className="flex flex-col sm:flex-row gap-4" aria-hidden="true">
          <div className="skeleton w-full sm:w-60 h-48 sm:h-72 rounded-card shrink-0" />
          <div className="skeleton flex-1 h-72 rounded-card" />
        </div>
      ) : !modules?.length ? (
        <EmptyState icon={<Layers size={24} />} title="No custom modules yet" description="Create your first module to model data that doesn't fit CRM/IT Desk out of the box" action={{ label: 'New Module', onClick: () => setCreateOpen(true) }} />
      ) : (
        <div className="flex flex-col sm:flex-row gap-4 flex-1 min-h-0">
          <Card padding="none" className="w-full sm:w-60 sm:flex-shrink-0 max-h-48 sm:max-h-none overflow-y-auto p-2 space-y-1">
            {modules.map((m: any) => (
              <button
                key={m.id}
                onClick={() => setSelectedId(m.id)}
                className={`w-full text-left px-3 py-2 rounded-btn text-sm flex items-center justify-between gap-2 group transition-colors ${
                  selectedId === m.id ? 'bg-accent-soft text-accent-soft-fg font-medium' : 'text-fg-muted hover:bg-surface-hover'
                }`}
              >
                <span className="truncate" title={m.name}>{m.name}</span>
                <span className="flex items-center gap-1 flex-shrink-0">
                  {m.syncConfig?.isActive && <span title="Sync enabled"><Zap size={11} className="text-info" /></span>}
                  <span className="text-xs text-fg-subtle tabular-nums">{m._count?.records ?? 0}</span>
                </span>
              </button>
            ))}
          </Card>

          <Card padding="none" className="flex-1 min-w-0 p-4 overflow-y-auto">
            {!module_ ? (
              <div className="space-y-3" aria-hidden="true">
                <div className="skeleton h-6 w-1/3" />
                <div className="skeleton h-8 w-2/3" />
                <div className="skeleton h-48 w-full rounded-card" />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div className="min-w-0">
                    <h2 className="text-[14px] font-semibold text-fg tracking-tight truncate">{module_.name}</h2>
                    {module_.description && <p className="text-xs text-fg-subtle truncate" title={module_.description}>{module_.description}</p>}
                  </div>
                  <div className="flex items-center gap-1">
                    <IconButton
                      label="Edit module"
                      icon={<Pencil size={15} />}
                      onClick={() => setEditOpen(true)}
                    />
                    <IconButton
                      label="Delete module"
                      tone="danger"
                      icon={<Trash2 size={15} />}
                      onClick={() => { if (confirm(`Delete "${module_.name}" and all its records? This can't be undone.`)) { deleteModule.mutate(module_.id); setSelectedId(null); } }}
                    />
                  </div>
                </div>
                <Tabs
                  variant="pill"
                  aria-label="Module section"
                  className="mb-4"
                  items={(['records', 'fields', 'sync'] as const).map(t => ({ key: t, label: <span className="capitalize">{t}</span> }))}
                  value={tab}
                  onChange={setTab}
                />
                {tab === 'fields' && <FieldsTab module_={module_} />}
                {tab === 'records' && <CustomModuleRecordsTab module_={module_} />}
                {tab === 'sync' && <SyncTab module_={module_} />}
              </>
            )}
          </Card>
        </div>
      )}
      </PageBody>

      <CreateModuleModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={id => { setSelectedId(id); setCreateOpen(false); setTab('fields'); }} />
      {editOpen && module_ && <EditModuleModal module_={module_} onClose={() => setEditOpen(false)} />}
    </div>
  );
}
