/**
 * HR-authored HTML payslip templates: placeholder language, sanitizer and the
 * renderer that turns a PayslipDoc into the final, isolated HTML document.
 *
 * Why a home-grown placeholder language rather than Handlebars/Mustache: none
 * is a dependency yet, and what HR needs is deliberately small — values,
 * loops over the payslip's tables and if/unless. Small means the whole
 * surface is reviewable and unit-tested (tests/unit/payslip-html-template.test.ts):
 *
 *   {{employee.name}}                 value, ALWAYS HTML-escaped
 *   {{#each earnings}}…{{/each}}      loop; inside, {{name}} {{amount}} {{@number}} …
 *   {{#each loans}}…{{else}}…{{/each}} optional "empty" branch
 *   {{#if loans}}…{{else}}…{{/if}}    truthy = non-empty text/list, non-zero money, true
 *   {{#unless revision}}…{{/unless}}
 *   {{! a comment }}
 *
 * There is no raw-HTML output ({{{x}}} is an error) and no helpers/expressions.
 * Unknown placeholders are a validation error (listed with line numbers) — a
 * typo must not silently print a blank on 300 payslips.
 *
 * Security: the template is admin-entered HTML that employees' browsers and
 * the server's headless Chromium render. Defence in depth:
 *  1. sanitizeTemplateHtml() on save (unsafe markup is stripped and reported);
 *  2. the SAME sanitizer again on every render, AFTER placeholders are filled
 *     (values are escaped, but this is what actually guarantees the output) —
 *     with the strict image policy: data: images or this template's own
 *     logo / signature / watermark URLs only;
 *  3. the rendered document carries a CSP meta (no scripts, images from data:
 *     only in the PDF) and is shown in a sandboxed iframe without
 *     allow-scripts (client) / rendered with JavaScript disabled and every
 *     network request blocked (utils/htmlPdf.ts).
 */
import sanitizeHtml from 'sanitize-html';
import {
  PAYSLIP_FIELDS, type PayslipDoc, type DocLine, type FieldKey,
  money, amountText, currencySymbol, fmtDate, detailPairs, dayTiles, unrecoveredNote, watermarkHtml,
} from './payslipRender';
import { revisionNoteLines } from './payrollRevision';

/** Template source limit (HTML + CSS together). Data-URI images count, so keep logos on the template's logo field. */
export const HTML_TEMPLATE_MAX_BYTES = 200 * 1024;
/** Hard cap on rendered output — loops over a payslip's lines can't legitimately get near this. */
const OUTPUT_MAX_CHARS = 3_000_000;
const MAX_NESTING = 12;
/** Max placeholder/block visits per render (see renderTemplate). */
export const RENDER_MAX_STEPS = 200_000;

// ─── Placeholder catalogue ───────────────────────────────────────────────────
//
// One list drives validation, the editor's reference panel and the docs. Each
// entry is a root path ("employee.pan") or, with `list`, a field of a loop item.

export type PlaceholderType = 'text' | 'money' | 'image' | 'flag' | 'list' | 'object';
export interface PlaceholderInfo { path: string; label: string; group: string; type: PlaceholderType; list?: string; example?: string }

const LINE_FIELDS: [string, string, PlaceholderType][] = [
  ['name', 'Line name', 'text'], ['code', 'Component code', 'text'],
  ['amount', 'Amount (number only, e.g. 30,000.00)', 'money'], ['amountWithCurrency', 'Amount with currency (₹30,000.00)', 'money'],
  ['basis', 'How it was calculated (blank when "line basis" is off)', 'text'],
];
const LISTS: { key: string; label: string; fields: [string, string, PlaceholderType][] }[] = [
  { key: 'earnings', label: 'Earnings lines', fields: LINE_FIELDS },
  { key: 'reimbursements', label: 'Reimbursement lines', fields: LINE_FIELDS },
  { key: 'deductions', label: 'Deduction lines', fields: LINE_FIELDS },
  { key: 'employerContributions', label: 'Employer contributions (PF/ESI — not part of net pay; empty when turned off)', fields: LINE_FIELDS },
  { key: 'loans', label: 'Loans & advances', fields: [
    ['name', 'Loan name', 'text'], ['type', 'LOAN / ADVANCE', 'text'], ['principal', 'Principal', 'money'],
    ['recoveredThisPeriod', 'Recovered this period', 'money'], ['totalRecovered', 'Total recovered', 'money'],
    ['outstanding', 'Outstanding', 'money'], ['emiLabel', 'EMI label (e.g. EMI 3 of 10)', 'text'],
  ] },
  { key: 'attendanceTiles', label: 'Attendance tiles (only figures that exist; empty when the days summary is off)', fields: [
    ['label', 'Tile label (Working days, LOP days…)', 'text'], ['value', 'Tile value', 'text'], ['negative', 'True for LOP (style it red)', 'flag'],
  ] },
  { key: 'employeeDetails', label: 'Employee details as label/value rows (respects the Fields tab)', fields: [['label', 'Label', 'text'], ['value', 'Value', 'text']] },
  { key: 'paymentDetails', label: 'Payment details as label/value rows (period, number, status, bank, PAN…)', fields: [['label', 'Label', 'text'], ['value', 'Value', 'text']] },
  { key: 'revisionLines', label: 'Revision note lines (revised payslips only) — use {{this}}', fields: [['this', 'The line of text', 'text']] },
];
const LOOP_VARS: [string, string, PlaceholderType][] = [
  ['@index', 'Position in the loop, from 0', 'text'], ['@number', 'Position in the loop, from 1', 'text'],
  ['@first', 'True on the first item', 'flag'], ['@last', 'True on the last item', 'flag'],
];

