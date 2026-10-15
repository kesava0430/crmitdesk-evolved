/**
 * Rerun payroll after salary changes — the database half.
 *
 *   DRAFT run ──rerun──▶ DRAFT run (+ change summary)
 *   PROCESSED/PAID ──reopen (reason, snapshot every payslip)──▶ DRAFT (version+1)
 *   DRAFT ──finalise──▶ PROCESSED (or PAID when nothing changed for paid people)
 *
 * Pure rules (plan, diff, snapshot, re-finalise decision, settlement) live in
 * utils/payrollRevision.ts. Guardrails:
 *  - org scoping on every query; routes are HR managers only (payroll.routes.ts)
 *  - a per-run column lock (PayrollRun.lockedAt) so two managers can't rerun,
 *    reopen or finalise the same run at once — the second gets a 409
 *  - a reopened run can't be discarded (its payslips were already issued)
 *  - reopening when a LATER run is already finalised is allowed but reported:
 *    attendance for this period stays locked (frozenUntil looks at the latest
 *    finalised run) and carry effects into later runs are not recalculated.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { logAction } from '../../../utils/auditLog';
import {
  parseRerunOptions, planRerun, applyAdjustments, diffSlip, sortChanges, summariseChanges, figuresOfPayslip, figuresOfRevision,
  snapshotPayslip, paidBaselines, latestRevision, refinalizeDecision, computeSettlement, runVersionHistory,
  type RerunOptions, type ChangeEntry, type SlipFigures, type SlipLine, type RevisionRow, type RevisionData,
} from '../../../utils/payrollRevision';
import { computeSlip, slipColumns, lineRows, nextPayslipNumber, loanEntryRows, reapplyLoans, type ComputedSlip } from './payroll.controller';
import { settleLoanStatuses } from './loans.controller';
import { isLoanCode, loanIdOf } from '../../../utils/payrollLoans';
import { resolveTemplate } from './payslipTemplates.controller';

const LOCK_STALE_MS = 10 * 60_000;

const runInclude = {
  runByUser: { select: { id: true, name: true } },
  payrollCycle: { select: { id: true, name: true, frequency: true } },
  payslips: { include: { user: { select: { id: true, name: true, avatarUrl: true, department: true } }, lines: { orderBy: { displayOrder: 'asc' as const } } }, orderBy: { user: { name: 'asc' as const } } },
};

/**
 * Hold the run's lock while `fn` runs. A conditional update is atomic in
 * Postgres, so this works across API instances; a lock older than 10 minutes
 * (crashed request) is taken over.
 */
export async function withRunLock<T>(orgId: string, runId: string, fn: () => Promise<T>): Promise<T> {
  const got = await prisma.payrollRun.updateMany({
    where: { id: runId, orgId, OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } }] },
    data: { lockedAt: new Date() },
  });
  if (got.count === 0) {
    const exists = await prisma.payrollRun.findFirst({ where: { id: runId, orgId }, select: { id: true } });
    if (!exists) throw new AppError(404, 'Payroll run not found');
    throw new AppError(409, 'Another manager is rerunning or finalising this payroll right now — try again in a moment.');
  }
  try { return await fn(); } finally {
    await prisma.payrollRun.updateMany({ where: { id: runId }, data: { lockedAt: null } }).catch(() => undefined);
  }
}

export const isLocked = (run: { lockedAt?: Date | null }) => !!run.lockedAt && run.lockedAt.getTime() > Date.now() - LOCK_STALE_MS;

const figuresOfComputed = (c: ComputedSlip, lines: SlipLine[], totals: ComputedSlip['totals']): SlipFigures => ({
  gross: totals.earnings, deductions: totals.deductions, net: totals.net, reimbursements: totals.reimbursements, employer: totals.employer,
  workingDays: c.fields.workingDays, paidDays: c.fields.paidDays, lopDays: c.fields.lopDays, lines,
});

/** Runs finalised after this one's period (attendance stays frozen; carry effects aren't recalculated). */
async function laterFinalisedRuns(orgId: string, run: { id: string; periodStart: Date | null }) {
  if (!run.periodStart) return [];
  const rows = await prisma.payrollRun.findMany({
    where: { orgId, id: { not: run.id }, status: { in: ['PROCESSED', 'PAID'] }, periodStart: { gt: run.periodStart } },
    select: { id: true, month: true, year: true, status: true, periodStart: true, payrollCycle: { select: { name: true } } },
    orderBy: { periodStart: 'asc' }, take: 10,
  });
  return rows.map(r => ({ id: r.id, month: r.month, year: r.year, status: r.status, periodStart: r.periodStart, cycleName: r.payrollCycle?.name ?? null }));
}

