import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { logAction } from '../../../utils/auditLog';
import { ensureDefaultComponents, computePayslip, periodFor, defaultPeriodInputs, inputsFromAttendance, type Overrides } from '../../../utils/payrollEngine';
import { payrollSummary } from '../../../utils/attendanceRegister';
import { ensureDefaultCycle, employeeContext, toDef } from './payrollConfig.controller';
import { ensureDefaultTemplate } from './payslipTemplates.controller';
import { loanSummaryForPayslip } from './loans.controller';

import { canManageHr } from '../../../utils/hrAccess';
import { nextSequence, totalsOfLines, type SlipLine } from '../../../utils/payrollRevision';
import { computeLoanRecoveries, recoveryLines, withLoanLines, recoveryEntriesFromLines, outstandingOf, isLoanCode, loanIdOf, round2 } from '../../../utils/payrollLoans';

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

// ─── Payroll Runs (component-based, draft → review → finalise) ───────────────

const RunSchema = z.object({
  /** Cycle to run; default cycle when omitted */
  payrollCycleId: z.string().optional(),
  /** ATTENDANCE (default) derives paid/LOP/OT days from the attendance register; CALENDAR pays every day. */
  attendanceMode: z.enum(['ATTENDANCE', 'CALENDAR']).optional(),
  /** Any date inside the period to run (default: the period before today's) */
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Legacy monthly shape still accepted
  month: z.coerce.number().int().min(1).max(12).optional(),
  year:  z.coerce.number().int().min(2000).max(2100).optional(),
});

const runInclude = {
  runByUser: { select: { id: true, name: true } },
  payrollCycle: { select: { id: true, name: true, frequency: true } },
  payslips: { include: { user: { select: { id: true, name: true, avatarUrl: true, department: true } }, lines: { orderBy: { displayOrder: 'asc' as const } } }, orderBy: { user: { name: 'asc' as const } } },
};

/** Sequential per-org display number, e.g. "PAY-2026-08-0001". Takes the
 *  highest number in use rather than counting rows: counting reused numbers
 *  after a payslip was deleted (recalculate used to delete and recreate). */
export async function nextPayslipNumber(orgId: string, year: number, month: number, skip = 0): Promise<string> {
  const prefix = `PAY-${year}-${String(month).padStart(2, '0')}-`;
  const rows = await prisma.payslip.findMany({ where: { orgId, year, month, payslipNumber: { startsWith: prefix } }, select: { payslipNumber: true } });
  return `${prefix}${String(nextSequence(rows.map(r => r.payslipNumber), prefix) + skip).padStart(4, '0')}`;
}

export type RunForCompute = { id: string; periodStart: Date; periodEnd: Date; month: number; year: number; payrollCycleId: string | null; attendanceMode?: string | null };
export type SalaryForCompute = { id: string; userId: string; overrides: any; ctcAnnual: any; currency: string };

/**
 * Loan/advance recoveries for one payslip (utils/payrollLoans.ts). The
 * payslip's own earlier recoveries (`payslipId`, on a rerun) are ignored so the
 * balance it sees is the one before this payslip — that is what makes a rerun
 * idempotent: the ledger rows are then replaced, not added to.
 */
export async function loanRecoveriesFor(orgId: string, userId: string, run: { month: number; year: number }, netBeforeLoans: number, payslipId?: string | null, excludeLoanIds: string[] = []) {
  const all = await prisma.employeeLoan.findMany({ where: { orgId, userId, status: { not: 'CANCELLED' } }, include: { entries: true } });
  const outstandingAll: Record<string, number> = {};
  for (const l of all) outstandingAll[l.id] = outstandingOf(l as any, l.entries.filter(e => !payslipId || e.payslipId !== payslipId) as any);
  const loans = all.filter(l => !excludeLoanIds.includes(l.id));
  if (!loans.length) return { lines: [] as SlipLine[], outstandingBefore: outstandingAll, notes: {} as Record<string, string>, warnings: [] as string[] };
  const r = computeLoanRecoveries({
    year: run.year, month: run.month, netBeforeLoans,
    loans: loans.map(l => ({ loan: l as any, otherEntries: l.entries.filter(e => !payslipId || e.payslipId !== payslipId) as any })),
  });
  const outstandingBefore: Record<string, number> = { ...outstandingAll }, notes: Record<string, string> = {};
  for (const x of r.recoveries) {
    if (x.shortfall > 0) notes[x.loanId] = `short by ${x.shortfall.toFixed(2)} (net pay floor) — carried in balance`;
  }
  return { lines: recoveryLines(r.recoveries), outstandingBefore, notes, warnings: r.warnings };
}