const ROOT: [string, string, string, PlaceholderType][] = [
  // group, path, label, type
  ['Organisation', 'org.name', 'Company name (template override or org name)', 'text'],
  ['Organisation', 'org.address', 'Company address (keeps line breaks — use white-space:pre-line)', 'text'],
  ['Organisation', 'org.logo', 'Logo image — use as <img src="{{org.logo}}">', 'image'],
  ['Organisation', 'org.branch', "Employee's branch / location name", 'text'],
  ['Organisation', 'org.branchAddress', "Employee's branch address", 'text'],
  ['Branding', 'brand.title', 'Document title ("Payslip")', 'text'],
  ['Branding', 'brand.primaryColor', 'Primary colour (#2563eb)', 'text'],
  ['Branding', 'brand.accentColor', 'Accent colour', 'text'],
  ['Branding', 'brand.headerNote', 'Header note', 'text'],
  ['Branding', 'brand.footerNote', 'Footer note', 'text'],
  ['Branding', 'brand.signature', 'Signature image — <img src="{{brand.signature}}">', 'image'],
  ['Branding', 'brand.signatoryName', 'Signatory name', 'text'],
  ['Branding', 'brand.signatureLabel', 'Signature label ("Authorized Signatory")', 'text'],
  ['Payslip', 'payslip.number', 'Payslip number', 'text'],
  ['Payslip', 'payslip.status', '"Paid on 05 Oct 2026" or "Issued"', 'text'],
  ['Payslip', 'payslip.statusCode', 'PAID / GENERATED', 'text'],
  ['Payslip', 'payslip.isPaid', 'True once paid', 'flag'],
  ['Payslip', 'payslip.paidOn', 'Date paid', 'text'],
  ['Payslip', 'payslip.generatedOn', 'Date generated', 'text'],
  ['Payslip', 'payslip.cycleName', 'Payroll cycle name', 'text'],
  ['Payslip', 'payslip.currency', 'Currency code (INR)', 'text'],
  ['Payslip', 'payslip.currencySymbol', 'Currency symbol (₹)', 'text'],
  ['Period', 'period.label', 'Pay period ("September 2026")', 'text'],
  ['Period', 'period.start', 'Period start date (custom cycles)', 'text'],
  ['Period', 'period.end', 'Period end date (custom cycles)', 'text'],
  ['Employee', 'employee.name', 'Employee name', 'text'],
  ['Employee', 'employee.code', 'Employee code', 'text'],
  ['Employee', 'employee.designation', 'Designation', 'text'],
  ['Employee', 'employee.department', 'Department', 'text'],
  ['Employee', 'employee.location', 'Location / branch', 'text'],
  ['Employee', 'employee.joiningDate', 'Date of joining', 'text'],
  ['Employee', 'employee.costCenter', 'Cost centre', 'text'],
  ['Employee', 'employee.email', 'Work e-mail', 'text'],
  ['Employee', 'employee.bankName', 'Bank name', 'text'],
  ['Employee', 'employee.bankAccount', 'Bank account (masked: XXXXXXXXXX6789)', 'text'],
  ['Employee', 'employee.bankIfsc', 'IFSC', 'text'],
  ['Employee', 'employee.pan', 'PAN', 'text'],
  ['Employee', 'employee.uan', 'UAN', 'text'],
  ['Employee', 'employee.esi', 'ESI number', 'text'],
  ['Employee', 'employee.ctcAnnual', 'Annual CTC', 'money'],
  ['Attendance', 'attendance', 'Attendance figures exist and the days summary is on', 'object'],
  ['Attendance', 'attendance.working', 'Working days', 'text'],
  ['Attendance', 'attendance.paid', 'Paid days', 'text'],
  ['Attendance', 'attendance.present', 'Present days', 'text'],
  ['Attendance', 'attendance.leave', 'Leave days', 'text'],
  ['Attendance', 'attendance.half', 'Half days', 'text'],
  ['Attendance', 'attendance.lop', 'Loss-of-pay days', 'text'],
  ['Attendance', 'attendance.overtimeHours', 'Overtime hours', 'text'],
  ['Totals', 'totals.earnings', 'Total earnings', 'money'],
  ['Totals', 'totals.reimbursements', 'Total reimbursements', 'money'],
  ['Totals', 'totals.gross', 'Gross (earnings + reimbursements)', 'money'],
  ['Totals', 'totals.deductions', 'Total deductions', 'money'],
  ['Totals', 'totals.employer', 'Total employer contributions', 'money'],
  ['Totals', 'totals.net', 'Net pay with currency (₹40,727.27)', 'money'],
  ['Totals', 'totals.netAmount', 'Net pay, number only (40,727.27)', 'money'],
  ['Totals', 'totals.netInWords', 'Net pay in words (blank when turned off)', 'text'],
  ['Totals', 'totals.unrecovered', 'Deductions that could not be recovered (net floored at 0)', 'money'],
  ['Totals', 'totals.equation', '"Gross ₹… − Deductions ₹…" (+ unrecovered note)', 'text'],
  ['Revision', 'revision', 'This is a revised payslip', 'object'],
  ['Revision', 'revision.version', 'Version number', 'text'],
  ['Revision', 'revision.supersedesIssuedOn', 'Issue date of the version it replaces', 'text'],
  ['Revision', 'revision.paidDifference', 'Difference vs what was already paid', 'money'],
  ['Revision', 'revision.note', 'The one-line "Revised (v2) — supersedes…" note', 'text'],
];

export const PLACEHOLDERS: PlaceholderInfo[] = [
  ...ROOT.map(([group, path, label, type]) => ({ group, path, label, type })),
  ...PAYSLIP_FIELDS.map(f => ({ group: 'Show (Fields tab)', path: `show.${f.key}`, label: `On when "${f.label}" is ticked`, type: 'flag' as const })),
  ...LISTS.flatMap(l => [
    { group: 'Lists', path: l.key, label: l.label, type: 'list' as const },
    ...l.fields.map(([f, label, type]) => ({ group: 'Lists', path: f, label, type, list: l.key })),
  ]),
  ...LOOP_VARS.map(([path, label, type]) => ({ group: 'Inside any loop', path, label, type, list: '*' })),
];

const rootTypes = new Map<string, PlaceholderType>(PLACEHOLDERS.filter(p => !p.list).map(p => [p.path, p.type]));
const listFields = new Map<string, Map<string, PlaceholderType>>(LISTS.map(l => [l.key, new Map(l.fields.map(([f, , t]) => [f, t]))]));
const loopVars = new Map<string, PlaceholderType>(LOOP_VARS.map(([p, , t]) => [p, t]));
const IMAGE_PATHS = PLACEHOLDERS.filter(p => p.type === 'image').map(p => p.path);

// ─── Parser ──────────────────────────────────────────────────────────────────

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; path: string; pos: number }
  | { t: 'each'; path: string; pos: number; body: Node[]; inverse: Node[] }
  | { t: 'if'; path: string; pos: number; negate: boolean; body: Node[]; inverse: Node[] };

export interface TemplateIssue { message: string; line: number }
class ParseError extends Error { constructor(message: string, public pos: number) { super(message); } }

