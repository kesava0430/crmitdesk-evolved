/**
 * Employee loans & salary advances — HR manages them, payroll recovers them.
 *
 *   create (principal, EMI or instalments, start month, optional flat interest)
 *   → payroll runs add one RECOVERY ledger row per month (payroll.controller.ts computeSlip)
 *   → HR can pause a month (SKIP), record a lump-sum repayment (REPAYMENT),
 *     close early (waiving any remainder: WAIVER) or cancel a loan nothing was recovered on.
 *
 * Pure rules live in utils/payrollLoans.ts. Routes: managers only, except
 * GET /loans/mine (an employee's own loans, read-only). Every change is audit-logged.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { logAction } from '../../../utils/auditLog';
import { canManageHr } from '../../../utils/hrAccess';
import {
  planLoan, loanFigures, ledgerWithBalances, projectSchedule, outstandingOf, payslipLoanSummary, round2, isLoanCode, type LoanSummaryRow,
} from '../../../utils/payrollLoans';

const AUTO_CLOSE_REASON = 'Fully recovered';
const ymNow = () => { const d = new Date(); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }; };
const dateOnly = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

const loanInclude = {
  user: { select: { id: true, name: true, email: true, department: true } },
  entries: { include: { payslip: { select: { status: true, payslipNumber: true } } } },
};

type LoanRow = Awaited<ReturnType<typeof loadLoan>>;
async function loadLoan(orgId: string, id: string) {
  const loan = await prisma.employeeLoan.findFirst({ where: { id, orgId }, include: loanInclude });
  if (!loan) throw new AppError(404, 'Loan not found');
  return loan;
}

const entriesOf = (loan: { entries: any[] }) => loan.entries.map(e => ({ ...e, amount: Number(e.amount), payslipStatus: e.payslip?.status ?? null }));

/** API shape: the loan + figures (+ ledger with running balance and the projected schedule when `detail`). */
function present(loan: NonNullable<LoanRow>, detail = false, forEmployee = false) {
  // Employees don't see recoveries of draft (unissued) payslips.
  const entries = entriesOf(loan).filter(e => !forEmployee || !(e.type === 'RECOVERY' && e.payslipStatus === 'DRAFT'));
  const figs = loanFigures(loan as any, entries);
  const { entries: _e, ...rest } = loan;
  const out: any = {
    ...rest, principal: Number(loan.principal), interestRate: loan.interestRate != null ? Number(loan.interestRate) : null,
    interestAmount: Number(loan.interestAmount), totalRepayable: Number(loan.totalRepayable), emiAmount: Number(loan.emiAmount),
    ...figs, pending: forEmployee ? 0 : figs.pending,
    skippedMonths: entries.filter(e => e.type === 'SKIP').map(e => ({ id: e.id, year: e.year, month: e.month, note: e.note })),
  };
  if (detail) {
    out.ledger = ledgerWithBalances(loan as any, entries).map(e => ({
      id: e.id, type: e.type, amount: e.amount, month: e.month, year: e.year, entryDate: e.entryDate, note: e.note,
      payslipId: e.payslipId, payslipNumber: (e as any).payslip?.payslipNumber ?? null, payslipStatus: e.payslipStatus, balance: e.balance,
    }));
    out.schedule = projectSchedule(loan as any, entries, ymNow());
  }
  return out;
}

// ─── Read ────────────────────────────────────────────────────────────────────

/** GET /hr/payroll/loans[?userId&status] — managers */
export async function listLoans(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, status } = req.query as Record<string, string>;
    const where: any = { orgId: req.user!.orgId };
    if (userId) where.userId = userId;
    if (status && ['ACTIVE', 'CLOSED', 'CANCELLED'].includes(status)) where.status = status;
    const loans = await prisma.employeeLoan.findMany({ where, include: loanInclude, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] });
    res.json(loans.map(l => present(l)));
  } catch (err) { next(err); }
}

