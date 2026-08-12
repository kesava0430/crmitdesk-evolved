import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { logAction } from '../../../utils/auditLog';

const MANAGER_ROLES = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'];

// ─── Salary Structures ───────────────────────────────────────────────────────

const structureInclude = {
  user: { select: { id: true, name: true, email: true, department: true, avatarUrl: true } },
};

const StructureSchema = z.object({
  userId:          z.string(),
  basic:           z.coerce.number().min(0),
  hra:             z.coerce.number().min(0).default(0),
  allowances:      z.coerce.number().min(0).default(0),
  pfPercent:       z.coerce.number().min(0).max(100).default(12),
  professionalTax: z.coerce.number().min(0).default(0),
  otherDeductions: z.coerce.number().min(0).default(0),
  effectiveFrom:   z.string(), // YYYY-MM-DD
});

function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** GET /hr/payroll/structures — every employee's current active salary structure (managers only) */
export async function listStructures(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const structures = await prisma.salaryStructure.findMany({
      where: { orgId: req.user!.orgId, isActive: true },
      include: structureInclude,
      orderBy: { user: { name: 'asc' } },
    });
    res.json(structures);
  } catch (err) { next(err); }
}

/** POST /hr/payroll/structures — set (or revise) an employee's salary structure.
 *  Any existing active structure for that employee is deactivated first, so
 *  payslips already generated keep pointing at the structure that was
 *  actually in effect at the time — this is a revision, not an in-place edit. */
export async function upsertStructure(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = StructureSchema.parse(req.body);

    const employee = await prisma.user.findFirst({ where: { id: data.userId, orgId, isActive: true } });
    if (!employee) throw new AppError(404, 'Employee not found');

    const [, structure] = await prisma.$transaction([
      prisma.salaryStructure.updateMany({ where: { orgId, userId: data.userId, isActive: true }, data: { isActive: false } }),
      prisma.salaryStructure.create({
        data: {
          orgId,
          userId: data.userId,
          basic: data.basic,
          hra: data.hra,
          allowances: data.allowances,
          pfPercent: data.pfPercent,
          professionalTax: data.professionalTax,
          otherDeductions: data.otherDeductions,
          effectiveFrom: parseDateOnly(data.effectiveFrom),
        },
        include: structureInclude,
      }),
    ]);

    logAction(req.user!.id, 'CREATE', 'SalaryStructure', structure.id, { userId: data.userId });
    res.status(201).json(structure);
  } catch (err) { next(err); }
}

/** DELETE /hr/payroll/structures/:id — take an employee off payroll (e.g. offboarding); soft-delete, keeps history */
export async function deactivateStructure(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const existing = await prisma.salaryStructure.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!existing) throw new AppError(404, 'Salary structure not found');
    await prisma.salaryStructure.update({ where: { id: existing.id }, data: { isActive: false } });
    res.json({ message: 'Salary structure deactivated' });
  } catch (err) { next(err); }
}

// ─── Payroll Runs ────────────────────────────────────────────────────────────

const RunSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year:  z.coerce.number().int().min(2000).max(2100),
});

const runInclude = {
  runByUser: { select: { id: true, name: true } },
  payslips: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
};

/** Sequential per-org display number, e.g. "PAY-2026-08-0001" — same
 *  count-then-format approach as Invoice.invoiceNumber. */
async function nextPayslipNumber(orgId: string, year: number, month: number): Promise<string> {
  const count = await prisma.payslip.count({ where: { orgId, year, month } });
  return `PAY-${year}-${String(month).padStart(2, '0')}-${String(count + 1).padStart(4, '0')}`;
}

/** POST /hr/payroll/runs — process payroll for a month: snapshots every
 *  employee's current active SalaryStructure into a Payslip. */
export async function runPayroll(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { month, year } = RunSchema.parse(req.body);

    const existingRun = await prisma.payrollRun.findFirst({ where: { orgId, month, year } });
    if (existingRun) throw new AppError(400, `Payroll for ${year}-${String(month).padStart(2, '0')} has already been run`);

    const structures = await prisma.salaryStructure.findMany({
      where: { orgId, isActive: true, user: { isActive: true } },
    });
    if (structures.length === 0) throw new AppError(400, 'No employees have a salary structure set up yet');

    const run = await prisma.payrollRun.create({ data: { orgId, month, year, runBy: req.user!.id } });

    for (const s of structures) {
      const basic = Number(s.basic), hra = Number(s.hra), allowances = Number(s.allowances);
      const grossPay = basic + hra + allowances;
      const pf = Math.round(basic * (Number(s.pfPercent) / 100) * 100) / 100;
      const professionalTax = Number(s.professionalTax);
      const otherDeductions = Number(s.otherDeductions);
      const totalDeductions = pf + professionalTax + otherDeductions;
      const netPay = grossPay - totalDeductions;
      const payslipNumber = await nextPayslipNumber(orgId, year, month);

      await prisma.payslip.create({
        data: {
          orgId, userId: s.userId, payrollRunId: run.id, salaryStructureId: s.id,
          payslipNumber, month, year,
          basic, hra, allowances, grossPay,
          pf, professionalTax, otherDeductions, totalDeductions, netPay,
        },
      });
    }

    logAction(req.user!.id, 'CREATE', 'PayrollRun', run.id, { month, year, count: structures.length });

    const full = await prisma.payrollRun.findUnique({ where: { id: run.id }, include: runInclude });
    res.status(201).json(full);
  } catch (err) { next(err); }
}

