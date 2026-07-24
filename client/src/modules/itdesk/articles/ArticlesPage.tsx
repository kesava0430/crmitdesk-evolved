import { useState } from 'react';
import { BookOpen, Plus, Pencil, Trash2, Eye } from 'lucide-react';
import { useArticles, useCreateArticle, useUpdateArticle, useDeleteArticle } from '../../../api/itdesk';
import { useCategories } from '../../../api/itdesk';
import { PageHeader, Button, Modal, Badge, EmptyState, Spinner, SearchInput, SearchableSelect, RowActions } from '../../../shared/components';
import { articleStatusVariant } from '../../../shared/components/Badge';
import { formatDistanceToNow } from 'date-fns';

function ArticleForm({ initial, categories, onSubmit, loading }: any) {
  const [form, setForm] = useState(initial || { title: '', body: '', categoryId: '', status: 'DRAFT' });
  const f = (k: string) => (e: any) => setForm((p: any) => ({ ...p, [k]: e.target.value }));
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(form); }} className="space-y-3">
      <div className="form-section">
        <p className="form-section-title">Article Details</p>
        <div className="space-y-4">
          <div>
            <label className="form-label">Title <span className="req">*</span></label>
            <input required className="ui-input" aria-label="Title" value={form.title} onChange={f('title')} placeholder="e.g. How to reset your password" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">Category</label>
<SearchableSelect ariaLabel="Category" value={form.categoryId} onChange={val => setForm((p: any) => ({ ...p, categoryId: val }))} options={(categories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
            </div>
            <div>
              <label className="form-label">Status</label>
<SearchableSelect ariaLabel="Status" value={form.status} onChange={val => setForm((p: any) => ({ ...p, status: val }))} required options={['DRAFT','PUBLISHED','ARCHIVED'].map(s => ({ value: s, label: s }))} />
            </div>
          </div>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-title">Content <span className="req">*</span></p>
        <textarea required rows={10} className="ui-input font-mono text-xs" aria-label="Body" value={form.body} onChange={f('body')} placeholder="Write your article content here… (Markdown supported)" />
        <p className="form-hint">Markdown formatting is supported</p>
      </div>
      <div className="flex justify-end pt-1"><Button type="submit" loading={loading}>{initial ? 'Save Changes' : 'Create Article'}</Button></div>
    </form>
  );
}

function ArticleView({ article }: any) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={articleStatusVariant[article.status]}>{article.status}</Badge>
        {article.category && <Badge variant="blue">{article.category.name}</Badge>}
        <span className="text-xs text-gray-400">by {article.author?.name} · {formatDistanceToNow(new Date(article.createdAt), { addSuffix: true })}</span>
      </div>
      <div className="prose prose-sm max-w-none bg-gray-50 rounded-xl p-4 text-gray-700 whitespace-pre-wrap font-mono text-xs leading-relaxed">
        {article.body}
      </div>
    </div>
  );
}

export function ArticlesPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [modal, setModal] = useState<null | 'create' | { type: 'edit'; article: any } | { type: 'view'; article: any }>(null);
  const { data: articles, isLoading } = useArticles({ all: '1', ...(statusFilter && { status: statusFilter }) });
  const { data: categories } = useCategories();
  const create = useCreateArticle();
  const update = useUpdateArticle();
  const del = useDeleteArticle();

  const filtered = articles?.filter((a: any) => !search || a.title.toLowerCase().includes(search.toLowerCase()));

  async function handleSubmit(form: any) {
    // Only close the modal on success — closing unconditionally in a
    // `finally` here hid real failures (e.g. a validation error) behind
    // what looked like a successful save, with the record silently never
    // created/updated.
    if (modal === 'create') await create.mutateAsync(form);
    else if (modal && typeof modal === 'object' && modal.type === 'edit') await update.mutateAsync({ id: modal.article.id, ...form });
    setModal(null);
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Knowledge Base"
        subtitle={`${filtered?.length ?? 0} articles`}
        actions={<>
          <SearchInput value={search} onChange={setSearch} placeholder="Search articles..." />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ui-input focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white">
            <option value="">All Statuses</option>
            {['DRAFT','PUBLISHED','ARCHIVED'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button icon={<Plus size={15} />} onClick={() => setModal('create')}>New Article</Button>
        </>}
      />

      {isLoading ? <Spinner /> : filtered?.length === 0 ? (
        <EmptyState icon={<BookOpen size={24} />} title="No articles yet" description="Create your first knowledge base article" action={{ label: 'New Article', onClick: () => setModal('create') }} />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {filtered?.map((a: any) => (
            <div key={a.id} data-testid="article-card" className="bg-white border border-gray-200 rounded-xl p-4 flex items-start justify-between hover:border-brand-200 hover:shadow-sm transition-all">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Badge variant={articleStatusVariant[a.status]}>{a.status}</Badge>
                  {a.category && <Badge variant="blue">{a.category.name}</Badge>}
                </div>
                <h3 className="font-semibold text-gray-900 mb-0.5 truncate">{a.title}</h3>
                <p className="text-xs text-gray-400">by {a.author?.name} · {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}</p>
              </div>
              <RowActions items={[
                { label: 'View article', icon: <Eye size={14} />, onClick: () => setModal({ type: 'view', article: a }) },
                { label: 'Edit article', icon: <Pencil size={14} />, onClick: () => setModal({ type: 'edit', article: a }) },
                { label: 'Delete article', icon: <Trash2 size={14} />, onClick: () => del.mutate(a.id), variant: 'danger' },
              ]} />
            </div>
          ))}
        </div>
      )}

      <Modal open={modal === 'create' || (!!modal && typeof modal === 'object' && modal.type === 'edit')}
        onClose={() => setModal(null)}
        title={modal === 'create' ? 'New Article' : 'Edit Article'}
        size="lg">
        <ArticleForm
          initial={modal && typeof modal === 'object' && modal.type === 'edit' ? modal.article : null}
          categories={categories}
          onSubmit={handleSubmit}
          loading={create.isPending || update.isPending}
        />
      </Modal>

      <Modal open={!!modal && typeof modal === 'object' && modal.type === 'view'}
        onClose={() => setModal(null)}
        title={(modal && typeof modal === 'object' && modal.type === 'view') ? modal.article.title : ''}
        size="lg">
        {modal && typeof modal === 'object' && modal.type === 'view' && <ArticleView article={modal.article} />}
      </Modal>
    </div>
  );
}
