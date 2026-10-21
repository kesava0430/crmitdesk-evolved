/**
 * Payslip templates (phase 4): several per org, eight layouts, field
 * visibility, assignment by department / location / employment type, and
 * the render endpoints (HTML, PDF, bulk PDF, e-mail) that use them.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { logAction } from '../../../utils/auditLog';
import { sendMail } from '../../../utils/mailer';
import {
  LAYOUTS, CUSTOM_HTML_LAYOUT, PAYSLIP_FIELDS, buildPayslipDoc, samplePayslipDoc, type PayslipDoc,
} from '../../../utils/payslipRender';
import { renderDocHtml, renderDocHtmlForClient, renderDocPdf, renderDocsBundlePdf } from '../../../utils/payslipOutput';
import { PLACEHOLDERS, STARTER_HTML, STARTER_CSS, HTML_TEMPLATE_MAX_BYTES, checkTemplateSource, renderCustomPayslipHtml, TemplateRenderError, type TemplateIssue } from '../../../utils/payslipHtmlTemplate';
import { htmlPdfStatus, HtmlPdfUnavailableError } from '../../../utils/htmlPdf';

import { canManageHr } from '../../../utils/hrAccess';
import { loanSummaryForPayslip } from './loans.controller';
import { imageUrlSchema, watermarkSchemaFields } from '../../../utils/payslipWatermark';
const emptyToNull = (v: unknown) => (v === '' ? null : v);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const TemplateSchema = z.object({
  name: z.string().min(1).max(80),
  layout: z.enum(['STANDARD', 'MODERN', 'MINIMAL', 'DETAILED', 'COMPACT', 'CORPORATE', 'BRANCH', 'STATEMENT', 'CUSTOM_HTML']).default('STANDARD'),
  /** CUSTOM_HTML only — validated + sanitized by checkHtml() below. The char cap is a cheap first gate; the byte limit is enforced there. */
  htmlBody: z.preprocess(emptyToNull, z.string().max(HTML_TEMPLATE_MAX_BYTES * 2).nullable().optional()),
  htmlCss: z.preprocess(emptyToNull, z.string().max(HTML_TEMPLATE_MAX_BYTES * 2).nullable().optional()),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  companyName: z.preprocess(emptyToNull, z.string().nullable().optional()),
  companyAddress: z.preprocess(emptyToNull, z.string().nullable().optional()),
  logoUrl: z.preprocess(emptyToNull, imageUrlSchema.nullable().optional()),
  primaryColor: hexColor.default('#2563eb'),
  accentColor: z.preprocess(emptyToNull, hexColor.nullable().optional()),
  headerTitle: z.string().min(1).max(60).default('Payslip'),
  headerNote: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
  footerNote: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
  showSignature: z.boolean().default(true),
  signatureLabel: z.string().max(80).default('Authorized Signatory'),
  signatoryName: z.preprocess(emptyToNull, z.string().max(80).nullable().optional()),
  signatureUrl: z.preprocess(emptyToNull, imageUrlSchema.nullable().optional()),
  watermarkImageUrl: z.preprocess(emptyToNull, imageUrlSchema.nullable().optional()),
  ...watermarkSchemaFields,
  showFields: z.record(z.boolean()).nullable().optional(),
  applicability: z.object({
    departmentIds: z.array(z.string()).optional(),
    locationIds: z.array(z.string()).optional(),
    employmentTypes: z.array(z.string()).optional(),
  }).nullable().optional(),
});

class TemplateSourceError extends AppError {
  constructor(public issues: TemplateIssue[], public unknown: string[]) {
    super(400, issues.length === 1 ? `Template error on line ${issues[0].line}: ${issues[0].message}` : `The HTML template has ${issues.length} problems — first, line ${issues[0].line}: ${issues[0].message}`);
  }
}
const sendSourceError = (res: Response, err: TemplateSourceError) => res.status(400).json({ error: err.message, issues: err.issues, unknown: err.unknown });

/**
 * For a CUSTOM_HTML template (the merged state for an update), validate and
 * sanitize the source; returns the values to store plus what was stripped.
 * Built-in layouts keep whatever HTML they had (switching layout back and
 * forth must not lose someone's code).
 */
function checkHtml(merged: { layout?: string | null; htmlBody?: string | null; htmlCss?: string | null }) {
  if (merged.layout !== 'CUSTOM_HTML') return null;
  const r = checkTemplateSource(merged.htmlBody ?? '', merged.htmlCss);
  if (r.errors.length) throw new TemplateSourceError(r.errors, r.unknown);
  return r;
}

