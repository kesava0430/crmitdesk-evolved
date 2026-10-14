/**
 * Rerun / reopen / revise payroll — the pure half.
 *
 * Everything here works on plain objects so it can be unit-tested without a
 * database (tests/unit/payroll-revision.test.ts). The controller
 * (modules/hr/payroll/payrollRevision.controller.ts) loads rows, calls these,
 * and writes the result.
 *
 * Vocabulary
 *  - rerun:     recompute a DRAFT run from the employees' current salaries and
 *               the attendance register, reporting what changed per person.
 *  - reopen:    move a finalised (PROCESSED) or PAID run back to DRAFT so it can
 *               be rerun. Every payslip is first frozen as a PayslipRevision.
 *  - re-finalise: issue the run again. Payslips that changed get version+1;
 *               unchanged ones are restored exactly as they were.
 *  - paid baseline: the latest revision of a person's payslip that was PAID —
 *               the money that actually left the bank. The difference between
 *               a revised net and that is arrears (+) or a recovery (−).
 */
import { z } from 'zod';

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface SlipLine {
  code: string; name: string; category: string; amount: number;
  basis?: string | null; showOnPayslip?: boolean; displayOrder?: number; adjusted?: boolean;
}

/** The figures of a payslip that matter for comparing versions. */
export interface SlipFigures {
  gross: number; deductions: number; net: number; reimbursements: number; employer: number;
  workingDays: number | null; paidDays: number | null; lopDays: number | null;
  lines: SlipLine[];
}

