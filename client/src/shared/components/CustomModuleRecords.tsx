import { useState } from 'react';
import { Layers, Plus, Trash2, Pencil } from 'lucide-react';
import {
  useModuleRecords, useCreateModuleRecord, useUpdateModuleRecord, useDeleteModuleRecord,
} from '../../api/customModules';
import { Button, Modal, Spinner, EmptyState, SearchableSelect, RowActions } from './index';

// Extracted out of pages/CustomModulesPage.tsx (the module builder) so the
// same records table + form can also be embedded standalone on a module's
// own nav-linked page (pages/CustomModuleViewPage.tsx) — day-to-day record
// entry shouldn't require going through the admin builder UI to get there.

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

/** Records table + add/edit/delete for one custom module. `module_` must include its `fields` array (from useCustomModule, not the list endpoint). */
export function CustomModuleRecordsTab({ module_, canDelete = true }: { module_: any; canDelete?: boolean }) {
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
            <thead className="bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
              <tr>
                {fields.map((f: any) => <th key={f.id} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{f.label}</th>)}
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {records.data.map((r: any) => (
                <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  {fields.map((f: any) => (
                    <td key={f.id} className="px-4 py-3 text-gray-700 dark:text-gray-300">
                      {f.fieldType === 'BOOLEAN' ? (r.data[f.fieldKey] ? 'Yes' : 'No') : String(r.data[f.fieldKey] ?? '—')}
                    </td>
                  ))}
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${r.source === 'SYNC' ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>{r.source}</span>
                  </td>
                  <td className="px-4 py-3">
                    <RowActions items={[
                      { label: 'Edit record', icon: <Pencil size={14} />, onClick: () => setRecordModal(r) },
                      { label: 'Delete record', icon: <Trash2 size={14} />, onClick: () => deleteRecord.mutate({ moduleId: module_.id, recordId: r.id }), variant: 'danger', hidden: !canDelete },
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