/** Every org gets one template row; older orgs already have it (migrated from the single-letterhead model). */
export async function ensureDefaultTemplate(orgId: string) {
  const existing = await prisma.payslipTemplate.findFirst({ where: { orgId, isDefault: true } });
  if (existing) return existing;
  const any = await prisma.payslipTemplate.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  if (any) return prisma.payslipTemplate.update({ where: { id: any.id }, data: { isDefault: true } });
  return prisma.payslipTemplate.create({ data: { orgId, name: 'Default', layout: 'STANDARD', isDefault: true } });
}

/** Employee context needed for template applicability + the document. */
async function employeeFor(orgId: string, userId: string) {
  return prisma.employee.findFirst({
    where: { orgId, userId },
    include: { department: { select: { name: true } }, location: { select: { name: true, addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true, country: true } } },
  });
}

/** First active non-default template whose applicability matches, else the default. */
export async function resolveTemplate(orgId: string, emp: { departmentId?: string | null; locationId?: string | null; employmentType?: string | null } | null) {
  const templates = await prisma.payslipTemplate.findMany({ where: { orgId, isActive: true }, orderBy: [{ isDefault: 'asc' }, { createdAt: 'asc' }] });
  if (templates.length === 0) return ensureDefaultTemplate(orgId);
  const matches = (t: any) => {
    const a = (t.applicability ?? {}) as { departmentIds?: string[]; locationIds?: string[]; employmentTypes?: string[] };
    const rules = [
      a.departmentIds?.length ? a.departmentIds.includes(emp?.departmentId ?? '') : null,
      a.locationIds?.length ? a.locationIds.includes(emp?.locationId ?? '') : null,
      a.employmentTypes?.length ? a.employmentTypes.includes(emp?.employmentType ?? '') : null,
    ].filter(r => r !== null);
    return rules.length > 0 && rules.every(Boolean);
  };
  return templates.find(t => !t.isDefault && matches(t)) ?? templates.find(t => t.isDefault) ?? templates[0];
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listTemplates(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    await ensureDefaultTemplate(orgId);
    const [templates, counts] = await Promise.all([
      prisma.payslipTemplate.findMany({ where: { orgId }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }),
      prisma.payslip.groupBy({ by: ['templateId'], where: { orgId, templateId: { not: null } }, _count: { _all: true } }),
    ]);
    const used = new Map(counts.map(c => [c.templateId, c._count._all]));
    res.json({
      templates: templates.map(t => ({ ...t, payslipCount: used.get(t.id) ?? 0 })), layouts: LAYOUTS.map(({ key, name, description, defaults }) => ({ key, name, description, defaults })), fields: PAYSLIP_FIELDS,
      // Custom HTML templates: the placeholder reference, the starter, and whether this server can print them to PDF.
      customHtml: { layout: { key: CUSTOM_HTML_LAYOUT.key, name: CUSTOM_HTML_LAYOUT.name, description: CUSTOM_HTML_LAYOUT.description, defaults: CUSTOM_HTML_LAYOUT.defaults }, placeholders: PLACEHOLDERS, starter: { html: STARTER_HTML, css: STARTER_CSS }, maxBytes: HTML_TEMPLATE_MAX_BYTES, pdf: htmlPdfStatus() },
    });
  } catch (err) { next(err); }
}

export async function createTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = TemplateSchema.parse(req.body);
    const html = checkHtml(data);
    if (html) { data.htmlBody = html.htmlBody; data.htmlCss = html.htmlCss; }
    await ensureDefaultTemplate(orgId);
    const t = await prisma.$transaction(async tx => {
      if (data.isDefault) await tx.payslipTemplate.updateMany({ where: { orgId }, data: { isDefault: false } });
      return tx.payslipTemplate.create({ data: { orgId, ...data, isDefault: !!data.isDefault, isActive: data.isActive ?? true, showFields: data.showFields ?? undefined, applicability: data.applicability ?? undefined } });
    });
    logAction(req.user!.id, 'CREATE', 'PayslipTemplate', t.id, { name: t.name, layout: t.layout, ...(html?.removed.length ? { sanitized: html.removed } : {}) });
    res.status(201).json({ ...t, warnings: html?.removed ?? [] });
  } catch (err) { if (err instanceof TemplateSourceError) return sendSourceError(res, err); next(err); }
}

