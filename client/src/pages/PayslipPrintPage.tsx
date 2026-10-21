import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Wallet, Printer, FileDown } from 'lucide-react';
import { Button, EmptyState } from '../shared/components';
import { usePayslipHtml, downloadPdf } from '../api/payslipTemplates';
import { isNative } from '../native/platform';

// Authenticated, in-app print view. Since phase 4 the document itself is
// rendered on the server (utils/payslipRender.ts) from the payslip's pinned
// template, so what prints here, what the PDF contains and what the employee
// receives by e-mail are the same layout. This page only adds the toolbar.
// Managers can pass ?templateId= to preview a payslip in another template.
export default function PayslipPrintPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const templateId = params.get('templateId') ?? undefined;
  const { data, isLoading, error } = usePayslipHtml(id, templateId);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameH, setFrameH] = useState(900);
  // Custom HTML templates arrive as a complete, author-written document. It is
  // shown in a sandboxed iframe — no allow-scripts, so nothing in it can run or
  // reach this app's tokens/DOM. allow-same-origin only lets THIS page size the
  // frame to its content and print it (the frame itself can't run code to use
  // it); allow-modals is what lets its print dialog open.
  // body, not documentElement: the latter is never shorter than the frame itself, so it could only grow.
  const fit = () => { const d = frameRef.current?.contentDocument; if (d?.body) setFrameH(Math.max(400, Math.ceil(d.body.getBoundingClientRect().height) + 4)); };
  useEffect(() => { if (!data?.isolated) return; window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }, [data?.isolated]);
  const print = () => (data?.isolated ? frameRef.current?.contentWindow?.print() : window.print());

  if (isLoading) {
    return (
      <div className="min-h-screen bg-canvas py-8 px-4 sm:py-14" aria-hidden="true">
        <div className="max-w-2xl mx-auto space-y-3">
          <div className="skeleton h-9 w-40 ml-auto" />
          <div className="skeleton h-[560px] w-full rounded-card" />
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <EmptyState icon={<Wallet />} title={(error as any)?.response?.data?.error || 'This payslip could not be found.'} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas py-8 px-4 sm:py-12 print:py-0 print:px-0 print:bg-white">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-end gap-2 mb-3 no-print print:hidden">
          <Button variant="secondary" icon={<FileDown size={14} />} loading={busy} onClick={async () => { setBusy(true); try { await downloadPdf(`/hr/payroll/payslips/${id}/pdf${templateId ? `?templateId=${templateId}` : ''}`, `payslip-${id}.pdf`); } finally { setBusy(false); } }}>
            Download PDF
          </Button>
          {/* window.print() is a no-op inside the Android WebView — the PDF
              (opened through the share sheet) is the printable copy there. */}
          {!isNative && <Button icon={<Printer size={14} />} onClick={print}>Print</Button>}
        </div>
        {data.isolated ? (
          <iframe
            ref={frameRef} title="Payslip" srcDoc={data.html} sandbox="allow-same-origin allow-modals" referrerPolicy="no-referrer" onLoad={fit}
            className="block w-full rounded-card shadow-card bg-white border-0 print:shadow-none print:rounded-none" style={{ height: frameH }}
          />
        ) : (
          <div className="rounded-card shadow-card overflow-x-auto overflow-y-hidden bg-white print:shadow-none print:rounded-none print:overflow-visible" dangerouslySetInnerHTML={{ __html: data.html }} />
        )}
      </div>
      <style>{`@media print { @page { margin: 1.4cm; } body { background: white; } }`}</style>
    </div>
  );
}
