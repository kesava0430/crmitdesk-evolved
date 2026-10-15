/**
 * Employee loans / salary advances (utils/payrollLoans.ts) and the payslip
 * pieces that print them (utils/payslipRender.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planLoan, computeLoanRecoveries, recoveryLines, withLoanLines, recoveryEntriesFromLines, outstandingOf, loanFigures,
  ledgerWithBalances, projectSchedule, payslipLoanSummary, isLoanCode, loanCode, loanIdOf, emiLabel,
  type LoanLike, type LedgerEntryLike,
} from '../../src/utils/payrollLoans';
import { applyAdjustments, totalsOfLines } from '../../src/utils/payrollRevision';
import { amountInWords, amountText, samplePayslipDoc, renderPayslipHtml, renderPayslipPdf, buildPayslipDoc, LAYOUTS } from '../../src/utils/payslipRender';

const loan = (o: Partial<LoanLike> = {}): LoanLike => ({
  id: 'cl1', name: 'Laptop loan', type: 'LOAN', principal: 50000, totalRepayable: 50000, emiAmount: 5000, instalments: 10,
  startMonth: 8, startYear: 2026, status: 'ACTIVE', createdAt: '2026-07-01', ...o,
});
const rec = (month: number, amount: number, payslipId = `ps-${month}`, year = 2026): LedgerEntryLike => ({ type: 'RECOVERY', amount, month, year, payslipId });

// ─── Planning ────────────────────────────────────────────────────────────────

test('planLoan: EMI from instalments (no interest), rounded up so N EMIs cover the loan', () => {
  assert.deepEqual(planLoan({ principal: 50000, instalments: 10 }), { interestAmount: 0, totalRepayable: 50000, emiAmount: 5000, instalments: 10 });
  const p = planLoan({ principal: 10000, instalments: 3 });
  assert.equal(p.emiAmount, 3333.34);
  assert.ok(p.emiAmount * 3 >= p.totalRepayable);
});

test('planLoan: instalments from EMI; optional flat interest is clearly added', () => {
  assert.deepEqual(planLoan({ principal: 20000, emiAmount: 6000 }), { interestAmount: 0, totalRepayable: 20000, emiAmount: 6000, instalments: 4 });
  // 12% a year flat on 1,20,000 for 12 months = 14,400
  const p = planLoan({ principal: 120000, interestRate: 12, instalments: 12 });
  assert.equal(p.interestAmount, 14400);
  assert.equal(p.totalRepayable, 134400);
  assert.equal(p.emiAmount, 11200);
  assert.throws(() => planLoan({ principal: 0, instalments: 2 }));
  assert.throws(() => planLoan({ principal: 1000 }));
});

// ─── Recovery rules ──────────────────────────────────────────────────────────

test('recovery starts at the start month and labels the EMI number', () => {
  const before = computeLoanRecoveries({ year: 2026, month: 7, netBeforeLoans: 40000, loans: [{ loan: loan(), otherEntries: [] }] });
  assert.equal(before.recoveries.length, 0, 'nothing before the start month');
  const r = computeLoanRecoveries({ year: 2026, month: 10, netBeforeLoans: 40000, loans: [{ loan: loan(), otherEntries: [rec(8, 5000), rec(9, 5000)] }] });
  assert.equal(r.recoveries[0].amount, 5000);
  assert.equal(r.recoveries[0].emiNumber, 3);
  assert.equal(r.recoveries[0].label, 'Loan recovery — Laptop loan (EMI 3 of 10)');
  assert.equal(r.recoveries[0].balanceAfter, 35000);
});

test('the last EMI is capped at the outstanding balance; a fully recovered loan deducts nothing', () => {
  const entries = [8, 9, 10, 11, 12].map(m => rec(m, 9000));
  const r = computeLoanRecoveries({ year: 2027, month: 1, netBeforeLoans: 40000, loans: [{ loan: loan({ emiAmount: 9000, instalments: 6 }), otherEntries: entries }] });
  assert.equal(r.recoveries[0].amount, 5000);
  assert.equal(r.recoveries[0].balanceAfter, 0);
  const done = computeLoanRecoveries({ year: 2027, month: 2, netBeforeLoans: 40000, loans: [{ loan: loan(), otherEntries: [...entries, rec(1, 5000, 'x', 2027)] }] });
  assert.equal(done.recoveries.length, 0);
});

test('net pay never goes negative: recovery is capped, the shortfall stays in the balance and is flagged', () => {
  const r = computeLoanRecoveries({ year: 2026, month: 9, netBeforeLoans: 3200, loans: [{ loan: loan(), otherEntries: [] }] });
  assert.equal(r.recoveries[0].amount, 3200);
  assert.equal(r.recoveries[0].shortfall, 1800);
  assert.equal(r.recoveries[0].balanceAfter, 46800);
  assert.equal(r.warnings.length, 1);
  // Two loans: the oldest takes what is available first; nothing left → no line for the second, but a warning
  const r2 = computeLoanRecoveries({ year: 2026, month: 9, netBeforeLoans: 4000, loans: [
    { loan: loan({ id: 'cl2', name: 'Advance', startMonth: 9, createdAt: '2026-08-20' }), otherEntries: [] },
    { loan: loan(), otherEntries: [] },
  ] });
  assert.deepEqual(r2.recoveries.map(x => [x.loanId, x.amount]), [['cl1', 4000]]);
  assert.equal(r2.warnings.length, 2);
  // Negative net before loans (other deductions already exceed pay): nothing recovered
  assert.equal(computeLoanRecoveries({ year: 2026, month: 9, netBeforeLoans: -500, loans: [{ loan: loan(), otherEntries: [] }] }).recoveries.length, 0);
  // The payslip net after loans is exactly 0, never below
  const base = { lines: [{ code: 'BASIC', name: 'Basic', category: 'EARNING', amount: 3200 }], totals: { earnings: 3200, deductions: 0, reimbursements: 0, employer: 0, net: 3200 } };
  assert.equal(withLoanLines(base, recoveryLines(r.recoveries)).totals.net, 0);
});

test('a paused month (SKIP) and an earlier run in the same month (weekly cycle) deduct nothing', () => {
  const skip: LedgerEntryLike = { type: 'SKIP', amount: 0, month: 9, year: 2026 };
  assert.equal(computeLoanRecoveries({ year: 2026, month: 9, netBeforeLoans: 40000, loans: [{ loan: loan(), otherEntries: [rec(8, 5000), skip] }] }).recoveries.length, 0);
  assert.equal(computeLoanRecoveries({ year: 2026, month: 9, netBeforeLoans: 40000, loans: [{ loan: loan(), otherEntries: [rec(8, 5000), rec(9, 5000, 'week-1')] }] }).recoveries.length, 0);
  // The month after a pause recovers as EMI 2 — the schedule just runs a month longer
  const r = computeLoanRecoveries({ year: 2026, month: 10, netBeforeLoans: 40000, loans: [{ loan: loan(), otherEntries: [rec(8, 5000), skip] }] });
  assert.equal(r.recoveries[0].emiNumber, 2);
  // Cancelled loans never recover
  assert.equal(computeLoanRecoveries({ year: 2026, month: 9, netBeforeLoans: 40000, loans: [{ loan: loan({ status: 'CANCELLED' }), otherEntries: [] }] }).recoveries.length, 0);
});

test('a lump-sum repayment lowers the balance and the final EMI', () => {
  const entries: LedgerEntryLike[] = [rec(8, 5000), { type: 'REPAYMENT', amount: 42000, month: 9, year: 2026 }];
  assert.equal(outstandingOf(loan(), entries), 3000);
  const r = computeLoanRecoveries({ year: 2026, month: 10, netBeforeLoans: 40000, loans: [{ loan: loan(), otherEntries: entries }] });
  assert.equal(r.recoveries[0].amount, 3000);
});

// ─── Rerun idempotency / revisions ───────────────────────────────────────────

/** Simulates the controller: compute ignoring this payslip's own rows, then replace them. */
function rerun(ledger: LedgerEntryLike[], payslipId: string, month: number, net: number, adjustments: { code: string; amount: number }[] = []) {
  const others = ledger.filter(e => e.payslipId !== payslipId);
  const r = computeLoanRecoveries({ year: 2026, month, netBeforeLoans: net, loans: [{ loan: loan(), otherEntries: others }] });
  const base = { lines: [{ code: 'BASIC', name: 'Basic', category: 'EARNING', amount: net }], totals: { earnings: net, deductions: 0, reimbursements: 0, employer: 0, net } };
  let { lines } = withLoanLines(base, recoveryLines(r.recoveries));
  if (adjustments.length) lines = applyAdjustments(lines, adjustments).lines;
  const before = Object.fromEntries(r.recoveries.map(x => [x.loanId, x.outstandingBefore]));
  const rows = recoveryEntriesFromLines(lines, { orgId: 'o', year: 2026, month, payrollRunId: 'run', outstandingBefore: before });
  return { ledger: [...others, ...rows.map(x => ({ ...x, payslipId }))], lines };
}

