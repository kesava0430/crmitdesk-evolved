import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { RowActions, EmptyState, Badge } from '../shared/components';
import { Receipt, Plus, Pencil, Trash2, Link2, Check as CheckIcon, Send } from 'lucide-react';
import { useFormat } from '../hooks/useFormat';

interface InvoiceLine { id?: string; description: string; quantity: number; unitPrice: number; discount: number }
interface Invoice {
  id: string; invoiceNumber: string; title: string; status: string;
  dueDate: string | null; paidAt: string | null; taxRate: number; createdAt: string;
  deal?: { title: string } | null; quote?: { title: string } | null; lines: InvoiceLine[];
}

const STATUS_VARIANT: Record<string, any> = {
  DRAFT: 'gray', SENT: 'blue', PAID: 'green', OVERDUE: 'red', VOID: 'gray',
};

const EMPTY_LINE: InvoiceLine = { description: '', quantity: 1, unitPrice: 0, discount: 0 };

function lineTotal(l: InvoiceLine) {
  return Number(l.quantity) * Number(l.unitPrice) * (1 - (Number(l.discount) || 0) / 100);
}

export default function InvoicesPage() {
  const qc = useQueryClient();
  const { money, date } = useFormat();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [form, setForm] = useState({ title: '', dueDate: '', notes: '', taxRate: 0, lines: [{ ...EMPTY_LINE }] });
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: invoices = [], isLoading } = useQuery<Invoice[]>({
    queryKey: ['invoices'],
    queryFn: () => api.get('/invoices').then(r => r.data.data ?? r.data),
  });

  const save = useMutation({
    mutationFn: (body: typeof form) =>
      editing
        ? api.patch(`/invoices/${editing.id}`, body).then(r => r.data)
        : api.post('/invoices', body).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invoices'] }); closeModal(); },
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/invoices/${id}/status`, { status }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/invoices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });

  async function copyShareLink(id: string) {
    try {
      const { data } = await api.get(`/invoices/${id}/share-link`);
      await navigator.clipboard.writeText(data.link);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch { alert('Could not generate share link.'); }
  }

  function openCreate() {
    setEditing(null);
    setForm({ title: '', dueDate: '', notes: '', taxRate: 0, lines: [{ ...EMPTY_LINE }] });
    setShowModal(true);
  }

  function openEdit(inv: Invoice) {
    setEditing(inv);
    setForm({
      title: inv.title,
      dueDate: inv.dueDate ? inv.dueDate.split('T')[0] : '',
      notes: '',
      taxRate: Number(inv.taxRate) || 0,
      lines: inv.lines.map(l => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discount: Number(l.discount) || 0 })),
    });
    setShowModal(true);
  }

  function closeModal() { setShowModal(false); setEditing(null); }

  function updateLine(i: number, field: keyof InvoiceLine, value: string | number) {
    setForm(f => {
      const lines = [...f.lines];
      lines[i] = { ...lines[i], [field]: value };
      return { ...f, lines };
    });
  }
  function addLine() { setForm(f => ({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] })); }
  function removeLine(i: number) { setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) })); }

  const subtotal = form.lines.reduce((s, l) => s + lineTotal(l), 0);
  const taxAmount = subtotal * (Number(form.taxRate) / 100);
  const grandTotal = subtotal + taxAmount;

  if (isLoading) return <div className="p-8 text-gray-500 dark:text-gray-400">Loading…</div>;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Receipt size={24} className="text-brand-600 shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Invoices</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Generate, send and track payment status</p>
          </div>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium">
          <Plus size={16} /> New Invoice
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {invoices.length === 0 ? (
          <EmptyState icon={<Receipt size={22} />} title="No invoices yet" description="Create one manually, or accept a quote to auto-generate one" />
        ) : (
          invoices.map(inv => {
            const total = inv.lines.reduce((s, l) => s + lineTotal(l), 0) * (1 + (Number(inv.taxRate) || 0) / 100);
            return (
              <div key={inv.id} className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow dark:bg-gray-900 dark:border-gray-800">
                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-xs font-mono text-gray-400 dark:text-gray-500">{inv.invoiceNumber}</span>
                      <h3 className="font-semibold text-gray-900 dark:text-white">{inv.title}</h3>
                      <Badge variant={STATUS_VARIANT[inv.status] ?? 'gray'}>{inv.status}</Badge>
                    </div>
                    {inv.deal?.title && <p className="text-xs text-gray-500 dark:text-gray-400">Deal: {inv.deal.title}</p>}
                    {inv.quote?.title && <p className="text-xs text-gray-400 dark:text-gray-500">From quote: {inv.quote.title}</p>}
                    <p className="text-xs text-gray-400 mt-0.5 dark:text-gray-500">{date(inv.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <div className="flex items-center gap-1 text-xl font-bold text-gray-900 dark:text-white">
                      {money(total)}
                    </div>
                    {inv.dueDate && <p className="text-xs text-gray-400 dark:text-gray-500">Due {date(inv.dueDate)}</p>}
                    {inv.paidAt && <p className="text-xs text-green-600 dark:text-green-400">Paid {date(inv.paidAt)}</p>}
                  </div>
                </div>

                {inv.lines?.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                    <div className="space-y-1">
                      {inv.lines.slice(0, 3).map((l, i) => (
                        <div key={i} className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                          <span>{l.description} × {Number(l.quantity)}</span>
                          <span>{money(lineTotal(l))}</span>
                        </div>
                      ))}
                      {inv.lines.length > 3 && <p className="text-xs text-gray-400 dark:text-gray-500">+{inv.lines.length - 3} more items</p>}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 mt-4 flex-wrap">
                  {inv.status === 'DRAFT' && (
                    <button onClick={() => changeStatus.mutate({ id: inv.id, status: 'SENT' })}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-xs font-medium hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20">
                      <Send size={12} /> Send
                    </button>
                  )}
                  {(inv.status === 'SENT' || inv.status === 'OVERDUE') && (
                    <button onClick={() => changeStatus.mutate({ id: inv.id, status: 'PAID' })}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg text-xs font-medium hover:bg-green-100 dark:bg-green-500/10 dark:text-green-300 dark:hover:bg-green-500/20">
                      <CheckIcon size={12} /> Mark Paid
                    </button>
                  )}
                  {inv.status !== 'DRAFT' && (
                    <button onClick={() => copyShareLink(inv.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 text-gray-600 rounded-lg text-xs font-medium hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">
                      {copiedId === inv.id ? <><CheckIcon size={12} /> Copied</> : <><Link2 size={12} /> Copy customer link</>}
                    </button>
                  )}
                  <RowActions items={[
                    { label: 'Edit invoice', icon: <Pencil size={14} />, onClick: () => openEdit(inv), hidden: inv.status === 'PAID' || inv.status === 'VOID' },
                    { label: 'Void invoice', icon: <Trash2 size={14} />, onClick: () => changeStatus.mutate({ id: inv.id, status: 'VOID' }), hidden: inv.status === 'PAID' || inv.status === 'VOID' },
                    { label: 'Delete invoice', icon: <Trash2 size={14} />, onClick: () => { if (confirm('Delete this invoice?')) remove.mutate(inv.id); }, variant: 'danger' },
                  ]} />
                </div>
              </div>
            );
          })
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 dark:bg-gray-900">
            <h2 className="text-xl font-bold mb-5 text-gray-900 dark:text-white">{editing ? 'Edit Invoice' : 'New Invoice'}</h2>

            <div className="space-y-3">
              <div className="form-section">
                <p className="form-section-title">Invoice Details</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="form-label">Title <span className="req">*</span></label>
                    <input className="ui-input" aria-label="Title" placeholder="e.g. Services for Acme Corp"
                      value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Due Date</label>
                    <input type="date" className="ui-input"
                      value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                  </div>
                </div>
                <div className="mt-3">
                  <label className="form-label">Tax rate (%)</label>
                  <input type="number" min={0} max={100} step="0.01" className="ui-input w-32"
                    value={form.taxRate} onChange={e => setForm(f => ({ ...f, taxRate: Number(e.target.value) }))} />
                </div>
                <div className="mt-3">
                  <label className="form-label">Notes (optional)</label>
                  <textarea className="ui-input" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                </div>
              </div>

              <div className="form-section">
                <p className="form-section-title">Line Items</p>
                <div className="space-y-2">
                  <div className="grid grid-cols-12 gap-2 text-xs font-semibold text-gray-500 uppercase px-1 dark:text-gray-400">
                    <div className="col-span-5">Description</div>
                    <div className="col-span-2">Qty</div>
                    <div className="col-span-2">Price</div>
                    <div className="col-span-2">Disc %</div>
                    <div className="col-span-1"></div>
                  </div>
                  {form.lines.map((line, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2">
                      <input className="col-span-5 border border-gray-200 rounded-lg px-2 py-1.5 text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                        aria-label="Description" placeholder="Item description"
                        value={line.description}
                        onChange={e => updateLine(i, 'description', e.target.value)} />
                      <input type="number" min="1" aria-label="Qty" className="col-span-2 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                        value={line.quantity}
                        onChange={e => updateLine(i, 'quantity', Number(e.target.value))} />
                      <input type="number" min="0" step="0.01" className="col-span-2 border border-gray-200 rounded-lg px-2 py-1.5 text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                        aria-label="Price" placeholder="0.00"
                        value={line.unitPrice}
                        onChange={e => updateLine(i, 'unitPrice', Number(e.target.value))} />
                      <input type="number" min="0" max="100" className="col-span-2 border border-gray-200 rounded-lg px-2 py-1.5 text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                        aria-label="Discount" placeholder="0"
                        value={line.discount}
                        onChange={e => updateLine(i, 'discount', Number(e.target.value))} />
                      <button onClick={() => removeLine(i)} disabled={form.lines.length === 1}
                        className="col-span-1 p-1 text-gray-300 hover:text-red-500 disabled:opacity-0 dark:text-gray-600 dark:hover:text-red-400">
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

            <div className="flex justify-end pt-4 mt-3 border-t border-gray-100 dark:border-gray-800">
              <div className="text-right text-sm space-y-0.5">
                <p className="text-gray-500 dark:text-gray-400">Subtotal: <span className="text-gray-800 font-medium dark:text-gray-200">{money(subtotal)}</span></p>
                {Number(form.taxRate) > 0 && <p className="text-gray-500 dark:text-gray-400">Tax ({form.taxRate}%): <span className="text-gray-800 font-medium dark:text-gray-200">{money(taxAmount)}</span></p>}
                <p className="text-lg font-bold text-gray-900 dark:text-white">{money(grandTotal)}</p>
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={closeModal} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">Cancel</button>
              <button
                disabled={!form.title || form.lines.length === 0 || save.isPending}
                onClick={() => save.mutate(form)}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {save.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Invoice'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
