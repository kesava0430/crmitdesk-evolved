/**
 * Payslip document model + the two renderers that share it (phase 4).
 *
 *  - buildPayslipDoc()  turns a Payslip row (+ template, employee, org) into a
 *                       plain, render-ready object: every visibility decision
 *                       is made here, once.
 *  - renderPayslipHtml() self-contained HTML (inline CSS) — used by the in-app
 *                       print view, template previews and the e-mail body.
 *  - renderPayslipPdf()  PDFKit — no headless browser, so it runs anywhere the
 *                       API runs (Render free tier included). Same doc, same
 *                       layout registry, so the PDF and the HTML agree.
 *
 * Eight layouts are expressed as *style configs* rather than eight code paths,
 * so adding a ninth is a registry entry.
 *
 * Images (logo, signature, watermark): the HTML just references the URL; the
 * PDF needs the bytes, which loadPdfAssets() fetches through the SSRF-safe
 * loader (utils/safeImageLoader.ts) before drawing. A missing or unsupported
 * image is skipped — the payslip itself always renders.
 */
import PDFDocument from 'pdfkit';
import { loadImage, type LoadedImage } from './safeImageLoader';
import { resolveWatermark, TILE_SCALE, TILE_GAP, type Watermark } from './payslipWatermark';
import { revisionNoteLines } from './payrollRevision';

// ─── Layout registry ─────────────────────────────────────────────────────────

export type LayoutKey = 'STANDARD' | 'MODERN' | 'MINIMAL' | 'DETAILED' | 'COMPACT' | 'CORPORATE' | 'BRANCH' | 'STATEMENT';

export interface LayoutStyle {
  key: LayoutKey;
  name: string;
  description: string;
  /** How the letterhead is drawn */
  header: 'line' | 'band' | 'plain' | 'boxed';
  /** Earnings/deductions side by side or stacked as one statement table */
  columns: 1 | 2;
  /** Font sizing */
  density: 'normal' | 'compact' | 'airy';
  /** Draw table borders around every cell (formal look) */
  bordered: boolean;
  /** Field defaults for a template created with this layout */
  defaults: Partial<Record<FieldKey, boolean>>;
  /** Show the branch/location block prominently in the header */
  branchHeader?: boolean;
  /** Serif body font (PDF: Times) */
  serif?: boolean;
}

export const LAYOUTS: LayoutStyle[] = [
  { key: 'STANDARD',  name: 'Standard',   description: 'Two columns, accent rule under the letterhead. The classic Indian payslip.', header: 'line',  columns: 2, density: 'normal',  bordered: false, defaults: {} },
  { key: 'MODERN',    name: 'Modern',     description: 'Colour band header, rounded summary tiles, generous spacing.',            header: 'band',  columns: 2, density: 'airy',    bordered: false, defaults: { daysSummary: true } },
  { key: 'MINIMAL',   name: 'Minimal',    description: 'Monochrome, thin rules, no logo band — prints well in black and white.',  header: 'plain', columns: 2, density: 'normal',  bordered: false, defaults: { employerContributions: false, amountInWords: false } },
  { key: 'DETAILED',  name: 'Detailed',   description: 'Every employee field, bank + statutory IDs, days summary, CTC contributions, amount in words.', header: 'line', columns: 2, density: 'normal', bordered: false, defaults: { bankDetails: true, statutoryIds: true, employerContributions: true, amountInWords: true, daysSummary: true, joiningDate: true, costCenter: true, ctc: true } },
  { key: 'COMPACT',   name: 'Compact',    description: 'Dense single page for high-volume printing; small type, no extras.',      header: 'line',  columns: 2, density: 'compact', bordered: true,  defaults: { amountInWords: false, employerContributions: false, signature: false } },
  { key: 'CORPORATE', name: 'Corporate',  description: 'Fully boxed tables, serif body, formal signatory block.',                  header: 'boxed', columns: 2, density: 'normal',  bordered: true,  defaults: { amountInWords: true, signature: true }, serif: true },
  { key: 'BRANCH',    name: 'Branch',     description: 'Branch / office address takes the header; ideal for multi-location orgs.', header: 'band',  columns: 2, density: 'normal',  bordered: false, defaults: { location: true, bankDetails: true }, branchHeader: true },
  { key: 'STATEMENT', name: 'Statement',  description: 'One statement-style table: earnings, then deductions, then net — like a bank statement.', header: 'line', columns: 1, density: 'normal', bordered: true, defaults: { amountInWords: true } },
];
export const layoutFor = (key: string | null | undefined): LayoutStyle => LAYOUTS.find(l => l.key === key) ?? LAYOUTS[0];

// ─── Field visibility ────────────────────────────────────────────────────────

export type FieldKey =
  | 'employeeCode' | 'designation' | 'department' | 'location' | 'joiningDate' | 'costCenter' | 'email'
  | 'bankDetails' | 'statutoryIds' | 'daysSummary' | 'employerContributions' | 'ctc' | 'amountInWords' | 'signature' | 'paidStamp' | 'lineBasis';

export const PAYSLIP_FIELDS: { key: FieldKey; label: string; group: 'Employee' | 'Blocks'; default: boolean }[] = [
  { key: 'employeeCode', label: 'Employee code', group: 'Employee', default: true },
  { key: 'designation', label: 'Designation', group: 'Employee', default: true },
  { key: 'department', label: 'Department', group: 'Employee', default: true },
  { key: 'location', label: 'Location / branch', group: 'Employee', default: false },
  { key: 'joiningDate', label: 'Date of joining', group: 'Employee', default: false },
  { key: 'costCenter', label: 'Cost centre', group: 'Employee', default: false },
  { key: 'email', label: 'Work e-mail', group: 'Employee', default: false },
  { key: 'bankDetails', label: 'Bank name + masked account', group: 'Employee', default: false },
  { key: 'statutoryIds', label: 'PAN / UAN / ESI numbers', group: 'Employee', default: false },
  { key: 'daysSummary', label: 'Working / paid / LOP days + overtime', group: 'Blocks', default: true },
  { key: 'employerContributions', label: 'Employer contributions (PF / ESI)', group: 'Blocks', default: false },
  { key: 'ctc', label: 'Annual CTC', group: 'Blocks', default: false },
  { key: 'amountInWords', label: 'Net pay in words', group: 'Blocks', default: true },
  { key: 'signature', label: 'Signature block', group: 'Blocks', default: true },
  { key: 'paidStamp', label: '"PAID" stamp once paid', group: 'Blocks', default: true },
  { key: 'lineBasis', label: 'Show how each line was calculated', group: 'Blocks', default: false },
];

export function resolveFields(layout: LayoutStyle, stored: any): Record<FieldKey, boolean> {
  const out = {} as Record<FieldKey, boolean>;
  for (const f of PAYSLIP_FIELDS) out[f.key] = stored && typeof stored[f.key] === 'boolean' ? stored[f.key] : (layout.defaults[f.key] ?? f.default);
  return out;
}

// ─── Document model ──────────────────────────────────────────────────────────

export interface PayslipLoanRow { name: string; type?: string; principal: number; recoveredThisPeriod: number; totalRecovered: number; outstanding: number; emiLabel: string | null }
export interface DocLine { code: string; name: string; amount: number; basis?: string | null }
export interface PayslipDoc {
  layout: LayoutStyle;
  fields: Record<FieldKey, boolean>;
  currency: string;
  locale: string;
  company: { name: string; address: string | null; logoUrl: string | null; branch: string | null; branchAddress: string | null };
  brand: { primary: string; accent: string; title: string; headerNote: string | null; footerNote: string | null; signatureLabel: string; signatoryName: string | null; signatureUrl: string | null; showSignature: boolean };
  payslip: { number: string; periodLabel: string; periodStart: string | null; periodEnd: string | null; status: string; paidAt: string | null; generatedAt: string; cycleName: string | null };
  employee: { name: string; code: string | null; designation: string | null; department: string | null; location: string | null; joiningDate: string | null; costCenter: string | null; email: string | null; bankName: string | null; bankAccountMasked: string | null; bankIfsc: string | null; pan: string | null; uan: string | null; esi: string | null };
  days: { working: number; paid: number; present: number; leave: number; half: number; lop: number; overtimeHours: number } | null;
  earnings: DocLine[];
  reimbursements: DocLine[];
  deductions: DocLine[];
  employerContributions: DocLine[];
  totals: { earnings: number; reimbursements: number; deductions: number; employer: number; net: number; ctcAnnual: number | null; unrecovered?: number };
  netInWords: string;
  /** Effective watermark (null = none) — see utils/payslipWatermark.ts */
  watermark: Watermark | null;
  /** "Loans & advances" block (utils/payrollLoans.ts payslipLoanSummary) — empty = not printed */
  loans: PayslipLoanRow[];
  /** Set on a revised payslip (version ≥ 2) — prints a one-line "Revised" note; layouts are otherwise unchanged */
  revision: { version: number; supersedesIssuedAt: string | null; paidDifference: number | null } | null;
}

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const n = (v: any) => (v == null ? 0 : Number(v));
const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const mask = (acct: string | null | undefined) => (acct ? acct.replace(/.(?=.{4})/g, 'X') : null);