// ─── Rerun ───────────────────────────────────────────────────────────────────

async function loadRunForRerun(orgId: string, id: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id, orgId }, include: { payslips: { include: { lines: true, user: { select: { id: true, name: true } } } }, payrollCycle: true } });
  if (!run) throw new AppError(404, 'Payroll run not found');
  return run;
}

/** Recompute a DRAFT run; returns the change summary. `legacy` reproduces the old /recalculate (any active salary, nobody added). */
async function rerunCore(orgId: string, runId: string, options: RerunOptions, legacy = false) {
  const run = await loadRunForRerun(orgId, runId);
  if (run.status !== 'DRAFT') throw new AppError(400, 'Only draft runs can be rerun — reopen the run first');
  const comps = await prisma.salaryComponent.findMany({ where: { orgId } });
  const cycle = run.payrollCycle ?? { frequency: 'MONTHLY' };
  const salaries = await prisma.employeeSalary.findMany({
    where: { orgId, isActive: true },
    include: { user: { select: { id: true, name: true, isActive: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const plan = planRerun({
    existing: run.payslips.map(p => ({ userId: p.userId, payslipId: p.id })),
    salaries: salaries.map(s => ({ userId: s.userId, employeeSalaryId: s.id, payrollCycleId: s.payrollCycleId, userActive: s.user.isActive })),
    runCycleId: legacy ? null : run.payrollCycleId,
    options,
  });

  const names = new Map<string, string>();
  for (const p of run.payslips) names.set(p.userId, p.user.name);
  for (const s of salaries) if (!names.has(s.userId)) names.set(s.userId, s.user.name);
  const unknown = plan.skipped.map(s => s.userId).filter(u => !names.has(u));
  if (unknown.length) {
    for (const u of await prisma.user.findMany({ where: { orgId, id: { in: unknown } }, select: { id: true, name: true } })) names.set(u.id, u.name);
  }
  const salaryById = new Map(salaries.map(s => [s.id, s]));
  const slipById = new Map(run.payslips.map(p => [p.id, p]));
  const runC = { id: run.id, periodStart: run.periodStart!, periodEnd: run.periodEnd!, month: run.month, year: run.year, payrollCycleId: run.payrollCycleId, attendanceMode: run.attendanceMode };

  // 1) compute everything (reads only) — the previous values are captured
  //    before anything is written, so the summary compares like with like.
  const writes: any[] = [];
  const entries: ChangeEntry[] = [];
  for (const r of plan.rebuild) {
    const p = slipById.get(r.payslipId)!;
    const before = figuresOfPayslip(p);
    const c = await computeSlip(orgId, runC, salaryById.get(r.employeeSalaryId)!, comps, cycle, p.id);
    let lines = c.lines, totals = c.totals, kept = 0, dropped: string[] = [];
    const adj = options.keepAdjustments ? p.lines.filter(l => l.adjusted).map(l => ({ code: l.code, amount: Number(l.amount) })) : [];
    let loans = c.loans;
    if (adj.length) {
      const a = applyAdjustments(c.lines, adj);
      lines = a.lines; kept = a.applied; dropped = a.missing;
      totals = { earnings: a.totals.earnings, deductions: a.totals.deductions, reimbursements: a.totals.reimbursements, employer: a.totals.employer, net: a.totals.net };
      // Re-applied adjustments change what's left for loan EMIs: recompute them so net pay stays ≥ 0.
      if (lines.some(l => isLoanCode(l.code)) || a.totals.net < 0) {
        const r = await reapplyLoans(orgId, p.userId, runC, lines, p.id);
        lines = r.lines; loans = r.loans;
        const w = (c.fields.attendanceSummary.warnings ?? []).filter((x: string) => !/could be recovered without making net pay negative/.test(x));
        c.fields.attendanceSummary = { ...c.fields.attendanceSummary, warnings: [...w, ...r.loans.warnings] };
        totals = { earnings: r.totals.earnings, deductions: r.totals.deductions, reimbursements: r.totals.reimbursements, employer: r.totals.employer, net: r.totals.net };
      }
    }
    writes.push(prisma.payslip.update({
      where: { id: p.id },
      // Loan recoveries are replaced with this computation's (never added to) — rerun is idempotent.
      data: { ...slipColumns({ lines, totals, fields: c.fields }), lines: { deleteMany: {}, create: lineRows(lines) }, loanEntries: { deleteMany: {}, create: loanEntryRows(orgId, runC, lines, loans) } },
    }));
    entries.push({ userId: p.userId, name: p.user.name, payslipId: p.id, kind: 'UPDATED', diff: diffSlip(before, figuresOfComputed(c, lines, totals)), adjustmentsKept: kept, adjustmentsDropped: dropped });
  }
  let k = 0;
  for (const a of plan.add) {
    const es = salaryById.get(a.employeeSalaryId)!;
    const c = await computeSlip(orgId, runC, es, comps, cycle);
    const payslipNumber = await nextPayslipNumber(orgId, run.year, run.month, k++);
    writes.push(prisma.payslip.create({
      data: {
        orgId, userId: a.userId, payrollRunId: run.id, payslipNumber, month: run.month, year: run.year, periodStart: run.periodStart, periodEnd: run.periodEnd,
        ...slipColumns(c), status: 'DRAFT', lines: { create: lineRows(c.lines) }, loanEntries: { create: loanEntryRows(orgId, runC, c.lines, c.loans) },
      },
    }));
    entries.push({ userId: a.userId, name: es.user.name, payslipId: null, kind: 'ADDED', diff: diffSlip(null, figuresOfComputed(c, c.lines, c.totals)) });
  }
  for (const r of plan.remove) {
    const p = slipById.get(r.payslipId)!;
    writes.push(prisma.payslip.delete({ where: { id: p.id } }));
    entries.push({ userId: p.userId, name: p.user.name, payslipId: null, kind: 'REMOVED', diff: diffSlip(figuresOfPayslip(p), null) });
  }

  // 2) write it all at once — a failure leaves the draft as it was.
  if (writes.length) await prisma.$transaction(writes);

  return {
    run,
    summary: {
      options,
      entries: sortChanges(entries),
      added: plan.add.map(a => ({ userId: a.userId, name: names.get(a.userId) ?? a.userId })),
      removed: plan.remove.map(r => ({ userId: r.userId, name: names.get(r.userId) ?? r.userId, reason: r.reason })),
      skipped: plan.skipped.map(s => ({ userId: s.userId, name: names.get(s.userId) ?? s.userId, reason: s.reason })),
      ...summariseChanges(entries),
    },
  };
}

/** POST /hr/payroll/runs/:id/rerun — "Rerun with latest salaries" with options; returns { run, summary }. */
export async function rerunRun(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const options = parseRerunOptions(req.body);
    const { summary } = await withRunLock(orgId, req.params.id, () => rerunCore(orgId, req.params.id, options));
    logAction(req.user!.id, 'UPDATE', 'PayrollRun', req.params.id, {
      action: 'rerun', options: { ...options, userIds: options.userIds?.length ?? 'all' },
      changed: summary.changedCount, added: summary.added.length, removed: summary.removed.length, skipped: summary.skipped.length, netChange: summary.totals.net,
    });
    res.json({ run: await prisma.payrollRun.findUnique({ where: { id: req.params.id }, include: runInclude }), summary });
  } catch (err) { next(err); }
}

/** POST /hr/payroll/runs/:id/recalculate — kept for older app builds: same as before (keeps adjustments, adds/removes nobody), returns the run. */
export async function recalculateRun(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const options: RerunOptions = { userIds: null, keepAdjustments: true, includeNewEmployees: false, removeWithoutSalary: false, refreshAttendance: true };
    await withRunLock(orgId, req.params.id, () => rerunCore(orgId, req.params.id, options, true));
    logAction(req.user!.id, 'UPDATE', 'PayrollRun', req.params.id, { action: 'recalculate' });
    res.json(await prisma.payrollRun.findUnique({ where: { id: req.params.id }, include: runInclude }));
  } catch (err) { next(err); }
}

// ─── Reopen ──────────────────────────────────────────────────────────────────

const ReopenSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500),
  /** Required for PAID runs: the manager confirms money already went out */
  acknowledgePaid: z.boolean().optional(),
});

