import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { RowActions, SearchableSelect } from '../shared/components';
import { Attachments } from '../shared/components/Attachments';
import { FileText, Plus, Pencil, Trash2, Send, CheckCircle, XCircle, DollarSign, LayoutTemplate } from 'lucide-react';
import { useQuoteTemplates } from '../api/templates';

interface QuoteLine { id?: string; description: string; quantity: number; unitPrice: number; }
interface Quote {
  id: string;
  title: string;
  status: string;
  total: number;
  validUntil: string | null;
  createdAt: string;
  deal?: { title: string } | null;
  lines: QuoteLine[];
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  SENT: 'bg-blue-100 text-blue-700',
  ACCEPTED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-600',
};

const EMPTY_LINE: QuoteLine = { description: '', quantity: 1, unitPrice: 0 };

export default function QuotesPage() {
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [form, setForm] = useState({ title: '', validUntil: '', notes: '', lines: [{ ...EMPTY_LINE }] });

  const { data: quotes = [], isLoading } = useQuery<Quote[]>({
    queryKey: ['quotes'],
    queryFn: () => api.get('/quotes').then(r => Array.isArray(r.data) ? r.data : (r.data.data ?? [])),
  });
  const { data: quoteTemplates } = useQuoteTemplates();

  const save = useMutation({
    mutationFn: (body: typeof form) =>
      editing
        ? api.patch(`/quotes/${editing.id}`, body).then(r => r.data)
        : api.post('/quotes', body).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['quotes'] }); closeModal(); },
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/quotes/${id}/status`, { status }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['quotes'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/quotes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['quotes'] }),
  });

  function openCreate() {
    setEditing(null);
    setForm({ title: '', validUntil: '', notes: '', lines: [{ ...EMPTY_LINE }] });
    setShowModal(true);
  }

  function openEdit(q: Quote) {
    setEditing(q);
    setForm({
      title: q.title,
      validUntil: q.validUntil ? q.validUntil.split('T')[0] : '',
      notes: '',
      lines: q.lines.map(l => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })),
    });
    setShowModal(true);
  }

  function closeModal() { setShowModal(false); setEditing(null); }

  function updateLine(i: number, field: keyof QuoteLine, value: string | number) {
    setForm(f => {
      const lines = [...f.lines];
      lines[i] = { ...lines[i], [field]: value };
      return { ...f, lines };
    });
  }

  function addLine() { setForm(f => ({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] })); }
  function removeLine(i: number) { setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) })); }

  const lineTotal = form.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);

  if (isLoading) return <div className="p-8 text-gray-500">Loading…</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText size={24} className="text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Quotes & Proposals</h1>
            <p className="text-sm text-gray-500">Create and manage sales quotes</p>
          </div>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium">
          <Plus size={16} /> New Quote
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {quotes.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl py-16 text-center text-gray-400">
            <FileText size={40} className="mx-auto mb-3 opacity-30" />
            <p>No quotes yet. Create your first proposal.</p>
          </div>
        ) : (
          quotes.map(q => (
            <div key={q.id} data-testid="quote-card" className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-gray-900">{q.title}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[q.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {q.status}
                    </span>
                  </div>
                  {q.deal && <p className="text-xs text-gray-500">Deal: {q.deal.title}</p>}
                  <p className="text-xs text-gray-400 mt-0.5">{new Date(q.createdAt).toLocaleDateString()}</p>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-1 text-xl font-bold text-gray-900">
                    <DollarSign size={18} className="text-green-500" />
                    {(q.lines?.reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice), 0) ?? 0)
                      .toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </div>
                  {q.validUntil && (
                    <p className="text-xs text-gray-400">Valid until {new Date(q.validUntil).toLocaleDateString()}</p>
                  )}
                </div>
              </div>

              {/* Line preview */}
              {q.lines?.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <div className="space-y-1">
                    {q.lines.slice(0, 3).map((l, i) => (
                      <div key={i} className="flex justify-between text-xs text-gray-500">
                        <span>{l.description} × {Number(l.quantity)}</span>
                        <span>${(Number(l.quantity) * Number(l.unitPrice)).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                      </div>
                    ))}
                    {q.lines.length > 3 && <p className="text-xs text-gray-400">+{q.lines.length - 3} more items</p>}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 mt-4">
                {q.status === 'DRAFT' && (
                  <button onClick={() => changeStatus.mutate({ id: q.id, status: 'SENT' })}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-xs font-medium hover:bg-blue-100">
                    <Send size={12} /> Send
                  </button>
                )}
                {q.status === 'SENT' && (
                  <>
                    <button onClick={() => changeStatus.mutate({ id: q.id, status: 'ACCEPTED' })}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg text-xs font-medium hover:bg-green-100">
                      <CheckCircle size={12} /> Accept
                    </button>
                    <button onClick={() => changeStatus.mutate({ id: q.id, status: 'REJECTED' })}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-700 rounded-lg text-xs font-medium hover:bg-red-100">
                      <XCircle size={12} /> Reject
                    </button>
                  </>
                )}
                <RowActions items={[
                  { label: 'Edit quote', icon: <Pencil size={14} />, onClick: () => openEdit(q), hidden: q.status !== 'DRAFT' },
                  { label: 'Delete quote', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this quote?')) remove.mutate(q.id); }, variant: 'danger' },
                ]} />
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-xl font-bold mb-5">{editing ? 'Edit Quote' : 'New Quote'}</h2>

            <div className="space-y-3">
              {!editing && quoteTemplates && quoteTemplates.length > 0 && (
                <div className="form-section">
                  <p className="form-section-title flex items-center gap-1.5"><LayoutTemplate size={13} /> Start from a template</p>
                  <SearchableSelect
                    ariaLabel="Template"
                    value=""
                    onChange={val => {
                      const t = quoteTemplates.find(t => t.id === val);
                      if (t) setForm(f => ({ ...f, lines: t.lines.map(l => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })) }));
                    }}
                    options={quoteTemplates.map(t => ({ value: t.id, label: t.name }))}
                    placeholder="— none, start blank —"
                  />
                </div>
              )}
              <div className="form-section">
                <p className="form-section-title">Quote Details</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="form-label">Title <span className="req">*</span></label>
                    <input className="ui-input" aria-label="Title" placeholder="e.g. Proposal for Acme Corp"
                      value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Valid Until</label>
                    <input type="date" className="ui-input"
                      value={form.validUntil} onChange={e => setForm(f => ({ ...f, validUntil: e.target.value }))} />
                  </div>
                </div>
              </div>

              {/* Line items */}
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
                        aria-label="Description" placeholder="Service description"
                        value={line.description}
                        onChange={e => updateLine(i, 'description', e.target.value)} />
                      <input type="number" min="1" aria-label="Qty" className="col-span-2 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center"
                        value={line.quantity}
                        onChange={e => updateLine(i, 'quantity', Number(e.target.value))} />
                      <input type="number" min="0" step="0.01" className="col-span-3 border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
                        aria-label="Price" placeholder="0.00"
                        value={line.unitPrice}
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

              {editing && <Attachments entityType="QUOTE" entityId={editing.id} />}

              {/* Total */}
              <div className="flex justify-end pt-2 border-t border-gray-100">
                <div className="text-right">
                  <span className="text-sm text-gray-500">Total: </span>
                  <span className="text-lg font-bold text-gray-900">${lineTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>

            <div className="flex gap-3 mt-5">
              <button onClick={closeModal} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button
                disabled={!form.title || form.lines.length === 0 || save.isPending}
                onClick={() => save.mutate(form)}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {save.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Quote'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