test('rerunning a draft never double-deducts (ledger rows are replaced, not added)', () => {
  let ledger: LedgerEntryLike[] = [rec(8, 5000)];
  for (let i = 0; i < 4; i++) ledger = rerun(ledger, 'ps-sep', 9, 40000).ledger;
  assert.equal(ledger.filter(e => e.payslipId === 'ps-sep').length, 1);
  assert.equal(outstandingOf(loan(), ledger), 40000);
  // A discarded draft takes its rows with it (FK cascade): the balance is back
  assert.equal(outstandingOf(loan(), ledger.filter(e => e.payslipId !== 'ps-sep')), 45000);
});

test('revising an issued run adjusts its recovery consistently (and a later month sees the new balance)', () => {
  let ledger: LedgerEntryLike[] = [rec(8, 5000)];
  ledger = rerun(ledger, 'ps-sep', 9, 40000).ledger;          // issued: 5,000
  ledger = rerun(ledger, 'ps-oct', 10, 40000).ledger;          // next month: EMI 3
  // September reopened: salary was lower, only 2,000 could be recovered
  ledger = rerun(ledger, 'ps-sep', 9, 2000).ledger;
  assert.equal(ledger.find(e => e.payslipId === 'ps-sep')!.amount, 2000);
  assert.equal(outstandingOf(loan(), ledger), 38000);
  // A manual adjustment in review (kept across reruns) drives the ledger row
  const adj = rerun(ledger, 'ps-sep', 9, 40000, [{ code: loanCode('cl1'), amount: 1000 }]);
  assert.equal(adj.ledger.find(e => e.payslipId === 'ps-sep')!.amount, 1000);
  assert.equal(totalsOfLines(adj.lines).deductions, 1000);
});