export function buildPayslipDoc(input: {
  payslip: any; template: any; employee: any | null; org: { name: string; currency: string };
  /** Issue date of the version this payslip supersedes (from its latest PayslipRevision) */
  supersedesIssuedAt?: string | null;
  /** Loans & advances summary for this payslip (loans.controller.ts loanSummaryForPayslip) */
  loans?: PayslipLoanRow[] | null;
}): PayslipDoc {
  const { payslip: p, template: t, employee: e, org } = input;
  const layout = layoutFor(t?.layout);
  const fields = resolveFields(layout, t?.showFields);
  const lines: any[] = (p.lines ?? []).slice().sort((a: any, b: any) => a.displayOrder - b.displayOrder);
  // Zero-amount lines (e.g. "Loss of Pay 0.00", an unused allowance) are noise
  // on the employee's document; the run review still lists them.
  const visible = lines.filter(l => l.showOnPayslip !== false && n(l.amount) !== 0);
  const toLine = (l: any): DocLine => ({ code: l.code, name: l.name, amount: n(l.amount), basis: l.basis ?? null });
  const legacy = lines.length === 0;
  const earnings = legacy
    ? [{ code: 'BASIC', name: 'Basic', amount: n(p.basic) }, { code: 'HRA', name: 'HRA', amount: n(p.hra) }, { code: 'ALLOW', name: 'Allowances', amount: n(p.allowances) }].filter(l => l.amount)
    : visible.filter(l => l.category === 'EARNING').map(toLine);
  const deductions = legacy
    ? [{ code: 'PF', name: 'Provident Fund', amount: n(p.pf) }, { code: 'PT', name: 'Professional Tax', amount: n(p.professionalTax) }, { code: 'OTH', name: 'Other Deductions', amount: n(p.otherDeductions) }].filter(l => l.amount)
    : visible.filter(l => l.category === 'DEDUCTION').map(toLine);
  const reimbursements = legacy ? [] : visible.filter(l => l.category === 'REIMBURSEMENT').map(toLine);
  const employerContributions = legacy ? [] : lines.filter(l => l.category === 'EMPLOYER_CONTRIBUTION').map(toLine);
  const totals = {
    earnings: n(p.totalEarnings ?? p.grossPay), reimbursements: n(p.totalReimbursements), deductions: n(p.totalDeductions),
    employer: n(p.employerContributions), net: n(p.netPay), ctcAnnual: p.employeeSalary?.ctcAnnual != null ? n(p.employeeSalary.ctcAnnual) : null,
    unrecovered: n(p.unrecoveredDeductions),
  };
  const cycle = p.payrollRun?.payrollCycle ?? null;
  const periodLabel = cycle && cycle.frequency !== 'MONTHLY' && p.periodStart && p.periodEnd
    ? `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`
    : `${MONTHS[p.month]} ${p.year}`;
  const locName = e?.location?.name ?? null;
  const locAddress = e?.location ? [e.location.addressLine1, e.location.addressLine2, [e.location.city, e.location.state, e.location.postalCode].filter(Boolean).join(' '), e.location.country].filter(Boolean).join('\n') : null;
  return {
    layout, fields, currency: org.currency || 'INR', locale: (org.currency || 'INR') === 'INR' ? 'en-IN' : 'en-US',
    company: { name: t?.companyName || org.name, address: t?.companyAddress ?? null, logoUrl: t?.logoUrl ?? null, branch: locName, branchAddress: locAddress },
    brand: {
      primary: t?.primaryColor || '#2563eb', accent: t?.accentColor || t?.primaryColor || '#2563eb', title: t?.headerTitle || 'Payslip',
      headerNote: t?.headerNote ?? null, footerNote: t?.footerNote ?? null, signatureLabel: t?.signatureLabel || 'Authorized Signatory',
      signatoryName: t?.signatoryName ?? null, signatureUrl: t?.signatureUrl ?? null, showSignature: (t?.showSignature ?? true) && fields.signature,
    },
    payslip: { number: p.payslipNumber, periodLabel, periodStart: iso(p.periodStart), periodEnd: iso(p.periodEnd), status: p.status, paidAt: iso(p.paidAt), generatedAt: iso(p.createdAt) ?? '', cycleName: cycle?.name ?? null },
    employee: {
      name: p.user?.name ?? e?.displayName ?? '', code: e?.employeeCode ?? null, designation: e?.designation ?? null,
      department: e?.department?.name ?? p.user?.department ?? null, location: locName, joiningDate: iso(e?.joiningDate), costCenter: e?.costCenter ?? null,
      email: e?.workEmail ?? p.user?.email ?? null, bankName: e?.bankName ?? null, bankAccountMasked: mask(e?.bankAccountNumber), bankIfsc: e?.bankIfsc ?? null,
      pan: e?.taxId ?? null, uan: e?.socialSecurityId ?? null, esi: e?.nationalId ?? null,
    },
    days: p.paidDays != null ? { working: n(p.workingDays), paid: n(p.paidDays), present: n(p.presentDays), leave: n(p.leaveDays), half: n(p.halfDays), lop: n(p.lopDays), overtimeHours: n(p.overtimeHours) } : null,
    earnings, reimbursements, deductions, employerContributions, totals,
    netInWords: amountInWords(totals.net, org.currency || 'INR'),
    watermark: resolveWatermark(t),
    loans: (input.loans ?? []).map(l => ({ name: l.name, type: l.type, principal: n(l.principal), recoveredThisPeriod: n(l.recoveredThisPeriod), totalRecovered: n(l.totalRecovered), outstanding: n(l.outstanding), emiLabel: l.emiLabel ?? null })),
    revision: (p.version ?? 1) > 1 ? { version: p.version, supersedesIssuedAt: input.supersedesIssuedAt ?? null, paidDifference: p.paidDifference != null ? n(p.paidDifference) : null } : null,
  };
}

/** A sample document for template previews when no payslip exists yet. */
/** Net pay is floored at 0; the remainder is stated next to the sum, not hidden. */
export function unrecoveredNote(doc: { totals: { unrecovered?: number } }, fm: (n: number) => string): string {
  const u = Number(doc.totals.unrecovered ?? 0);
  return u > 0 ? ` · Unrecovered ${fm(u)} (net pay floored at 0; carried forward for HR to recover)` : '';
}

export function samplePayslipDoc(template: any, org: { name: string; currency: string }): PayslipDoc {
  const today = new Date(); const m = today.getMonth() || 12; const y = m === 12 ? today.getFullYear() - 1 : today.getFullYear();
  const mk = (code: string, name: string, category: string, amount: number, order: number, basis?: string) => ({ code, name, category, amount, displayOrder: order, showOnPayslip: true, basis });
  const lines = [
    mk('BASIC', 'Basic Salary', 'EARNING', 30000, 10, 'fixed'), mk('HRA', 'House Rent Allowance', 'EARNING', 12000, 20, '40% of BASIC'),
    mk('CONVEYANCE', 'Conveyance Allowance', 'EARNING', 1600, 30, 'fixed'), mk('SPECIAL', 'Special Allowance', 'EARNING', 6400, 40, 'fixed'),
    mk('PF_EMP', 'Provident Fund', 'DEDUCTION', 1800, 100, '12% of BASIC (ceiling 15000)'), mk('PT', 'Professional Tax', 'DEDUCTION', 200, 120, 'slab'),
    mk('LOP', 'Loss of Pay', 'DEDUCTION', 2272.73, 150, '1 day'), mk('LOAN_sample', 'Loan recovery — Laptop loan (EMI 3 of 10)', 'DEDUCTION', 5000, 9000, 'EMI'),
    mk('PF_EMPLOYER', 'Employer PF', 'EMPLOYER_CONTRIBUTION', 1800, 300),
  ];
  const payslip = {
    payslipNumber: `PAY-${y}-${String(m).padStart(2, '0')}-0001`, month: m, year: y, status: 'PAID', paidAt: new Date(), createdAt: new Date(),
    totalEarnings: 50000, totalReimbursements: 0, totalDeductions: 9272.73, employerContributions: 1800, netPay: 40727.27,
    workingDays: 22, paidDays: 21, presentDays: 20, leaveDays: 1, halfDays: 0, lopDays: 1, overtimeHours: 2.5, lines,
    user: { name: 'Priya Sharma', email: 'priya@example.com', department: 'Engineering' }, employeeSalary: { ctcAnnual: 720000 },
  };
  const employee = { employeeCode: 'EMP-0042', designation: 'Senior Engineer', department: { name: 'Engineering' }, location: { name: 'Hyderabad', addressLine1: 'Plot 12, HITEC City', city: 'Hyderabad', state: 'Telangana', postalCode: '500081', country: 'India' }, joiningDate: new Date(y - 2, 3, 1), costCenter: 'CC-ENG-01', workEmail: 'priya@example.com', bankName: 'HDFC Bank', bankAccountNumber: '50100123456789', bankIfsc: 'HDFC0001234', taxId: 'ABCDE1234F', socialSecurityId: '100987654321', nationalId: null };
  const loans = [{ name: 'Laptop loan', type: 'LOAN', principal: 50000, recoveredThisPeriod: 5000, totalRecovered: 15000, outstanding: 35000, emiLabel: 'EMI 3 of 10' }];
  return buildPayslipDoc({ payslip, template, employee, org, loans });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(d: any) { const x = new Date(d); return x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
export function money(v: number, currency: string, locale: string) {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2 }).format(v); }
  catch { return `${currency} ${v.toFixed(2)}`; }
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function sub1000(x: number): string {
  const h = Math.floor(x / 100), r = x % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r < 20) { if (r) parts.push(ONES[r]); } else parts.push(`${TENS[Math.floor(r / 10)]}${r % 10 ? ' ' + ONES[r % 10] : ''}`);
  return parts.join(' ');
}
/** Indian numbering (lakh/crore) for INR, short scale otherwise. */
export function amountInWords(amount: number, currency: string): string {
  const whole = Math.floor(Math.abs(amount)); const paise = Math.round((Math.abs(amount) - whole) * 100);
  const unit = currency === 'INR' ? ['Rupees', 'Paise'] : currency === 'USD' ? ['Dollars', 'Cents'] : currency === 'GBP' ? ['Pounds', 'Pence'] : currency === 'EUR' ? ['Euros', 'Cents'] : [currency, 'Cents'];
  let words: string;
  if (whole === 0) words = 'Zero';
  else if (currency === 'INR') {
    const crore = Math.floor(whole / 1e7), lakh = Math.floor((whole % 1e7) / 1e5), thousand = Math.floor((whole % 1e5) / 1000), rest = whole % 1000;
    words = [crore && `${sub1000(crore)} Crore`, lakh && `${sub1000(lakh)} Lakh`, thousand && `${sub1000(thousand)} Thousand`, rest && sub1000(rest)].filter(Boolean).join(' ');
  } else {
    const scales = ['', 'Thousand', 'Million', 'Billion']; const parts: string[] = []; let x = whole, i = 0;
    while (x > 0) { const c = x % 1000; if (c) parts.unshift(`${sub1000(c)}${scales[i] ? ' ' + scales[i] : ''}`); x = Math.floor(x / 1000); i++; }
    words = parts.join(' ');
  }
  return `${unit[0]} ${words}${paise ? ` and ${sub1000(paise)} ${unit[1]}` : ''} Only`;
}