/**
 * Recompute the automatic loan lines of a payslip whose other lines changed
 * (a manual adjustment in review, or adjustments re-applied on rerun), so the
 * net-pay floor still holds. Loan lines a manager adjusted by hand are kept.
 */
export async function reapplyLoans(orgId: string, userId: string, run: { month: number; year: number }, lines: SlipLine[], payslipId?: string | null) {
  const manual = lines.filter(l => isLoanCode(l.code) && l.adjusted);
  const nonLoan = lines.filter(l => !isLoanCode(l.code));
  const net = totalsOfLines(nonLoan).net - manual.reduce((s, l) => s + l.amount, 0);
  const loans = await loanRecoveriesFor(orgId, userId, run, net, payslipId, manual.map(l => loanIdOf(l.code)!));
  const out = [...nonLoan, ...manual, ...loans.lines];
  return { lines: out, totals: totalsOfLines(out), loans };
}

/** Ledger rows for a payslip's final lines (create these under Payslip.loanEntries). */
export function loanEntryRows(orgId: string, run: { id: string; month: number; year: number }, lines: SlipLine[], loans: { outstandingBefore: Record<string, number>; notes: Record<string, string> }) {
  return recoveryEntriesFromLines(lines, { orgId, year: run.year, month: run.month, payrollRunId: run.id, outstandingBefore: loans.outstandingBefore, note: loans.notes });
}

/** Compute one employee's payslip for a run (reads attendance + employee context) without writing anything.
 *  `payslipId`: the payslip being recomputed (rerun), so its own loan recoveries aren't counted twice. */
export async function computeSlip(orgId: string, run: RunForCompute, es: SalaryForCompute, comps: any[], cycle: any, payslipId?: string | null) {
  const period = periodFor(cycle, run.periodStart);
  const useAttendance = (run.attendanceMode ?? 'ATTENDANCE') !== 'CALENDAR';
  let inputs = defaultPeriodInputs(period);
  let attendanceSummary: any = { source: 'calendar' };
  if (useAttendance) {
    const s = await payrollSummary(orgId, es.userId, run.periodStart, run.periodEnd);
    inputs = inputsFromAttendance(period, s);
    attendanceSummary = {
      source: 'attendance', policyGroup: s.policyGroupName, byStatus: s.byStatus, absentDays: s.absentDays, unpaidLeaveDays: s.unpaidLeaveDays,
      lateCount: s.lateCount, lateConversion: s.lateConversion, futureDaysAssumedPaid: s.futureDaysAssumedPaid, manualCorrections: s.manualCorrections,
      // Zero punches in the period / days outside employment (ATT-8) — shown on the run review
      notEmployedDays: s.notEmployedDays, warnings: s.warnings,
    };
  }
  const ctx = await employeeContext(orgId, es.userId);
  const result = computePayslip(comps.map(toDef), (es.overrides ?? {}) as Overrides, ctx, inputs, es.ctcAnnual != null ? Number(es.ctcAnnual) : null);
  const baseLines: SlipLine[] = result.lines.map(l => ({ code: l.code, name: l.name, category: l.category, amount: l.amount, basis: l.basis, showOnPayslip: l.showOnPayslip, displayOrder: l.displayOrder }));
  const baseTotals = { earnings: result.totals.earnings, deductions: result.totals.deductions, reimbursements: result.totals.reimbursements, employer: result.totals.employerContributions, net: result.totals.net };
  const loans = await loanRecoveriesFor(orgId, es.userId, run, baseTotals.net, payslipId);
  const { lines, totals } = withLoanLines({ lines: baseLines, totals: baseTotals }, loans.lines);
  return {
    lines,
    totals,
    loans: { outstandingBefore: loans.outstandingBefore, notes: loans.notes },
    fields: {
      employeeSalaryId: es.id, currency: es.currency,
      workingDays: inputs.workingDays, presentDays: inputs.presentDays, paidDays: inputs.paidDays, leaveDays: inputs.leaveDays,
      lopDays: inputs.lopDays, halfDays: inputs.halfDays, overtimeHours: inputs.overtimeHours,
      attendanceSummary: { ...attendanceSummary, warnings: [...result.warnings, ...loans.warnings] },
    },
  };
}
export type ComputedSlip = Awaited<ReturnType<typeof computeSlip>>;

