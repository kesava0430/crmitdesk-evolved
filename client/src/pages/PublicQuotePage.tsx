import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Loader2, FileText, CheckCircle2, ShieldCheck, Eraser } from 'lucide-react';
import { api } from '../api/client';

interface QuoteLine { id: string; description: string; quantity: string; unitPrice: string; discount: string }
interface Quote {
  id: string; title: string; status: string; notes?: string; validUntil?: string;
  lines: QuoteLine[]; org: { name: string }; deal?: { title: string } | null;
  signerName?: string; signedAt?: string;
}

function lineTotal(l: QuoteLine) {
  const qty = Number(l.quantity), price = Number(l.unitPrice), disc = Number(l.discount) || 0;
  return qty * price * (1 - disc / 100);
}

/** Hand-drawn signature pad on a <canvas>. The parent owns `canvasRef` and
 *  reads it directly via `canvas.toDataURL()` on submit — the drawing itself
 *  never needs to trigger a re-render, only whether it's empty does. */
function SignaturePad({ canvasRef, onChange }: { canvasRef: React.RefObject<HTMLCanvasElement>; onChange: (hasSignature: boolean) => void }) {
  const drawingRef = useRef(false);
  const hasDrawnRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = true;
    lastPointRef.current = point(e);
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const p = point(e);
    const last = lastPointRef.current;
    if (last) {
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    lastPointRef.current = p;
    if (!hasDrawnRef.current) { hasDrawnRef.current = true; onChange(true); }
  }

  function end() { drawingRef.current = false; lastPointRef.current = null; }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawnRef.current = false;
    onChange(false);
  }

  return (
    <div>
      <div className="border border-gray-200 rounded-xl bg-white overflow-hidden touch-none">
        <canvas
          ref={canvasRef}
          width={500}
          height={150}
          className="w-full h-[150px] touch-none cursor-crosshair"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
        />
      </div>
      <button type="button" onClick={clear} className="mt-1.5 flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600">
        <Eraser size={12} /> Clear signature
      </button>
    </div>
  );
}

// Public, token-secured — no auth. Customers land here from a link a sales
// rep copies off the Quote detail page ("Copy customer link"). See
// quotes.controller.ts publicView/publicAccept.
export function PublicQuotePage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') || '';

  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!id || !token) { setError('This link is invalid.'); setLoading(false); return; }
    api.get(`/quotes/public/${id}`, { params: { t: token } })
      .then(res => setQuote(res.data))
      .catch(() => setError('This quote could not be found, or the link has expired.'))
      .finally(() => setLoading(false));
  }, [id, token]);

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed) return;
    setSubmitting(true); setError('');
    try {
      const signatureImage = hasSignature ? signatureCanvasRef.current?.toDataURL('image/png') : undefined;
      const res = await api.post(`/quotes/public/${id}/accept`, { token, signerName, signerEmail, agreed: true, signatureImage });
      setQuote(res.data);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.message || 'Could not submit your acceptance. Please try again.');
    } finally { setSubmitting(false); }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-gray-400" /></div>;
  }
  if (error && !quote) {
    return <div className="min-h-screen flex items-center justify-center p-6"><p className="text-sm text-gray-500">{error}</p></div>;
  }
  if (!quote) return null;

  const total = quote.lines.reduce((s, l) => s + lineTotal(l), 0);

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:py-14">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-5 py-5 sm:px-8 sm:py-6 border-b border-gray-100">
            <p className="text-xs text-gray-400">{quote.org.name}</p>
            <h1 className="text-lg sm:text-xl font-semibold text-gray-900 mt-0.5 flex items-center gap-2">
              <FileText size={18} className="text-brand-500 shrink-0" /> {quote.title}
            </h1>
            {quote.deal?.title && <p className="text-xs text-gray-400 mt-1">Re: {quote.deal.title}</p>}
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
                {quote.lines.map(l => (
                  <tr key={l.id}>
                    <td className="py-2.5 text-gray-800">{l.description}</td>
                    <td className="py-2.5 text-right text-gray-600">{l.quantity}</td>
                    <td className="py-2.5 text-right text-gray-600">${Number(l.unitPrice).toFixed(2)}</td>
                    <td className="py-2.5 text-right font-medium text-gray-900">${lineTotal(l).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end mt-4 pt-4 border-t border-gray-100">
              <div className="text-right">
                <p className="text-xs text-gray-400">Total</p>
                <p className="text-xl font-semibold text-gray-900">${total.toFixed(2)}</p>
              </div>
            </div>
            {quote.notes && <p className="text-sm text-gray-500 mt-4 whitespace-pre-wrap">{quote.notes}</p>}
          </div>

          <div className="px-5 py-5 sm:px-8 sm:py-6 bg-gray-50 border-t border-gray-100">
            {quote.status === 'ACCEPTED' ? (
              <div className="flex items-start gap-3 text-green-700">
                <CheckCircle2 size={20} className="shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-sm">Accepted{quote.signerName ? ` by ${quote.signerName}` : ''}</p>
                  {quote.signedAt && <p className="text-xs text-green-600 mt-0.5">{new Date(quote.signedAt).toLocaleString()}</p>}
                </div>
              </div>
            ) : quote.status === 'REJECTED' ? (
              <p className="text-sm text-gray-500">This quote is no longer available for acceptance.</p>
            ) : (
              <form onSubmit={handleAccept} className="space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                  <ShieldCheck size={13} /> Accept this quote
                </p>
                {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
                <div className="grid sm:grid-cols-2 gap-3">
                  <input
                    required value={signerName} onChange={e => setSignerName(e.target.value)}
                    placeholder="Your full name" className="px-3.5 py-2.5 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <input
                    required type="email" value={signerEmail} onChange={e => setSignerEmail(e.target.value)}
                    placeholder="you@company.com" className="px-3.5 py-2.5 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Draw your signature</label>
                  <SignaturePad canvasRef={signatureCanvasRef} onChange={setHasSignature} />
                </div>
                <label className="flex items-start gap-2 text-xs text-gray-500">
                  <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} className="mt-0.5" />
                  Signing above and checking this box constitutes my electronic signature and acceptance of this quote.
                </label>
                <button
                  type="submit" disabled={!agreed || submitting}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium px-6 py-2.5 rounded-xl text-sm transition-colors"
                >
                  {submitting && <Loader2 size={14} className="animate-spin" />}
                  {submitting ? 'Submitting…' : 'Accept & Sign'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
