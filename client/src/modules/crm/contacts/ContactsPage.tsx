import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Plus, Pencil, Trash2, Mail, Phone } from 'lucide-react';
import { useContacts, useCreateContact, useUpdateContact, useDeleteContact } from '../../../api/crm';
import { useAccounts } from '../../../api/crm';
import { PageHeader, Button, Modal, Badge, SearchInput, EmptyState, Spinner, SearchableSelect, RowActions, CustomFieldsFormFields, RecordTemplatePicker } from '../../../shared/components';
import { useCustomFieldDefs, useCustomFieldValues, useSaveCustomFieldValues, toValuesPayload, fromValueRecords } from '../../../api/customFields';
import { useEffect } from 'react';
import { useLabels } from '../../../hooks/useLabels';

function ContactForm({ initial, accounts, entityId, onSubmit, loading }: any) {
  const [form, setForm] = useState(initial || { name: '', email: '', phone: '', jobTitle: '', accountId: '', source: '' });
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const { data: existingValues } = useCustomFieldValues(entityId);
  useEffect(() => {
    if (existingValues) setCustomValues(fromValueRecords(existingValues));
  }, [existingValues]);
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: e.target.value }));
  const { entityLabel, fieldLabel } = useLabels();
  const singular = entityLabel('contact', 'singular', 'Contact');
  // Fall back to the exact original text when unset, so the e2e suite's
  // getByLabel(/^name$/i) etc. keeps matching for the seeded test org.
  const nameLabel = fieldLabel('contact', 'name', 'Name');
  const phoneLabel = fieldLabel('contact', 'phone', 'Phone');
  const jobTitleLabel = fieldLabel('contact', 'jobTitle', 'Job Title');
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ ...form, __customFieldValues: customValues }); }} className="space-y-3">
      {!initial && (
        <RecordTemplatePicker
          entityType="CONTACT"
          onApply={t => {
            setForm((p: any) => ({ ...p, ...t.fieldValues }));
            if (t.customFieldValues) setCustomValues(p => ({ ...p, ...t.customFieldValues as Record<string, string> }));
          }}
        />
      )}
      <div className="form-section">
        <p className="form-section-title">Basic Information</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="form-label">{nameLabel} <span className="req">*</span></label>
            <input aria-label={nameLabel} required className="ui-input" value={form.name} onChange={f('name')} placeholder="Full name" />
          </div>
          <div>
            <label className="form-label">Email</label>
            <input aria-label="Email" type="email" className="ui-input" value={form.email} onChange={f('email')} placeholder="email@company.com" />
          </div>
          <div>
            <label className="form-label">{phoneLabel}</label>
            <input aria-label={phoneLabel} className="ui-input" value={form.phone} onChange={f('phone')} placeholder="+1 (555) 000-0000" />
          </div>
          <div>
            <label className="form-label">{jobTitleLabel}</label>
            <input aria-label={jobTitleLabel} className="ui-input" value={form.jobTitle} onChange={f('jobTitle')} placeholder="e.g. Product Manager" />
          </div>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Additional Details</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="form-label">Source</label>
<SearchableSelect ariaLabel="Source" value={form.source} onChange={val => setForm((p: any) => ({ ...p, source: val }))} options={['Web','Referral','Cold Outreach','Event','Social Media','Other'].map(s => ({ value: s, label: s }))} />
          </div>
          <div>
            <label className="form-label">Account</label>
<SearchableSelect ariaLabel="Account" value={form.accountId} onChange={val => setForm((p: any) => ({ ...p, accountId: val }))} options={(accounts ?? []).map((a: any) => ({ value: a.id, label: a.name }))} placeholder="— none —" />
          </div>
        </div>
      </div>
      <CustomFieldsFormFields
        entityType="CONTACT"
        values={customValues}
        onChange={(key, value) => setCustomValues(p => ({ ...p, [key]: value }))}
      />
      <div className="flex justify-end pt-1">
        <Button type="submit" loading={loading}>{initial ? 'Save Changes' : `Create ${singular}`}</Button>
      </div>
    </form>
  );
}