/** Payslip columns for a computed slip (totals may differ from the engine's when adjustments were re-applied). */
export function slipColumns(c: { lines: SlipLine[]; totals: { earnings: number; deductions: number; reimbursements: number; employer: number; net: number }; fields: ComputedSlip['fields'] }) {
  const g = (code: string) => c.lines.find(l => l.code === code)?.amount ?? 0;
  const t = c.totals;
  return {
    ...c.fields,
    // legacy denormalised columns so older views keep working
    basic: g('BASIC'), hra: g('HRA'), allowances: Math.max(0, t.earnings - g('BASIC') - g('HRA')),
    grossPay: t.earnings, pf: g('PF_EMP'), professionalTax: g('PT'),
    otherDeductions: Math.max(0, t.deductions - g('PF_EMP') - g('PT')),
    totalDeductions: t.deductions, netPay: t.net,
    totalEarnings: t.earnings, totalReimbursements: t.reimbursements, employerContributions: t.employer,
  };
}

export function lineRows(lines: SlipLine[]) {
  return lines.map(l => ({ code: l.code, name: l.name, category: l.category as any, amount: l.amount, basis: l.basis ?? null, showOnPayslip: l.showOnPayslip !== false, displayOrder: l.displayOrder ?? 0, adjusted: !!l.adjusted }));
}

/** Compute + write one employee's payslip (draft) for a run. */
async function buildPayslip(orgId: string, run: RunForCompute, es: SalaryForCompute, comps: any[], cycle: any) {
  const c = await computeSlip(orgId, run, es, comps, cycle);
  const payslipNumber = await nextPayslipNumber(orgId, run.year, run.month);
  return prisma.payslip.create({
    data: {
      orgId, userId: es.userId, payrollRunId: run.id, payslipNumber,
      month: run.month, year: run.year, periodStart: run.periodStart, periodEnd: run.periodEnd,
      ...slipColumns(c),
      status: 'DRAFT',
      lines: { create: lineRows(c.lines) },
      loanEntries: { create: loanEntryRows(orgId, run, c.lines, c.loans) },
    },
  });
}