/** POST /hr/payroll/runs/:id/reopen — PROCESSED/PAID → DRAFT after freezing every payslip as a revision. */
export async function reopenRun(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { reason, acknowledgePaid } = ReopenSchema.parse(req.body ?? {});
    const result = await withRunLock(orgId, req.params.id, async () => {
      const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId }, include: { payslips: { include: { lines: true } } } });
      if (!run) throw new AppError(404, 'Payroll run not found');
      if (run.status === 'DRAFT') throw new AppError(400, 'This run is already a draft');
      if (run.status !== 'PROCESSED' && run.status !== 'PAID') throw new AppError(400, `A ${run.status} run can't be reopened`);
      if (run.status === 'PAID' && !acknowledgePaid) throw new AppError(400, 'This run was already paid — confirm that you understand the differences will need settling');
      const fromStatus = run.status;
      await prisma.$transaction([
        prisma.payslipRevision.createMany({
          data: run.payslips.map(p => ({
            orgId, payslipId: p.id, payrollRunId: run.id, userId: p.userId, version: p.version,
            data: snapshotPayslip(p, run) as any, reason, createdBy: req.user!.id,
          })),
        }),
        // Back to draft: hidden from employees (drafts are manager-only),
        // attendance for the period unlocks (frozenUntil ignores drafts).
        prisma.payslip.updateMany({ where: { payrollRunId: run.id, orgId }, data: { status: 'DRAFT', paidAt: null } }),
        prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'DRAFT', version: run.version + 1 } }),
      ]);
      return { fromStatus, version: run.version + 1, count: run.payslips.length, run };
    });
    logAction(req.user!.id, 'UPDATE', 'PayrollRun', req.params.id, { action: 'reopen', reason, fromStatus: result.fromStatus, version: result.version, payslips: result.count });
    const later = await laterFinalisedRuns(orgId, result.run);
    res.json({ ...(await prisma.payrollRun.findUnique({ where: { id: req.params.id }, include: runInclude })), reopened: { fromStatus: result.fromStatus, laterFinalisedRuns: later } });
  } catch (err) { next(err); }
}