export async function updateTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const existing = await prisma.payslipTemplate.findFirst({ where: { id: req.params.id, orgId } });
    if (!existing) throw new AppError(404, 'Template not found');
    const data = TemplateSchema.partial().parse(req.body);
    if (existing.isDefault && (data.isDefault === false || data.isActive === false)) throw new AppError(400, 'Make another template the default first');
    const html = checkHtml({ layout: data.layout ?? existing.layout, htmlBody: data.htmlBody !== undefined ? data.htmlBody : existing.htmlBody, htmlCss: data.htmlCss !== undefined ? data.htmlCss : existing.htmlCss });
    if (html) { data.htmlBody = html.htmlBody; data.htmlCss = html.htmlCss; }
    const t = await prisma.$transaction(async tx => {
      if (data.isDefault) await tx.payslipTemplate.updateMany({ where: { orgId, id: { not: existing.id } }, data: { isDefault: false } });
      return tx.payslipTemplate.update({ where: { id: existing.id }, data: { ...data, showFields: data.showFields === null ? undefined : data.showFields, applicability: data.applicability === null ? undefined : data.applicability } as any });
    });
    logAction(req.user!.id, 'UPDATE', 'PayslipTemplate', t.id, { name: t.name, ...(html?.removed.length ? { sanitized: html.removed } : {}) });
    res.json({ ...t, warnings: html?.removed ?? [] });
  } catch (err) { if (err instanceof TemplateSourceError) return sendSourceError(res, err); next(err); }
}

export async function deleteTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const t = await prisma.payslipTemplate.findFirst({ where: { id: req.params.id, orgId } });
    if (!t) throw new AppError(404, 'Template not found');
    if (t.isDefault) throw new AppError(400, 'The default template cannot be deleted — make another one the default first');
    const used = await prisma.payslip.count({ where: { templateId: t.id } });
    if (used > 0) {
      await prisma.payslipTemplate.update({ where: { id: t.id }, data: { isActive: false } });
      logAction(req.user!.id, 'UPDATE', 'PayslipTemplate', t.id, { action: 'deactivated (in use)' });
      return res.json({ ok: true, deactivated: true, message: `${used} issued payslip(s) use this template, so it was deactivated instead of deleted.` });
    }
    await prisma.payslipTemplate.delete({ where: { id: t.id } });
    logAction(req.user!.id, 'DELETE', 'PayslipTemplate', t.id, {});
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** POST /templates/:id/duplicate */
export async function duplicateTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const t = await prisma.payslipTemplate.findFirst({ where: { id: req.params.id, orgId } });
    if (!t) throw new AppError(404, 'Template not found');
    const { id, createdAt, updatedAt, ...rest } = t as any;
    const copy = await prisma.payslipTemplate.create({ data: { ...rest, name: `${t.name} (copy)`, isDefault: false } });
    res.status(201).json(copy);
  } catch (err) { next(err); }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const payslipInclude = {
  user: { select: { id: true, name: true, email: true, department: true } },
  org: { select: { name: true, currency: true } },
  lines: { orderBy: { displayOrder: 'asc' as const } },
  payrollRun: { select: { id: true, status: true, periodStart: true, periodEnd: true, payrollCycle: { select: { name: true, frequency: true } } } },
  employeeSalary: { select: { ctcAnnual: true } },
  template: true,
};

async function loadPayslipForRender(req: AuthRequest, id: string, templateOverride?: string) {
  const payslip = await prisma.payslip.findFirst({ where: { id, orgId: req.user!.orgId }, include: payslipInclude });
  if (!payslip) throw new AppError(404, 'Payslip not found');
  const isManager = (await canManageHr(req.user!, 'payroll'));
  if (!isManager && payslip.userId !== req.user!.id) throw new AppError(403, 'You can only view your own payslips');
  if (!isManager && payslip.status === 'DRAFT') throw new AppError(404, 'Payslip not found');
  return docFor(payslip, isManager && templateOverride ? templateOverride : undefined);
}

export async function docFor(payslip: any, templateOverride?: string): Promise<PayslipDoc> {
  const employee = await employeeFor(payslip.orgId, payslip.userId);
  let template = templateOverride ? await prisma.payslipTemplate.findFirst({ where: { id: templateOverride, orgId: payslip.orgId } }) : payslip.template;
  if (!template) template = await resolveTemplate(payslip.orgId, employee);
  // A revised payslip says which issue it supersedes (the latest frozen version's issue date).
  let supersedesIssuedAt: string | null = null;
  if ((payslip.version ?? 1) > 1) {
    const prev = await prisma.payslipRevision.findFirst({ where: { orgId: payslip.orgId, payslipId: payslip.id }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }], select: { data: true } });
    supersedesIssuedAt = (prev?.data as any)?.issuedAt ?? null;
  }
  const loans = await loanSummaryForPayslip(payslip);
  return buildPayslipDoc({ payslip, template, employee, org: payslip.org, supersedesIssuedAt, loans });
}