export function ContactsPage() {
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<null | 'create' | { type: 'edit'; contact: any }>(null);
  const { data: contacts, isLoading } = useContacts(search ? { search } : undefined);
  const { data: accounts } = useAccounts();
  const create = useCreateContact();
  const update = useUpdateContact();
  const del = useDeleteContact();
  const saveCustomFields = useSaveCustomFieldValues();
  const { data: contactFieldDefs } = useCustomFieldDefs('CONTACT');
  const { entityLabel } = useLabels();
  const singular = entityLabel('contact', 'singular', 'Contact');
  const plural = entityLabel('contact', 'plural', 'Contacts');

  async function handleSubmit(form: any) {
    const { __customFieldValues, ...rest } = form;
    let contactId: string;
    if (modal === 'create') {
      const created = await create.mutateAsync(rest);
      contactId = created.id;
    } else {
      contactId = (modal as any).contact.id;
      await update.mutateAsync({ id: contactId, ...rest });
    }
    if (__customFieldValues && contactFieldDefs?.length) {
      const values = toValuesPayload(contactFieldDefs, __customFieldValues);
      if (values.length) await saveCustomFields.mutateAsync({ entityId: contactId, values });
    }
    setModal(null);
  }

  return (
    <div className="p-4 sm:p-6 animate-slide-up">
      <PageHeader
        title={plural}
        subtitle={`${contacts?.length ?? 0} ${plural.toLowerCase()}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <SearchInput value={search} onChange={setSearch} placeholder={`Search ${plural.toLowerCase()}...`} />
            <Button icon={<Plus size={15} />} onClick={() => setModal('create')}>New {singular}</Button>
          </div>
        }
      />

      {isLoading ? <Spinner /> : contacts?.length === 0 ? (
        <EmptyState icon={<Users size={24} />} title={`No ${plural.toLowerCase()} yet`} description="Add your first contact to get started" action={{ label: `New ${singular}`, onClick: () => setModal('create') }} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead><tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                <th className="hidden sm:table-cell text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Phone</th>
                <th className="hidden sm:table-cell text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Job Title</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Account</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Source</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider"></th>
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {contacts?.map((c: any) => (
                  <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors duration-150 group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center text-xs font-bold flex-shrink-0">
                          {c.name[0]?.toUpperCase()}
                        </div>
                        <Link to={`/crm/contacts/${c.id}`} className="font-medium text-gray-900 hover:text-brand-600 hover:underline">
                          {c.name}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{c.email && <span className="flex items-center gap-1"><Mail size={12} />{c.email}</span>}</td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-500">{c.phone && <span className="flex items-center gap-1"><Phone size={12} />{c.phone}</span>}</td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-500">{c.jobTitle}</td>
                    <td className="px-4 py-3">{c.account && <Badge variant="blue">{c.account.name}</Badge>}</td>
                    <td className="px-4 py-3">{c.source && <Badge>{c.source}</Badge>}</td>
                    <td className="px-4 py-3">
                      <RowActions items={[
                        { label: 'Edit contact', icon: <Pencil size={14} />, onClick: () => setModal({ type: 'edit', contact: c }) },
                        { label: 'Delete contact', icon: <Trash2 size={14} />, onClick: () => del.mutate(c.id), variant: 'danger' },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={modal === 'create' || (typeof modal === 'object' && modal !== null && (modal as any).type === 'edit')}
        onClose={() => setModal(null)}
        title={modal === 'create' ? `New ${singular}` : `Edit ${singular}`}
      >
        <ContactForm
          initial={modal && typeof modal === 'object' && (modal as any).type === 'edit' ? (modal as any).contact : null}
          entityId={modal && typeof modal === 'object' && (modal as any).type === 'edit' ? (modal as any).contact.id : undefined}
          accounts={accounts}
          onSubmit={handleSubmit}
          loading={create.isPending || update.isPending}
        />
      </Modal>
    </div>
  );
}