const PATH_RE = /^(?:this|@[a-z]+|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/;
// Line numbers via a cached table of line starts + binary search: slicing and
// splitting the source per placeholder was O(size × placeholders) — seconds of
// blocked event loop for a 200 KB template full of {{…}}.
let lineCache: { src: string; starts: number[] } | null = null;
const lineOf = (src: string, pos: number) => {
  if (lineCache?.src !== src) {
    const starts = [0];
    for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
    lineCache = { src, starts };
  }
  const st = lineCache.starts; let lo = 0, hi = st.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo + 1;
};

/** Tokenise + build the tree. Throws ParseError on structural problems. */
function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Extract<Node, { t: 'each' | 'if' }>; kind: 'each' | 'if' | 'unless'; inElse: boolean }[] = [];
  const out = () => { const top = stack[stack.length - 1]; return !top ? root : top.inElse ? top.node.inverse : top.node.body; };
  // `{{{` opens a (rejected) triple; a lone `}` after `}}` is ordinary text —
  // minified CSS like `.t{color:{{brand.primaryColor}}}` must keep working.
  // Scanned with indexOf, not a lazy regex: /\{\{([\s\S]*?)\}\}/ retried from
  // every "{{" to the end of the source when no "}}" followed — quadratic, 20 s
  // of blocked event loop (every tenant) for 200 KB of "{{". Same semantics:
  // the first "}}" after the opener closes it; an opener with no "}}" after it
  // (and so everything after) is plain text.
  let last = 0; let from = 0;
  for (;;) {
    const open = src.indexOf('{{', from);
    if (open < 0) break;
    const triple = src[open + 2] === '{';
    let close = triple ? src.indexOf('}}', open + 3) : -1;
    const isTriple = triple && close >= 0;
    if (!isTriple) close = src.indexOf('}}', open + 2);
    if (close < 0) break;
    const m = ['', isTriple ? '{' : '', src.slice(open + (isTriple ? 3 : 2), close)];
    if (open > last) out().push({ t: 'text', v: src.slice(last, open) });
    last = from = close + 2;
    const pos = open;
    if (m[1]) throw new ParseError('Triple braces {{{…}}} (unescaped output) are not supported — every value is escaped', pos);
    const raw = m[2].trim();
    if (raw.startsWith('!')) continue; // comment
    if (!raw) throw new ParseError('Empty {{ }}', pos);
    if (raw[0] === '#') {
      const [kw, path, ...extra] = raw.slice(1).trim().split(/\s+/);
      if (kw !== 'each' && kw !== 'if' && kw !== 'unless') throw new ParseError(`Unknown block {{#${kw}}} — use #each, #if or #unless`, pos);
      if (!path) throw new ParseError(`{{#${kw}}} needs a placeholder, e.g. {{#${kw} ${kw === 'each' ? 'earnings' : 'loans'}}}`, pos);
      if (extra.length || !PATH_RE.test(path)) throw new ParseError(`{{#${kw} ${raw.slice(kw.length + 2).trim()}}} — only a single placeholder name is allowed (no expressions)`, pos);
      if (stack.length >= MAX_NESTING) throw new ParseError(`Blocks are nested more than ${MAX_NESTING} deep`, pos);
      const node: any = kw === 'each' ? { t: 'each', path, pos, body: [], inverse: [] } : { t: 'if', path, pos, negate: kw === 'unless', body: [], inverse: [] };
      out().push(node);
      stack.push({ node, kind: kw, inElse: false });
      continue;
    }
    if (raw[0] === '/') {
      const kw = raw.slice(1).trim();
      const top = stack.pop();
      if (!top) throw new ParseError(`{{/${kw}}} has no matching {{#${kw}}}`, pos);
      if (top.kind !== kw) throw new ParseError(`{{/${kw}}} closes {{#${top.kind} ${top.node.path}}} (opened on line ${lineOf(src, top.node.pos)})`, pos);
      continue;
    }
    if (raw === 'else') {
      const top = stack[stack.length - 1];
      if (!top) throw new ParseError('{{else}} outside an #if / #each block', pos);
      if (top.inElse) throw new ParseError('Two {{else}} in the same block', pos);
      top.inElse = true;
      continue;
    }
    if (!PATH_RE.test(raw)) throw new ParseError(`{{${raw}}} is not a placeholder — names look like {{employee.name}} (no spaces, helpers or expressions)`, pos);
    out().push({ t: 'var', path: raw, pos });
  }
  if (last < src.length) out().push({ t: 'text', v: src.slice(last) });
  if (stack.length) { const top = stack[stack.length - 1]; throw new ParseError(`{{#${top.kind} ${top.node.path}}} is never closed — add {{/${top.kind}}}`, top.node.pos); }
  return root;
}

/** Type of a path in the given loop scopes (innermost last), or null when unknown. */
function typeOf(path: string, scopes: string[]): PlaceholderType | null {
  if (scopes.length) {
    const inner = listFields.get(scopes[scopes.length - 1]);
    if (path === 'this') return inner?.has('this') ? 'text' : null;
    if (loopVars.has(path)) return loopVars.get(path)!;
    if (inner?.has(path)) return inner.get(path)!;
  }
  return rootTypes.get(path) ?? null;
}

/**
 * Validate a template source: structure, unknown placeholders, misuse
 * ({{earnings}} printed as text, #each over a non-list). Errors carry line numbers.
 */
export function validateTemplate(src: string): { errors: TemplateIssue[]; unknown: string[] } {
  const errors: TemplateIssue[] = []; const unknown = new Set<string>();
  let tree: Node[];
  try { tree = parse(src); } catch (e) {
    if (e instanceof ParseError) return { errors: [{ message: e.message, line: lineOf(src, e.pos) }], unknown: [] };
    throw e;
  }
  const walk = (nodes: Node[], scopes: string[]) => {
    for (const n of nodes) {
      if (n.t === 'text') continue;
      const ty = typeOf(n.path, scopes);
      const line = lineOf(src, n.pos);
      if (!ty) {
        unknown.add(n.path);
        const hint = n.path.startsWith('@') ? ' (only inside {{#each}})' : scopes.length === 0 && [...listFields.values()].some(f => f.has(n.path)) ? ' (item fields like this only work inside {{#each …}})' : '';
        errors.push({ message: `Unknown placeholder {{${n.path}}}${hint}`, line });
        if (n.t !== 'var') { walk(n.body, n.t === 'each' ? [...scopes, n.path] : scopes); walk(n.inverse, scopes); }
        continue;
      }
      if (n.t === 'var') {
        if (ty === 'list') errors.push({ message: `{{${n.path}}} is a list — loop over it with {{#each ${n.path}}}…{{/each}}`, line });
        else if (ty === 'object') errors.push({ message: `{{${n.path}}} is a group — use it in {{#if ${n.path}}} or print a field such as {{${n.path}.${n.path === 'attendance' ? 'paid' : 'version'}}}`, line });
      } else if (n.t === 'each') {
        if (ty !== 'list') errors.push({ message: `{{#each ${n.path}}} — ${n.path} is not a list`, line });
        walk(n.body, ty === 'list' ? [...scopes, n.path] : scopes); walk(n.inverse, scopes);
      } else { walk(n.body, scopes); walk(n.inverse, scopes); }
    }
  };
  walk(tree, []);
  return { errors, unknown: [...unknown] };
}

