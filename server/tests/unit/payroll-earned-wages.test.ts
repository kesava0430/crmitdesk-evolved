/**
 * FIX — statutory deductions on earned wages; net pay never negative.
 *
 * With loss of pay shown as a deduction line, PF / ESI / PT (and percentage
 * deductions) were computed on the FULL salary. Someone on LOP for the whole
 * period (salary effective before joining) got Gross 56,000 − LOP 56,000 −
 * PF 591.38 − PT 65.71 = net −657.09. Now: wage-based deductions use earned
 * wages, net pay is floored at 0 and any uncovered remainder is reported as
 * `unrecovered` (payslip + run review), and loan EMIs only recover what the
 * pay can cover.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePayslip, DEFAULT_COMPONENTS, netAndUnrecovered, type ComponentDef, type PeriodInputs } from '../../src/utils/payrollEngine';
import { totalsOfLines } from '../../src/utils/payrollRevision';
import { computeLoanRecoveries } from '../../src/utils/payrollLoans';

const OFF = ['CONVEYANCE', 'SPECIAL', 'OVERTIME', 'INCENTIVE', 'ESI_EMP', 'TDS', 'REIMB', 'ESI_EMPLOYER'];
const comps = (extra: Partial<Record<string, Partial<ComponentDef>>> = {}): ComponentDef[] =>
  DEFAULT_COMPONENTS.map(c => ({ ...c, isActive: !OFF.includes(c.code), ...(extra[c.code] ?? {}) } as ComponentDef));
const period = (o: Partial<PeriodInputs>): PeriodInputs => ({ daysInPeriod: 30, workingDays: 22, presentDays: 22, paidDays: 22, leaveDays: 0, lopDays: 0, halfDays: 0, overtimeHours: 0, periodFraction: 1, ...o });
const amt = (r: ReturnType<typeof computePayslip>, code: string) => r.lines.find(l => l.code === code)?.amount;
const ctx = { userId: 'u1' };

test('normal month (no LOP) is unchanged: PF on capped basic, PT slab on full gross', () => {
  const r = computePayslip(comps(), { BASIC: { amount: 20000 } }, ctx, period({}));
  assert.equal(amt(r, 'HRA'), 8000);
  assert.equal(amt(r, 'PF_EMP'), 1800);          // 12% of min(20000, 15000)
  assert.equal(amt(r, 'PT'), 200);
  assert.equal(amt(r, 'LOP'), 0);
  assert.equal(r.totals.net, 26000);
  assert.equal(r.totals.unrecovered, 0);
});

test('the regression case: whole period on LOP → statutory 0, net 0 (was −657.09)', () => {
  // 10-day custom cycle, 8 working days, all 8 LOP (salary effective before joining)
  const r = computePayslip(comps(), { BASIC: { amount: 40000 } }, ctx, period({ daysInPeriod: 10, workingDays: 8, presentDays: 0, paidDays: 0, lopDays: 8, periodFraction: 0.3285 }));
  assert.equal(amt(r, 'LOP'), 56000);
  assert.equal(amt(r, 'PF_EMP'), 0);
  assert.equal(amt(r, 'PT'), 0);
  assert.equal(amt(r, 'PF_EMPLOYER'), 0);
  assert.equal(r.totals.net, 0);
  assert.equal(r.totals.unrecovered, 0);
  assert.ok(r.totals.net >= 0);
});

test('partial LOP: PF and PT follow earned wages', () => {
  // half the working days on LOP: earned basic 10000, earned gross 14000
  const r = computePayslip(comps(), { BASIC: { amount: 20000 } }, ctx, period({ presentDays: 11, paidDays: 11, lopDays: 11 }));
  assert.equal(amt(r, 'LOP'), 14000);
  assert.equal(amt(r, 'PF_EMP'), 1200);          // 12% of earned 10000 (was 1800 on full basic)
  assert.equal(amt(r, 'PT'), 0);                 // earned 14000 ≤ 15000 slab (was 200 on full gross)
  assert.match(r.lines.find(l => l.code === 'PF_EMP')!.basis, /earned, after loss of pay/);
  assert.equal(r.totals.net, 28000 - 14000 - 1200);
});

test('ESI: eligibility on full gross, contribution on earned gross', () => {
  const r = computePayslip(comps({ ESI_EMP: { isActive: true }, ESI_EMPLOYER: { isActive: true } }), { BASIC: { amount: 12000 } }, ctx, period({ presentDays: 11, paidDays: 11, lopDays: 11 }));
  // gross 16800 ≤ 21000 → eligible; earned 8400 → 0.75% = 63, 3.25% = 273
  assert.equal(amt(r, 'ESI_EMP'), 63);
  assert.equal(amt(r, 'ESI_EMPLOYER'), 273);
});

test('percentage deductions are on earned wages; percentage earnings stay on the full rate', () => {
  const welfare: ComponentDef = { code: 'WELFARE', name: 'Welfare fund', category: 'DEDUCTION', calcType: 'PERCENT', percent: 1, percentOf: 'GROSS_EARNINGS', prorate: false, taxable: false, showOnPayslip: true, displayOrder: 125, isActive: true };
  const r = computePayslip([...comps(), welfare], { BASIC: { amount: 20000 } }, ctx, period({ presentDays: 11, paidDays: 11, lopDays: 11 }));
  assert.equal(amt(r, 'HRA'), 8000);             // earnings shown in full (LOP line deducts)
  assert.equal(amt(r, 'WELFARE'), 140);          // 1% of earned 14000
});

test('proration mode (LOP component off) is unchanged: earnings prorated, statutory on paid amounts', () => {
  const r = computePayslip(comps({ LOP: { isActive: false } }), { BASIC: { amount: 20000 } }, ctx, period({ presentDays: 11, paidDays: 11, lopDays: 11 }));
  assert.equal(amt(r, 'BASIC'), 10000);
  assert.equal(amt(r, 'PF_EMP'), 1200);
  assert.equal(r.totals.net, 14000 - 1200);
});

test('deductions beyond the pay: net floored at 0, remainder unrecovered + warning', () => {
  const r = computePayslip(comps({ TDS: { isActive: true } }), { BASIC: { amount: 40000 }, TDS: { amount: 5000 } }, ctx, period({ presentDays: 0, paidDays: 0, lopDays: 22 }));
  assert.equal(r.totals.net, 0);
  assert.equal(r.totals.unrecovered, 5000);
  assert.ok(r.warnings.some(w => /unrecovered/.test(w)));
  assert.deepEqual(netAndUnrecovered(-12.34), { net: 0, unrecovered: 12.34 });
});

test('totals from payslip lines (review / rerun) use the same floor', () => {
  const t = totalsOfLines([
    { code: 'BASIC', name: 'Basic', category: 'EARNING', amount: 1000 },
    { code: 'TDS', name: 'TDS', category: 'DEDUCTION', amount: 1500 },
  ] as any);
  assert.equal(t.net, 0);
  assert.equal(t.unrecovered, 500);
});

test('a loan EMI that pay cannot cover is not recovered (stays in the balance)', () => {
  const r = computeLoanRecoveries({
    year: 2026, month: 3, netBeforeLoans: 0,
    loans: [{ loan: { id: 'l1', name: 'Laptop', type: 'LOAN', status: 'ACTIVE', totalRepayable: 30000, emiAmount: 5000, startMonth: 3, startYear: 2026 } as any, otherEntries: [] }],
  });
  const rec = r.recoveries.find(x => x.loanId === 'l1');
  assert.ok(!rec || rec.amount === 0);
  assert.ok(r.warnings.some(w => /without making net pay negative/.test(w)));
});
