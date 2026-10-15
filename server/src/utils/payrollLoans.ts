/**
 * Employee loans and salary advances — the pure half.
 *
 * Everything here works on plain objects so it can be unit-tested without a
 * database (tests/unit/payroll-loans.test.ts). The controllers load rows, call
 * these, and write the result.
 *
 * Rules
 *  - The balance is never stored on the loan: outstanding = totalRepayable −
 *    (RECOVERY + REPAYMENT + WAIVER entries). SKIP entries are amount 0 markers.
 *  - Payroll recovers one EMI per loan per payroll month (the run's
 *    period-start month), from the loan's start month on, capped at the
 *    outstanding balance. Weekly/biweekly cycles therefore recover once a
 *    month, in the first run of the month.
 *  - Net pay never goes negative: recoveries take what is left after every
 *    other deduction (oldest loan first). A shortfall is not added to next
 *    month's EMI — it stays in the balance and the schedule runs one EMI
 *    longer. The payslip gets a warning so HR sees it in the run review.
 *  - Recoveries are tied to the payslip (LoanLedgerEntry.payslipId). Computing
 *    a payslip ignores that payslip's own previous recoveries and the ledger
 *    rows are replaced on every recompute, so a rerun never double-deducts; a
 *    discarded draft deletes them with the payslip.
 */
import type { SlipLine } from './payrollRevision';

export const round2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown) => (v == null ? 0 : Number(v));

/** Payslip line code for a loan's recovery. Never collides with component codes (A–Z, 0–9, _ upper case). */
export const LOAN_CODE_PREFIX = 'LOAN_';
export const loanCode = (loanId: string) => `${LOAN_CODE_PREFIX}${loanId}`;
export const isLoanCode = (code: string | null | undefined) => !!code && code.startsWith(LOAN_CODE_PREFIX) && code.length > LOAN_CODE_PREFIX.length && code !== code.toUpperCase();
export const loanIdOf = (code: string) => (isLoanCode(code) ? code.slice(LOAN_CODE_PREFIX.length) : null);
/** Loan lines go after every component deduction on the payslip. */
export const LOAN_LINE_ORDER = 9000;

export const ENTRY_TYPES = ['RECOVERY', 'REPAYMENT', 'WAIVER', 'SKIP'] as const;
export type EntryType = typeof ENTRY_TYPES[number];
/** Entry types that reduce the balance */
export const REDUCING: readonly string[] = ['RECOVERY', 'REPAYMENT', 'WAIVER'];