test('ledger view: running balance, figures exclude draft recoveries from "recovered"', () => {
  const entries: LedgerEntryLike[] = [
    { ...rec(8, 5000), payslipStatus: 'PAID' }, { ...rec(9, 5000), payslipStatus: 'DRAFT' },
    { type: 'REPAYMENT', amount: 10000, month: 9, year: 2026, entryDate: '2026-09-15' },
  ];
  const l = ledgerWithBalances(loan(), entries);
  assert.deepEqual(l.map(e => e.balance), [45000, 40000, 30000]);
  const f = loanFigures(loan(), entries);
  assert.deepEqual([f.recovered, f.pending, f.outstanding, f.emisRecovered], [15000, 5000, 30000, 1]);
});

test('projected schedule skips paused and already-recovered months', () => {
  const s = projectSchedule(loan({ totalRepayable: 12000, emiAmount: 5000 }), [rec(8, 5000), { type: 'SKIP', amount: 0, month: 9, year: 2026 }], { year: 2026, month: 8 });
  assert.deepEqual(s.map(x => [x.month, x.amount, x.balanceAfter]), [[10, 5000, 2000], [11, 2000, 0]]);
});

test('payslip summary is "as of" the payslip: later months and other drafts do not leak in', () => {
  const entries: LedgerEntryLike[] = [
    { ...rec(8, 5000), payslipStatus: 'PAID' }, { ...rec(9, 5000, 'this'), payslipStatus: 'GENERATED' },
    { ...rec(10, 5000), payslipStatus: 'DRAFT' }, { type: 'SKIP', amount: 0, month: 11, year: 2026 },
  ];
  const rows = payslipLoanSummary({ payslipId: 'this', year: 2026, month: 9, lines: [{ code: loanCode('cl1'), amount: 5000 }], loans: [{ ...loan(), entries }] });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].recoveredThisPeriod, rows[0].totalRecovered, rows[0].outstanding, rows[0].emiLabel], [5000, 10000, 40000, 'EMI 2 of 10']);
  // A month the loan was paused still lists the active loan (no EMI this month)
  const paused = payslipLoanSummary({ payslipId: 'nov', year: 2026, month: 11, lines: [], loans: [{ ...loan(), entries }] });
  assert.equal(paused[0].recoveredThisPeriod, 0);
  assert.equal(paused[0].emiLabel, null);
});

