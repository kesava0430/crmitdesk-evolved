import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Settings2, Plus, Pencil, Trash2 } from 'lucide-react';
import {
  SearchableSelect, RowActions,
  PageHeader, PageBody, Card, Tabs, Button, Modal, Field, Input, Checkbox, FormGrid,
  DataTable, EmptyState, Badge, type Column,
} from '../shared/components';

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

  const columns: Column<CustomField>[] = [
    { key: 'label', header: 'Label', cell: f => <span className="font-medium text-fg">{f.label}</span> },
    {
      key: 'fieldKey', header: 'API Name',
      cell: f => <code className="text-xs font-mono bg-surface-sunken text-fg px-1.5 py-0.5 rounded-badge" title={f.fieldKey}>{f.fieldKey}</code>,
    },
    {
      key: 'type', header: 'Type', hideBelow: 'sm',
      cell: f => <Badge variant="blue">{TYPE_LABELS[f.fieldType] ?? f.fieldType}</Badge>,
    },
    {
      key: 'required', header: 'Required', hideBelow: 'sm',
      cell: f => f.required
        ? <span className="text-success font-medium">Yes</span>
        : <span className="text-fg-subtle">No</span>,
    },
    { key: 'options', header: 'Options', muted: true, cell: f => f.options?.join(', ') ?? '—' },
    {
      key: 'actions', header: '', width: 56,
      cell: f => (
        <RowActions items={[
          { label: 'Edit field', icon: <Pencil size={14} />, onClick: () => openEdit(f) },
          { label: 'Delete field', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this field?')) remove.mutate(f.id); }, variant: 'danger' },
        ]} />
      ),
    },
  ];

  return (
    <div className="animate-slide-up">
      <PageHeader
        title="Custom Fields"
        subtitle="Add extra fields to tickets, contacts, deals, and leads"
        actions={<Button icon={<Plus size={16} />} onClick={openCreate}>Add Field</Button>}
        below={(
          <Tabs
            variant="pill"
            aria-label="Entity type"
            items={ENTITY_TYPES.map(t => ({ key: t, label: t[0] + t.slice(1).toLowerCase() + 's' }))}
            value={entityType}
            onChange={setEntityType}
          />
        )}
      />

      <PageBody width="wide">
        <Card padding="none">
          <DataTable
            columns={columns}
            rows={fields}
            rowKey={f => f.id}
            minWidth={640}
            loading={isLoading}
            empty={(
              <EmptyState
                icon={<Settings2 size={22} />}
                title={`No custom fields for ${entityType.toLowerCase()}s yet`}
                description={`Add a field to capture extra information on every ${entityType.toLowerCase()}.`}
                action={{ label: 'Add Field', onClick: openCreate }}
              />
            )}
          />
        </Card>
      </PageBody>

      <Modal
        open={showModal}
        onClose={closeModal}
        title={editing ? 'Edit Field' : 'Create Custom Field'}
        size="md"
        footer={(
          <>
            <Button variant="secondary" onClick={closeModal}>Cancel</Button>
            <Button disabled={!form.fieldKey || !form.label} loading={save.isPending} onClick={handleSubmit}>
              {save.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Field'}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <div className="form-section">
            <p className="form-section-title">Field Identity</p>
            <div className="space-y-4">
              <Field label="Label" required>
                <Input aria-label="Label" placeholder="e.g. Customer Type" value={form.label}
                  onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
              </Field>
              <Field label="API Name" required hint="Lowercase letters, numbers, and underscores only">
                <Input aria-label="API Name" placeholder="e.g. customer_type" value={form.fieldKey}
                  onChange={e => setForm(f => ({ ...f, fieldKey: e.target.value }))} />
              </Field>
            </div>
          </div>
          <div className="form-section">
            <p className="form-section-title">Configuration</p>
            <div className="space-y-4">
              <FormGrid>
                <Field label="Type">
                  <SearchableSelect ariaLabel="Type" value={form.fieldType} onChange={val => setForm(f => ({ ...f, fieldType: val }))} required options={FIELD_TYPES.map(t => ({ value: t, label: TYPE_LABELS[t] }))} />
                </Field>
                <Field label="Entity">
                  <SearchableSelect ariaLabel="Entity" value={form.entityType} onChange={val => setForm(f => ({ ...f, entityType: val }))} required options={ENTITY_TYPES.map(t => ({ value: t, label: t[0] + t.slice(1).toLowerCase() + 's' }))} />
                </Field>
              </FormGrid>
              {form.fieldType === 'SELECT' && (
                <Field label="Options" hint="Separate options with commas">
                  <Input placeholder="Option A, Option B, Option C" value={form.options}
                    onChange={e => setForm(f => ({ ...f, options: e.target.value }))} />
                </Field>
              )}
              <Checkbox
                label="Mark as required field"
                checked={form.required}
                onChange={e => setForm(f => ({ ...f, required: e.target.checked }))}
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
