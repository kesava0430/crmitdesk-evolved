import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Loader2, Receipt, Printer } from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency } from '../utils/format';

interface InvoiceLine { id: string; description: string; quantity: string; unitPrice: string; discount: string }
interface Invoice {
  id: string; invoiceNumber: string; title: string; status: string;
  dueDate?: string; paidAt?: string; taxRate: string; createdAt: string;
  lines: InvoiceLine[]; org: { name: string; currency?: string }; deal?: { title: string } | null;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', SENT: 'Payment Due', PAID: 'Paid', OVERDUE: 'Overdue', VOID: 'Void',
};
const STATUS_COLOR: Record<string, string> = {
  DRAFT: 'text-gray-500 bg-gray-100', SENT: 'text-blue-700 bg-blue-50',
  PAID: 'text-green-700 bg-green-50', OVERDUE: 'text-red-700 bg-red-50', VOID: 'text-gray-500 bg-gray-100',
};

function lineTotal(l: InvoiceLine) {
  const qty = Number(l.quantity), price = Number(l.unitPrice), disc = Number(l.discount) || 0;
  return qty * price * (1 - disc / 100);
}

// Public, token-secured — no auth. Print-to-PDF via the browser's native
// print dialog rather than pulling in a server-side PDF library; the layout
// below is print-tuned (see the @media print rules) so "Save as PDF" from
// the browser produces a clean one-pager.
export function PublicInvoicePage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') || '';

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id || !token) { setError('This link is invalid.'); setLoading(false); return; }
    api.get(`/invoices/public/${id}`, { params: { t: token } })
      .then(res => setInvoice(res.data))
      .catch(() => setError('This invoice could not be found, or the link has expired.'))
      .finally(() => setLoading(false));
  }, [id, token]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-gray-400" /></div>;
  }
  if (error && !invoice) {
    return <div className="min-h-screen flex items-center justify-center p-6"><p className="text-sm text-gray-500">{error}</p></div>;
  }
  if (!invoice) return null;

  const subtotal = invoice.lines.reduce((s, l) => s + lineTotal(l), 0);
  const taxRate = Number(invoice.taxRate) || 0;
  const taxAmount = subtotal * (taxRate / 100);
  const total = subtotal + taxAmount;
  const money = (v: number) => formatCurrency(v, invoice.org.currency || 'USD');

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:py-14 print:bg-white print:py-0 print:px-0">
      <div className="max-w-2xl mx-auto">
        <div className="flex justify-end mb-3 print:hidden">
          <button onClick={() => window.print()} className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-xl">
            <Printer size={14} /> Print / Save as PDF
          </button>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden print:shadow-none print:border-0 print:rounded-none">
          <div className="px-5 py-5 sm:px-8 sm:py-6 border-b border-gray-100 flex items-start justify-between flex-wrap gap-3">
            <div>
              <p className="text-xs text-gray-400">{invoice.org.name}</p>
              <h1 className="text-lg sm:text-xl font-semibold text-gray-900 mt-0.5 flex items-center gap-2">
                <Receipt size={18} className="text-brand-500 shrink-0" /> {invoice.title}
              </h1>
              <p className="text-xs text-gray-400 mt-1 font-mono">{invoice.invoiceNumber}</p>
              {invoice.deal?.title && <p className="text-xs text-gray-400 mt-0.5">Re: {invoice.deal.title}</p>}
            </div>
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${STATUS_COLOR[invoice.status] ?? 'text-gray-500 bg-gray-100'}`}>
              {STATUS_LABEL[invoice.status] ?? invoice.status}
            </span>
          </div>

          <div className="px-5 py-3 sm:px-8 grid grid-cols-2 gap-3 text-xs text-gray-500 border-b border-gray-50">
            <p>Issued: {new Date(invoice.createdAt).toLocaleDateString()}</p>
            {invoice.dueDate && <p>Due: {new Date(invoice.dueDate).toLocaleDateString()}</p>}
            {invoice.paidAt && <p className="text-green-600 col-span-2">Paid on {new Date(invoice.paidAt).toLocaleDateString()}</p>}
          </div>

          <div className="px-5 py-5 sm:px-8 sm:py-6 overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="text-left text-xs text-gray-400 uppercase tracking-wide">
                  <th className="pb-2 font-medium">Description</th>
                  <th className="pb-2 font-medium text-right">Qty</th>
                  <th className="pb-2 font-medium text-right">Price</th>
                  <th className="pb-2 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {invoice.lines.map(l => (
                  <tr key={l.id}>
                    <td className="py-2.5 text-gray-800">{l.description}</td>
                    <td className="py-2.5 text-right text-gray-600">{l.quantity}</td>
                    <td className="py-2.5 text-right text-gray-600">{money(Number(l.unitPrice))}</td>
                    <td className="py-2.5 text-right font-medium text-gray-900">{money(lineTotal(l))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end mt-4 pt-4 border-t border-gray-100">
              <div className="text-right space-y-0.5">
                <p className="text-xs text-gray-400">Subtotal <span className="text-gray-700 font-medium ml-2">{money(subtotal)}</span></p>
                {taxRate > 0 && <p className="text-xs text-gray-400">Tax ({taxRate}%) <span className="text-gray-700 font-medium ml-2">{money(taxAmount)}</span></p>}
                <p className="text-xl font-semibold text-gray-900 mt-1">{money(total)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @media print {
          @page { margin: 1.5cm; }
          body { background: white; }
        }
      `}</style>
    </div>
  );
}