// ─── HTML renderer ───────────────────────────────────────────────────────────
//
// One clean structure for every layout (the layout only changes the header
// treatment, density, colour use and table framing):
//   letterhead · revision note · employee | payment details · attendance strip
//   · Earnings | Deductions (subtotals aligned at the bottom) · Net pay box
//   (amount in words) · Loans & advances · employer contributions · signature.
// Amount columns carry the currency once in the header ("Amount (₹)") and
// print bare, grouped numbers (en-IN → 1,31,781.75); totals and net pay print
// the full currency. The document is its own CSS container, so a narrow pane
// (phone, the template editor's preview) stacks the columns even on a wide
// screen; print/PDF keep the A4 layout.

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Grouped number with two decimals in the org's locale (no currency symbol). */
export function amountText(v: number, locale: string) {
  try { return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v); }
  catch { return v.toFixed(2); }
}
/** The currency's symbol as the locale prints it (₹, $, €…). */
export function currencySymbol(currency: string, locale: string) {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0).find(p => p.type === 'currency')?.value ?? currency; }
  catch { return currency; }
}

/** Mix a #rrggbb colour with white (t = share of white, 0–1). */
export function tint(c: string, t: number) {
  const h = /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#2563eb';
  const ch = (i: number) => Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - t) + 255 * t).toString(16).padStart(2, '0');
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

/** Employee / payment key–value pairs, in print order (shared by HTML and PDF). */
export function detailPairs(doc: PayslipDoc) {
  const F = doc.fields, e = doc.employee;
  const fm = (v: number) => money(v, doc.currency, doc.locale);
  const employee: [string, string | null | undefined][] = [
    ['Name', e.name],
    F.employeeCode ? ['Employee code', e.code] : null,
    F.designation ? ['Designation', e.designation] : null,
    F.department ? ['Department', e.department] : null,
    F.location ? ['Location', e.location] : null,
    F.joiningDate ? ['Date of joining', e.joiningDate && fmtDate(e.joiningDate)] : null,
    F.costCenter ? ['Cost centre', e.costCenter] : null,
    F.email ? ['E-mail', e.email] : null,
    F.ctc && doc.totals.ctcAnnual != null ? ['Annual CTC', fm(doc.totals.ctcAnnual)] : null,
  ].filter(Boolean) as [string, string | null | undefined][];
  const payment: [string, string | null | undefined][] = [
    ['Pay period', doc.payslip.periodLabel],
    ['Payslip no.', doc.payslip.number],
    doc.payslip.cycleName ? ['Payroll cycle', doc.payslip.cycleName] : null,
    ['Status', doc.payslip.status === 'PAID' ? `Paid${doc.payslip.paidAt ? ' on ' + fmtDate(doc.payslip.paidAt) : ''}` : 'Issued'],
    F.bankDetails ? ['Bank', [e.bankName, e.bankAccountMasked].filter(Boolean).join(' · ') || null] : null,
    F.bankDetails ? ['IFSC', e.bankIfsc] : null,
    F.statutoryIds ? ['PAN', e.pan] : null,
    F.statutoryIds ? ['UAN', e.uan] : null,
    F.statutoryIds ? ['ESI no.', e.esi] : null,
  ].filter(Boolean) as [string, string | null | undefined][];
  const keep = (rows: [string, string | null | undefined][]) => rows.filter(([, v]) => v != null && v !== '') as [string, string][];
  return { employee: keep(employee), payment: keep(payment) };
}

/** Attendance tiles (label, value, is-negative) — only figures that exist. */
export function dayTiles(doc: PayslipDoc): [string, string, boolean][] {
  const d = doc.days;
  if (!doc.fields.daysSummary || !d) return [];
  const t: [string, string, boolean][] = [['Working days', String(d.working), false], ['Paid days', String(d.paid), false]];
  if (d.lop) t.push(['LOP days', String(d.lop), true]);
  if (d.leave) t.push(['Leave', String(d.leave), false]);
  if (d.half) t.push(['Half days', String(d.half), false]);
  if (d.overtimeHours) t.push(['Overtime', `${d.overtimeHours} h`, false]);
  return t;
}