/** GET /hr/payroll/loans/mine — the signed-in employee's loans (read-only, issued figures only) */
export async function myLoans(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const loans = await prisma.employeeLoan.findMany({ where: { orgId: req.user!.orgId, userId: req.user!.id, status: { not: 'CANCELLED' } }, include: loanInclude, orderBy: { createdAt: 'desc' } });
    res.json(loans.map(l => present(l, true, true)));
  } catch (err) { next(err); }
}

/** GET /hr/payroll/loans/:id — managers, or the employee it belongs to */
export async function getLoan(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const loan = await loadLoan(req.user!.orgId, req.params.id);
    const manager = (await canManageHr(req.user!, 'payroll'));
    if (!manager && loan.userId !== req.user!.id) throw new AppError(403, 'You can only view your own loans');
    res.json(present(loan, true, !manager));
  } catch (err) { next(err); }
}

// ─── Create / edit ───────────────────────────────────────────────────────────

const money = z.coerce.number().positive().max(1e9);
const CreateSchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(2).max(80),
  type: z.enum(['LOAN', 'ADVANCE']).default('LOAN'),
  principal: money,
  interestRate: z.coerce.number().min(0).max(60).nullable().optional(),
  instalments: z.coerce.number().int().min(1).max(360).nullable().optional(),
  emiAmount: money.nullable().optional(),
  disbursedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMonth: z.coerce.number().int().min(1).max(12),
  startYear: z.coerce.number().int().min(2000).max(2100),
  notes: z.string().trim().max(1000).nullable().optional(),
});

function plan(data: { principal: number; interestRate?: number | null; instalments?: number | null; emiAmount?: number | null }) {
  try { return planLoan(data); } catch (e: any) { throw new AppError(400, e.message); }
}

/** POST /hr/payroll/loans */
export async function createLoan(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = CreateSchema.parse(req.body);
    const user = await prisma.user.findFirst({ where: { id: data.userId, orgId }, select: { id: true } });
    if (!user) throw new AppError(404, 'Employee not found');
    const p = plan(data);
    const loan = await prisma.employeeLoan.create({
      data: {
        orgId, userId: data.userId, name: data.name, type: data.type, principal: round2(data.principal), interestRate: data.interestRate || null,
        interestAmount: p.interestAmount, totalRepayable: p.totalRepayable, emiAmount: p.emiAmount, instalments: p.instalments,
        disbursedOn: dateOnly(data.disbursedOn), startMonth: data.startMonth, startYear: data.startYear, notes: data.notes || null, createdBy: req.user!.id,
      },
      include: loanInclude,
    });
    logAction(req.user!.id, 'CREATE', 'EmployeeLoan', loan.id, { userId: data.userId, name: data.name, type: data.type, principal: data.principal, emi: p.emiAmount, instalments: p.instalments, interest: p.interestAmount, start: `${data.startYear}-${data.startMonth}` });
    res.status(201).json(present(loan, true));
  } catch (err) { next(err); }
}

const UpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  /** New EMI for the remaining balance (instalments are recomputed) */
  emiAmount: money.optional(),
  startMonth: z.coerce.number().int().min(1).max(12).optional(),
  startYear: z.coerce.number().int().min(2000).max(2100).optional(),
});