const ym = (year: number, month: number) => year * 12 + (month - 1);
export const ymLabel = (year: number, month: number) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${year}`;

// ─── Plan a new loan ─────────────────────────────────────────────────────────

export interface LoanPlanInput { principal: number; interestRate?: number | null; instalments?: number | null; emiAmount?: number | null }
export interface LoanPlan { interestAmount: number; totalRepayable: number; emiAmount: number; instalments: number }

/**
 * EMI from a number of instalments, or the number of instalments from an EMI.
 * Interest (optional) is flat: principal × rate% × months / 12, added to the
 * amount recovered. With an EMI given, the tenure is first worked out on the
 * principal, interest added for that tenure, then the tenure recomputed on the
 * total (it may grow by an instalment).
 */
export function planLoan(input: LoanPlanInput): LoanPlan {
  const principal = round2(num(input.principal));
  if (!(principal > 0)) throw new Error('Principal must be more than zero');
  const rate = input.interestRate != null && Number(input.interestRate) > 0 ? Number(input.interestRate) : 0;
  if (rate > 60) throw new Error('Interest rate looks wrong (more than 60% a year)');
  const flat = (months: number) => round2(principal * rate / 100 * months / 12);
  if (input.instalments != null && Number(input.instalments) > 0) {
    const n = Math.floor(Number(input.instalments));
    if (n > 360) throw new Error('At most 360 instalments');
    const interestAmount = flat(n);
    const totalRepayable = round2(principal + interestAmount);
    // Round the EMI up to the paisa so n EMIs always cover the total; the last
    // one is capped at the balance anyway.
    const emiAmount = Math.ceil(totalRepayable / n * 100) / 100;
    return { interestAmount, totalRepayable, emiAmount, instalments: n };
  }
  const emi = round2(num(input.emiAmount));
  if (!(emi > 0)) throw new Error('Give either the number of instalments or the EMI amount');
  if (emi > principal + flat(360)) throw new Error('EMI is more than the amount to recover');
  const n0 = Math.ceil(principal / emi);
  const interestAmount = flat(n0);
  const totalRepayable = round2(principal + interestAmount);
  const instalments = Math.ceil(round2(totalRepayable / emi));
  if (instalments > 360) throw new Error('That EMI would take more than 360 months to recover the loan');
  return { interestAmount, totalRepayable, emiAmount: emi, instalments };
}

// ─── Balances ────────────────────────────────────────────────────────────────

export interface LedgerEntryLike {
  id?: string; type: string; amount: number | string | any; month: number; year: number;
  payslipId?: string | null; entryDate?: Date | string | null; createdAt?: Date | string | null;
  /** Status of the linked payslip, when known (DRAFT recoveries are "pending") */
  payslipStatus?: string | null;
}
export interface LoanLike {
  id: string; name: string; type?: string; principal: number | any; totalRepayable: number | any; emiAmount: number | any; instalments: number;
  startMonth: number; startYear: number; status: string; createdAt?: Date | string | null; disbursedOn?: Date | string | null;
}

export function reducedBy(entries: LedgerEntryLike[], filter: (e: LedgerEntryLike) => boolean = () => true) {
  return round2(entries.filter(e => REDUCING.includes(e.type) && filter(e)).reduce((s, e) => s + num(e.amount), 0));
}
export const outstandingOf = (loan: LoanLike, entries: LedgerEntryLike[], filter?: (e: LedgerEntryLike) => boolean) => round2(Math.max(0, num(loan.totalRepayable) - reducedBy(entries, filter)));

/** Summary figures for lists: recovered (issued), pending in draft runs, waived, outstanding. */
export function loanFigures(loan: LoanLike, entries: LedgerEntryLike[]) {
  const pending = reducedBy(entries, e => e.type === 'RECOVERY' && e.payslipStatus === 'DRAFT');
  const waived = reducedBy(entries, e => e.type === 'WAIVER');
  const recovered = round2(reducedBy(entries, e => e.type !== 'WAIVER') - pending);
  const emisRecovered = entries.filter(e => e.type === 'RECOVERY' && num(e.amount) > 0 && e.payslipStatus !== 'DRAFT').length;
  return { recovered, pending, waived, outstanding: outstandingOf(loan, entries), emisRecovered };
}

const entryOrder = (e: LedgerEntryLike) => [ym(e.year, e.month), new Date((e.entryDate ?? e.createdAt ?? 0) as any).getTime()] as const;
/** Ledger in order with a running balance (the stored balanceAfter is a snapshot; this one is always consistent). */
export function ledgerWithBalances<T extends LedgerEntryLike>(loan: LoanLike, entries: T[]): (T & { balance: number })[] {
  const sorted = entries.slice().sort((a, b) => { const x = entryOrder(a), y = entryOrder(b); return x[0] - y[0] || x[1] - y[1]; });
  let bal = num(loan.totalRepayable);
  return sorted.map(e => { if (REDUCING.includes(e.type)) bal = round2(bal - num(e.amount)); return { ...e, balance: Math.max(0, bal) }; });
}

/** Months still to recover: EMI per month from the later of the start month and next month after the last entry, skipping SKIP months. */
export function projectSchedule(loan: LoanLike, entries: LedgerEntryLike[], from: { year: number; month: number }, limit = 120) {
  const out: { year: number; month: number; amount: number; balanceAfter: number }[] = [];
  if (loan.status !== 'ACTIVE') return out;
  let bal = outstandingOf(loan, entries);
  const emi = num(loan.emiAmount);
  if (!(emi > 0)) return out;
  const recoveredMonths = new Set(entries.filter(e => e.type === 'RECOVERY' && num(e.amount) > 0).map(e => ym(e.year, e.month)));
  const skipped = new Set(entries.filter(e => e.type === 'SKIP').map(e => ym(e.year, e.month)));
  let k = Math.max(ym(loan.startYear, loan.startMonth), ym(from.year, from.month));
  while (bal > 0.004 && out.length < limit) {
    if (!skipped.has(k) && !recoveredMonths.has(k)) {
      const amount = round2(Math.min(emi, bal));
      bal = round2(bal - amount);
      out.push({ year: Math.floor(k / 12), month: (k % 12) + 1, amount, balanceAfter: bal });
    }
    k++;
  }
  return out;
}

// ─── Payroll: recoveries for one payslip ─────────────────────────────────────

export interface LoanRecoveryInput {
  loan: LoanLike;
  /** Every ledger entry of the loan EXCEPT the ones on the payslip being computed */
  otherEntries: LedgerEntryLike[];
}
export interface LoanRecovery {
  loanId: string; name: string; amount: number; due: number; outstandingBefore: number; balanceAfter: number;
  emiNumber: number; instalments: number; shortfall: number; label: string;
}

const typeWord = (t?: string) => (t === 'ADVANCE' ? 'Advance recovery' : 'Loan recovery');
export function emiLabel(n: number, of: number) { return n <= of ? `EMI ${n} of ${of}` : `EMI ${n}, extended`; }
export function recoveryLineName(loan: { name: string; type?: string }, n: number, of: number) { return `${typeWord(loan.type)} — ${loan.name} (${emiLabel(n, of)})`; }

/**
 * Which loans recover how much on a payslip for (year, month).
 * `netBeforeLoans` is net pay after every other deduction.
 */
export function computeLoanRecoveries(input: { year: number; month: number; netBeforeLoans: number; loans: LoanRecoveryInput[] }) {
  const period = ym(input.year, input.month);
  let available = round2(Math.max(0, input.netBeforeLoans));
  const recoveries: LoanRecovery[] = [];
  const warnings: string[] = [];
  const ordered = input.loans.slice().sort((a, b) =>
    ym(a.loan.startYear, a.loan.startMonth) - ym(b.loan.startYear, b.loan.startMonth)
    || new Date((a.loan.createdAt ?? 0) as any).getTime() - new Date((b.loan.createdAt ?? 0) as any).getTime());
  for (const { loan, otherEntries } of ordered) {
    if (loan.status === 'CANCELLED') continue;
    if (period < ym(loan.startYear, loan.startMonth)) continue;
    // Paused for this month
    if (otherEntries.some(e => e.type === 'SKIP' && ym(e.year, e.month) === period)) continue;
    // Another payslip (an earlier weekly run of the same month) already recovered it
    if (otherEntries.some(e => e.type === 'RECOVERY' && num(e.amount) > 0 && ym(e.year, e.month) === period)) continue;
    const outstanding = outstandingOf(loan, otherEntries);
    if (outstanding <= 0) continue;
    const due = round2(Math.min(num(loan.emiAmount), outstanding));
    const amount = round2(Math.min(due, available));
    const shortfall = round2(due - amount);
    available = round2(available - amount);
    const emiNumber = otherEntries.filter(e => e.type === 'RECOVERY' && num(e.amount) > 0 && ym(e.year, e.month) < period).length + 1;
    if (shortfall > 0) warnings.push(`${loan.name}: only ${amount.toFixed(2)} of the ${due.toFixed(2)} EMI could be recovered without making net pay negative — the rest stays in the loan balance.`);
    if (amount <= 0) continue;
    recoveries.push({
      loanId: loan.id, name: loan.name, amount, due, outstandingBefore: outstanding, balanceAfter: round2(outstanding - amount),
      emiNumber, instalments: loan.instalments, shortfall, label: recoveryLineName(loan, emiNumber, loan.instalments),
    });
  }
  return { recoveries, warnings };
}

/** Recovery lines for a payslip. */
export function recoveryLines(recoveries: LoanRecovery[]): SlipLine[] {
  return recoveries.map((r, i) => ({
    code: loanCode(r.loanId), name: r.label, category: 'DEDUCTION', amount: r.amount,
    basis: r.shortfall > 0 ? `EMI ${r.due.toFixed(2)}, capped to keep net pay ≥ 0` : r.amount < r.due ? 'final EMI (balance)' : `EMI · balance after ${r.balanceAfter.toFixed(2)}`,
    showOnPayslip: true, displayOrder: LOAN_LINE_ORDER + i,
  }));
}

/**
 * Ledger rows for a payslip's FINAL lines (after manual adjustments): one
 * RECOVERY per loan line with an amount. `outstandingBefore` comes from the
 * computation (balance excluding this payslip's own earlier recoveries).
 */
export function recoveryEntriesFromLines(lines: SlipLine[], ctx: { orgId: string; year: number; month: number; payrollRunId: string; outstandingBefore: Record<string, number>; note?: Record<string, string> }) {
  const rows: { orgId: string; loanId: string; type: 'RECOVERY'; amount: number; month: number; year: number; payrollRunId: string; balanceAfter: number | null; note: string | null }[] = [];
  for (const l of lines) {
    const loanId = loanIdOf(l.code);
    if (!loanId || !(l.amount > 0)) continue;
    const before = ctx.outstandingBefore[loanId];
    rows.push({
      orgId: ctx.orgId, loanId, type: 'RECOVERY', amount: round2(l.amount), month: ctx.month, year: ctx.year, payrollRunId: ctx.payrollRunId,
      balanceAfter: before != null ? round2(Math.max(0, before - l.amount)) : null, note: ctx.note?.[loanId] ?? (l.adjusted ? 'adjusted in run review' : null),
    });
  }
  return rows;
}

/** Totals after appending loan lines to a computed payslip. */
export function withLoanLines(base: { lines: SlipLine[]; totals: { earnings: number; deductions: number; reimbursements: number; employer: number; net: number } }, loanLines: SlipLine[]) {
  if (!loanLines.length) return base;
  const extra = round2(loanLines.reduce((s, l) => s + l.amount, 0));
  return {
    lines: [...base.lines.filter(l => !isLoanCode(l.code)), ...loanLines],
    totals: { ...base.totals, deductions: round2(base.totals.deductions + extra), net: round2(base.totals.net - extra) },
  };
}

// ─── Payslip summary ("Loans & advances" block) ──────────────────────────────

export interface LoanSummaryRow { loanId: string; name: string; type: string; principal: number; totalRepayable: number; recoveredThisPeriod: number; totalRecovered: number; outstanding: number; emiLabel: string | null }

/**
 * The block printed on a payslip for (year, month): every loan with a
 * recovery on this payslip, plus the employee's other active loans with a
 * balance (e.g. paused this month). Figures are as of this payslip — later
 * months' entries and other drafts don't leak into an older payslip.
 */
export function payslipLoanSummary(input: {
  payslipId: string; year: number; month: number; lines: { code: string; amount: number | any; name?: string }[];
  loans: (LoanLike & { entries: LedgerEntryLike[] })[];
  disbursedBy?: Date | null;
}): LoanSummaryRow[] {
  const period = ym(input.year, input.month);
  const rows: LoanSummaryRow[] = [];
  for (const loan of input.loans) {
    const thisLine = input.lines.find(l => loanIdOf(l.code) === loan.id);
    const thisAmount = thisLine ? round2(num(thisLine.amount)) : 0;
    const asOf = (e: LedgerEntryLike) => e.payslipId === input.payslipId ? false
      : ym(e.year, e.month) <= period && (e.type !== 'RECOVERY' || e.payslipStatus !== 'DRAFT');
    const priorEntries = loan.entries.filter(asOf);
    const totalRecovered = round2(reducedBy(priorEntries, e => e.type !== 'WAIVER') + thisAmount);
    const outstanding = round2(Math.max(0, num(loan.totalRepayable) - reducedBy(priorEntries) - thisAmount));
    const started = loan.disbursedOn ? new Date(loan.disbursedOn as any) <= (input.disbursedBy ?? new Date(8.64e15)) : true;
    if (!thisAmount && !(loan.status === 'ACTIVE' && outstanding > 0 && started)) continue;
    const n = priorEntries.filter(e => e.type === 'RECOVERY' && num(e.amount) > 0 && ym(e.year, e.month) < period).length + 1;
    rows.push({
      loanId: loan.id, name: loan.name, type: loan.type ?? 'LOAN', principal: round2(num(loan.principal)), totalRepayable: round2(num(loan.totalRepayable)),
      recoveredThisPeriod: thisAmount, totalRecovered, outstanding, emiLabel: thisAmount ? emiLabel(n, loan.instalments) : null,
    });
  }
  return rows;
}