/** GET /hr/payroll/runs — managers only */
export async function listRuns(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const runs = await prisma.payrollRun.findMany({
      where: { orgId: req.user!.orgId },
      include: { runByUser: { select: { id: true, name: true } }, _count: { select: { payslips: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    res.json(runs);
  } catch (err) { next(err); }
}

/** GET /hr/payroll/runs/:id — managers only */
export async function getRun(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId }, include: runInclude });
    if (!run) throw new AppError(404, 'Payroll run not found');
    res.json(run);
  } catch (err) { next(err); }
}

/** PATCH /hr/payroll/runs/:id/mark-paid — marks the run and every one of its still-GENERATED payslips as PAID */
export async function markRunPaid(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!run) throw new AppError(404, 'Payroll run not found');

    const paidAt = new Date();
    await prisma.$transaction([
      prisma.payslip.updateMany({ where: { payrollRunId: run.id, status: 'GENERATED' }, data: { status: 'PAID', paidAt } }),
      prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'PAID' } }),
    ]);

    logAction(req.user!.id, 'UPDATE', 'PayrollRun', run.id, { action: 'marked paid' });
    const full = await prisma.payrollRun.findUnique({ where: { id: run.id }, include: runInclude });
    res.json(full);
  } catch (err) { next(err); }
}

// ─── Payslips ────────────────────────────────────────────────────────────────

const payslipInclude = {
  user: { select: { id: true, name: true, email: true, department: true, avatarUrl: true } },
  org: { select: { name: true } },
};

/** GET /hr/payroll/payslips — self sees own; managers can pass ?scope=org to see everyone's */
export async function listPayslips(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { scope, userId, month, year } = req.query as Record<string, string>;
    const isManager = MANAGER_ROLES.includes(req.user!.role);

    const where: any = { orgId };
    if (isManager && scope === 'org') {
      if (userId) where.userId = userId;
    } else {
      where.userId = req.user!.id;
    }
    if (month) where.month = Number(month);
    if (year) where.year = Number(year);

    const payslips = await prisma.payslip.findMany({
      where, include: payslipInclude,
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    res.json(payslips);
  } catch (err) { next(err); }
}

/** GET /hr/payroll/payslips/:id — an employee can only view their own; managers can view anyone's */
export async function getPayslip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const payslip = await prisma.payslip.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId }, include: payslipInclude });
    if (!payslip) throw new AppError(404, 'Payslip not found');
    const isManager = MANAGER_ROLES.includes(req.user!.role);
    if (!isManager && payslip.userId !== req.user!.id) throw new AppError(403, 'You can only view your own payslips');
    res.json(payslip);
  } catch (err) { next(err); }
}

/** PATCH /hr/payroll/payslips/:id/mark-paid — managers only */
export async function markPayslipPaid(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const payslip = await prisma.payslip.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!payslip) throw new AppError(404, 'Payslip not found');
    const updated = await prisma.payslip.update({
      where: { id: payslip.id },
      data: { status: 'PAID', paidAt: new Date() },
      include: payslipInclude,
    });
    logAction(req.user!.id, 'UPDATE', 'Payslip', payslip.id, { action: 'marked paid' });
    res.json(updated);
  } catch (err) { next(err); }
}

// ─── Payslip Template (letterhead used to render the printable/PDF payslip) ──

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const TemplateSchema = z.object({
  companyName:    z.preprocess(emptyToUndefined, z.string().optional()),
  companyAddress: z.preprocess(emptyToUndefined, z.string().optional()),
  logoUrl:        z.preprocess(emptyToUndefined, z.string().url().optional()),
  primaryColor:   z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb'),
  footerNote:     z.preprocess(emptyToUndefined, z.string().optional()),
  showSignature:  z.boolean().default(true),
  signatureLabel: z.string().default('Authorized Signatory'),
});

const DEFAULT_TEMPLATE = {
  companyName: null, companyAddress: null, logoUrl: null,
  primaryColor: '#2563eb', footerNote: null,
  showSignature: true, signatureLabel: 'Authorized Signatory',
};

/** GET /hr/payroll/template — everyone can read it (needed to render their own payslip print view) */
export async function getTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const template = await prisma.payslipTemplate.findUnique({ where: { orgId: req.user!.orgId } });
    res.json(template ?? DEFAULT_TEMPLATE);
  } catch (err) { next(err); }
}

/** PUT /hr/payroll/template — managers only */
export async function saveTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = TemplateSchema.parse(req.body);
    const template = await prisma.payslipTemplate.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: { ...data },
    });
    logAction(req.user!.id, 'UPDATE', 'PayslipTemplate', template.id, {});
    res.json(template);
  } catch (err) { next(err); }
}