export function renderPayslipHtml(doc: PayslipDoc, opts: { embed?: boolean } = {}): string {
  const { layout: L, fields: F, brand: B } = doc;
  const fm = (v: number) => money(v, doc.currency, doc.locale);
  const an = (v: number) => amountText(v, doc.locale);
  const sym = currencySymbol(doc.currency, doc.locale);
  const fs = L.density === 'compact' ? 12 : L.density === 'airy' ? 13.5 : 13;
  const P = L.density === 'compact' ? 24 : L.density === 'airy' ? 36 : 32;
  const rowPad = L.density === 'compact' ? 5 : L.density === 'airy' ? 9 : 7;
  const font = L.serif ? "Georgia, 'Times New Roman', serif" : "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const mono = L.header === 'plain';
  const primary = mono ? '#111827' : B.primary;
  const accent = mono ? '#374151' : B.accent;
  const band = L.header === 'band';

  const kvs = (rows: [string, string][]) => rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  const pairs = detailPairs(doc);
  const tiles = dayTiles(doc);
  const basis = (l: DocLine) => F.lineBasis && l.basis ? `<span class="basis">${esc(l.basis)}</span>` : '';
  const row = (l: DocLine) => `<div class="row"><span class="nm">${esc(l.name)}${basis(l)}</span><span class="am">${an(l.amount)}</span></div>`;
  const colHead = (title: string) => `<div class="th"><span>${esc(title)}</span><span>Amount (${esc(sym)})</span></div>`;

  const earnCol = `<div class="tbl">${colHead('Earnings')}${doc.earnings.map(row).join('')}${doc.reimbursements.length ? `<div class="subh">Reimbursements</div>${doc.reimbursements.map(row).join('')}` : ''}<div class="row tot"><span class="nm">Gross earnings</span><span class="am">${fm(doc.totals.earnings + doc.totals.reimbursements)}</span></div></div>`;
  const dedCol = `<div class="tbl">${colHead('Deductions')}${doc.deductions.length ? doc.deductions.map(row).join('') : '<div class="row"><span class="nm muted">No deductions</span><span class="am"></span></div>'}<div class="row tot"><span class="nm">Total deductions</span><span class="am">${fm(doc.totals.deductions)}</span></div></div>`;
  const statement = `<table class="stmt"><thead><tr><th>Description</th><th class="am">Earnings (${esc(sym)})</th><th class="am">Deductions (${esc(sym)})</th></tr></thead><tbody>
    ${doc.earnings.concat(doc.reimbursements).map(l => `<tr><td>${esc(l.name)}${basis(l)}</td><td class="am">${an(l.amount)}</td><td class="am"></td></tr>`).join('')}
    ${doc.deductions.map(l => `<tr><td>${esc(l.name)}${basis(l)}</td><td class="am"></td><td class="am">${an(l.amount)}</td></tr>`).join('')}
    <tr class="tot"><td>Totals</td><td class="am">${fm(doc.totals.earnings + doc.totals.reimbursements)}</td><td class="am">${fm(doc.totals.deductions)}</td></tr>
  </tbody></table>`;

  const loansBlock = doc.loans.length ? `<section class="blk"><h3 class="h">Loans &amp; advances</h3>
    <table class="loans"><thead><tr><th>Loan</th><th class="am">Principal</th><th class="am">Recovered this month</th><th class="am">Total recovered</th><th class="am">Outstanding</th></tr></thead><tbody>
    ${doc.loans.map(l => `<tr><td data-l="Loan"><b>${esc(l.name)}</b>${l.emiLabel ? `<span class="basis">${esc(l.emiLabel)}</span>` : l.recoveredThisPeriod ? '' : '<span class="basis">No EMI this month</span>'}</td><td class="am" data-l="Principal">${an(l.principal)}</td><td class="am" data-l="This month">${an(l.recoveredThisPeriod)}</td><td class="am" data-l="Total recovered">${an(l.totalRecovered)}</td><td class="am strong" data-l="Outstanding">${an(l.outstanding)}</td></tr>`).join('')}
    </tbody></table></section>` : '';
  const employerBlock = F.employerContributions && doc.employerContributions.length ? `<section class="blk"><h3 class="h">Employer contributions <span class="hint">not part of net pay</span></h3>
    <div class="tbl solo">${doc.employerContributions.map(row).join('')}<div class="row tot"><span class="nm">Total</span><span class="am">${fm(doc.totals.employer)}</span></div></div></section>` : '';

  const reimb = doc.totals.reimbursements;
  const eq = `Gross ${fm(doc.totals.earnings + reimb)} − Deductions ${fm(doc.totals.deductions)}${unrecoveredNote(doc, fm)}`;

  const css = `
    .ps{font-family:${font};font-size:${fs}px;line-height:1.45;color:#1f2937;background:#fff;max-width:760px;margin:0 auto;position:relative;container-type:inline-size;-webkit-text-size-adjust:100%}
    .ps *{box-sizing:border-box} .ps h3{margin:0}
    .ps.boxed{border:1.5px solid ${primary}}
    .hd{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:${Math.round(P * 0.75)}px ${P}px}
    .hd.line{border-bottom:3px solid ${primary}} .hd.plain{border-bottom:1px solid #111827} .hd.boxed{border-bottom:1.5px solid ${primary}}
    .hd.band{background:${primary}} .hd.band .co,.hd.band .t,.hd.band .p{color:#fff} .hd.band .addr,.hd.band .n{color:rgba(255,255,255,.82)}
    .brand{display:flex;gap:14px;align-items:center;min-width:0;flex:1 1 auto}
    .logo{width:52px;height:52px;object-fit:contain;flex:none;border-radius:8px;background:#fff}
    .hd.band .logo{padding:4px}
    .co{font-size:${fs + 6}px;font-weight:700;line-height:1.25;color:#111827;overflow-wrap:anywhere}
    .branch{font-weight:600;color:${band ? '#fff' : accent};margin-top:1px}
    .addr{font-size:${fs - 1.5}px;color:#6b7280;white-space:pre-line;margin-top:3px;line-height:1.4}
    .title{text-align:right;flex:none}
    .t{font-size:${fs - 2.5}px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${primary}}
    .p{font-size:${fs + 5}px;font-weight:700;color:#111827;line-height:1.25;margin-top:2px}
    .n{font-size:${fs - 2}px;color:#6b7280;font-variant-numeric:tabular-nums;margin-top:2px}
    .rev{padding:${rowPad + 1}px ${P}px;font-size:${fs - 1}px;color:#92400e;background:#fffbeb;border-bottom:1px solid #fde68a;font-weight:600}
    .note{padding:${rowPad + 1}px ${P}px;font-size:${fs - 1}px;color:#4b5563;background:#f9fafb;border-bottom:1px solid #eef0f3}
    .sec{padding:${Math.round(P * 0.6)}px ${P}px 0}
    .h{font-size:${fs - 2.5}px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${accent};margin-bottom:6px}
    .h .hint{font-weight:500;letter-spacing:0;text-transform:none;color:#9ca3af;margin-left:6px}
    .details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 32px}
    .kv{display:grid;grid-template-columns:112px minmax(0,1fr);gap:10px;padding:${Math.max(3, rowPad - 3)}px 0;border-bottom:1px solid #f1f3f5}
    .k{color:#6b7280} .v{font-weight:600;color:#111827;overflow-wrap:anywhere}
    .stats{display:grid;grid-template-columns:repeat(${Math.max(tiles.length, 1)},minmax(0,1fr));gap:8px}
    .stat{border:1px solid #e5e7eb;border-radius:8px;padding:${rowPad}px 10px;background:rgba(255,255,255,.7)}
    .stat span{display:block;font-size:${fs - 3}px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
    .stat b{display:block;font-size:${fs + 3}px;color:#111827;font-variant-numeric:tabular-nums} .stat b.neg{color:#b91c1c}
    .cols{display:grid;grid-template-columns:${L.columns === 2 ? 'repeat(2,minmax(0,1fr))' : '1fr'};gap:28px;align-items:stretch}
    .tbl{display:flex;flex-direction:column;height:100%;${L.bordered ? 'border:1px solid #e5e7eb;border-radius:6px;padding:0 12px 2px;' : ''}}
    .tbl.solo{height:auto}
    .th{display:flex;justify-content:space-between;gap:12px;padding:${rowPad}px 0;border-bottom:1.5px solid ${L.bordered ? '#e5e7eb' : primary};font-size:${fs - 2.5}px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${accent}}
    .th span:last-child{letter-spacing:.04em;white-space:nowrap}
    .row{display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:${rowPad}px 0;border-bottom:1px solid #f1f3f5}
    .nm{min-width:0;overflow-wrap:anywhere} .am{white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
    .basis{display:block;font-size:${fs - 3}px;color:#9ca3af;font-weight:400}
    .subh{font-size:${fs - 3}px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;padding:${rowPad + 2}px 0 0}
    .row.tot{margin-top:auto;border-top:1px solid #cbd5e1;border-bottom:0;font-weight:700;color:#111827;padding-top:${rowPad + 2}px}
    .muted{color:#9ca3af}
    table.stmt{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
    .stmt th{text-align:left;font-size:${fs - 2.5}px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${accent};padding:${rowPad}px 8px;border-bottom:1.5px solid ${primary}}
    .stmt td{padding:${rowPad}px 8px;border-bottom:1px solid #f1f3f5;vertical-align:top;overflow-wrap:anywhere}
    .stmt th.am,.stmt td.am{text-align:right;white-space:nowrap} .stmt tr.tot td{font-weight:700;border-top:1px solid #cbd5e1;border-bottom:0}
    .net{display:flex;justify-content:space-between;align-items:center;gap:8px 20px;flex-wrap:wrap;margin-top:${Math.round(P * 0.6)}px;padding:${rowPad + 9}px 20px;border-radius:10px;
      background:${band ? primary : mono ? '#f3f4f6' : tint(primary, 0.93)};border:1px solid ${band ? primary : mono ? '#d1d5db' : tint(primary, 0.7)}}
    .net .lbl{font-size:${fs - 2.5}px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${band ? '#fff' : primary}}
    .net .words{font-size:${fs - 1}px;color:${band ? 'rgba(255,255,255,.9)' : '#374151'};margin-top:3px;font-style:italic}
    .net .eq{font-size:${fs - 2.5}px;color:${band ? 'rgba(255,255,255,.75)' : '#6b7280'};margin-top:3px;font-variant-numeric:tabular-nums}
    .net .val{font-size:${fs + 13}px;font-weight:800;color:${band ? '#fff' : primary};font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1.1}
    .blk{margin-top:${Math.round(P * 0.6)}px}
    table.loans{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
    .loans th{font-size:${fs - 3}px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:${rowPad - 1}px 8px;border-bottom:1px solid #e5e7eb;background:#f9fafb}
    .loans td{padding:${rowPad}px 8px;border-bottom:1px solid #f1f3f5;vertical-align:top;overflow-wrap:anywhere}
    .loans .am{text-align:right;white-space:nowrap} .loans .strong{font-weight:700;color:#111827}
    .foot-row{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-top:${Math.round(P * 0.9)}px}
    .sigbox{text-align:center;min-width:180px;margin-left:auto;font-size:${fs - 1}px;color:#4b5563}
    .sigbox img{height:40px;max-width:180px;object-fit:contain;display:block;margin:0 auto 4px} .sigbox .sl{border-top:1px solid ${L.serif ? '#111827' : '#cbd5e1'};padding-top:6px} .sigbox b{display:block;color:#111827}
    .stamp{display:inline-block;transform:rotate(-10deg);border:2.5px solid #16a34a;color:#16a34a;font-weight:800;font-size:18px;letter-spacing:.2em;padding:2px 14px;border-radius:6px;opacity:.85}
    .foot{margin-top:${Math.round(P * 0.6)}px;padding-top:10px;border-top:1px solid #f1f3f5;text-align:center;font-size:${fs - 2.5}px;color:#9ca3af;white-space:pre-line}
    .end{height:${Math.round(P * 0.8)}px}
    .wm{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .wm.mono{filter:grayscale(1)} .wm img{position:absolute;left:50%;top:50%;max-width:none;height:auto} .wm svg{position:absolute;inset:0;width:100%;height:100%}
    .ps>*:not(.wm){position:relative;z-index:1}
    .has-wm .note{background:rgba(249,250,251,.6)} .has-wm .loans th{background:rgba(249,250,251,.6)}
    @container (max-width: 620px){
      .hd{flex-direction:column;align-items:flex-start;gap:12px;padding:18px 16px} .title{text-align:left}
      .rev,.note{padding-left:16px;padding-right:16px} .sec{padding:16px 16px 0}
      .details{grid-template-columns:1fr;gap:0} .details>div+div{margin-top:12px}
      .kv{grid-template-columns:104px minmax(0,1fr)}
      .stats{grid-template-columns:repeat(${Math.min(Math.max(tiles.length, 1), 3)},minmax(0,1fr))}
      .cols{grid-template-columns:1fr;gap:20px}
      .stmt th,.stmt td{padding-left:4px;padding-right:4px} .stmt{font-size:${fs - 1}px}
      .net{padding:14px 16px} .net .val{font-size:${fs + 8}px}
      .loans thead{display:none} .loans,.loans tbody,.loans tr,.loans td{display:block;width:100%}
      .loans tr{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;padding:8px 0;border-bottom:1px solid #e5e7eb}
      .loans td{border:0;padding:2px 0} .loans td:first-child{grid-column:1/-1}
      .loans td.am{text-align:left} .loans td.am::before{content:attr(data-l);display:block;font-size:${fs - 3}px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-weight:400}
      .sigbox{min-width:150px}
    }
    @media print{.ps{max-width:none} @page{size:A4;margin:1.2cm} .row,.stmt tr,.loans tr,.net,.kv{break-inside:avoid}}`;

  const stamp = F.paidStamp && doc.payslip.status === 'PAID' ? '<div class="stamp">PAID</div>' : '';
  const revLines = revisionNoteLines(doc.revision, fm, fmtDate);
  const headerInner = `
    <div class="brand">
      ${doc.company.logoUrl && !mono ? `<img src="${esc(doc.company.logoUrl)}" alt="" class="logo">` : ''}
      <div style="min-width:0">
        <div class="co">${esc(doc.company.name)}</div>
        ${L.branchHeader && doc.company.branch ? `<div class="branch">${esc(doc.company.branch)} branch</div>` : ''}
        ${L.branchHeader && doc.company.branchAddress ? `<div class="addr">${esc(doc.company.branchAddress)}</div>` : doc.company.address ? `<div class="addr">${esc(doc.company.address)}</div>` : ''}
      </div>
    </div>
    <div class="title"><div class="t">${esc(B.title)} for</div><div class="p">${esc(doc.payslip.periodLabel)}</div><div class="n">${esc(doc.payslip.number)}</div></div>`;

  const body = `<div class="ps${L.header === 'boxed' ? ' boxed' : ''}${doc.watermark ? ' has-wm' : ''}">
    ${watermarkHtml(doc.watermark, mono)}
    <div class="hd ${L.header}">${headerInner}</div>
    ${revLines.length ? `<div class="rev">${revLines.map(esc).join('<br>')}</div>` : ''}
    ${B.headerNote ? `<div class="note">${esc(B.headerNote)}</div>` : ''}
    <div class="sec"><div class="details"><div><h3 class="h">Employee details</h3>${kvs(pairs.employee)}</div><div><h3 class="h">Payment details</h3>${kvs(pairs.payment)}</div></div></div>
    ${tiles.length ? `<div class="sec"><h3 class="h">Attendance</h3><div class="stats">${tiles.map(([l, v, neg]) => `<div class="stat"><span>${esc(l)}</span><b${neg ? ' class="neg"' : ''}>${esc(v)}</b></div>`).join('')}</div></div>` : ''}
    <div class="sec">
      ${L.columns === 2 ? `<div class="cols">${earnCol}${dedCol}</div>` : statement}
      <div class="net"><div style="min-width:0"><div class="lbl">Net pay</div>${F.amountInWords ? `<div class="words">${esc(doc.netInWords)}</div>` : ''}<div class="eq">${esc(eq)}</div></div><div class="val">${fm(doc.totals.net)}</div></div>
      ${loansBlock}
      ${employerBlock}
      ${B.showSignature || stamp ? `<div class="foot-row"><span>${stamp}</span>${B.showSignature ? `<div class="sigbox">${B.signatureUrl ? `<img src="${esc(B.signatureUrl)}" alt="">` : ''}<div class="sl">${B.signatoryName ? `<b>${esc(B.signatoryName)}</b>` : ''}${esc(B.signatureLabel)}</div></div>` : ''}</div>` : ''}
      ${B.footerNote ? `<div class="foot">${esc(B.footerNote)}</div>` : ''}
      <div class="end"></div>
    </div>
  </div>`;
  if (opts.embed) return `<style>${css}</style>${body}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(doc.payslip.number)}</title><style>body{margin:0;padding:24px 12px;background:#f3f4f6}@media (max-width:600px){body{padding:0}}@media print{body{padding:0;background:#fff}}${css}</style></head><body>${body}</body></html>`;
}

