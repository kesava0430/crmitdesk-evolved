import { useState } from 'react';
import { Layers, Plus, Trash2, Pencil } from 'lucide-react';
import {
  useModuleRecords, useCreateModuleRecord, useUpdateModuleRecord, useDeleteModuleRecord,
} from '../../api/customModules';
import {
  Button, Modal, Spinner, EmptyState, SearchableSelect, RowActions,
  Field, Input, Textarea, Checkbox, DataTable, Badge, FormError, type Column,
} from './index';

// Extracted out of pages/CustomModulesPage.tsx (the module builder) so the
// same records table + form can also be embedded standalone on a module's
// own nav-linked page (pages/CustomModuleViewPage.tsx) — day-to-day record
// entry shouldn't require going through the admin builder UI to get there.

function RecordFieldInput({ field, value, onChange }: { field: any; value: any; onChange: (v: any) => void }) {
  const label = field.label;
  if (field.fieldType === 'BOOLEAN') {
    return <Checkbox label={label} checked={!!value} onChange={e => onChange(e.target.checked)} />;
  }
  if (field.fieldType === 'DROPDOWN') {
    return <SearchableSelect ariaLabel={label} value={value ?? ''} onChange={onChange} options={(field.options ?? []).map((o: string) => ({ value: o, label: o }))} placeholder={`Select ${label}…`} />;
  }
  if (field.fieldType === 'DATE') {
    return <Input aria-label={label} type="date" value={value ? String(value).slice(0, 10) : ''} onChange={e => onChange(e.target.value)} />;
  }
  if (field.fieldType === 'NUMBER' || field.fieldType === 'CURRENCY') {
    return <Input aria-label={label} type="number" value={value ?? ''} onChange={e => onChange(e.target.value)} />;
  }
  if (field.fieldType === 'TEXTAREA') {
    return <Textarea aria-label={label} rows={2} value={value ?? ''} onChange={e => onChange(e.target.value)} />;
  }
  return <Input aria-label={label} type={field.fieldType === 'EMAIL' ? 'email' : 'text'} value={value ?? ''} onChange={e => onChange(e.target.value)} />;
}

function RecordFormModal({ module_, record, onClose }: { module_: any; record: any | null; onClose: () => void }) {
  const create = useCreateModuleRecord();
  const update = useUpdateModuleRecord();
  const [data, setData] = useState<Record<string, unknown>>(record?.data ?? {});
  const [error, setError] = useState('');
  const loading = create.isPending || update.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (record) await update.mutateAsync({ moduleId: module_.id, recordId: record.id, data });
      else await create.mutateAsync({ moduleId: module_.id, data });
      // Close on success only. Previously both calls were awaited with no
      // catch, so a rejected save (a required field the server rejects, a
      // dropped connection) surfaced as an unhandled rejection: the modal
      // just sat there, and the user had no idea the record was not created.
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Could not save this record. Check the required fields and try again.');
    }
  }

  return (
    <Modal open onClose={onClose} title={record ? 'Edit Record' : `New ${module_.name} Record`}>
      <form onSubmit={submit} className="space-y-4">
        <FormError>{error}</FormError>
        {(module_.fields ?? []).map((f: any) => (
          f.fieldType === 'BOOLEAN' ? (
            <RecordFieldInput key={f.id} field={f} value={data[f.fieldKey]} onChange={v => setData(p => ({ ...p, [f.fieldKey]: v }))} />
          ) : (
            <Field key={f.id} label={f.label} required={f.required}>
              <RecordFieldInput field={f} value={data[f.fieldKey]} onChange={v => setData(p => ({ ...p, [f.fieldKey]: v }))} />
            </Field>
          )
        ))}
        <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>{record ? 'Save Changes' : 'Create Record'}</Button></div>
      </form>
    </Modal>
  );
}

/** Records table + add/edit/delete for one custom module. `module_` must include its `fields` array (from useCustomModule, not the list endpoint). */
export function CustomModuleRecordsTab({ module_, canDelete = true }: { module_: any; canDelete?: boolean }) {
  const { data: records, isLoading } = useModuleRecords(module_.id);

  /* useModuleRecords already unwraps the paginated envelope: api/customModules.ts
     runs every response through `unwrap`, which turns the server's
     { data: [...], pagination: {...} } into the bare array. This component then
     asked for `records.data` — and an array has no `.data`, so it resolved to
     undefined and fell back to [] on EVERY render. The table was permanently
     empty, which read as "the record I just added didn't save".

     Accepting both shapes so the table cannot silently blank again if the
     endpoint or the unwrap helper changes. */
  const rows: any[] = Array.isArray(records) ? records : ((records as any)?.data ?? []);
  const deleteRecord = useDeleteModuleRecord();
  const [recordModal, setRecordModal] = useState<null | 'new' | any>(null);
  const fields = (module_.fields ?? []).slice(0, 5); // keep the table readable — full record shown in the edit modal

  const columns: Column<any>[] = [
    ...fields.map((f: any) => ({
      key: f.id,
      header: f.label,
      cell: (r: any) => f.fieldType === 'BOOLEAN' ? (r.data[f.fieldKey] ? 'Yes' : 'No') : String(r.data[f.fieldKey] ?? '—'),
    })),
    {
      key: '__source', header: 'Source',
      cell: (r: any) => <Badge variant={r.source === 'SYNC' ? 'indigo' : 'gray'}>{r.source}</Badge>,
    },
    {
      key: '__actions', header: '', width: 56,
      cell: (r: any) => (
        <RowActions items={[
          { label: 'Edit record', icon: <Pencil size={14} />, onClick: () => setRecordModal(r) },
          { label: 'Delete record', icon: <Trash2 size={14} />, onClick: () => deleteRecord.mutate({ moduleId: module_.id, recordId: r.id }), variant: 'danger', hidden: !canDelete },
        ]} />
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setRecordModal('new')} disabled={!module_.fields?.length}>Add Record</Button>
      </div>
      {!module_.fields?.length ? (
        <EmptyState icon={<Layers size={22} />} title="Add fields first" description="Define at least one field before creating records" />
      ) : isLoading ? <Spinner /> : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r: any) => r.id}
          minWidth={560}
          empty={<EmptyState icon={<Layers size={22} />} title="No records yet" description="Add one manually, or connect a sync in the Sync tab" />}
        />
      )}
      {recordModal && <RecordFormModal module_={module_} record={recordModal === 'new' ? null : recordModal} onClose={() => setRecordModal(null)} />}
    </div>
  );
}