/** POST /hr/payroll/runs — compute a DRAFT run for a cycle's period. Nothing is issued until finalised. */
export async function runPayroll(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const body = RunSchema.parse(req.body);
    await ensureDefaultComponents(orgId);
    const cycle = body.payrollCycleId
      ? await prisma.payrollCycle.findFirst({ where: { id: body.payrollCycleId, orgId } })
      : await ensureDefaultCycle(orgId);
    if (!cycle) throw new AppError(404, 'Payroll cycle not found');

    const on = body.on ? parseDateOnly(body.on)
      : body.month && body.year ? new Date(Date.UTC(body.year, body.month - 1, 1))
      : new Date(periodFor(cycle, new Date()).start.getTime() - 86_400_000); // previous period by default
    const period = periodFor(cycle, on);
    const month = period.start.getUTCMonth() + 1, year = period.start.getUTCFullYear();

    const existing = await prisma.payrollRun.findFirst({ where: { orgId, payrollCycleId: cycle.id, periodStart: period.start } });
    if (existing) throw new AppError(400, `Payroll for ${period.label} (${cycle.name}) already exists — open it to review or finalise.`);

    const salaries = await prisma.employeeSalary.findMany({ where: { orgId, isActive: true, payrollCycleId: cycle.id, user: { isActive: true } } });
    if (salaries.length === 0) throw new AppError(400, `No employees are assigned to the ${cycle.name} cycle with a salary set up.`);
    const comps = await prisma.salaryComponent.findMany({ where: { orgId } });

    const attendanceMode = body.attendanceMode ?? 'ATTENDANCE';
    const run = await prisma.payrollRun.create({ data: { orgId, month, year, payrollCycleId: cycle.id, periodStart: period.start, periodEnd: period.end, status: 'DRAFT', runBy: req.user!.id, attendanceMode } });
    for (const es of salaries) await buildPayslip(orgId, { ...run, periodStart: period.start, periodEnd: period.end }, es, comps, cycle);

    logAction(req.user!.id, 'CREATE', 'PayrollRun', run.id, { cycle: cycle.name, period: period.label, count: salaries.length });
    const full = await prisma.payrollRun.findUnique({ where: { id: run.id }, include: runInclude });
    res.status(201).json(full);
  } catch (err) { next(err); }
}

// Rerun / recalculate / finalise / reopen live in payrollRevision.controller.ts.

/** Overwrite one line's amount and re-total the payslip. */
async function applyAdjustment(payslipId: string, code: string, amount: number) {
  const line = await prisma.payslipLine.findFirst({ where: { payslipId, code } });
  if (!line) throw new AppError(404, `Line ${code} not found on this payslip`);
  if (isLoanCode(code)) {
    // A loan recovery can be lowered (or raised up to the balance); its ledger row follows.
    const loanId = loanIdOf(code)!;
    const loan = await prisma.employeeLoan.findUnique({ where: { id: loanId }, include: { entries: true } });
    if (!loan) throw new AppError(404, 'Loan not found');
    const others = loan.entries.filter(e => e.payslipId !== payslipId && ['RECOVERY', 'REPAYMENT', 'WAIVER'].includes(e.type)).reduce((s, e) => s + Number(e.amount), 0);
    const before = round2(Math.max(0, Number(loan.totalRepayable) - others));
    if (amount > before + 0.004) throw new AppError(400, `The outstanding balance of ${loan.name} is only ${before.toFixed(2)}`);
    const entry = loan.entries.find(e => e.payslipId === payslipId && e.type === 'RECOVERY');
    if (entry) await prisma.loanLedgerEntry.update({ where: { id: entry.id }, data: { amount, balanceAfter: round2(before - amount), note: 'adjusted in run review' } });
  }
  await prisma.payslipLine.update({ where: { id: line.id }, data: { amount, adjusted: true } });
  if (!isLoanCode(code)) {
    const p = await prisma.payslip.findUnique({ where: { id: payslipId }, include: { lines: true, payrollRun: true } });
    if (p && (p.lines.some(l => isLoanCode(l.code)) || await prisma.employeeLoan.count({ where: { orgId: p.orgId, userId: p.userId, status: 'ACTIVE' } }) > 0)) {
      const cur: SlipLine[] = p!.lines.map(l => ({ code: l.code, name: l.name, category: l.category, amount: Number(l.amount), basis: l.basis, showOnPayslip: l.showOnPayslip, displayOrder: l.displayOrder, adjusted: l.adjusted }));
      const r = await reapplyLoans(p!.orgId, p!.userId, p!.payrollRun, cur, payslipId);
      const loanLines = r.lines.filter(l => isLoanCode(l.code) && !l.adjusted);
      await prisma.$transaction([
        prisma.payslipLine.deleteMany({ where: { payslipId, code: { startsWith: 'LOAN_' }, adjusted: false } }),
        prisma.loanLedgerEntry.deleteMany({ where: { payslipId, type: 'RECOVERY', loanId: { in: [...new Set([...loanLines, ...cur.filter(l => isLoanCode(l.code) && !l.adjusted)].map(l => loanIdOf(l.code)!))] } } }),
        ...(loanLines.length ? [prisma.payslipLine.createMany({ data: lineRows(loanLines).map(x => ({ ...x, payslipId })) })] : []),
        ...loanEntryRows(p!.orgId, p!.payrollRun, loanLines, r.loans).map(d => prisma.loanLedgerEntry.create({ data: { ...d, payslipId } })),
      ]);
    }
  }
  const lines = await prisma.payslipLine.findMany({ where: { payslipId } });
  const sum = (cat: string) => Math.round(lines.filter(l => l.category === cat).reduce((s, l) => s + Number(l.amount), 0) * 100) / 100;
  const earnings = sum('EARNING'), deductions = sum('DEDUCTION'), reimb = sum('REIMBURSEMENT'), employer = sum('EMPLOYER_CONTRIBUTION');
  const g = (c: string) => Number(lines.find(l => l.code === c)?.amount ?? 0);
  await prisma.payslip.update({
    where: { id: payslipId },
    data: {
      basic: g('BASIC'), hra: g('HRA'), allowances: Math.max(0, earnings - g('BASIC') - g('HRA')), grossPay: earnings,
      pf: g('PF_EMP'), professionalTax: g('PT'), otherDeductions: Math.max(0, deductions - g('PF_EMP') - g('PT')),
      totalDeductions: deductions, netPay: Math.round((earnings + reimb - deductions) * 100) / 100,
      totalEarnings: earnings, totalReimbursements: reimb, employerContributions: employer,
    },
  });
}