/** Width the HTML tile size is computed against (the .ps max-width). */
const HTML_PAGE_PX = 760;

/**
 * Faded mark behind the content. Single = one centred <img>; tiled = an
 * inline SVG pattern, so a large data-URL logo appears in the markup once
 * instead of once per tile. Both are real content (not CSS backgrounds), so
 * they print even when "background graphics" is off.
 */
export function watermarkHtml(w: Watermark | null, mono: boolean): string {
  if (!w) return '';
  const cls = `wm${mono ? ' mono' : ''}`;
  if (!w.repeat) {
    return `<div class="${cls}" aria-hidden="true"><img src="${esc(w.url)}" alt="" style="width:${w.size}%;opacity:${w.opacity};transform:translate(-50%,-50%) rotate(${w.rotation}deg)"></div>`;
  }
  const tile = Math.round(HTML_PAGE_PX * (w.size / 100) * TILE_SCALE);
  const cell = Math.round(tile * (1 + TILE_GAP)), g = Math.round((cell - tile) / 2);
  // Brick pattern: two rows per pattern cell, the second shifted half a cell.
  const img = (x: number, y: number) => `<image href="${esc(w.url)}" x="${x}" y="${y}" width="${tile}" height="${tile}" preserveAspectRatio="xMidYMid meet"/>`;
  // viewBox in "page px" with slice: the pattern scales with the payslip's
  // width (like the PDF, where tiles are a fraction of the page width) instead
  // of staying a fixed pixel size in a narrow phone preview. The tall viewBox
  // keeps the width as the scaling side for any realistic payslip height.
  const vbH = HTML_PAGE_PX * 6;
  return `<div class="${cls}" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${HTML_PAGE_PX} ${vbH}" preserveAspectRatio="xMidYMin slice"><defs><pattern id="zwm" patternUnits="userSpaceOnUse" width="${cell}" height="${cell * 2}" patternTransform="rotate(${w.rotation})">`
    + `${img(g, g)}${img(g + cell / 2, g + cell)}${img(g - cell / 2, g + cell)}</pattern></defs><rect width="${HTML_PAGE_PX}" height="${vbH}" fill="url(#zwm)" opacity="${w.opacity}"/></svg></div>`;
}

// ─── PDF renderer (PDFKit) ───────────────────────────────────────────────────

export interface PdfAssets { logo: LoadedImage | null; signature: LoadedImage | null; watermark: LoadedImage | null }

/** Fetch every image a document needs (cached by URL in the loader). Never throws. */
export async function loadPdfAssets(doc: PayslipDoc): Promise<PdfAssets> {
  const mono = doc.layout.header === 'plain';
  const [logo, signature, watermark] = await Promise.all([
    mono ? null : loadImage(doc.company.logoUrl),
    doc.brand.showSignature ? loadImage(doc.brand.signatureUrl) : null,
    doc.watermark ? loadImage(doc.watermark.url) : null,
  ]);
  return { logo, signature, watermark };
}

// One embedded XObject per image per PDF: a 300-payslip bundle must not
// embed the same logo 300 times.
const opened = new WeakMap<PDFKit.PDFDocument, Map<Buffer, any>>();
function openImage(pdf: PDFKit.PDFDocument, img: LoadedImage | null): any | null {
  if (!img) return null;
  let m = opened.get(pdf);
  if (!m) { m = new Map(); opened.set(pdf, m); }
  if (m.has(img.data)) return m.get(img.data);
  let o: any = null;
  try { o = (pdf as any).openImage(img.data); } catch (err: any) { console.warn(`[payslip] image could not be decoded: ${err?.message ?? err}`); }
  m.set(img.data, o);
  return o;
}