/** PATCH /hr/payroll/loans/:id — rename, notes, change the EMI or the start month (affects future runs and drafts on rerun) */
export async function updateLoan(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = UpdateSchema.parse(req.body);
    const loan = await loadLoan(orgId, req.params.id);
    if (loan.status !== 'ACTIVE' && (data.emiAmount || data.startMonth || data.startYear)) throw new AppError(400, `This loan is ${loan.status.toLowerCase()} — only its name and notes can change`);
    const upd: any = {};
    if (data.name) upd.name = data.name;
    if (data.notes !== undefined) upd.notes = data.notes || null;
    if (data.startMonth || data.startYear) {
      const recovered = loan.entries.some(e => e.type === 'RECOVERY' && Number(e.amount) > 0);
      if (recovered) throw new AppError(400, 'EMIs were already recovered — pause months instead of moving the start');
      upd.startMonth = data.startMonth ?? loan.startMonth; upd.startYear = data.startYear ?? loan.startYear;
    }
    if (data.emiAmount) {
      if (data.emiAmount > Number(loan.totalRepayable)) throw new AppError(400, 'EMI is more than the amount to recover');
      upd.emiAmount = round2(data.emiAmount);
      // Instalments = EMIs already recovered + what the remaining balance needs at the new EMI.
      const entries = entriesOf(loan);
      const done = entries.filter(e => e.type === 'RECOVERY' && e.amount > 0).length;
      upd.instalments = done + Math.ceil(round2(outstandingOf(loan as any, entries) / data.emiAmount));
    }
    const updated = await prisma.employeeLoan.update({ where: { id: loan.id }, data: upd, include: loanInclude });
    logAction(req.user!.id, 'UPDATE', 'EmployeeLoan', loan.id, { action: 'edit', ...data });
    res.json(present(updated, true));
  } catch (err) { next(err); }
}

// ─── Pause a month ───────────────────────────────────────────────────────────

const SkipSchema = z.object({ month: z.coerce.number().int().min(1).max(12), year: z.coerce.number().int().min(2000).max(2100), note: z.string().trim().max(300).optional() });

/** POST /hr/payroll/loans/:id/skip — no EMI in that payroll month (rerun the month's draft if it already exists) */
export async function skipMonth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { month, year, note } = SkipSchema.parse(req.body);
    const loan = await loadLoan(orgId, req.params.id);
    if (loan.status !== 'ACTIVE') throw new AppError(400, 'Only active loans can be paused');
    if (loan.entries.some(e => e.type === 'SKIP' && e.month === month && e.year === year)) throw new AppError(400, 'That month is already paused');
    const issued = loan.entries.find(e => e.type === 'RECOVERY' && e.month === month && e.year === year && e.payslip && e.payslip.status !== 'DRAFT');
    if (issued) throw new AppError(400, 'The EMI for that month is already on an issued payslip — reopen that payroll run first, then pause and rerun');
    await prisma.loanLedgerEntry.create({ data: { orgId, loanId: loan.id, type: 'SKIP', amount: 0, month, year, note: note || null, createdBy: req.user!.id } });
    const inDraft = loan.entries.some(e => e.type === 'RECOVERY' && e.month === month && e.year === year);
    logAction(req.user!.id, 'UPDATE', 'EmployeeLoan', loan.id, { action: 'pause month', month, year, note });
    res.json({ ...present(await loadLoan(orgId, loan.id), true), notice: inDraft ? 'A draft payroll run already deducts this month — rerun it to remove the EMI.' : undefined });
  } catch (err) { next(err); }
}

/** DELETE /hr/payroll/loans/:id/skip/:entryId — undo a pause */
export async function unskipMonth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const loan = await loadLoan(orgId, req.params.id);
    const e = loan.entries.find(x => x.id === req.params.entryId && x.type === 'SKIP');
    if (!e) throw new AppError(404, 'Paused month not found');
    await prisma.loanLedgerEntry.delete({ where: { id: e.id } });
    logAction(req.user!.id, 'UPDATE', 'EmployeeLoan', loan.id, { action: 'resume month', month: e.month, year: e.year });
    res.json(present(await loadLoan(orgId, loan.id), true));
  } catch (err) { next(err); }
}

// ─── Repayment, closure, cancellation ────────────────────────────────────────

const RepaySchema = z.object({ amount: money, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().max(300).optional() });

