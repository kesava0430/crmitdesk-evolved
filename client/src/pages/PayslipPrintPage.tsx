import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Wallet, Printer } from 'lucide-react';
import { api } from '../api/client';
import { useFormat } from '../hooks/useFormat';
import { Card, Button, Badge, Spinner, EmptyState } from '../shared/components';

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Payslip {
  id: string; payslipNumber: string; month: number; year: number;
  basic: string; hra: string; allowances: string; grossPay: string;
  pf: string; professionalTax: string; otherDeductions: string; totalDeductions: string; netPay: string;
  status: string; paidAt: string | null; createdAt: string;
  user: { name: string; email: string; department?: string | null };
  org: { name: string };
}

interface PayslipTemplate {
  companyName: string | null; companyAddress: string | null; logoUrl: string | null;
  primaryColor: string; footerNote: string | null;
  showSignature: boolean; signatureLabel: string;
}

// Authenticated, in-app (not the public token-shared kind — see
// PublicInvoicePage.tsx for that pattern). Opened in a new tab from a
// payslip's "Print / Save as PDF" button; renders full-page with no sidebar
// chrome so the browser's native print dialog produces a clean one-pager,
// same approach as the Invoice document (no server-side PDF library).
//
// `template.primaryColor` is customer-configured branding stored per org, so
// it stays an inline style rather than a token — it is data, not theme.
export default function PayslipPrintPage() {
  const { money, date } = useFormat();
  const { id } = useParams();
  const [payslip, setPayslip] = useState<Payslip | null>(null);
  const [template, setTemplate] = useState<PayslipTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.get(`/hr/payroll/payslips/${id}`),
      api.get('/hr/payroll/template'),
    ])
      .then(([p, t]) => { setPayslip(p.data); setTemplate(t.data); })
      .catch(err => setError(err?.response?.data?.error || 'This payslip could not be found.'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Spinner label={null} /></div>;
  }
  if (error || !payslip || !template) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <EmptyState icon={<Wallet />} title={error || 'Payslip not found.'} />
      </div>
    );
  }

  const companyName = template.companyName || payslip.org.name;

  return (
    <div className="min-h-screen bg-canvas py-8 px-4 sm:py-14 print:py-0 print:px-0">
      <div className="max-w-2xl mx-auto">
        <div className="flex justify-end mb-3 print:hidden">
          <Button icon={<Printer size={14} />} onClick={() => window.print()}>
            Print / Save as PDF
          </Button>
        </div>

        <Card padding="none" className="overflow-hidden print:shadow-none print:border-0 print:rounded-none">
          <div className="px-5 py-5 sm:px-8 sm:py-6 border-b-2 flex items-start justify-between flex-wrap gap-3" style={{ borderColor: template.primaryColor }}>
            <div className="flex items-center gap-3">
              {template.logoUrl && <img src={template.logoUrl} alt="" className="w-10 h-10 rounded object-contain shrink-0" />}
              <div>
                <p className="text-lg font-semibold text-fg">{companyName}</p>
                {template.companyAddress && <p className="text-xs text-fg-subtle whitespace-pre-line mt-0.5">{template.companyAddress}</p>}
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold flex items-center gap-1.5 justify-end" style={{ color: template.primaryColor }}>
                <Wallet size={14} /> Payslip
              </p>
              <p className="text-xs text-fg-subtle mt-0.5">{MONTH_NAMES[payslip.month]} {payslip.year}</p>
              <p className="text-xs text-fg-subtle font-mono">{payslip.payslipNumber}</p>
            </div>
          </div>

          <div className="px-5 py-4 sm:px-8 border-b border-line-subtle flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-medium text-fg">{payslip.user.name}</p>
              <p className="text-xs text-fg-subtle">{payslip.user.department || payslip.user.email}</p>
            </div>
            <Badge variant={payslip.status === 'PAID' ? 'green' : 'yellow'}>
              {payslip.status === 'PAID' ? `Paid${payslip.paidAt ? ' on ' + date(payslip.paidAt) : ''}` : 'Generated'}
            </Badge>
          </div>

          <div className="px-5 py-5 sm:px-8 sm:py-6">
            <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
              <p className="text-fg-muted">Basic</p><p className="text-right text-fg">{money(payslip.basic)}</p>
              <p className="text-fg-muted">HRA</p><p className="text-right text-fg">{money(payslip.hra)}</p>
              <p className="text-fg-muted">Allowances</p><p className="text-right text-fg">{money(payslip.allowances)}</p>
              <p className="font-medium text-fg border-t border-line-subtle pt-2">Gross Pay</p>
              <p className="text-right font-medium text-fg border-t border-line-subtle pt-2">{money(payslip.grossPay)}</p>
              <p className="text-fg-muted mt-1.5">Provident Fund</p><p className="text-right text-fg-muted mt-1.5">-{money(payslip.pf)}</p>
              <p className="text-fg-muted">Professional Tax</p><p className="text-right text-fg-muted">-{money(payslip.professionalTax)}</p>
              <p className="text-fg-muted">Other Deductions</p><p className="text-right text-fg-muted">-{money(payslip.otherDeductions)}</p>
              <p className="font-medium text-fg border-t border-line-subtle pt-2">Total Deductions</p>
              <p className="text-right font-medium text-fg border-t border-line-subtle pt-2">-{money(payslip.totalDeductions)}</p>
            </div>

            <div className="flex justify-end mt-4 pt-4 border-t-2" style={{ borderColor: template.primaryColor }}>
              <div className="text-right">
                <p className="text-xs text-fg-subtle">Net Pay</p>
                <p className="text-2xl font-bold text-fg">{money(payslip.netPay)}</p>
              </div>
            </div>

            {template.showSignature && (
              <div className="mt-10 pt-3 border-t border-dashed border-line-strong w-48 ml-auto text-center">
                <p className="text-xs text-fg-muted">{template.signatureLabel}</p>
              </div>
            )}
            {template.footerNote && <p className="text-[11px] text-fg-subtle mt-6 text-center">{template.footerNote}</p>}
          </div>
        </Card>
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