/** Draw the watermark on the current page (call before any content). */
function drawWatermark(pdf: PDFKit.PDFDocument, w: Watermark, image: any, mono: boolean) {
  const pw = pdf.page.width, ph = pdf.page.height, cx = pw / 2, cy = ph / 2;
  const ratio = image.height / image.width;
  // An opaque white page gives the Saturation pass below a backdrop to blend
  // with (over a transparent backdrop it would just paint grey).
  if (mono) pdf.save().rect(0, 0, pw, ph).fill('#ffffff').restore();
  pdf.save();
  pdf.opacity(w.opacity);
  pdf.rotate(w.rotation, { origin: [cx, cy] });
  if (!w.repeat) {
    let iw = pw * (w.size / 100), ih = iw * ratio;
    if (ih > ph * 0.9) { ih = ph * 0.9; iw = ih / ratio; } // tall marks fit by height
    pdf.image(image, cx - iw / 2, cy - ih / 2, { width: iw, height: ih });
  } else {
    const tw = pw * (w.size / 100) * TILE_SCALE, th = tw * ratio;
    const cellX = tw * (1 + TILE_GAP), cellY = th + tw * TILE_GAP;
    // Cover the page's diagonal so rotation leaves no bare corners.
    const r = Math.hypot(pw, ph) / 2;
    const rows = Math.ceil(r / cellY) + 1, cols = Math.ceil(r / cellX) + 1;
    for (let j = -rows; j <= rows; j++) {
      const shift = (j & 1) ? cellX / 2 : 0;
      for (let i = -cols; i <= cols; i++) {
        pdf.image(image, cx + i * cellX + shift - tw / 2, cy + j * cellY - th / 2, { width: tw, height: th });
      }
    }
  }
  pdf.restore();
  // MINIMAL is monochrome: desaturate the mark (the HTML uses a CSS grayscale
  // filter). PDFKit has no image filters, so paint a grey rect with the
  // Saturation blend mode over the page — nothing but the watermark is on it
  // yet, and white stays white.
  if (mono) {
    const gs = (pdf as any).ref({ Type: 'ExtGState', BM: 'Saturation' });
    gs.end();
    (pdf.page as any).ext_gstates.GsZwmSat = gs;
    pdf.save();
    (pdf as any).addContent('/GsZwmSat gs');
    pdf.rect(0, 0, pw, ph).fill('#808080');
    pdf.restore();
  }
}

/** Fit an image inside a w×h box, centred; returns nothing (draw only). */
function drawFitted(pdf: PDFKit.PDFDocument, image: any, x: number, y: number, w: number, h: number) {
  const s = Math.min(w / image.width, h / image.height);
  const iw = image.width * s, ih = image.height * s;
  pdf.image(image, x + (w - iw) / 2, y + (h - ih) / 2, { width: iw, height: ih });
}

function hex(c: string) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#2563eb'; }

export async function renderPayslipPdf(doc: PayslipDoc, into?: PDFKit.PDFDocument): Promise<Buffer> {
  const own = !into;
  const pdf = into ?? new PDFDocument({ size: 'A4', margin: 40, info: { Title: doc.payslip.number, Author: doc.company.name } });
  const chunks: Buffer[] = [];
  if (own) pdf.on('data', c => chunks.push(c));
  drawPayslip(pdf, doc, await loadPdfAssets(doc));
  if (!own) return Buffer.alloc(0);
  return new Promise(resolve => { pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.end(); });
}

/** One PDF with a page per payslip (bulk download for a run). */
export async function renderPayslipBundlePdf(docs: PayslipDoc[]): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: false, info: { Title: 'Payslips' } });
  const chunks: Buffer[] = [];
  pdf.on('data', c => chunks.push(c));
  for (const d of docs) { const assets = await loadPdfAssets(d); pdf.addPage(); drawPayslip(pdf, d, assets); }
  return new Promise(resolve => { pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.end(); });
}

function drawPayslip(pdf: PDFKit.PDFDocument, doc: PayslipDoc, assets: PdfAssets = { logo: null, signature: null, watermark: null }) {
  const { layout: L, fields: F, brand: B } = doc;
  // Watermark first so everything else paints over it — and again on any
  // page PDFKit adds if a long payslip overflows.
  const wmImage = doc.watermark ? openImage(pdf, assets.watermark) : null;
  const onPage = () => { if (wmImage) drawWatermark(pdf, doc.watermark!, wmImage, L.header === 'plain'); };
  onPage();
  pdf.on('pageAdded', onPage);
  try { drawPayslipContent(pdf, doc, assets); } finally { pdf.removeListener('pageAdded', onPage); }
}

/** Currency prefix the standard PDF fonts can print (they have no ₹ glyph). */
function pdfSymbol(currency: string, locale: string) {
  const s = currencySymbol(currency, locale);
  return s === '₹' ? 'Rs.' : s === '€' ? 'EUR' : s === '£' ? 'GBP' : /^[\x20-\x7e]+$/.test(s) ? s : currency;
}

/**
 * The PDF mirrors the HTML structure. Every block is measured before it is
 * drawn and `ensure()` starts a new page when it would not fit, so long names
 * wrap instead of overlapping and PDFKit never auto-breaks mid-text (which used
 * to leave blank pages and push the net pay onto a page of its own). Paired
 * Earnings | Deductions rows share a height, so both subtotals line up.
 */