// ─── Finalise / re-finalise ─────────────────────────────────────────────────

async function revisionsFor(orgId: string, runId: string): Promise<(RevisionRow & { createdBy: string; reason: string })[]> {
  const rows = await prisma.payslipRevision.findMany({ where: { orgId, payrollRunId: runId }, orderBy: [{ version: 'asc' }, { createdAt: 'asc' }] });
  return rows.map(r => ({ userId: r.userId, payslipId: r.payslipId, version: r.version, createdAt: r.createdAt, data: r.data as unknown as RevisionData, createdBy: r.createdBy, reason: r.reason }));
}

async function settlementFor(orgId: string, run: { id: string; status: string }, revisions?: RevisionRow[]) {
  const revs = revisions ?? await revisionsFor(orgId, run.id);
  const baselines = paidBaselines(revs);
  if (baselines.size === 0) return computeSettlement([], baselines, new Map(), run.status);
  const slips = await prisma.payslip.findMany({ where: { orgId, payrollRunId: run.id }, select: { id: true, userId: true, netPay: true, status: true, paidAt: true, user: { select: { name: true } } } });
  const names = new Map<string, string>();
  const missing = [...baselines.keys()].filter(u => !slips.some(s => s.userId === u));
  if (missing.length) for (const u of await prisma.user.findMany({ where: { orgId, id: { in: missing } }, select: { id: true, name: true } })) names.set(u.id, u.name);
  return computeSettlement(slips.map(s => ({ userId: s.userId, name: s.user.name, payslipId: s.id, net: Number(s.netPay), status: s.status, paidAt: s.paidAt })), baselines, names, run.status);
}

