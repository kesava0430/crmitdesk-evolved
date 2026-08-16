import { useState } from 'react';
import { FolderTree, Plus, BellRing } from 'lucide-react';
import { useCategories, useCreateCategory, useUpdateCategory, useDeleteCategory, useSLAPolicies, useCreateSLAPolicy, useUpdateSLAPolicy, useDeleteSLAPolicy } from '../../../api/itdesk';
import { useUsers } from '../../../api/users';
import { PageHeader, Button, Modal, Badge, EmptyState, Spinner, SearchableSelect, RowActions, Card, Field, Input, Textarea, FormError } from '../../../shared/components';
import { Pencil, Trash2 } from 'lucide-react';

function CategoryForm({ initial, slaPolices, onSubmit, loading }: any) {
  const [form, setForm] = useState(initial || { name: '', description: '', slaPolicyId: '' });
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: e.target.value }));
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(form); }} className="space-y-3">
      <div className="form-section">
        <p className="form-section-title">Category Details</p>
        <div className="space-y-4">
          <Field label="Category Name" required htmlFor="cat-name">
            <Input id="cat-name" aria-label="Category Name" required value={form.name} onChange={f('name')} placeholder="e.g. Hardware, Software, Network" />
          </Field>
          <Field label="Description" htmlFor="cat-description">
            <Textarea id="cat-description" aria-label="Description" rows={2} value={form.description} onChange={f('description')} placeholder="Optional description…" />
          </Field>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">SLA</p>
        <Field label="SLA Policy">
          <SearchableSelect ariaLabel="SLA Policy" value={form.slaPolicyId} onChange={val => setForm((p: any) => ({ ...p, slaPolicyId: val }))} options={(slaPolices ?? []).map((p: any) => ({ value: p.id, label: `${p.name} (${p.responseHours}h / ${p.resolutionHours}h)` }))} />
        </Field>
      </div>
      <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>{initial ? 'Save Changes' : 'Create Category'}</Button></div>
    </form>
  );
}

function SLAForm({ initial, users, onSubmit, loading }: any) {
  const [form, setForm] = useState(initial || { name: '', responseHours: 4, resolutionHours: 24, notifyUserId: '' });
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: k.includes('Hours') ? Number(e.target.value) : e.target.value }));
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(form); }} className="space-y-3">
      <div className="form-section">
        <p className="form-section-title">Policy Details</p>
        <Field label="Policy Name" required htmlFor="sla-name">
          <Input id="sla-name" aria-label="Policy Name" required value={form.name} onChange={f('name')} placeholder="e.g. Standard, Priority, Critical" />
        </Field>
      </div>
      <div className="form-section">
        <p className="form-section-title">Time Targets</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Response Time (hrs)" htmlFor="sla-response">
            <Input id="sla-response" type="number" min="1" value={form.responseHours} onChange={f('responseHours')} />
          </Field>
          <Field label="Resolution Time (hrs)" htmlFor="sla-resolution">
            <Input id="sla-resolution" type="number" min="1" value={form.resolutionHours} onChange={f('resolutionHours')} />
          </Field>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Breach Notification</p>
        <Field
          label="Notify"
          hint="Gets an in-app + push notification the moment a ticket under this policy misses its resolution deadline. Independent of Workflows — you can use this, an SLA Breach workflow rule, or both."
        >
          <SearchableSelect
            ariaLabel="Notify"
            value={form.notifyUserId}
            onChange={val => setForm((p: any) => ({ ...p, notifyUserId: val }))}
            options={(users ?? []).map((u: any) => ({ value: u.id, label: `${u.name} (${u.role.replace(/_/g, ' ')})` }))}
            placeholder="— nobody (use a Workflows rule instead) —"
          />
        </Field>
      </div>
      <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>{initial ? 'Save Changes' : 'Create SLA Policy'}</Button></div>
    </form>
  );
}