// ─── Values + renderer ───────────────────────────────────────────────────────

/** A money value: prints formatted, is truthy when non-zero. */
export class Money { constructor(public value: number, public text: string) {} toString() { return this.text; } }

export const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c] as string));
/** For values filled into the CSS field: keep colours/data URIs, drop anything that could end a string, block or rule. */
export const escapeCssValue = (s: unknown) => String(s ?? '').replace(/[<>"'`\\{}\r\n]/g, '');

const truthy = (v: unknown): boolean =>
  v instanceof Money ? v.value !== 0 : Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v !== '' : typeof v === 'number' ? v !== 0 : !!v;
const show = (v: unknown): string => (v == null || v === false ? '' : v === true ? 'true' : String(v));

function lookup(ctx: any, path: string, frames: any[]): unknown {
  if (frames.length) {
    const f = frames[frames.length - 1];
    if (path === 'this') return f.item;
    if (path === '@index') return f.index;
    if (path === '@number') return f.index + 1;
    if (path === '@first') return f.index === 0;
    if (path === '@last') return f.index === f.count - 1;
    if (f.item && typeof f.item === 'object' && !(f.item instanceof Money) && path in f.item) return f.item[path];
  }
  let cur: any = ctx;
  for (const seg of path.split('.')) { if (cur == null || typeof cur !== 'object') return undefined; cur = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined; }
  return cur;
}

export class TemplateRenderError extends Error { constructor(message: string, public issues: TemplateIssue[] = []) { super(message); } }

/**
 * Fill a template. Throws TemplateRenderError when the source does not
 * validate (callers validate on save, so this only fires for rows written
 * around the API) — never prints a half-filled payslip.
 */
export function renderTemplate(src: string, ctx: Record<string, unknown>, escape: (s: unknown) => string = escapeHtml, opts: { lenient?: boolean } = {}): string {
  // lenient (editor preview only): unknown placeholders print as a visible ⟦name?⟧ marker instead of failing the whole preview.
  const { errors } = opts.lenient ? { errors: [] } : validateTemplate(src);
  if (errors.length) throw new TemplateRenderError(`Template has ${errors.length} problem(s): ${errors.slice(0, 3).map(e => `line ${e.line}: ${e.message}`).join('; ')}`, errors);
  const tree = parse(src);
  let size = 0;
  const parts: string[] = [];
  const emit = (s: string) => { size += s.length; if (size > OUTPUT_MAX_CHARS) throw new TemplateRenderError('Rendered payslip is too large'); parts.push(s); };
  const known = (path: string, frames: any[]) => !opts.lenient || typeOf(path, frames.map(f => f.list)) !== null;
  // Work budget, not just an output cap: nested {{#each}} blocks with no text
  // in them emit nothing, so 8–12 levels over a 12-row list ran for minutes
  // (12^8 visits ≈ 34 s) on the API's single thread without ever hitting
  // OUTPUT_MAX_CHARS. A real payslip visits a few thousand nodes.
  let work = 0;
  const run = (nodes: Node[], frames: any[]) => {
    for (const n of nodes) {
      if (++work > RENDER_MAX_STEPS) throw new TemplateRenderError('The template does too much work (deeply nested loops) — simplify it');
      if (n.t === 'text') emit(n.v);
      else if (n.t === 'var') emit(escape(known(n.path, frames) ? show(lookup(ctx, n.path, frames)) : `⟦${n.path}?⟧`));
      else if (n.t === 'if') { const v = truthy(lookup(ctx, n.path, frames)); run(v !== n.negate ? n.body : n.inverse, frames); }
      else {
        const list = lookup(ctx, n.path, frames);
        const arr = Array.isArray(list) ? list : [];
        if (!arr.length) run(n.inverse, frames);
        arr.forEach((item, index) => run(n.body, [...frames, { item, index, count: arr.length, list: n.path }]));
      }
    }
  };
  run(tree, []);
  return parts.join('');
}

/**
 * Placeholder values for a document. Visibility decisions already made in
 * buildPayslipDoc (doc.fields) are applied here too: a field switched off in
 * the Fields tab renders blank, so PAN/bank details can be withheld org-wide
 * without editing the HTML.
 */
export function buildTemplateContext(doc: PayslipDoc, images: { logo?: string | null; signature?: string | null } = {}): Record<string, unknown> {
  const F = doc.fields, e = doc.employee, B = doc.brand;
  const cur = (v: number) => new Money(v, money(v, doc.currency, doc.locale));
  const bare = (v: number) => new Money(v, amountText(v, doc.locale));
  const on = (k: FieldKey, v: string | null | undefined) => (F[k] ? v ?? '' : '');
  const line = (l: DocLine) => ({ name: l.name, code: l.code, amount: bare(l.amount), amountWithCurrency: cur(l.amount), basis: F.lineBasis ? l.basis ?? '' : '' });
  const pairs = detailPairs(doc);
  const fm = (v: number) => money(v, doc.currency, doc.locale);
  const revLines = revisionNoteLines(doc.revision, fm, fmtDate);
  const d = F.daysSummary ? doc.days : null;
  const gross = doc.totals.earnings + doc.totals.reimbursements;
  return {
    org: { name: doc.company.name, address: doc.company.address ?? '', logo: images.logo ?? doc.company.logoUrl ?? '', branch: doc.company.branch ?? '', branchAddress: doc.company.branchAddress ?? '' },
    brand: {
      title: B.title, primaryColor: B.primary, accentColor: B.accent, headerNote: B.headerNote ?? '', footerNote: B.footerNote ?? '',
      signature: B.showSignature ? images.signature ?? B.signatureUrl ?? '' : '', signatoryName: B.signatoryName ?? '', signatureLabel: B.signatureLabel,
    },
    payslip: {
      number: doc.payslip.number, statusCode: doc.payslip.status, isPaid: doc.payslip.status === 'PAID',
      status: doc.payslip.status === 'PAID' ? `Paid${doc.payslip.paidAt ? ' on ' + fmtDate(doc.payslip.paidAt) : ''}` : 'Issued',
      paidOn: doc.payslip.paidAt ? fmtDate(doc.payslip.paidAt) : '', generatedOn: doc.payslip.generatedAt ? fmtDate(doc.payslip.generatedAt) : '',
      cycleName: doc.payslip.cycleName ?? '', currency: doc.currency, currencySymbol: currencySymbol(doc.currency, doc.locale),
    },
    period: { label: doc.payslip.periodLabel, start: doc.payslip.periodStart ? fmtDate(doc.payslip.periodStart) : '', end: doc.payslip.periodEnd ? fmtDate(doc.payslip.periodEnd) : '' },
    employee: {
      name: e.name, code: on('employeeCode', e.code), designation: on('designation', e.designation), department: on('department', e.department),
      location: on('location', e.location), joiningDate: F.joiningDate && e.joiningDate ? fmtDate(e.joiningDate) : '', costCenter: on('costCenter', e.costCenter),
      email: on('email', e.email), bankName: on('bankDetails', e.bankName), bankAccount: on('bankDetails', e.bankAccountMasked), bankIfsc: on('bankDetails', e.bankIfsc),
      pan: on('statutoryIds', e.pan), uan: on('statutoryIds', e.uan), esi: on('statutoryIds', e.esi),
      ctcAnnual: F.ctc && doc.totals.ctcAnnual != null ? cur(doc.totals.ctcAnnual) : '',
    },
    attendance: d ? { working: String(d.working), paid: String(d.paid), present: String(d.present), leave: String(d.leave), half: String(d.half), lop: String(d.lop), overtimeHours: String(d.overtimeHours) } : null,
    attendanceTiles: dayTiles(doc).map(([label, value, negative]) => ({ label, value, negative })),
    employeeDetails: pairs.employee.map(([label, value]) => ({ label, value })),
    paymentDetails: pairs.payment.map(([label, value]) => ({ label, value })),
    earnings: doc.earnings.map(line), reimbursements: doc.reimbursements.map(line), deductions: doc.deductions.map(line),
    employerContributions: F.employerContributions ? doc.employerContributions.map(line) : [],
    loans: doc.loans.map(l => ({ name: l.name, type: l.type ?? '', principal: bare(l.principal), recoveredThisPeriod: bare(l.recoveredThisPeriod), totalRecovered: bare(l.totalRecovered), outstanding: bare(l.outstanding), emiLabel: l.emiLabel ?? '' })),
    totals: {
      earnings: cur(doc.totals.earnings), reimbursements: cur(doc.totals.reimbursements), gross: cur(gross), deductions: cur(doc.totals.deductions),
      employer: cur(doc.totals.employer), net: cur(doc.totals.net), netAmount: bare(doc.totals.net),
      netInWords: F.amountInWords ? doc.netInWords : '', unrecovered: cur(Number(doc.totals.unrecovered ?? 0)),
      equation: `Gross ${fm(gross)} − Deductions ${fm(doc.totals.deductions)}${unrecoveredNote(doc, fm)}`,
    },
    revision: doc.revision ? {
      version: String(doc.revision.version), supersedesIssuedOn: doc.revision.supersedesIssuedAt ? fmtDate(doc.revision.supersedesIssuedAt) : '',
      paidDifference: doc.revision.paidDifference != null ? cur(doc.revision.paidDifference) : '', note: revLines[0] ?? '',
    } : null,
    revisionLines: revLines,
    show: Object.fromEntries(PAYSLIP_FIELDS.map(f => [f.key, f.key === 'signature' ? B.showSignature : !!F[f.key]])),
  };
}

// ─── Sanitizer ───────────────────────────────────────────────────────────────

const ALLOWED_TAGS = [
  'div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'address', 'img', 'a', 'abbr', 'time', 'wbr',
];
// Contents dropped too (not just the tag): scripts, embedded documents, inline SVG/MathML (their own script/link vectors), head-only tags.
const DROP_WITH_CONTENT = ['script', 'style', 'textarea', 'option', 'xmp', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'noembed', 'noframes', 'template', 'svg', 'math', 'title', 'select', 'button', 'canvas', 'audio', 'video', 'picture', 'source', 'track', 'portal'];
const GLOBAL_ATTRS = ['class', 'id', 'style', 'title', 'dir', 'lang', 'role', 'aria-*', 'data-*'];
const ALLOWED_ATTRS: Record<string, string[]> = {
  '*': GLOBAL_ATTRS,
  img: ['src', 'alt', 'width', 'height'],
  a: ['href', 'name', 'rel'],
  table: ['border', 'cellpadding', 'cellspacing', 'width', 'align', 'bgcolor', 'summary'],
  td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'nowrap'],
  th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'scope', 'nowrap'],
  tr: ['align', 'valign', 'bgcolor'], col: ['span', 'width'], colgroup: ['span', 'width'],
  div: ['align'], p: ['align'], ol: ['start', 'type', 'reversed'], li: ['value'], time: ['datetime'], hr: ['width', 'size', 'align', 'noshade'],
};
const attrAllowed = (tag: string, a: string) => {
  const ok = (list?: string[]) => !!list?.some(x => x === a || (x.endsWith('*') && a.startsWith(x.slice(0, -1))));
  return ok(ALLOWED_ATTRS['*']) || ok(ALLOWED_ATTRS[tag]);
};