/** PayslipRevision.data — one frozen, issued payslip. */
export interface RevisionData {
  schema: 1;
  /** Run version this payslip was issued under */
  runVersion: number;
  /** When / by whom this version was issued (finalised) */
  issuedAt: string | null;
  issuedBy: string | null;
  payslipNumber: string;
  status: string;
  paidAt: string | null;
  emailedAt: string | null;
  templateId: string | null;
  /** Net that was paid with this version (null when it was not paid) */
  paidNet: number | null;
  /** Difference vs paid recorded on this version, if it was itself a revision of a paid payslip */
  paidDifference: number | null;
  totals: { gross: number; deductions: number; net: number; reimbursements: number; employer: number };
  days: { working: number | null; paid: number | null; present: number | null; leave: number | null; lop: number | null; half: number | null; overtimeHours: number | null };
  attendanceSummary: unknown;
  lines: SlipLine[];
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
export const round2 = (v: number) => Math.round(v * 100) / 100;
const same = (a: number | null | undefined, b: number | null | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < 0.005;
const isoOrNull = (d: unknown): string | null => (d ? new Date(d as any).toISOString() : null);

/** Figures of a live Payslip row (Prisma Decimals are fine) with its lines. */
export function figuresOfPayslip(p: any): SlipFigures {
  return {
    gross: num(p.totalEarnings ?? p.grossPay), deductions: num(p.totalDeductions), net: num(p.netPay),
    reimbursements: num(p.totalReimbursements), employer: num(p.employerContributions),
    workingDays: numOrNull(p.workingDays), paidDays: numOrNull(p.paidDays), lopDays: numOrNull(p.lopDays),
    lines: (p.lines ?? []).map((l: any) => ({
      code: l.code, name: l.name, category: l.category, amount: num(l.amount), basis: l.basis ?? null,
      showOnPayslip: l.showOnPayslip !== false, displayOrder: l.displayOrder ?? 0, adjusted: !!l.adjusted,
    })),
  };
}

/** Figures of a frozen revision. */
export function figuresOfRevision(d: RevisionData): SlipFigures {
  return {
    gross: d.totals.gross, deductions: d.totals.deductions, net: d.totals.net, reimbursements: d.totals.reimbursements, employer: d.totals.employer,
    workingDays: d.days.working, paidDays: d.days.paid, lopDays: d.days.lop, lines: d.lines,
  };
}

// ─── Options ─────────────────────────────────────────────────────────────────

export const RerunOptionsSchema = z.object({
  /** Only these employees (default: everyone in the run, plus new joiners if includeNewEmployees) */
  userIds: z.array(z.string().min(1)).min(1).max(5000).optional(),
  /** Re-apply lines a manager adjusted during review */
  keepAdjustments: z.boolean().default(true),
  /** Add payslips for people who now have an active salary on this cycle but none in the run */
  includeNewEmployees: z.boolean().default(true),
  /** Delete payslips of people who no longer have an active salary on this cycle (otherwise reported and left as is) */
  removeWithoutSalary: z.boolean().default(false),
});
export interface RerunOptions { userIds: string[] | null; keepAdjustments: boolean; includeNewEmployees: boolean; removeWithoutSalary: boolean; refreshAttendance: true }

/** Parse a request body into options with defaults. Attendance is always re-read — a rerun that kept stale days would be misleading. */
export function parseRerunOptions(body: unknown): RerunOptions {
  const o = RerunOptionsSchema.parse(body ?? {});
  return {
    userIds: o.userIds ? Array.from(new Set(o.userIds)) : null,
    keepAdjustments: o.keepAdjustments, includeNewEmployees: o.includeNewEmployees, removeWithoutSalary: o.removeWithoutSalary,
    refreshAttendance: true,
  };
}

// ─── Plan: who gets rebuilt / added / removed / skipped ──────────────────────

export interface ActiveSalary { userId: string; employeeSalaryId: string; payrollCycleId: string | null; userActive: boolean }
export interface RerunPlan {
  rebuild: { userId: string; payslipId: string; employeeSalaryId: string }[];
  add: { userId: string; employeeSalaryId: string }[];
  remove: { userId: string; payslipId: string; reason: string }[];
  skipped: { userId: string; payslipId: string | null; reason: string }[];
}

export function planRerun(input: {
  existing: { userId: string; payslipId: string }[];
  salaries: ActiveSalary[];
  runCycleId: string | null;
  options: Pick<RerunOptions, 'userIds' | 'includeNewEmployees' | 'removeWithoutSalary'>;
}): RerunPlan {
  const { existing, runCycleId, options } = input;
  const wanted = options.userIds ? new Set(options.userIds) : null;
  const byUser = new Map<string, ActiveSalary>();
  for (const s of input.salaries) if (!byUser.has(s.userId)) byUser.set(s.userId, s);
  // A run whose cycle was deleted (payrollCycleId → null) falls back to the
  // old behaviour: any active salary counts, and nobody new is added.
  const onCycle = (s: ActiveSalary) => runCycleId == null || s.payrollCycleId === runCycleId;

  const plan: RerunPlan = { rebuild: [], add: [], remove: [], skipped: [] };
  const inRun = new Set<string>();
  for (const e of existing) {
    inRun.add(e.userId);
    if (wanted && !wanted.has(e.userId)) continue;
    const s = byUser.get(e.userId);
    const reason = !s ? 'No active salary'
      : !s.userActive ? 'Employee is deactivated'
      : !onCycle(s) ? 'Salary is now on another payroll cycle'
      : null;
    if (!reason) { plan.rebuild.push({ userId: e.userId, payslipId: e.payslipId, employeeSalaryId: s!.employeeSalaryId }); continue; }
    if (options.removeWithoutSalary) plan.remove.push({ userId: e.userId, payslipId: e.payslipId, reason });
    else plan.skipped.push({ userId: e.userId, payslipId: e.payslipId, reason: `${reason} — previous payslip kept` });
  }
  if (options.includeNewEmployees && runCycleId != null) {
    for (const s of byUser.values()) {
      if (inRun.has(s.userId) || !s.userActive || s.payrollCycleId !== runCycleId) continue;
      if (wanted && !wanted.has(s.userId)) continue;
      plan.add.push({ userId: s.userId, employeeSalaryId: s.employeeSalaryId });
    }
  }
  if (wanted) {
    const handled = new Set([...plan.rebuild, ...plan.add, ...plan.remove, ...plan.skipped].map(x => x.userId));
    for (const u of wanted) {
      if (handled.has(u)) continue;
      const s = byUser.get(u);
      plan.skipped.push({
        userId: u, payslipId: null,
        reason: !s ? 'Not in this run and no active salary'
          : !s.userActive ? 'Employee is deactivated'
          : s.payrollCycleId !== runCycleId ? 'Salary is on another payroll cycle'
          : 'New employee — "include new employees" was off',
      });
    }
  }
  return plan;
}

// ─── Adjustments ─────────────────────────────────────────────────────────────

export function totalsOfLines(lines: SlipLine[]) {
  const sum = (cat: string) => round2(lines.filter(l => l.category === cat).reduce((s, l) => s + l.amount, 0));
  const earnings = sum('EARNING'), deductions = sum('DEDUCTION'), reimbursements = sum('REIMBURSEMENT'), employer = sum('EMPLOYER_CONTRIBUTION');
  return { earnings, deductions, reimbursements, employer, net: round2(earnings + reimbursements - deductions) };
}

/** Re-apply manual adjustments to freshly computed lines. Codes no longer on the payslip are reported, not invented. */
export function applyAdjustments(lines: SlipLine[], adjustments: { code: string; amount: number }[]) {
  const out = lines.map(l => ({ ...l }));
  const missing: string[] = [];
  for (const a of adjustments) {
    const l = out.find(x => x.code === a.code);
    if (!l) { missing.push(a.code); continue; }
    l.amount = a.amount; l.adjusted = true;
  }
  return { lines: out, totals: totalsOfLines(out), missing, applied: adjustments.length - missing.length };
}

// ─── Change summary ──────────────────────────────────────────────────────────

export interface Delta { old: number | null; new: number | null; delta: number }
export interface SlipDiff {
  gross: Delta; deductions: Delta; net: Delta;
  paidDays: Delta | null; lopDays: Delta | null;
  lines: { code: string; name: string; category: string; old: number | null; new: number | null; delta: number }[];
  changed: boolean;
}

const delta = (a: number | null, b: number | null): Delta => ({ old: a, new: b, delta: round2((b ?? 0) - (a ?? 0)) });

/** Compare two versions of a payslip (either side may be missing: added / removed). */
export function diffSlip(before: SlipFigures | null, after: SlipFigures | null): SlipDiff {
  const lines: SlipDiff['lines'] = [];
  const codes: string[] = [];
  for (const l of [...(before?.lines ?? []), ...(after?.lines ?? [])]) if (!codes.includes(l.code)) codes.push(l.code);
  for (const code of codes) {
    const a = before?.lines.find(l => l.code === code) ?? null;
    const b = after?.lines.find(l => l.code === code) ?? null;
    if (a && b && same(a.amount, b.amount)) continue;
    const meta = (b ?? a)!;
    lines.push({ code, name: meta.name, category: meta.category, old: a ? a.amount : null, new: b ? b.amount : null, delta: round2((b?.amount ?? 0) - (a?.amount ?? 0)) });
  }
  const days = (k: 'paidDays' | 'lopDays'): Delta | null => {
    const a = before ? before[k] : null, b = after ? after[k] : null;
    return a == null && b == null ? null : delta(a, b);
  };
  const d: SlipDiff = {
    gross: delta(before ? before.gross : null, after ? after.gross : null),
    deductions: delta(before ? before.deductions : null, after ? after.deductions : null),
    net: delta(before ? before.net : null, after ? after.net : null),
    paidDays: days('paidDays'), lopDays: days('lopDays'),
    lines, changed: false,
  };
  d.changed = !before || !after || lines.length > 0 || d.gross.delta !== 0 || d.deductions.delta !== 0 || d.net.delta !== 0
    || (d.paidDays?.delta ?? 0) !== 0 || (d.lopDays?.delta ?? 0) !== 0;
  return d;
}

export interface ChangeEntry { userId: string; name: string; payslipId: string | null; kind: 'UPDATED' | 'ADDED' | 'REMOVED'; diff: SlipDiff; adjustmentsKept?: number; adjustmentsDropped?: string[] }

/** Largest absolute net change first; unchanged people last; ties by name. */
export function sortChanges<T extends ChangeEntry>(entries: T[]): T[] {
  return entries.slice().sort((a, b) =>
    Number(b.diff.changed) - Number(a.diff.changed)
    || Math.abs(b.diff.net.delta) - Math.abs(a.diff.net.delta)
    || a.name.localeCompare(b.name));
}

export function summariseChanges(entries: ChangeEntry[]) {
  const totals = entries.reduce((t, e) => ({
    gross: round2(t.gross + e.diff.gross.delta), deductions: round2(t.deductions + e.diff.deductions.delta), net: round2(t.net + e.diff.net.delta),
  }), { gross: 0, deductions: 0, net: 0 });
  return { changedCount: entries.filter(e => e.diff.changed).length, unchangedCount: entries.filter(e => !e.diff.changed).length, totals };
}

// ─── Snapshots (reopen) ──────────────────────────────────────────────────────

/** Freeze an issued payslip. `run` is the run as it was issued. */
export function snapshotPayslip(p: any, run: { version: number; finalizedAt?: Date | string | null; finalizedBy?: string | null }): RevisionData {
  const f = figuresOfPayslip(p);
  return {
    schema: 1,
    runVersion: run.version,
    issuedAt: isoOrNull(p.revisedAt ?? run.finalizedAt ?? p.createdAt),
    issuedBy: run.finalizedBy ?? null,
    payslipNumber: p.payslipNumber,
    status: p.status,
    paidAt: isoOrNull(p.paidAt),
    emailedAt: isoOrNull(p.emailedAt),
    templateId: p.templateId ?? null,
    paidNet: p.status === 'PAID' ? f.net : null,
    paidDifference: numOrNull(p.paidDifference),
    totals: { gross: f.gross, deductions: f.deductions, net: f.net, reimbursements: f.reimbursements, employer: f.employer },
    days: {
      working: f.workingDays, paid: f.paidDays, present: numOrNull(p.presentDays), leave: numOrNull(p.leaveDays),
      lop: f.lopDays, half: numOrNull(p.halfDays), overtimeHours: numOrNull(p.overtimeHours),
    },
    attendanceSummary: p.attendanceSummary ?? null,
    lines: f.lines,
  };
}

/** Did the payslip change since it was frozen? (amounts, lines or days) */
export function slipChanged(prev: RevisionData, current: SlipFigures): boolean {
  return diffSlip(figuresOfRevision(prev), current).changed;
}

// ─── Paid baseline & re-finalise decision ────────────────────────────────────

export interface RevisionRow { userId: string; payslipId: string | null; version: number; createdAt: Date | string; data: RevisionData }
export interface PaidBaseline { userId: string; payslipId: string | null; version: number; paidNet: number; paidAt: string | null }

/** Latest revision per person that was PAID — the money that actually went out. */
export function paidBaselines(revisions: RevisionRow[]): Map<string, PaidBaseline> {
  const out = new Map<string, PaidBaseline & { t: number }>();
  for (const r of revisions) {
    if (r.data?.status !== 'PAID' || r.data.paidNet == null) continue;
    const t = new Date(r.createdAt).getTime();
    const cur = out.get(r.userId);
    if (!cur || t > cur.t || (t === cur.t && r.version > cur.version)) {
      out.set(r.userId, { userId: r.userId, payslipId: r.payslipId, version: r.version, paidNet: r.data.paidNet, paidAt: r.data.paidAt, t });
    }
  }
  return new Map([...out].map(([k, { t: _t, ...v }]) => [k, v]));
}

/** Latest frozen revision of a payslip (by payslip id, else by person — covers removed & re-added). */
export function latestRevision(revisions: RevisionRow[], payslipId: string, userId: string): RevisionRow | null {
  const pick = (rows: RevisionRow[]) => rows.reduce<RevisionRow | null>((best, r) => (!best || r.version > best.version || (r.version === best.version && new Date(r.createdAt) > new Date(best.createdAt)) ? r : best), null);
  return pick(revisions.filter(r => r.payslipId === payslipId)) ?? pick(revisions.filter(r => r.userId === userId));
}

export interface RefinalizeDecision {
  revised: boolean; version: number; status: 'GENERATED' | 'PAID'; paidAt: string | null;
  paidDifference: number | null; restoreTemplateId: string | null;
}

/**
 * What a payslip becomes when a reopened run is issued again.
 *  - unchanged since it was frozen → restored exactly (status, paidAt, version)
 *  - changed → version+1; if it had been paid, the difference vs paid decides:
 *    zero → stays PAID; otherwise GENERATED until HR settles it (mark paid)
 *  - first-time payslip (added while reopened) → version 1, GENERATED
 */
export function refinalizeDecision(prev: RevisionData | null, prevVersion: number | null, current: SlipFigures, baseline: PaidBaseline | null): RefinalizeDecision {
  if (!prev) return { revised: false, version: 1, status: 'GENERATED', paidAt: null, paidDifference: null, restoreTemplateId: null };
  const v = prevVersion ?? 1;
  if (!slipChanged(prev, current)) {
    return { revised: false, version: v, status: prev.status === 'PAID' ? 'PAID' : 'GENERATED', paidAt: prev.status === 'PAID' ? prev.paidAt : null, paidDifference: prev.paidDifference, restoreTemplateId: prev.templateId };
  }
  if (!baseline) return { revised: true, version: v + 1, status: 'GENERATED', paidAt: null, paidDifference: null, restoreTemplateId: prev.templateId };
  const diff = round2(current.net - baseline.paidNet);
  if (same(diff, 0)) return { revised: true, version: v + 1, status: 'PAID', paidAt: baseline.paidAt, paidDifference: 0, restoreTemplateId: prev.templateId };
  return { revised: true, version: v + 1, status: 'GENERATED', paidAt: null, paidDifference: diff, restoreTemplateId: prev.templateId };
}

// ─── Settlement (revised PAID runs) ──────────────────────────────────────────

export interface SettlementRow {
  userId: string; name: string; payslipId: string | null;
  paidNet: number | null; newNet: number | null; difference: number;
  kind: 'ARREARS' | 'RECOVERY' | 'NONE' | 'NOT_PAID_BEFORE' | 'REMOVED';
  settled: boolean; settledAt: string | null;
}
export interface Settlement {
  applicable: boolean;
  rows: SettlementRow[];
  totals: { arrears: number; recovery: number; net: number; pendingArrears: number; pendingRecovery: number; pendingCount: number };
}

/**
 * Per-person difference between the current issued net and the last paid net.
 * Only meaningful once some payslip in the run was paid and then revised.
 */
export function computeSettlement(
  current: { userId: string; name: string; payslipId: string; net: number; status: string; paidAt: Date | string | null }[],
  baselines: Map<string, PaidBaseline>,
  names: Map<string, string>,
  runStatus: string,
): Settlement {
  const rows: SettlementRow[] = [];
  const empty = { arrears: 0, recovery: 0, net: 0, pendingArrears: 0, pendingRecovery: 0, pendingCount: 0 };
  if (baselines.size === 0) return { applicable: false, rows, totals: empty };
  const seen = new Set<string>();
  for (const p of current) {
    seen.add(p.userId);
    const b = baselines.get(p.userId) ?? null;
    const paidAtNow = p.paidAt ? new Date(p.paidAt).toISOString() : null;
    if (!b) {
      rows.push({ userId: p.userId, name: p.name, payslipId: p.payslipId, paidNet: null, newNet: p.net, difference: round2(p.net), kind: 'NOT_PAID_BEFORE', settled: p.status === 'PAID', settledAt: p.status === 'PAID' ? paidAtNow : null });
      continue;
    }
    const diff = round2(p.net - b.paidNet);
    const kind = same(diff, 0) ? 'NONE' : diff > 0 ? 'ARREARS' : 'RECOVERY';
    // Settled once the payslip is PAID again after the baseline payment.
    const settled = kind === 'NONE' || (p.status === 'PAID' && (!b.paidAt || !paidAtNow || paidAtNow > b.paidAt));
    rows.push({ userId: p.userId, name: p.name, payslipId: p.payslipId, paidNet: b.paidNet, newNet: p.net, difference: kind === 'NONE' ? 0 : diff, kind, settled, settledAt: kind !== 'NONE' && settled ? paidAtNow : null });
  }
  for (const b of baselines.values()) {
    if (seen.has(b.userId)) continue;
    rows.push({ userId: b.userId, name: names.get(b.userId) ?? b.userId, payslipId: null, paidNet: b.paidNet, newNet: null, difference: round2(-b.paidNet), kind: 'REMOVED', settled: runStatus === 'PAID', settledAt: null });
  }
  rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.name.localeCompare(b.name));
  const totals = { ...empty };
  for (const r of rows) {
    if (r.difference > 0) { totals.arrears = round2(totals.arrears + r.difference); if (!r.settled) totals.pendingArrears = round2(totals.pendingArrears + r.difference); }
    if (r.difference < 0) { totals.recovery = round2(totals.recovery - r.difference); if (!r.settled) totals.pendingRecovery = round2(totals.pendingRecovery - r.difference); }
    if (r.difference !== 0 && !r.settled) totals.pendingCount++;
  }
  totals.net = round2(totals.arrears - totals.recovery);
  return { applicable: true, rows, totals };
}

/** CSV for the settlement panel (also used by the client download). */
export function settlementCsv(s: Settlement): string {
  const q = (v: unknown) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ['Employee', 'Paid net', 'Revised net', 'Difference', 'Type', 'Settled'];
  const body = s.rows.map(r => [r.name, r.paidNet ?? '', r.newNet ?? '', r.difference.toFixed(2), r.kind, r.settled ? 'yes' : 'no'].map(q).join(','));
  return [head.join(','), ...body].join('\n');
}

// ─── Run version history ─────────────────────────────────────────────────────

export interface VersionEntry {
  version: number; issuedAt: string | null; issuedBy: string | null; issuedByName: string | null;
  reopenedAt: string | null; reopenedBy: string | null; reopenedByName: string | null; reason: string | null;
  payslipCount: number; current: boolean; status: string | null;
}

/** One entry per issued run version (from the revisions), plus the version being worked on now. */
export function runVersionHistory(
  run: { version: number; status: string; finalizedAt: Date | string | null; finalizedBy: string | null; payslipCount: number },
  revisions: { createdAt: Date | string; createdBy: string; reason: string; data: RevisionData }[],
  names: Map<string, string>,
): VersionEntry[] {
  const groups = new Map<number, typeof revisions>();
  for (const r of revisions) {
    const v = r.data?.runVersion ?? 1;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v)!.push(r);
  }
  const out: VersionEntry[] = [];
  for (const v of [...groups.keys()].sort((a, b) => a - b)) {
    const rows = groups.get(v)!;
    const first = rows.reduce((a, b) => (new Date(a.createdAt) <= new Date(b.createdAt) ? a : b));
    const issuedAt = rows.map(r => r.data.issuedAt).filter(Boolean).sort().pop() ?? null;
    const issuedBy = rows.find(r => r.data.issuedBy)?.data.issuedBy ?? null;
    out.push({
      version: v, issuedAt, issuedBy, issuedByName: issuedBy ? names.get(issuedBy) ?? null : null,
      reopenedAt: new Date(first.createdAt).toISOString(), reopenedBy: first.createdBy, reopenedByName: names.get(first.createdBy) ?? null, reason: first.reason,
      payslipCount: rows.length, current: false, status: rows.some(r => r.data.status === 'PAID') ? 'PAID' : 'PROCESSED',
    });
  }
  const issuedNow = run.status !== 'DRAFT';
  out.push({
    version: run.version,
    issuedAt: issuedNow ? isoOrNull(run.finalizedAt) : null, issuedBy: issuedNow ? run.finalizedBy : null,
    issuedByName: issuedNow && run.finalizedBy ? names.get(run.finalizedBy) ?? null : null,
    reopenedAt: null, reopenedBy: null, reopenedByName: null, reason: null,
    payslipCount: run.payslipCount, current: true, status: run.status,
  });
  return out;
}

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Next sequence number for a payslip-number prefix, from the highest in use (counting rows reuses numbers after deletions). */
export function nextSequence(existing: string[], prefix: string): number {
  let max = 0;
  for (const n of existing) {
    if (!n.startsWith(prefix)) continue;
    const k = parseInt(n.slice(prefix.length), 10);
    if (Number.isFinite(k) && k > max) max = k;
  }
  return max + 1;
}

/** The small note printed on a revised payslip (HTML + PDF). */
export function revisionNoteLines(r: { version: number; supersedesIssuedAt: string | null; paidDifference: number | null } | null, fmtMoney: (v: number) => string, fmtDate: (iso: string) => string): string[] {
  if (!r || r.version <= 1) return [];
  const lines = [`Revised (v${r.version})${r.supersedesIssuedAt ? ` — supersedes payslip issued on ${fmtDate(r.supersedesIssuedAt)}` : ''}`];
  if (r.paidDifference != null && !same(r.paidDifference, 0)) {
    lines.push(r.paidDifference > 0 ? `Difference vs paid: +${fmtMoney(r.paidDifference)} arrears` : `Difference vs paid: −${fmtMoney(-r.paidDifference)} recovery`);
  }
  return lines;
}