/** POST /hr/payroll/loans/:id/repayment — the employee paid HR directly (prepayment / part-payment) */
export async function recordRepayment(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { amount, date, note } = RepaySchema.parse(req.body);
    const loan = await loadLoan(orgId, req.params.id);
    if (loan.status !== 'ACTIVE') throw new AppError(400, 'Only active loans can take a repayment');
    const outstanding = outstandingOf(loan as any, entriesOf(loan));
    if (amount > outstanding + 0.004) throw new AppError(400, `The outstanding balance is ${outstanding.toFixed(2)} — the repayment can't be more than that`);
    const d = dateOnly(date);
    const balanceAfter = round2(outstanding - amount);
    await prisma.loanLedgerEntry.create({ data: { orgId, loanId: loan.id, type: 'REPAYMENT', amount: round2(amount), month: d.getUTCMonth() + 1, year: d.getUTCFullYear(), entryDate: d, balanceAfter, note: note || null, createdBy: req.user!.id } });
    if (balanceAfter <= 0) await prisma.employeeLoan.update({ where: { id: loan.id }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: req.user!.id, closeReason: 'Repaid in full' } });
    logAction(req.user!.id, 'UPDATE', 'EmployeeLoan', loan.id, { action: 'repayment', amount, date, balanceAfter, note });
    res.json(present(await loadLoan(orgId, loan.id), true));
  } catch (err) { next(err); }
}

const CloseSchema = z.object({ reason: z.string().trim().min(3).max(300), waiveRemaining: z.boolean().default(false) });

/** POST /hr/payroll/loans/:id/close — early closure. A remaining balance must be explicitly waived (written off). */
export async function closeLoan(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { reason, waiveRemaining } = CloseSchema.parse(req.body);
    const loan = await loadLoan(orgId, req.params.id);
    if (loan.status !== 'ACTIVE') throw new AppError(400, `This loan is already ${loan.status.toLowerCase()}`);
    const entries = entriesOf(loan);
    if (entries.some(e => e.type === 'RECOVERY' && e.payslipStatus === 'DRAFT')) throw new AppError(400, 'A draft payroll run is recovering this loan — finalise or rerun it first');
    const outstanding = outstandingOf(loan as any, entries);
    if (outstanding > 0 && !waiveRemaining) throw new AppError(400, `${outstanding.toFixed(2)} is still outstanding — record a repayment, or confirm writing it off`);
    const now = new Date();
    await prisma.$transaction([
      ...(outstanding > 0 ? [prisma.loanLedgerEntry.create({ data: { orgId, loanId: loan.id, type: 'WAIVER', amount: outstanding, month: now.getUTCMonth() + 1, year: now.getUTCFullYear(), balanceAfter: 0, note: reason, createdBy: req.user!.id } })] : []),
      prisma.employeeLoan.update({ where: { id: loan.id }, data: { status: 'CLOSED', closedAt: now, closedBy: req.user!.id, closeReason: reason } }),
    ]);
    logAction(req.user!.id, 'UPDATE', 'EmployeeLoan', loan.id, { action: 'close', reason, waived: outstanding });
    res.json(present(await loadLoan(orgId, loan.id), true));
  } catch (err) { next(err); }
}

/** POST /hr/payroll/loans/:id/cancel — entered by mistake / never disbursed. Only while nothing was recovered or repaid. */
export async function cancelLoan(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body ?? {});
    const loan = await loadLoan(orgId, req.params.id);
    if (loan.status === 'CANCELLED') throw new AppError(400, 'Already cancelled');
    const moved = loan.entries.filter(e => (e.type === 'RECOVERY' || e.type === 'REPAYMENT') && Number(e.amount) > 0);
    if (moved.some(e => e.type === 'REPAYMENT' || (e.payslip && e.payslip.status !== 'DRAFT'))) throw new AppError(400, 'Money was already recovered on this loan — close it instead');
    // Draft recoveries go with the cancellation; rerun those drafts to update their totals.
    const draftRuns = new Set(moved.map(e => e.payrollRunId).filter(Boolean));
    await prisma.$transaction([
      prisma.loanLedgerEntry.deleteMany({ where: { loanId: loan.id, type: { in: ['RECOVERY', 'SKIP'] } } }),
      prisma.employeeLoan.update({ where: { id: loan.id }, data: { status: 'CANCELLED', closedAt: new Date(), closedBy: req.user!.id, closeReason: reason } }),
    ]);
    logAction(req.user!.id, 'UPDATE', 'EmployeeLoan', loan.id, { action: 'cancel', reason });
    res.json({ ...present(await loadLoan(orgId, loan.id), true), notice: draftRuns.size ? 'A draft payroll run still shows this deduction — rerun it to update the payslip.' : undefined });
  } catch (err) { next(err); }
}