test('loan line codes never collide with component codes', () => {
  assert.ok(isLoanCode(loanCode('cmv8abc123')));
  assert.equal(loanIdOf(loanCode('cmv8abc123')), 'cmv8abc123');
  assert.ok(!isLoanCode('LOAN_RECOVERY'), 'an org component called LOAN_RECOVERY is a component');
  assert.ok(!isLoanCode('BASIC'));
  assert.equal(emiLabel(11, 10), 'EMI 11, extended');
});

// ─── Amount in words + rendering ─────────────────────────────────────────────

test('amount in words uses Indian numbering for INR and paise', () => {
  assert.equal(amountInWords(131781.75, 'INR'), 'Rupees One Lakh Thirty One Thousand Seven Hundred Eighty One and Seventy Five Paise Only');
  assert.equal(amountInWords(12500000, 'INR'), 'Rupees One Crore Twenty Five Lakh Only');
  assert.equal(amountInWords(0, 'INR'), 'Rupees Zero Only');
  assert.equal(amountInWords(1250000, 'USD'), 'Dollars One Million Two Hundred Fifty Thousand Only');
  assert.equal(amountText(131781.75, 'en-IN'), '1,31,781.75');
});

test('payslip HTML shows loan lines under deductions and the Loans & advances summary; nothing when there are no loans', async () => {
  const org = { name: 'Zenkara', currency: 'INR' };
  const html = renderPayslipHtml(samplePayslipDoc({ layout: 'STANDARD' }, org));
  assert.match(html, /Loan recovery — Laptop loan \(EMI 3 of 10\)/);
  assert.match(html, /Loans &amp; advances/);
  assert.match(html, /35,000\.00/);
  assert.match(html, /Amount \(₹\)/);
  const doc = samplePayslipDoc({ layout: 'MODERN' }, org);
  doc.loans = [];
  assert.ok(!renderPayslipHtml(doc).includes('Loans &amp; advances'));
  // Every layout still renders a one-page PDF for typical data
  for (const l of LAYOUTS) {
    const buf = await renderPayslipPdf(samplePayslipDoc({ layout: l.key }, org));
    assert.equal((buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, 1, `${l.key} fits one page`);
  }
});

test('a long payslip breaks across pages without blank pages', async () => {
  const lines = Array.from({ length: 70 }, (_, i) => ({ code: `E${i}`, name: `Allowance number ${i} with a fairly long descriptive name that wraps`, category: i % 2 ? 'DEDUCTION' : 'EARNING', amount: 1000 + i, displayOrder: i, showOnPayslip: true }));
  const p = { payslipNumber: 'PAY-1', month: 9, year: 2026, status: 'GENERATED', createdAt: new Date(), lines, totalEarnings: 1, totalDeductions: 1, netPay: 1, user: { name: 'X' } };
  const buf = await renderPayslipPdf(buildPayslipDoc({ payslip: p, template: { layout: 'STANDARD' }, employee: null, org: { name: 'Z', currency: 'INR' } }));
  const pages = (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages >= 2 && pages <= 3, `got ${pages} pages`);
});