/** GET /payslips/:id/html[?templateId&embed=1] */
export async function payslipHtml(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const doc = await loadPayslipForRender(req, req.params.id, typeof req.query.templateId === 'string' ? req.query.templateId : undefined);
    const embed = req.query.embed === '1';
    if (embed) { const r = renderDocHtmlForClient(doc, { embed: true, clientSandboxes: req.query.sandbox === '1' }); return res.json({ html: r.html, isolated: r.isolated, ...(r.updateRequired ? { updateRequired: true } : {}), template: { layout: doc.layout.key } }); }
    const r = renderDocHtml(doc);
    // A custom template's document is author-written: when opened directly
    // (not in the client's sandboxed iframe) the browser must still treat it
    // as an opaque, script-less origin.
    if (r.isolated) res.setHeader('Content-Security-Policy', "sandbox allow-modals; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'");
    res.type('html').send(r.html);
  } catch (err) { next(err); }
}

/** GET /payslips/:id/pdf[?templateId] */
export async function payslipPdf(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const doc = await loadPayslipForRender(req, req.params.id, typeof req.query.templateId === 'string' ? req.query.templateId : undefined);
    const buf = await renderDocPdf(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${doc.payslip.number}.pdf"`);
    res.send(buf);
  } catch (err) { next(err); }
}

/** GET /runs/:id/pdf — every payslip in the run as one PDF (managers) */
export async function runPdf(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId }, include: { payslips: { include: payslipInclude, orderBy: { user: { name: 'asc' } } } } });
    if (!run) throw new AppError(404, 'Payroll run not found');
    const docs: PayslipDoc[] = [];
    for (const p of run.payslips) docs.push(await docFor(p));
    const buf = await renderDocsBundlePdf(docs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslips-${run.year}-${String(run.month).padStart(2, '0')}.pdf"`);
    res.send(buf);
  } catch (err) { next(err); }
}

/** GET /templates/:id/preview[?payslipId] — HTML preview of a template on a real or sample payslip */
export async function previewTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const isDraft = req.params.id === 'draft';
    const template: any = isDraft ? TemplateSchema.partial().parse({ ...(req.body ?? {}), name: req.body?.name || undefined }) : await prisma.payslipTemplate.findFirst({ where: { id: req.params.id, orgId } });
    if (!template) throw new AppError(404, 'Template not found');
    // Custom HTML drafts: report problems alongside a best-effort preview
    // (unknown placeholders show as a visible marker) so the editor can show
    // them inline while the author types.
    let check: ReturnType<typeof checkTemplateSource> | null = null;
    if (template.layout === 'CUSTOM_HTML') {
      check = checkTemplateSource(template.htmlBody ?? '', template.htmlCss);
      template.htmlBody = check.htmlBody; template.htmlCss = check.htmlCss;
      if (req.query.format === 'pdf' && check.errors.length) throw new TemplateSourceError(check.errors, check.unknown);
    }
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, currency: true } });
    let doc: PayslipDoc;
    if (typeof req.query.payslipId === 'string') {
      const p = await prisma.payslip.findFirst({ where: { id: req.query.payslipId, orgId }, include: payslipInclude });
      if (!p) throw new AppError(404, 'Payslip not found');
      doc = buildPayslipDoc({ payslip: p, template, employee: await employeeFor(orgId, p.userId), org: p.org, loans: await loanSummaryForPayslip(p) });
    } else doc = samplePayslipDoc(template, org!);
    if (req.query.format === 'pdf') {
      const buf = await renderDocPdf(doc);
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(buf);
    }
    if (doc.custom) {
      const issues = check?.errors ?? [];
      let html = '';
      try { html = renderCustomPayslipHtml(doc, { target: 'browser', lenient: true }); }
      catch (e) { if (!(e instanceof TemplateRenderError)) throw e; if (!issues.length) issues.push(...(e.issues.length ? e.issues : [{ message: e.message, line: 1 }])); }
      return res.json({ html, isolated: true, issues, unknown: check?.unknown ?? [], removed: check?.removed ?? [] });
    }
    res.json({ html: renderDocHtml(doc, { embed: true }).html, isolated: false });
  } catch (err) { if (err instanceof TemplateSourceError) return sendSourceError(res, err); next(err); }
}

/** POST /templates/preview — preview an unsaved template (body = template fields) */
export async function previewDraftTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  req.params.id = 'draft';
  return previewTemplate(req, res, next);
}