// ─── Used by payroll ─────────────────────────────────────────────────────────

/**
 * After a run is finalised: loans whose balance reached zero close themselves
 * ("Fully recovered"); a loan that was auto-closed but has a balance again
 * (a revision recovered less) goes back to ACTIVE.
 */
export async function settleLoanStatuses(orgId: string, runId: string, userId: string) {
  const touched = await prisma.loanLedgerEntry.findMany({ where: { orgId, payrollRunId: runId }, select: { loanId: true } });
  const autoClosed = await prisma.employeeLoan.findMany({ where: { orgId, status: 'CLOSED', closeReason: AUTO_CLOSE_REASON }, select: { id: true } });
  const ids = [...new Set([...touched.map(t => t.loanId), ...autoClosed.map(l => l.id)])];
  if (!ids.length) return;
  const loans = await prisma.employeeLoan.findMany({ where: { id: { in: ids }, orgId }, include: { entries: { include: { payslip: { select: { status: true } } } } } });
  for (const l of loans) {
    // Only issued money counts: a later month's draft recovery must not close the loan early.
    const out = outstandingOf(l as any, l.entries.filter(e => !(e.type === 'RECOVERY' && e.payslip?.status === 'DRAFT')).map(e => ({ ...e, amount: Number(e.amount) })));
    if (l.status === 'ACTIVE' && out <= 0) {
      await prisma.employeeLoan.update({ where: { id: l.id }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: userId, closeReason: AUTO_CLOSE_REASON } });
      logAction(userId, 'UPDATE', 'EmployeeLoan', l.id, { action: 'auto-close', reason: AUTO_CLOSE_REASON, runId });
    } else if (l.status === 'CLOSED' && l.closeReason === AUTO_CLOSE_REASON && out > 0) {
      await prisma.employeeLoan.update({ where: { id: l.id }, data: { status: 'ACTIVE', closedAt: null, closedBy: null, closeReason: null } });
      logAction(userId, 'UPDATE', 'EmployeeLoan', l.id, { action: 'reopened by payroll revision', outstanding: out, runId });
    }
  }
}

/** The "Loans & advances" block for one payslip (render + in-app view). */
export async function loanSummaryForPayslip(p: { id: string; orgId: string; userId: string; month: number; year: number; periodEnd?: Date | null; lines?: { code: string; amount: any }[] }): Promise<LoanSummaryRow[]> {
  const hasLoanLine = (p.lines ?? []).some(l => isLoanCode(l.code));
  const loans = await prisma.employeeLoan.findMany({
    where: { orgId: p.orgId, userId: p.userId, ...(hasLoanLine ? { status: { not: 'CANCELLED' } } : { status: 'ACTIVE' }) },
    include: { entries: { include: { payslip: { select: { status: true } } } } },
    orderBy: [{ startYear: 'asc' }, { startMonth: 'asc' }, { createdAt: 'asc' }],
  });
  if (!loans.length) return [];
  return payslipLoanSummary({
    payslipId: p.id, year: p.year, month: p.month, lines: p.lines ?? [], disbursedBy: p.periodEnd ?? null,
    loans: loans.map(l => ({ ...(l as any), entries: l.entries.map(e => ({ ...e, amount: Number(e.amount), payslipStatus: e.payslip?.status ?? null })) })),
  });
}