function drawPayslipContent(pdf: PDFKit.PDFDocument, doc: PayslipDoc, assets: PdfAssets) {
  const { layout: L, fields: F, brand: B } = doc;
  const wmOn = !!(doc.watermark && assets.watermark);
  const mono = L.header === 'plain';
  const band = L.header === 'band';
  const primary = mono ? '#111827' : hex(B.primary);
  const accent = mono ? '#374151' : hex(B.accent);
  const fs = L.density === 'compact' ? 8.4 : L.density === 'airy' ? 9.6 : 9;
  const small = fs - 1.6;
  const reg = L.serif ? 'Times-Roman' : 'Helvetica', bold = L.serif ? 'Times-Bold' : 'Helvetica-Bold', ital = L.serif ? 'Times-Italic' : 'Helvetica-Oblique';
  const sym = pdfSymbol(doc.currency, doc.locale);
  // Standard PDF fonts have no ₹ or U+2212 minus sign.
  const clean = (s: string) => s.replace(/−/g, '-').replace(/ | /g, ' ').replace(/₹\s?/g, 'Rs. ').replace(/€\s?/g, 'EUR ').replace(/£\s?/g, 'GBP ');
  const fm = (v: number) => clean(money(v, doc.currency, doc.locale));
  const an = (v: number) => clean(amountText(v, doc.locale));
  const left = pdf.page.margins.left, right = pdf.page.width - pdf.page.margins.right, width = right - left;
  const bottom = () => pdf.page.height - pdf.page.margins.bottom;
  const padX = L.header === 'boxed' ? 10 : 0;
  const rowPad = L.density === 'compact' ? 3.2 : L.density === 'airy' ? 5.5 : 4.4;
  const blockGap = L.density === 'compact' ? 10 : L.density === 'airy' ? 16 : 13;
  let y = pdf.page.margins.top;
  const newPage = () => { pdf.addPage(); y = pdf.page.margins.top; };
  const ensure = (h: number) => { if (y + h > bottom()) newPage(); };
  const H = (s: string, font: string, size: number, w: number) => pdf.font(font).fontSize(size).heightOfString(s || ' ', { width: w });
  const T = (s: string, x: number, yy: number, font: string, size: number, color: string, o: PDFKit.Mixins.TextOptions = {}) => {
    pdf.font(font).fontSize(size).fillColor(color).text(s, x, yy, { lineBreak: true, ...o });
  };
  const hr = (yy: number, color = '#eef0f3', w = 0.6, x0 = left, x1 = right) => pdf.save().lineWidth(w).strokeColor(color).moveTo(x0, yy).lineTo(x1, yy).stroke().restore();
  const heading = (s: string, x: number, w: number, hint?: string) => {
    T(s.toUpperCase(), x, y, bold, small, accent, { width: w, characterSpacing: 0.6, continued: !!hint });
    if (hint) pdf.font(reg).fontSize(small).fillColor('#9ca3af').text(`   ${hint}`, { characterSpacing: 0 });
  };

  // ── Letterhead ──
  const logo = mono ? null : openImage(pdf, assets.logo);
  const logoBox = L.density === 'compact' ? 36 : 44;
  const hp = band || L.header === 'boxed' ? 12 : 4;
  const titleW = 170;
  const nameX = left + hp + padX + (logo ? logoBox + 12 : 0);
  const nameW = width - titleW - (nameX - left) - 12;
  const addr = L.branchHeader && doc.company.branchAddress ? doc.company.branchAddress : doc.company.address;
  const branch = L.branchHeader && doc.company.branch ? `${doc.company.branch} branch` : null;
  const leftH = H(doc.company.name, bold, fs + 6, nameW) + (branch ? H(branch, bold, fs, nameW) + 1 : 0) + (addr ? H(addr, reg, small, nameW) + 3 : 0);
  // A weekly / custom cycle's label ("02 Mar 2026 – 11 Mar 2026") wraps to two
  // lines in the title column; size the header for it, or the payslip number
  // below is drawn over the header rule.
  const rightH = small + 3 + H(doc.payslip.periodLabel, bold, fs + 6, titleW) + 3 + small + 2;
  const headerH = Math.max(logo ? logoBox : 0, leftH, rightH) + hp * 2 + (band ? 0 : 6);
  if (band) pdf.save().rect(left, y, width, headerH).fill(primary).restore();
  if (L.header === 'boxed') pdf.save().lineWidth(1.2).strokeColor(primary).rect(left, y, width, headerH).stroke().restore();
  const onBand = (c: string) => (band ? '#ffffff' : c);
  if (logo) {
    const lx = left + hp + padX, ly = y + (headerH - logoBox) / 2 - (band ? 0 : 3);
    if (band) pdf.save().fillColor('#ffffff').roundedRect(lx - 3, ly - 3, logoBox + 6, logoBox + 6, 5).fill().restore();
    drawFitted(pdf, logo, lx, ly, logoBox, logoBox);
  }
  let hy = y + (headerH - leftH) / 2 - (band ? 0 : 3);
  T(doc.company.name, nameX, hy, bold, fs + 6, onBand('#111827'), { width: nameW }); hy = pdf.y;
  if (branch) { T(branch, nameX, hy + 1, bold, fs, band ? '#ffffff' : accent, { width: nameW }); hy = pdf.y; }
  if (addr) T(addr, nameX, hy + 3, reg, small, band ? '#e5e7eb' : '#6b7280', { width: nameW, lineGap: 0.5 });
  const tx = right - titleW - hp - padX;
  let ty = y + (headerH - rightH) / 2 - (band ? 0 : 3);
  T(`${B.title} for`.toUpperCase(), tx, ty, bold, small, onBand(primary), { width: titleW, align: 'right', characterSpacing: 1 }); ty += small + 3;
  T(doc.payslip.periodLabel, tx, ty, bold, fs + 6, onBand('#111827'), { width: titleW, align: 'right' }); ty = pdf.y + 2;
  T(doc.payslip.number, tx, ty, reg, small, band ? '#e5e7eb' : '#6b7280', { width: titleW, align: 'right' });
  y += headerH;
  if (L.header === 'line') hr(y, primary, 2.2);
  if (mono) hr(y, '#111827', 0.8);
  y += 10;

  const revLines = revisionNoteLines(doc.revision, fm, fmtDate).map(clean);
  if (revLines.length) {
    const rh = H(revLines.join('\n'), bold, fs - 0.5, width - 16) + 10;
    pdf.save().fillColor('#fffbeb').strokeColor('#fde68a').lineWidth(0.6).roundedRect(left, y, width, rh, 3).fillAndStroke().restore();
    T(revLines.join('\n'), left + 8, y + 5, bold, fs - 0.5, '#92400e', { width: width - 16 });
    y += rh + 8;
  }
  if (B.headerNote) { const nh = H(B.headerNote, reg, fs - 0.5, width - padX * 2); T(B.headerNote, left + padX, y, reg, fs - 0.5, '#4b5563', { width: width - padX * 2 }); y += nh + 8; }

  // ── Employee | payment details ──
  const pairs = detailPairs(doc);
  const colGap = 22, colW = (width - padX * 2 - colGap) / 2, labelW = 78, valW = colW - labelW - 6;
  const kvH = ([, v]: [string, string]) => Math.max(H(v, bold, fs, valW), fs + 1) + rowPad * 2 - 1;
  const colHeight = (rows: [string, string][]) => small + 6 + rows.reduce((s, r) => s + kvH(r), 0);
  ensure(Math.max(colHeight(pairs.employee), colHeight(pairs.payment)));
  const drawKvs = (x: number, title: string, rows: [string, string][]) => {
    let yy = y;
    T(title.toUpperCase(), x, yy, bold, small, accent, { width: colW, characterSpacing: 0.6 }); yy += small + 6;
    for (const r of rows) {
      const h = kvH(r);
      T(r[0], x, yy + rowPad - 0.5, reg, fs, '#6b7280', { width: labelW });
      T(clean(r[1]), x + labelW + 6, yy + rowPad - 0.5, bold, fs, '#111827', { width: valW });
      hr(yy + h, '#f1f3f5', 0.5, x, x + colW);
      yy += h;
    }
    return yy;
  };
  y = Math.max(drawKvs(left + padX, 'Employee details', pairs.employee), drawKvs(left + padX + colW + colGap, 'Payment details', pairs.payment)) + blockGap;

  // ── Attendance ──
  const tiles = dayTiles(doc);
  if (tiles.length) {
    const th = fs * 2 + 14;
    ensure(small + 6 + th);
    heading('Attendance', left + padX, width); y += small + 6;
    const gap = 6, tw = (width - padX * 2 - gap * (tiles.length - 1)) / tiles.length;
    tiles.forEach(([l, v, neg], i) => {
      const x = left + padX + i * (tw + gap);
      pdf.save().lineWidth(0.6).strokeColor('#e5e7eb').fillColor('#ffffff').fillOpacity(wmOn ? 0.55 : 1).roundedRect(x, y, tw, th, 4).fillAndStroke().restore();
      T(l.toUpperCase(), x + 7, y + 5, reg, small - 0.6, '#6b7280', { width: tw - 14, characterSpacing: 0.3, lineBreak: false, ellipsis: true });
      T(v, x + 7, y + 6 + small + 1, bold, fs + 2.5, neg ? '#b91c1c' : '#111827', { width: tw - 14, lineBreak: false });
    });
    y += th + blockGap;
  }

  // ── Earnings | Deductions ──
  const amtW = 74;
  type Cell = { name: string; amount: string; basis?: string | null; sub?: boolean } | null;
  const cellH = (c: Cell, nameW: number) => !c ? 0 : c.sub ? small + rowPad * 2 : H(c.name, reg, fs, nameW) + (F.lineBasis && c.basis ? H(c.basis, reg, small - 0.4, nameW) + 1 : 0) + rowPad * 2;
  const drawCell = (c: Cell, x: number, w: number, h: number, isTotal = false) => {
    if (!c) return;
    const nameW = w - amtW - 8;
    if (c.sub) { T(c.name.toUpperCase(), x, y + rowPad + 1, reg, small - 0.4, '#6b7280', { width: w, characterSpacing: 0.4 }); return; }
    T(c.name, x, y + rowPad, isTotal ? bold : reg, fs, '#111827', { width: nameW });
    if (F.lineBasis && c.basis) T(c.basis, x, pdf.y + 1, reg, small - 0.4, '#9ca3af', { width: nameW });
    T(c.amount, x + w - amtW, y + rowPad, isTotal ? bold : reg, fs, '#111827', { width: amtW, align: 'right' });
    if (!isTotal) hr(y + h, '#f1f3f5', 0.5, x, x + w);
  };
  const toCell = (l: DocLine): Cell => ({ name: clean(l.name), amount: an(l.amount), basis: l.basis ? clean(l.basis) : null });
  const headerRow = (cols: { x: number; w: number; title: string; amt?: string }[]) => {
    const h = small + rowPad * 2 + 2;
    ensure(h + fs * 3);
    for (const c of cols) {
      if (L.bordered) pdf.save().fillColor('#f8fafc').rect(c.x, y, c.w, h).fill().restore();
      T(c.title.toUpperCase(), c.x + (L.bordered ? 4 : 0), y + rowPad + 1, bold, small, accent, { width: c.w - amtW, characterSpacing: 0.6 });
      if (c.amt) T(c.amt.toUpperCase(), c.x + c.w - amtW - 30, y + rowPad + 1, bold, small, accent, { width: amtW + 30 - (L.bordered ? 4 : 0), align: 'right', characterSpacing: 0.3 });
      hr(y + h, L.bordered ? '#e5e7eb' : primary, 1.1, c.x, c.x + c.w);
    }
    y += h;
  };
  if (L.columns === 2) {
    const cw = (width - padX * 2 - 22) / 2, xL = left + padX, xR = xL + cw + 22;
    const cols = [{ x: xL, w: cw, title: 'Earnings', amt: `Amount (${sym})` }, { x: xR, w: cw, title: 'Deductions', amt: `Amount (${sym})` }];
    const leftCells: Cell[] = [...doc.earnings.map(toCell), ...(doc.reimbursements.length ? [{ name: 'Reimbursements', amount: '', sub: true }, ...doc.reimbursements.map(toCell)] : [])];
    const rightCells: Cell[] = doc.deductions.length ? doc.deductions.map(toCell) : [{ name: 'No deductions', amount: '' }];
    headerRow(cols);
    const n = Math.max(leftCells.length, rightCells.length);
    const nw = cw - amtW - 8;
    const colTotal = (cells: Cell[]) => cells.reduce((s, c) => s + cellH(c, nw), 0);
    const totalRowH = fs + rowPad * 2 + 5;
    if (y + Math.max(colTotal(leftCells), colTotal(rightCells)) + totalRowH <= bottom()) {
      // Both columns fit: draw each at its own row heights (no gaps opposite a
      // wrapped line), then the subtotals side by side under the taller one.
      const y0 = y;
      let yl = y0, yr = y0;
      for (const c of leftCells) { const h = cellH(c, nw); y = yl; drawCell(c, xL, cw, h); yl += h; }
      for (const c of rightCells) { const h = cellH(c, nw); y = yr; drawCell(c, xR, cw, h); yr += h; }
      y = Math.max(yl, yr);
    } else for (let i = 0; i < n; i++) {
      const a = leftCells[i] ?? null, b = rightCells[i] ?? null;
      const h = Math.max(cellH(a, cw - amtW - 8), cellH(b, cw - amtW - 8));
      if (y + h > bottom()) { newPage(); headerRow(cols); }
      drawCell(a, xL, cw, h); drawCell(b, xR, cw, h);
      y += h;
    }
    const th = fs + rowPad * 2 + 3;
    ensure(th);
    hr(y, '#cbd5e1', 0.8, xL, xL + cw); hr(y, '#cbd5e1', 0.8, xR, xR + cw);
    y += 2;
    drawCell({ name: 'Gross earnings', amount: fm(doc.totals.earnings + doc.totals.reimbursements) }, xL, cw, th, true);
    drawCell({ name: 'Total deductions', amount: fm(doc.totals.deductions) }, xR, cw, th, true);
    y += th;
  } else {
    // Statement: one table, two amount columns.
    const x = left + padX, w = width - padX * 2, aw = 96, nameW = w - aw * 2 - 8;
    const head = () => {
      const h = small + rowPad * 2 + 2;
      ensure(h + fs * 3);
      if (L.bordered) pdf.save().fillColor('#f8fafc').rect(x, y, w, h).fill().restore();
      T('DESCRIPTION', x + 4, y + rowPad + 1, bold, small, accent, { width: nameW, characterSpacing: 0.6 });
      T(`EARNINGS (${sym})`, x + w - aw * 2, y + rowPad + 1, bold, small, accent, { width: aw - 4, align: 'right' });
      T(`DEDUCTIONS (${sym})`, x + w - aw, y + rowPad + 1, bold, small, accent, { width: aw - 4, align: 'right' });
      hr(y + h, primary, 1.1, x, x + w);
      y += h;
    };
    head();
    const line = (name: string, e: string, d: string, basisText?: string | null, isTotal = false) => {
      const h = H(name, isTotal ? bold : reg, fs, nameW) + (F.lineBasis && basisText ? H(basisText, reg, small - 0.4, nameW) + 1 : 0) + rowPad * 2;
      if (y + h > bottom()) { newPage(); head(); }
      if (isTotal) { hr(y, '#cbd5e1', 0.8, x, x + w); }
      T(name, x + 4, y + rowPad, isTotal ? bold : reg, fs, '#111827', { width: nameW });
      if (F.lineBasis && basisText) T(basisText, x + 4, pdf.y + 1, reg, small - 0.4, '#9ca3af', { width: nameW });
      T(e, x + w - aw * 2, y + rowPad, isTotal ? bold : reg, fs, '#111827', { width: aw - 4, align: 'right' });
      T(d, x + w - aw, y + rowPad, isTotal ? bold : reg, fs, '#111827', { width: aw - 4, align: 'right' });
      if (!isTotal) hr(y + h, '#f1f3f5', 0.5, x, x + w);
      y += h;
    };
    for (const l of doc.earnings.concat(doc.reimbursements)) line(clean(l.name), an(l.amount), '', l.basis);
    for (const l of doc.deductions) line(clean(l.name), '', an(l.amount), l.basis);
    line('Totals', fm(doc.totals.earnings + doc.totals.reimbursements), fm(doc.totals.deductions), null, true);
  }
  y += blockGap - 2;

  // ── Net pay ──
  {
    const boxW = width - padX * 2, x = left + padX, valW = 190, textW = boxW - valW - 28;
    const eq = clean(`Gross ${fm(doc.totals.earnings + doc.totals.reimbursements)} - Deductions ${fm(doc.totals.deductions)}${unrecoveredNote(doc, fm)}`);
    const wordsH = F.amountInWords ? H(doc.netInWords, ital, fs - 0.3, textW) + 2 : 0;
    const eqH = H(eq, reg, small, textW);
    const inner = Math.max(small + 3 + wordsH + eqH, fs + 14);
    const h = inner + 22;
    ensure(h);
    const fill = band ? primary : mono ? '#f3f4f6' : tint(primary, 0.93);
    const stroke = band ? primary : mono ? '#d1d5db' : tint(primary, 0.7);
    pdf.save().fillColor(fill).strokeColor(stroke).lineWidth(0.8).roundedRect(x, y, boxW, h, 6).fillAndStroke().restore();
    let yy = y + 11;
    T('NET PAY', x + 14, yy, bold, small, band ? '#ffffff' : primary, { width: textW, characterSpacing: 1 }); yy += small + 3;
    if (F.amountInWords) { T(doc.netInWords, x + 14, yy, ital, fs - 0.3, band ? '#ffffff' : '#374151', { width: textW }); yy += wordsH; }
    T(eq, x + 14, yy, reg, small, band ? '#e5e7eb' : '#6b7280', { width: textW });
    T(fm(doc.totals.net), x + boxW - valW - 14, y + (h - (fs + 11)) / 2 + 1, bold, fs + 11, band ? '#ffffff' : primary, { width: valW, align: 'right', lineBreak: false });
    y += h + blockGap;
  }

  // ── Loans & advances ──
  if (doc.loans.length) {
    const x = left + padX, w = width - padX * 2, aw = 82, nameW = w - aw * 4 - 6;
    const head = () => {
      const h = small + rowPad * 2 + 2;
      ensure(small + 8 + h + fs * 3);
      heading('Loans & advances', x, w); y += small + 6;
      pdf.save().fillColor('#f8fafc').fillOpacity(wmOn ? 0.6 : 1).rect(x, y, w, h).fill().restore();
      const hs = ['Principal', 'This month', 'Total recovered', 'Outstanding'];
      T('LOAN', x + 4, y + rowPad + 1, bold, small - 0.4, '#6b7280', { width: nameW, characterSpacing: 0.3 });
      hs.forEach((s, i) => T(s.toUpperCase(), x + nameW + 6 + i * aw, y + rowPad + 1, bold, small - 0.4, '#6b7280', { width: aw - 4, align: 'right', characterSpacing: 0.2 }));
      hr(y + h, '#e5e7eb', 0.6, x, x + w);
      y += h;
    };
    head();
    for (const l of doc.loans) {
      const sub = l.emiLabel ?? (l.recoveredThisPeriod ? '' : 'No EMI this month');
      const h = H(clean(l.name), bold, fs, nameW - 4) + (sub ? H(sub, reg, small - 0.4, nameW - 4) + 1 : 0) + rowPad * 2;
      if (y + h > bottom()) { newPage(); head(); }
      T(clean(l.name), x + 4, y + rowPad, bold, fs, '#111827', { width: nameW - 4 });
      if (sub) T(sub, x + 4, pdf.y + 1, reg, small - 0.4, '#6b7280', { width: nameW - 4 });
      [l.principal, l.recoveredThisPeriod, l.totalRecovered, l.outstanding].forEach((v, i) =>
        T(an(v), x + nameW + 6 + i * aw, y + rowPad, i === 3 ? bold : reg, fs, '#111827', { width: aw - 4, align: 'right' }));
      hr(y + h, '#f1f3f5', 0.5, x, x + w);
      y += h;
    }
    y += blockGap;
  }

  // ── Employer contributions ──
  if (F.employerContributions && doc.employerContributions.length) {
    const x = left + padX, w = width - padX * 2;
    ensure(small + 8 + (fs + rowPad * 2) * 2);
    heading('Employer contributions', x, w, 'not part of net pay'); y += small + 6;
    for (const l of doc.employerContributions) {
      const c = toCell(l), h = cellH(c, w - amtW - 8);
      ensure(h); drawCell(c, x, w, h); y += h;
    }
    const th = fs + rowPad * 2 + 3;
    ensure(th); hr(y, '#cbd5e1', 0.8, x, x + w); y += 2;
    drawCell({ name: 'Total', amount: fm(doc.totals.employer) }, x, w, th, true); y += th + blockGap;
  }

  // ── PAID stamp + signature ──
  const sig = B.showSignature ? openImage(pdf, assets.signature) : null;
  const stamp = F.paidStamp && doc.payslip.status === 'PAID';
  if (B.showSignature || stamp) {
    const sigH = (sig ? 44 : 22) + (B.signatoryName ? fs + 3 : 0) + small + 6;
    ensure(Math.max(sigH, 50));
    if (stamp) {
      pdf.save().rotate(-10, { origin: [left + padX + 60, y + 26] }).lineWidth(2).strokeColor('#16a34a').roundedRect(left + padX + 12, y + 12, 96, 28, 4).stroke()
        .font('Helvetica-Bold').fontSize(15).fillColor('#16a34a').text('PAID', left + padX + 12, y + 19, { width: 96, align: 'center', characterSpacing: 4 }).restore();
    }
    if (B.showSignature) {
      const sw = 180, sx = right - padX - sw;
      let sy = y + (sig ? 44 : 22);
      if (sig) drawFitted(pdf, sig, sx + 20, sy - 40, sw - 40, 36);
      hr(sy, L.serif ? '#111827' : '#cbd5e1', 0.7, sx, sx + sw);
      sy += 4;
      if (B.signatoryName) { T(clean(B.signatoryName), sx, sy, bold, fs, '#111827', { width: sw, align: 'center' }); sy = pdf.y; }
      T(clean(B.signatureLabel), sx, sy, reg, small, '#4b5563', { width: sw, align: 'center' });
    }
    y += Math.max(sigH, 50) + 4;
  }
  if (B.footerNote) {
    const fh = H(clean(B.footerNote), reg, small, width) + 10;
    ensure(fh);
    hr(y, '#f1f3f5', 0.5);
    T(clean(B.footerNote), left, y + 6, reg, small, '#9ca3af', { width, align: 'center' });
  }
}