export function CategoriesPage() {
  const [catModal, setCatModal] = useState<null | 'create' | { type: 'edit'; cat: any }>(null);
  const [slaModal, setSlaModal] = useState<null | 'create' | { type: 'edit'; policy: any }>(null);
  const [catError, setCatError] = useState('');
  const [slaError, setSlaError] = useState('');
  const { data: categories, isLoading } = useCategories();
  const { data: slaPolicies } = useSLAPolicies();
  const { data: users } = useUsers();
  const createCat = useCreateCategory();
  const updateCat = useUpdateCategory();
  const deleteCat = useDeleteCategory();
  const createSLA = useCreateSLAPolicy();
  const updateSLA = useUpdateSLAPolicy();
  const deleteSLA = useDeleteSLAPolicy();

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Categories & SLA"
        subtitle="Manage ticket categories and service level agreements"
        actions={<>
          <Button variant="secondary" icon={<Plus size={15} />} onClick={() => setSlaModal('create')}>New SLA Policy</Button>
          <Button icon={<Plus size={15} />} onClick={() => setCatModal('create')}>New Category</Button>
        </>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Categories */}
        <div>
          <p className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-3">Categories</p>
          {isLoading ? <Spinner /> : categories?.length === 0 ? (
            <EmptyState icon={<FolderTree size={22} />} title="No categories" description="Create categories to organize tickets" action={{ label: 'New Category', onClick: () => setCatModal('create') }} />
          ) : (
            <div className="space-y-2">
              {categories?.map((cat: any) => (
                <Card key={cat.id} data-testid="category-card" padding="sm" className="flex items-center justify-between gap-3 group hover:border-accent/40 transition-colors">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-medium text-fg">{cat.name}</span>
                      <Badge>{cat._count?.tickets ?? 0} tickets</Badge>
                    </div>
                    {cat.slaPolicy && <p className="text-xs text-fg-subtle">{cat.slaPolicy.name} · {cat.slaPolicy.resolutionHours}h SLA</p>}
                  </div>
                  <RowActions items={[
                    { label: 'Edit category', icon: <Pencil size={14} />, onClick: () => setCatModal({ type: 'edit', cat }) },
                    { label: 'Delete category', icon: <Trash2 size={14} />, onClick: () => deleteCat.mutate(cat.id), variant: 'danger' },
                  ]} />
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* SLA Policies */}
        <div>
          <p className="text-sm font-semibold text-fg-muted uppercase tracking-wider mb-3">SLA Policies</p>
          {slaPolicies?.length === 0 ? (
            <EmptyState icon={<FolderTree size={22} />} title="No SLA policies" description="Create SLA policies to set response and resolution targets" action={{ label: 'New SLA Policy', onClick: () => setSlaModal('create') }} />
          ) : (
            <div className="space-y-2">
              {slaPolicies?.map((p: any) => (
                <Card key={p.id} padding="sm" className="flex items-center justify-between gap-3 group hover:border-accent/40 transition-colors">
                  <div>
                    <p className="font-medium text-fg mb-1">{p.name}</p>
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge variant="blue">Response: {p.responseHours}h</Badge>
                      <Badge variant="green">Resolution: {p.resolutionHours}h</Badge>
                      {p.notifyUser ? (
                        <span className="flex items-center gap-1 text-xs text-fg-subtle">
                          <BellRing size={11} /> Notifies {p.notifyUser.name} on breach
                        </span>
                      ) : (
                        <span className="text-xs text-fg-subtle">No breach notification set</span>
                      )}
                    </div>
                  </div>
                  <RowActions items={[
                    { label: 'Edit SLA policy', icon: <Pencil size={14} />, onClick: () => setSlaModal({ type: 'edit', policy: p }) },
                    { label: 'Delete SLA policy', icon: <Trash2 size={14} />, onClick: () => deleteSLA.mutate(p.id), variant: 'danger' },
                  ]} />
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal open={!!catModal} onClose={() => { setCatModal(null); setCatError(''); }} title={catModal === 'create' ? 'New Category' : 'Edit Category'}>
        <FormError className="mb-3">{catError}</FormError>
        <CategoryForm
          initial={catModal && typeof catModal === 'object' ? { name: catModal.cat.name, description: catModal.cat.description || '', slaPolicyId: catModal.cat.slaPolicyId || '' } : null}
          slaPolices={slaPolicies}
          loading={createCat.isPending || updateCat.isPending}
          onSubmit={async (form: any) => {
            const payload = { ...form, slaPolicyId: form.slaPolicyId || undefined };
            setCatError('');
            try {
              if (catModal === 'create') await createCat.mutateAsync(payload);
              else if (catModal && typeof catModal === 'object') await updateCat.mutateAsync({ id: catModal.cat.id, ...payload });
              // Only on success — a `finally` here discarded the user's input
              // whenever the save failed, and said nothing about why.
              setCatModal(null);
            } catch (err: any) {
              setCatError(err?.response?.data?.error || 'Could not save the category.');
            }
          }}
        />
      </Modal>

      <Modal open={!!slaModal} onClose={() => { setSlaModal(null); setSlaError(''); }} title={slaModal === 'create' ? 'New SLA Policy' : 'Edit SLA Policy'}>
        <FormError className="mb-3">{slaError}</FormError>
        <SLAForm
          initial={slaModal && typeof slaModal === 'object' ? {
            name: slaModal.policy.name,
            responseHours: slaModal.policy.responseHours,
            resolutionHours: slaModal.policy.resolutionHours,
            notifyUserId: slaModal.policy.notifyUserId || '',
          } : null}
          users={users}
          loading={createSLA.isPending || updateSLA.isPending}
          onSubmit={async (form: any) => {
            setSlaError('');
            try {
              if (slaModal === 'create') await createSLA.mutateAsync(form);
              else if (slaModal && typeof slaModal === 'object') await updateSLA.mutateAsync({ id: slaModal.policy.id, ...form });
              setSlaModal(null);
            } catch (err: any) {
              setSlaError(err?.response?.data?.error || 'Could not save the SLA policy.');
            }
          }}
        />
      </Modal>
    </div>
  );
}