/** PATCH /hr/payroll/runs/:id/payslips/:payslipId — adjust a line during review ({ code, amount }) */
export async function adjustDraftPayslip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { code, amount } = z.object({ code: z.string(), amount: z.coerce.number().min(0) }).parse(req.body);
    const payslip = await prisma.payslip.findFirst({ where: { id: req.params.payslipId, payrollRunId: req.params.id, orgId: req.user!.orgId }, include: { payrollRun: true } });
    if (!payslip) throw new AppError(404, 'Payslip not found');
    if (payslip.payrollRun.status !== 'DRAFT') throw new AppError(400, 'Only draft payslips can be adjusted');
    if (payslip.payrollRun.lockedAt && payslip.payrollRun.lockedAt.getTime() > Date.now() - 10 * 60_000) throw new AppError(409, 'This run is being rerun or finalised right now — try again in a moment.');
    await applyAdjustment(payslip.id, code, amount);
    logAction(req.user!.id, 'UPDATE', 'Payslip', payslip.id, { action: 'adjust', code, amount });
    res.json(await prisma.payslip.findUnique({ where: { id: payslip.id }, include: { lines: { orderBy: { displayOrder: 'asc' } }, user: { select: { id: true, name: true } } } }));
  } catch (err) { next(err); }
}

/** DELETE /hr/payroll/runs/:id — discard a draft */
export async function discardRun(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!run) throw new AppError(404, 'Payroll run not found');
    if (run.status !== 'DRAFT') throw new AppError(400, 'Only draft runs can be discarded');
    // A reopened run's payslips were already issued (and maybe paid) — its
    // history must survive. Re-finalise it instead.
    if (run.version > 1) throw new AppError(400, 'This run was issued before and is reopened for changes — finalise it again instead of discarding');
    await prisma.payrollRun.delete({ where: { id: run.id } });
    logAction(req.user!.id, 'DELETE', 'PayrollRun', run.id, {});
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** GET /hr/payroll/runs — managers only */
export async function listRuns(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const runs = await prisma.payrollRun.findMany({
      where: { orgId: req.user!.orgId },
      include: { runByUser: { select: { id: true, name: true } }, payrollCycle: { select: { id: true, name: true, frequency: true } }, _count: { select: { payslips: true } } },
      orderBy: [{ periodStart: 'desc' }, { year: 'desc' }, { month: 'desc' }],
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
    if (run.status === 'DRAFT') throw new AppError(400, 'Finalise the run before marking it paid');

    const paidAt = new Date();
    await prisma.$transaction([
      prisma.payslip.updateMany({ where: { payrollRunId: run.id, status: 'GENERATED' }, data: { status: 'PAID', paidAt } }),
      prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'PAID' } }),
    ]);

    logAction(req.user!.id, 'UPDATE', 'PayrollRun', run.id, run.version > 1 ? { action: 'marked paid', version: run.version, note: 'revision differences settled' } : { action: 'marked paid' });
    const full = await prisma.payrollRun.findUnique({ where: { id: run.id }, include: runInclude });
    res.json(full);
  } catch (err) { next(err); }
}