/** POST /hr/payroll/runs/:id/finalize — issue the payslips (DRAFT → PROCESSED). { repinTemplate?: boolean } for reopened runs. */
export async function finalizeRun(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const repinTemplate = req.body?.repinTemplate === true;
    const out = await withRunLock(orgId, req.params.id, async () => {
      const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId } });
      if (!run) throw new AppError(404, 'Payroll run not found');
      if (run.status !== 'DRAFT') throw new AppError(400, 'This run is already finalised');
      const slips = await prisma.payslip.findMany({ where: { payrollRunId: run.id, orgId }, include: { lines: true } });
      if (slips.length === 0) throw new AppError(400, 'This run has no payslips to issue');
      // A loan cancelled/closed after this draft was computed leaves a recovery
      // line without its ledger row (or the reverse) — issue only consistent payslips.
      const loanRows = await prisma.loanLedgerEntry.findMany({ where: { orgId, payslipId: { in: slips.map(s => s.id) }, type: 'RECOVERY' }, select: { payslipId: true, loanId: true, amount: true } });
      const stale = slips.filter(s => {
        const lineSet = s.lines.filter(l => isLoanCode(l.code) && Number(l.amount) > 0).map(l => `${loanIdOf(l.code)}:${Number(l.amount).toFixed(2)}`).sort().join('|');
        const rowSet = loanRows.filter(r => r.payslipId === s.id && Number(r.amount) > 0).map(r => `${r.loanId}:${Number(r.amount).toFixed(2)}`).sort().join('|');
        return lineSet !== rowSet;
      });
      if (stale.length) throw new AppError(400, `Loan recoveries changed since this draft was calculated (${stale.length} payslip${stale.length === 1 ? '' : 's'}) — rerun the draft before finalising.`);
      const revisions = run.version > 1 ? await revisionsFor(orgId, run.id) : [];
      const baselines = paidBaselines(revisions);
      const now = new Date();
      // Pin each payslip to the template that applies to the employee today, so
      // later template edits never restyle an issued document. A revised
      // payslip keeps the template it was first issued with unless HR asks to re-pin.
      const templateFor = async (userId: string) => {
        const emp = await prisma.employee.findFirst({ where: { orgId, userId }, select: { departmentId: true, locationId: true, employmentType: true } });
        return (await resolveTemplate(orgId, emp)).id;
      };
      const updates: any[] = [];
      const stats = { revised: 0, unchanged: 0, first: 0, revisedEmailedBefore: 0 };
      const finalStatus: string[] = [];
      for (const s of slips) {
        if (revisions.length === 0) {
          updates.push(prisma.payslip.update({ where: { id: s.id }, data: { status: 'GENERATED', templateId: await templateFor(s.userId) } }));
          finalStatus.push('GENERATED'); stats.first++;
          continue;
        }
        const prev = latestRevision(revisions, s.id, s.userId);
        const d = refinalizeDecision(prev?.data ?? null, prev?.version ?? null, figuresOfPayslip(s), baselines.get(s.userId) ?? null);
        const pinned = s.templateId ?? d.restoreTemplateId;
        const templateId = !pinned || (repinTemplate && (d.revised || !prev)) ? await templateFor(s.userId) : pinned;
        updates.push(prisma.payslip.update({
          where: { id: s.id },
          data: {
            status: d.status, paidAt: d.paidAt ? new Date(d.paidAt) : null, version: d.version, templateId,
            revisedAt: d.revised ? now : s.revisedAt, paidDifference: d.paidDifference,
          },
        }));
        finalStatus.push(d.status);
        if (!prev) stats.first++; else if (d.revised) { stats.revised++; if (s.emailedAt) stats.revisedEmailedBefore++; } else stats.unchanged++;
      }
      await prisma.$transaction([
        ...updates,
        prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'PROCESSED', finalizedAt: now, finalizedBy: req.user!.id } }),
      ]);
      // A revised paid run stays PROCESSED until every difference is settled
      // (existing mark-paid). If nothing changed for anyone, it is PAID again.
      let settlement = null as Awaited<ReturnType<typeof settlementFor>> | null;
      if (baselines.size > 0) {
        settlement = await settlementFor(orgId, { id: run.id, status: 'PROCESSED' }, revisions);
        if (finalStatus.every(s => s === 'PAID') && settlement.totals.pendingCount === 0) {
          await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'PAID' } });
        }
      }
      // Loans whose last EMI was just issued close themselves; a revision
      // that gave money back to a closed loan reopens it.
      await settleLoanStatuses(orgId, run.id, req.user!.id);
      return { run, stats, settlement };
    });
    logAction(req.user!.id, 'UPDATE', 'PayrollRun', req.params.id, out.run.version > 1
      ? { action: 're-finalize', version: out.run.version, revised: out.stats.revised, unchanged: out.stats.unchanged, added: out.stats.first, repinTemplate, arrears: out.settlement?.totals.arrears ?? 0, recovery: out.settlement?.totals.recovery ?? 0 }
      : { action: 'finalize' });
    const full = await prisma.payrollRun.findUnique({ where: { id: req.params.id }, include: runInclude });
    res.json({ ...full, refinalize: out.run.version > 1 ? { ...out.stats, settlement: out.settlement } : undefined });
  } catch (err) { next(err); }
}