const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=\s]+$/i;
const IMAGE_PLACEHOLDER_RE = new RegExp(`^\\{\\{\\s*(?:${IMAGE_PATHS.map(p => p.replace('.', '\\.')).join('|')})\\s*\\}\\}$`);

export interface SanitizePolicy {
  /** 'save': image placeholders allowed as src (values unknown yet). 'render': final values, strict allow-list. */
  mode: 'save' | 'render';
  /** render mode: the template's own asset URLs (logo, signature, watermark) that may appear as image sources */
  allowedImageUrls?: string[];
}

const imageAllowed = (src: string, p: SanitizePolicy) => {
  const v = src.trim();
  if (DATA_IMAGE_RE.test(v)) return true;
  if (p.mode === 'save') return IMAGE_PLACEHOLDER_RE.test(v);
  return !!v && (p.allowedImageUrls ?? []).includes(v);
};
const hrefAllowed = (href: string, p: SanitizePolicy) => {
  const v = href.trim();
  if (v.startsWith('#') || /^mailto:/i.test(v)) return true;
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return true;
  return p.mode === 'save' && /^\{\{\s*[\w.@]+\s*\}\}$/.test(v);
};

/**
 * CSS (a <style> block, the template's CSS field or a style="" attribute):
 * removes everything that could fetch from the network or run code —
 * @import, url()/image-set()/src() to anything but an allowed image,
 * expression(), behavior / -moz-binding, javascript: — plus comments and
 * backslash escapes (which could spell "url" as "u\72l"). `<` is removed so a
 * block can never close its <style> element.
 */