// ─── Payslips ────────────────────────────────────────────────────────────────

const payslipInclude = {
  user: { select: { id: true, name: true, email: true, department: true, avatarUrl: true } },
  org: { select: { name: true } },
  lines: { orderBy: { displayOrder: 'asc' as const } },
  payrollRun: { select: { id: true, status: true, periodStart: true, periodEnd: true, payrollCycle: { select: { name: true, frequency: true } } } },
};

/** GET /hr/payroll/payslips — self sees own; managers can pass ?scope=org to see everyone's */
export async function listPayslips(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { scope, userId, month, year } = req.query as Record<string, string>;
    const isManager = (await canManageHr(req.user!, 'payroll'));

    const where: any = { orgId };
    if (isManager && scope === 'org') {
      if (userId) where.userId = userId;
    } else {
      where.userId = req.user!.id;
      where.status = { not: 'DRAFT' }; // drafts are visible to managers only, in the run review
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
    const isManager = (await canManageHr(req.user!, 'payroll'));
    if (!isManager && payslip.userId !== req.user!.id) throw new AppError(403, 'You can only view your own payslips');
    if (!isManager && payslip.status === 'DRAFT') throw new AppError(404, 'Payslip not found');
    res.json({ ...payslip, loanSummary: await loanSummaryForPayslip(payslip) });
  } catch (err) { next(err); }
}

/** PATCH /hr/payroll/payslips/:id/mark-paid — managers only */
export async function markPayslipPaid(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const payslip = await prisma.payslip.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!payslip) throw new AppError(404, 'Payslip not found');
    // Drafts (including payslips of a reopened run) aren't issued yet.
    if (payslip.status === 'DRAFT') throw new AppError(400, 'Finalise the run before marking this payslip paid');
    const updated = await prisma.payslip.update({
      where: { id: payslip.id },
      data: { status: 'PAID', paidAt: new Date() },
      include: payslipInclude,
    });
    logAction(req.user!.id, 'UPDATE', 'Payslip', payslip.id, { action: 'marked paid' });
    res.json(updated);
  } catch (err) { next(err); }
}

// ─── Legacy single-template endpoints (kept for older clients) ──────────────
// The default template is what GET /template returns; PUT /template edits it.
// Full multi-template management lives in payslipTemplates.controller.ts.

const LegacyTemplateSchema = z.object({
  companyName:    z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional()),
  companyAddress: z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional()),
  logoUrl:        z.preprocess(v => (v === '' ? null : v), z.string().url().nullable().optional()),
  primaryColor:   z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  footerNote:     z.preprocess(v => (v === '' ? null : v), z.string().nullable().optional()),
  showSignature:  z.boolean().optional(),
  signatureLabel: z.string().optional(),
});

/** GET /hr/payroll/template — the org's default template */
export async function getTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try { res.json(await ensureDefaultTemplate(req.user!.orgId)); } catch (err) { next(err); }
}

/** PUT /hr/payroll/template — edit the default template's letterhead fields */
export async function saveTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = LegacyTemplateSchema.parse(req.body);
    const t = await ensureDefaultTemplate(req.user!.orgId);
    const template = await prisma.payslipTemplate.update({ where: { id: t.id }, data: data as any });
    logAction(req.user!.id, 'UPDATE', 'PayslipTemplate', template.id, {});
    res.json(template);
  } catch (err) { next(err); }
}