// ─── History, settlement, compare ────────────────────────────────────────────

/** GET /hr/payroll/runs/:id/history — versions, settlement, warnings for the run review */
export async function runHistory(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId }, include: { _count: { select: { payslips: true } } } });
    if (!run) throw new AppError(404, 'Payroll run not found');
    const revisions = await revisionsFor(orgId, run.id);
    const userIds = new Set<string>([run.runBy]);
    if (run.finalizedBy) userIds.add(run.finalizedBy);
    for (const r of revisions) { userIds.add(r.createdBy); if (r.data?.issuedBy) userIds.add(r.data.issuedBy); }
    const names = new Map((await prisma.user.findMany({ where: { orgId, id: { in: [...userIds] } }, select: { id: true, name: true } })).map(u => [u.id, u.name]));
    // Runs issued before version tracking have no finalizedBy — fall back to whoever ran them.
    const fallbackIssuer = (v: { issuedBy: string | null; issuedByName: string | null }) => v.issuedBy ? v : { issuedBy: run.runBy, issuedByName: names.get(run.runBy) ?? null };
    const versions = runVersionHistory({ version: run.version, status: run.status, finalizedAt: run.finalizedAt, finalizedBy: run.finalizedBy, payslipCount: run._count.payslips }, revisions, names)
      .map(v => (v.current && run.status === 'DRAFT') ? v : { ...v, ...fallbackIssuer(v) });
    // Revised payslips whose previous version reached the employee by e-mail
    // and the revision hasn't been sent yet — the "re-send?" prompt.
    const revisedEmailedBefore = (await prisma.payslip.findMany({
      where: { orgId, payrollRunId: run.id, status: { not: 'DRAFT' }, revisedAt: { not: null }, emailedAt: { not: null } },
      select: { revisedAt: true, emailedAt: true },
    })).filter(p => p.emailedAt! < p.revisedAt!).length;
    res.json({
      versions,
      reopened: run.status === 'DRAFT' && run.version > 1,
      locked: isLocked(run),
      settlement: await settlementFor(orgId, run, revisions),
      laterFinalisedRuns: await laterFinalisedRuns(orgId, run),
      revisedEmailedBefore,
      revisionCounts: revisions.reduce<Record<string, number>>((m, r) => { m[r.userId] = (m[r.userId] ?? 0) + 1; return m; }, {}),
    });
  } catch (err) { next(err); }
}

/** GET /hr/payroll/runs/:id/settlement — arrears/recovery per employee after revising a paid run */
export async function runSettlement(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const run = await prisma.payrollRun.findFirst({ where: { id: req.params.id, orgId }, select: { id: true, status: true } });
    if (!run) throw new AppError(404, 'Payroll run not found');
    res.json(await settlementFor(orgId, run));
  } catch (err) { next(err); }
}

/** GET /hr/payroll/runs/:id/payslips/:payslipId/compare — every issued version of one payslip vs the current one */
export async function comparePayslip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const p = await prisma.payslip.findFirst({ where: { id: req.params.payslipId, payrollRunId: req.params.id, orgId }, include: { lines: true, user: { select: { id: true, name: true } } } });
    if (!p) throw new AppError(404, 'Payslip not found');
    const revs = (await revisionsFor(orgId, p.payrollRunId)).filter(r => r.payslipId === p.id || (r.payslipId == null && r.userId === p.userId));
    const current = figuresOfPayslip(p);
    const versions = revs.map((r, i) => {
      const f = figuresOfRevision(r.data);
      const next = i + 1 < revs.length ? figuresOfRevision(revs[i + 1].data) : current;
      return {
        version: r.version, runVersion: r.data.runVersion, issuedAt: r.data.issuedAt, status: r.data.status, paidAt: r.data.paidAt, paidNet: r.data.paidNet, reason: r.reason, reopenedAt: r.createdAt,
        figures: f, diffToNext: diffSlip(f, next), diffToCurrent: diffSlip(f, current),
      };
    });
    res.json({
      payslip: { id: p.id, userId: p.userId, name: p.user.name, payslipNumber: p.payslipNumber, version: p.version, status: p.status, revisedAt: p.revisedAt, paidDifference: p.paidDifference != null ? Number(p.paidDifference) : null },
      current, versions,
    });
  } catch (err) { next(err); }
}