export function sanitizeCss(css: string, policy: SanitizePolicy): { css: string; removed: string[] } {
  const removed = new Set<string>();
  let s = css;
  const strip = (re: RegExp, label: string, repl = '') => { s = s.replace(re, () => { removed.add(label); return repl; }); };
  strip(/\/\*[\s\S]*?(?:\*\/|$)/g, '', ' '); removed.delete('');
  strip(/\\/g, 'CSS escape sequences');
  strip(/</g, '"<" in CSS');
  strip(/@import\b[^;]*;?/gi, '@import');
  strip(/@(?:namespace|charset)\b[^;]*;?/gi, '@namespace/@charset');
  strip(/javascript\s*:/gi, 'javascript: URL');
  strip(/expression\s*\(/gi, 'CSS expression()', 'x-blocked(');
  strip(/(?<![\w-])(?:behavior|-moz-binding)\s*:/gi, 'behavior/-moz-binding', 'x-blocked:');
  strip(/(?:-webkit-)?image-set\s*\(/gi, 'image-set()', 'x-blocked(');
  strip(/(?<![\w-])src\s*\(/gi, 'src()', 'x-blocked(');
  // A blocked function keeps nothing of its arguments (e.g. image-set's URL strings).
  s = s.replace(/x-blocked\([^)]*\)?/g, 'none');
  // url(…) — walk each occurrence so unbalanced or nested forms can't slip through.
  let out = ''; let i = 0;
  const urlRe = /url\s*\(/gi; let m: RegExpExecArray | null;
  while ((m = urlRe.exec(s))) {
    out += s.slice(i, m.index);
    const start = urlRe.lastIndex; const end = s.indexOf(')', start);
    if (end < 0) { removed.add('unterminated url()'); i = s.length; urlRe.lastIndex = s.length; break; }
    const inner = s.slice(start, end).trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (imageAllowed(inner, policy)) out += `url("${inner.replace(/["\s]/g, '')}")`;
    else { out += 'none'; removed.add(`url(${inner.length > 40 ? inner.slice(0, 40) + '…' : inner})`); }
    i = end + 1; urlRe.lastIndex = i;
  }
  out += s.slice(i);
  return { css: out, removed: [...removed] };
}

export interface SanitizeResult { html: string; removed: string[] }

/**
 * Pull out <style …>…</style> blocks (an unclosed one runs to the end), the
 * same as /<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi but in linear time:
 * that regex rescanned to the end for every "<style" lacking a ">" (8 s for
 * 200 KB). A "<style" with no ">" after it is left for sanitize-html.
 */
export function extractStyleBlocks(html: string, onCss: (css: string) => void): string {
  const lower = html.toLowerCase();
  let out = ''; let i = 0; let from = 0;
  for (;;) {
    const at = lower.indexOf('<style', from);
    if (at < 0) break;
    if (/\w/.test(lower[at + 6] ?? '')) { from = at + 6; continue; } // <styles> — not a style tag (\b in the old regex)
    const gt = lower.indexOf('>', at + 6);
    if (gt < 0) break;
    const closeRe = /<\/style\s*>/g; closeRe.lastIndex = gt + 1;
    const c = closeRe.exec(lower);
    onCss(html.slice(gt + 1, c ? c.index : html.length));
    out += html.slice(i, at);
    i = from = c ? closeRe.lastIndex : html.length;
  }
  return out + html.slice(i);
}

/**
 * Sanitize template HTML. <style> blocks are pulled out first and run through
 * sanitizeCss (sanitize-html does not clean CSS inside <style>); everything
 * else goes through sanitize-html with a layout/text/table/image allow-list.
 * `removed` lists what was stripped, so the editor can say so.
 */
export function sanitizeTemplateHtml(html: string, policy: SanitizePolicy): SanitizeResult {
  const removed = new Set<string>();
  const styles: string[] = [];
  const withoutStyles = extractStyleBlocks(html, css => {
    const r = sanitizeCss(css, policy); r.removed.forEach(x => removed.add(x)); styles.push(r.css);
  });
  const body = sanitizeHtml(withoutStyles, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    // Scheme checks are done in transformTags below (data: images + the template's own assets only).
    allowedSchemes: ['https', 'mailto', 'data'], allowedSchemesByTag: {}, allowProtocolRelative: false,
    allowedSchemesAppliedToAttributes: ['href', 'cite'],
    nonTextTags: DROP_WITH_CONTENT,
    disallowedTagsMode: 'discard',
    parseStyleAttributes: false,
    onOpenTag: (tag, attribs) => {
      if (!ALLOWED_TAGS.includes(tag) && !['html', 'head', 'body'].includes(tag)) removed.add(`<${tag}>`);
      for (const a of Object.keys(attribs)) {
        if (/^on/i.test(a)) removed.add(`${a}= event handler`);
        else if (ALLOWED_TAGS.includes(tag) && !attrAllowed(tag, a)) removed.add(`${a}= attribute on <${tag}>`);
      }
    },
    transformTags: {
      '*': (tagName, attribs) => {
        const a = { ...attribs };
        if (a.style != null) { const r = sanitizeCss(a.style, policy); r.removed.forEach(x => removed.add(x)); a.style = r.css; }
        if (tagName === 'img' && a.src != null && !imageAllowed(a.src, policy)) { removed.add(`image source ${a.src.length > 50 ? a.src.slice(0, 50) + '…' : a.src}`); delete a.src; }
        if (tagName === 'a') {
          if (a.href != null && !hrefAllowed(a.href, policy)) { removed.add(`link ${a.href.slice(0, 50)}`); delete a.href; }
          // Links can't navigate the sandboxed frame anyway; this keeps the PDF's link annotations honest.
          a.rel = 'noopener noreferrer';
        }
        return { tagName, attribs: a };
      },
    },
  });
  const css = styles.filter(s => s.trim()).join('\n');
  return { html: (css ? `<style>${css}</style>` : '') + body, removed: [...removed] };
}

// ─── Save-time processing ────────────────────────────────────────────────────

export interface CheckedTemplate { htmlBody: string; htmlCss: string | null; errors: TemplateIssue[]; unknown: string[]; removed: string[] }

/**
 * Validate + sanitize what an HR manager typed. The source is stored as typed
 * when nothing unsafe was found (sanitize-html would otherwise reformat it —
 * <br> → <br />, decoded entities — and the code editor would show different
 * code than they wrote); when something was stripped, the cleaned version is
 * stored and `removed` says what went. Render-time sanitizing is the real
 * guarantee either way.
 */
export function checkTemplateSource(htmlBody: string, htmlCss: string | null | undefined): CheckedTemplate {
  const css = htmlCss ?? '';
  const errors: TemplateIssue[] = [];
  const bytes = Buffer.byteLength(htmlBody, 'utf8') + Buffer.byteLength(css, 'utf8');
  if (bytes > HTML_TEMPLATE_MAX_BYTES) errors.push({ message: `Template is ${Math.ceil(bytes / 1024)} KB — the limit is ${HTML_TEMPLATE_MAX_BYTES / 1024} KB (HTML + CSS). Use the Logo / Signature fields instead of pasting large images.`, line: 1 });
  if (!htmlBody.trim()) errors.push({ message: 'The HTML is empty', line: 1 });
  if (errors.length) return { htmlBody, htmlCss: htmlCss ?? null, errors, unknown: [], removed: [] };
  const v1 = validateTemplate(htmlBody);
  const v2 = validateTemplate(css);
  errors.push(...v1.errors, ...v2.errors.map(e => ({ ...e, message: `CSS: ${e.message}` })));
  const h = sanitizeTemplateHtml(htmlBody, { mode: 'save' });
  const c = sanitizeCss(css, { mode: 'save' });
  const removed = [...new Set([...h.removed, ...c.removed])];
  const hRemoved = h.removed.length > 0;
  return {
    htmlBody: hRemoved ? h.html : htmlBody,
    htmlCss: !css.trim() ? null : c.removed.length ? c.css : css,
    errors, unknown: [...new Set([...v1.unknown, ...v2.unknown])], removed,
  };
}

// ─── Final document ──────────────────────────────────────────────────────────

/** Base styles under the author's CSS: A4 page, watermark layer, sensible defaults. The author's CSS comes later and wins. */
const BASE_CSS = `@page{size:A4;margin:12mm}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;background:#fff;color:#111827;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px}
.zps-root{position:relative}.zps-root>*:not(.wm){position:relative;z-index:1}
.wm{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}.wm img{position:absolute;left:50%;top:50%;max-width:none;height:auto}.wm svg{position:absolute;inset:0;width:100%;height:100%}
img{max-width:100%}
@media screen{body{padding:20px 16px}}`;

export interface CustomRenderOptions {
  /** 'pdf': images must already be data URIs (see utils/payslipOutput.ts); CSP allows data: images only */
  target: 'browser' | 'pdf';
  /** Replacements for the template's image URLs (PDF: the fetched bytes as data URIs) */
  images?: { logo?: string | null; signature?: string | null; watermark?: string | null };
  /** Editor preview: unknown placeholders render as a marker instead of throwing */
  lenient?: boolean;
}

/**
 * The complete, self-contained HTML document for a custom-HTML payslip. It is
 * always shown in isolation (sandboxed iframe / headless Chromium with JS
 * off), never injected into the app's DOM.
 */
export function renderCustomPayslipHtml(doc: PayslipDoc, opts: CustomRenderOptions): string {
  if (!doc.custom) throw new Error('Not a custom HTML payslip');
  const images = opts.images ?? {};
  const ctx = buildTemplateContext(doc, { logo: images.logo, signature: images.signature });
  const wm = doc.watermark ? { ...doc.watermark, url: images.watermark ?? doc.watermark.url } : null;
  const assetUrls = [ctx.org && (ctx.org as any).logo, (ctx.brand as any).signature, wm?.url].filter((u): u is string => typeof u === 'string' && !!u);
  const policy: SanitizePolicy = { mode: 'render', allowedImageUrls: opts.target === 'pdf' ? assetUrls.filter(u => u.startsWith('data:')) : assetUrls };
  const filledBody = renderTemplate(doc.custom.html, ctx, escapeHtml, { lenient: opts.lenient });
  const filledCss = doc.custom.css ? renderTemplate(doc.custom.css, ctx, escapeCssValue, { lenient: opts.lenient }) : '';
  const body = sanitizeTemplateHtml(filledBody, policy).html;
  const css = filledCss ? sanitizeCss(filledCss, policy).css : '';
  const imgSrc = opts.target === 'pdf' ? 'data:' : 'data: https:';
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`;
  const wmHtml = wm && (opts.target === 'browser' || wm.url.startsWith('data:')) ? watermarkHtml(wm, false) : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(doc.payslip.number)}</title><style>${BASE_CSS}</style>${css ? `<style>${css}</style>` : ''}</head><body><div class="zps-root">${wmHtml}${body}</div></body></html>`;
}

// ─── Starter template ────────────────────────────────────────────────────────
//
// What "Start from HTML" loads: a clean standard payslip that exercises the
// common placeholders, so HR edits rather than starts from a blank page. Kept
// valid by a unit test.

export const STARTER_HTML = `<div class="slip">
  <header class="hd">
    <div class="brand">
      {{#if org.logo}}<img class="logo" src="{{org.logo}}" alt="">{{/if}}
      <div>
        <div class="co">{{org.name}}</div>
        {{#if org.address}}<div class="addr">{{org.address}}</div>{{/if}}
      </div>
    </div>
    <div class="title">
      <div class="t">{{brand.title}} for</div>
      <div class="p">{{period.label}}</div>
      <div class="n">{{payslip.number}}</div>
    </div>
  </header>

  {{#if revision}}<div class="rev">{{#each revisionLines}}{{this}}<br>{{/each}}</div>{{/if}}
  {{#if brand.headerNote}}<div class="note">{{brand.headerNote}}</div>{{/if}}

  <section class="details">
    <div>
      <h3>Employee details</h3>
      <table class="kv">
        {{#each employeeDetails}}<tr><th>{{label}}</th><td>{{value}}</td></tr>{{/each}}
      </table>
    </div>
    <div>
      <h3>Payment details</h3>
      <table class="kv">
        {{#each paymentDetails}}<tr><th>{{label}}</th><td>{{value}}</td></tr>{{/each}}
      </table>
    </div>
  </section>

  {{#if attendanceTiles}}
  <section>
    <h3>Attendance</h3>
    <div class="tiles">
      {{#each attendanceTiles}}<div class="tile"><span>{{label}}</span><b class="{{#if negative}}neg{{/if}}">{{value}}</b></div>{{/each}}
    </div>
  </section>
  {{/if}}

  <section class="cols">
    <table class="lines">
      <thead><tr><th>Earnings</th><th class="am">Amount ({{payslip.currencySymbol}})</th></tr></thead>
      <tbody>
        {{#each earnings}}<tr><td>{{name}}{{#if basis}}<small>{{basis}}</small>{{/if}}</td><td class="am">{{amount}}</td></tr>{{/each}}
        {{#each reimbursements}}<tr><td>{{name}} <small>Reimbursement</small></td><td class="am">{{amount}}</td></tr>{{/each}}
      </tbody>
      <tfoot><tr><td>Gross earnings</td><td class="am">{{totals.gross}}</td></tr></tfoot>
    </table>
    <table class="lines">
      <thead><tr><th>Deductions</th><th class="am">Amount ({{payslip.currencySymbol}})</th></tr></thead>
      <tbody>
        {{#each deductions}}<tr><td>{{name}}{{#if basis}}<small>{{basis}}</small>{{/if}}</td><td class="am">{{amount}}</td></tr>{{else}}<tr><td class="muted">No deductions</td><td></td></tr>{{/each}}
      </tbody>
      <tfoot><tr><td>Total deductions</td><td class="am">{{totals.deductions}}</td></tr></tfoot>
    </table>
  </section>

  <section class="net">
    <div>
      <div class="lbl">Net pay</div>
      {{#if totals.netInWords}}<div class="words">{{totals.netInWords}}</div>{{/if}}
      <div class="eq">{{totals.equation}}</div>
    </div>
    <div class="val">{{totals.net}}</div>
  </section>

  {{#if loans}}
  <section>
    <h3>Loans &amp; advances</h3>
    <table class="grid">
      <thead><tr><th>Loan</th><th class="am">Principal</th><th class="am">This month</th><th class="am">Total recovered</th><th class="am">Outstanding</th></tr></thead>
      <tbody>
        {{#each loans}}<tr><td><b>{{name}}</b>{{#if emiLabel}}<small>{{emiLabel}}</small>{{/if}}</td><td class="am">{{principal}}</td><td class="am">{{recoveredThisPeriod}}</td><td class="am">{{totalRecovered}}</td><td class="am"><b>{{outstanding}}</b></td></tr>{{/each}}
      </tbody>
    </table>
  </section>
  {{/if}}

  {{#if employerContributions}}
  <section>
    <h3>Employer contributions <span class="hint">not part of net pay</span></h3>
    <table class="lines">
      <tbody>{{#each employerContributions}}<tr><td>{{name}}</td><td class="am">{{amount}}</td></tr>{{/each}}</tbody>
      <tfoot><tr><td>Total</td><td class="am">{{totals.employer}}</td></tr></tfoot>
    </table>
  </section>
  {{/if}}

  <footer class="sign">
    <div>{{#if show.paidStamp}}{{#if payslip.isPaid}}<span class="stamp">PAID</span>{{/if}}{{/if}}</div>
    {{#if show.signature}}
    <div class="sig">
      {{#if brand.signature}}<img src="{{brand.signature}}" alt="">{{/if}}
      <div class="line">{{#if brand.signatoryName}}<b>{{brand.signatoryName}}</b>{{/if}}{{brand.signatureLabel}}</div>
    </div>
    {{/if}}
  </footer>
  {{#if brand.footerNote}}<p class="foot">{{brand.footerNote}}</p>{{/if}}
</div>`;

export const STARTER_CSS = `.slip { max-width: 760px; margin: 0 auto; padding: 8px 0 16px; color: #1f2937; line-height: 1.4; font-size: 12.5px; }
.hd { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 0 0 16px; border-bottom: 3px solid {{brand.primaryColor}}; }
.brand { display: flex; gap: 14px; align-items: center; }
.logo { width: 52px; height: 52px; object-fit: contain; }
.co { font-size: 19px; font-weight: 700; color: #111827; }
.addr { font-size: 11.5px; color: #6b7280; white-space: pre-line; }
.title { text-align: right; }
.t { font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: {{brand.primaryColor}}; }
.p { font-size: 18px; font-weight: 700; }
.n { font-size: 11px; color: #6b7280; }
.rev { margin-top: 10px; padding: 8px 12px; background: #fffbeb; color: #92400e; font-weight: 600; font-size: 12px; }
.note { margin-top: 10px; padding: 8px 12px; background: #f9fafb; color: #4b5563; font-size: 12px; }
section { margin-top: 14px; break-inside: avoid; }
h3 { margin: 0 0 6px; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: {{brand.accentColor}}; }
.hint { font-weight: 500; letter-spacing: 0; text-transform: none; color: #9ca3af; }
.details { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.kv th { text-align: left; font-weight: 400; color: #6b7280; width: 40%; padding: 3px 0; border-bottom: 1px solid #f1f3f5; }
.kv td { font-weight: 600; padding: 3px 0; border-bottom: 1px solid #f1f3f5; }
.tiles { display: flex; gap: 8px; flex-wrap: wrap; }
.tile { flex: 1; min-width: 90px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px 10px; }
.tile span { display: block; font-size: 10px; color: #6b7280; text-transform: uppercase; }
.tile b { font-size: 16px; } .tile b.neg { color: #b91c1c; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: start; }
.lines th { text-align: left; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: {{brand.accentColor}}; padding: 5px 0; border-bottom: 1.5px solid {{brand.primaryColor}}; }
.lines td { padding: 5px 0; border-bottom: 1px solid #f1f3f5; vertical-align: top; }
.lines tfoot td { font-weight: 700; border-top: 1px solid #cbd5e1; border-bottom: 0; }
.am { text-align: right !important; white-space: nowrap; }
small { display: block; font-size: 10.5px; color: #9ca3af; }
.muted { color: #9ca3af; }
.net { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 12px 18px; border-radius: 10px; background: #eff6ff; border: 1px solid #bfdbfe; }
.lbl { font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: {{brand.primaryColor}}; }
.words { font-style: italic; font-size: 12px; margin-top: 3px; }
.eq { font-size: 10.5px; color: #6b7280; margin-top: 3px; }
.val { font-size: 26px; font-weight: 800; color: {{brand.primaryColor}}; white-space: nowrap; }
.grid th { text-align: left; font-size: 10px; color: #6b7280; text-transform: uppercase; padding: 6px 8px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
.grid td { padding: 5px 8px; border-bottom: 1px solid #f1f3f5; }
.sign { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 20px; break-inside: avoid; }
.stamp { display: inline-block; transform: rotate(-10deg); border: 2.5px solid #16a34a; color: #16a34a; font-weight: 800; font-size: 18px; letter-spacing: .2em; padding: 2px 14px; border-radius: 6px; }
.sig { text-align: center; min-width: 180px; font-size: 12px; color: #4b5563; }
.sig img { height: 40px; max-width: 180px; object-fit: contain; }
.sig .line { border-top: 1px solid #cbd5e1; padding-top: 6px; } .sig b { display: block; color: #111827; }
.foot { margin-top: 18px; padding-top: 10px; border-top: 1px solid #f1f3f5; text-align: center; font-size: 10.5px; color: #9ca3af; white-space: pre-line; }
@media (max-width: 600px) { .hd, .net { flex-direction: column; align-items: flex-start; } .title { text-align: left; } .details, .cols { grid-template-columns: 1fr; } }
@media print { tr, .net { break-inside: avoid; } }`;