// ─── E-mail ──────────────────────────────────────────────────────────────────

async function emailOne(payslip: any, orgId: string, sentBy: string) {
  const to = payslip.user?.email;
  if (!to) return { id: payslip.id, ok: false, reason: 'No e-mail address' };
  const doc = await docFor(payslip);
  let pdf: Buffer;
  // A custom-HTML payslip that can't be printed (no Chromium) is reported as
  // failed — never e-mailed in a different layout or without its PDF.
  try { pdf = await renderDocPdf(doc); }
  catch (err) { if (err instanceof HtmlPdfUnavailableError || err instanceof TemplateRenderError || (err instanceof AppError && (err.statusCode === 504 || err.statusCode === 503))) return { id: payslip.id, ok: false, reason: err.message, pdfError: true }; throw err; }
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">
    <p>Hi ${doc.employee.name.split(' ')[0]},</p>
    <p>${doc.revision ? `Your <strong>revised</strong> payslip (v${doc.revision.version}) for <strong>${doc.payslip.periodLabel}</strong> is attached as a PDF. It replaces the one you received earlier.` : `Your payslip for <strong>${doc.payslip.periodLabel}</strong> is attached as a PDF.`}</p>
    <p style="font-size:13px;color:#555">Net pay: <strong>${doc.totals.net.toLocaleString(doc.locale, { style: 'currency', currency: doc.currency })}</strong> · ${doc.payslip.number}</p>
    <p style="font-size:12px;color:#888">Log in to the HR portal to see every payslip and download older ones.</p>
  </div>`;
  await sendMail({ to, subject: `${doc.revision ? `Revised payslip (v${doc.revision.version})` : 'Payslip'} — ${doc.payslip.periodLabel} (${doc.payslip.number})`, html, orgId, attachments: [{ filename: `${doc.payslip.number}.pdf`, contentBase64: pdf.toString('base64'), contentType: 'application/pdf' }] });
  await prisma.payslip.update({ where: { id: payslip.id }, data: { emailedAt: new Date() } });
  logAction(sentBy, 'UPDATE', 'Payslip', payslip.id, { action: 'emailed', to });
  return { id: payslip.id, ok: true };
}

/** POST /payslips/:id/email */
export async function emailPayslip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const p = await prisma.payslip.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId }, include: payslipInclude });
    if (!p) throw new AppError(404, 'Payslip not found');
    if (p.status === 'DRAFT') throw new AppError(400, 'Finalise the run before e-mailing payslips');
    const r: any = await emailOne(p, req.user!.orgId, req.user!.id);
    if (r.pdfError) throw new AppError(503, r.reason);
    res.json(r);
  } catch (err) { next(err); }
}

/** Not e-mailed yet, or revised after it was last e-mailed (the employee has an outdated copy). */
export const needsEmail = (p: { emailedAt: Date | null; revisedAt?: Date | null }) => !p.emailedAt || (!!p.revisedAt && p.revisedAt > p.emailedAt);
/** Previously e-mailed, then revised — the "re-send revised payslips" action. */
export const revisedSinceEmail = (p: { emailedAt: Date | null; revisedAt?: Date | null }) => !!p.emailedAt && !!p.revisedAt && p.revisedAt > p.emailedAt;

/** POST /runs/:id/email — send every (non-draft) payslip in the run.
 *  { onlyUnsent?: boolean (default true: skip payslips whose current version was already sent),
 *    onlyRevised?: boolean (only payslips revised since they were last e-mailed) } */
export async function emailRun(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId }, include: { payslips: { include: payslipInclude } } });
    if (!run) throw new AppError(404, 'Payroll run not found');
    if (run.status === 'DRAFT') throw new AppError(400, 'Finalise the run before e-mailing payslips');
    const onlyUnsent = req.body?.onlyUnsent !== false;
    const onlyRevised = req.body?.onlyRevised === true;
    const results = [];
    for (const p of run.payslips) {
      if (p.status === 'DRAFT') { results.push({ id: p.id, ok: true, skipped: true }); continue; }
      if (onlyRevised ? !revisedSinceEmail(p) : (onlyUnsent && !needsEmail(p))) { results.push({ id: p.id, ok: true, skipped: true }); continue; }
      results.push(await emailOne(p, req.user!.orgId, req.user!.id));
    }
    res.json({ sent: results.filter(r => r.ok && !(r as any).skipped).length, skipped: results.filter(r => (r as any).skipped).length, failed: results.filter(r => !r.ok), results });
  } catch (err) { next(err); }
}
