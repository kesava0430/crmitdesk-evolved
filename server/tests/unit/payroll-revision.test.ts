/**
 * Rerun / reopen / revise payroll — pure rules in utils/payrollRevision.ts:
 * option handling, the rerun plan, the change-summary diff, adjustments,
 * version snapshots, the re-finalise decision, arrears/recovery settlement,
 * run version history and the revised-payslip note.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRerunOptions, planRerun, diffSlip, sortChanges, summariseChanges, applyAdjustments, totalsOfLines,
  snapshotPayslip, slipChanged, figuresOfPayslip, figuresOfRevision, paidBaselines, latestRevision, refinalizeDecision,
  computeSettlement, settlementCsv, runVersionHistory, nextSequence, revisionNoteLines,
  type SlipFigures, type ChangeEntry, type RevisionRow, type RevisionData,
} from '../../src/utils/payrollRevision';
import { samplePayslipDoc, renderPayslipHtml, renderPayslipPdf, LAYOUTS } from '../../src/utils/payslipRender';

const L = (code: string, amount: number, category = 'EARNING', extra: any = {}) => ({ code, name: code, category, amount, ...extra });
function fig(lines: ReturnType<typeof L>[], days: { paid?: number; lop?: number } = {}): SlipFigures {
  const t = totalsOfLines(lines);
  return { gross: t.earnings, deductions: t.deductions, net: t.net, reimbursements: t.reimbursements, employer: t.employer, workingDays: 30, paidDays: days.paid ?? 30, lopDays: days.lop ?? 0, lines };
}
/** A payslip row shaped like Prisma returns it (Decimals as strings are fine). */
function slip(over: any = {}) {
  const lines = over.lines ?? [L('BASIC', 30000), L('HRA', 12000), L('PF_EMP', 1800, 'DEDUCTION'), L('PT', 200, 'DEDUCTION'), L('PF_ER', 1800, 'EMPLOYER_CONTRIBUTION')];
  const t = totalsOfLines(lines);
  return {
    id: 'ps1', userId: 'u1', payslipNumber: 'PAY-2026-09-0001', status: 'GENERATED', paidAt: null, emailedAt: null, templateId: 'tpl1',
    createdAt: new Date('2026-10-01T10:00:00Z'), revisedAt: null, version: 1, paidDifference: null,
    totalEarnings: String(t.earnings), grossPay: String(t.earnings), totalDeductions: String(t.deductions), netPay: String(t.net),
    totalReimbursements: '0', employerContributions: String(t.employer),
    workingDays: '30', paidDays: '30', presentDays: '28', leaveDays: '2', lopDays: '0', halfDays: '0', overtimeHours: '0',
    attendanceSummary: { source: 'attendance', byStatus: { PRESENT: 28 } },
    lines: lines.map((l: any, i: number) => ({ ...l, amount: String(l.amount), basis: 'fixed', showOnPayslip: true, displayOrder: i, adjusted: false })),
    ...over,
  };
}

// ─── Options ─────────────────────────────────────────────────────────────────

test('rerun options default to keep adjustments, include new, keep (not remove) people without salary', () => {
  const o = parseRerunOptions(undefined);
  assert.deepEqual(o, { userIds: null, keepAdjustments: true, includeNewEmployees: true, removeWithoutSalary: false, refreshAttendance: true });
});

test('rerun options: subset is de-duplicated, explicit flags respected, attendance always refreshed', () => {
  const o = parseRerunOptions({ userIds: ['a', 'b', 'a'], keepAdjustments: false, includeNewEmployees: false, removeWithoutSalary: true, refreshAttendance: false });
  assert.deepEqual(o.userIds, ['a', 'b']);
  assert.equal(o.keepAdjustments, false);
  assert.equal(o.includeNewEmployees, false);
  assert.equal(o.removeWithoutSalary, true);
  assert.equal(o.refreshAttendance, true);
});

test('rerun options reject an empty subset and wrong types', () => {
  assert.throws(() => parseRerunOptions({ userIds: [] }));
  assert.throws(() => parseRerunOptions({ keepAdjustments: 'yes' }));
});

// ─── Plan ────────────────────────────────────────────────────────────────────

const salaries = [
  { userId: 'u1', employeeSalaryId: 's1', payrollCycleId: 'c1', userActive: true },
  { userId: 'u2', employeeSalaryId: 's2', payrollCycleId: 'c2', userActive: true },   // moved to another cycle
  { userId: 'u4', employeeSalaryId: 's4', payrollCycleId: 'c1', userActive: true },   // new joiner
  { userId: 'u5', employeeSalaryId: 's5', payrollCycleId: 'c1', userActive: false },  // deactivated
];
const existing = [{ userId: 'u1', payslipId: 'p1' }, { userId: 'u2', payslipId: 'p2' }, { userId: 'u3', payslipId: 'p3' }, { userId: 'u5', payslipId: 'p5' }];

test('plan: rebuild people on the cycle, add new joiners, report the rest with reasons', () => {
  const p = planRerun({ existing, salaries, runCycleId: 'c1', options: { userIds: null, includeNewEmployees: true, removeWithoutSalary: false } });
  assert.deepEqual(p.rebuild, [{ userId: 'u1', payslipId: 'p1', employeeSalaryId: 's1' }]);
  assert.deepEqual(p.add, [{ userId: 'u4', employeeSalaryId: 's4' }]);
  assert.deepEqual(p.remove, []);
  assert.deepEqual(p.skipped.map(s => [s.userId, s.reason]), [
    ['u2', 'Salary is now on another payroll cycle — previous payslip kept'],
    ['u3', 'No active salary — previous payslip kept'],
    ['u5', 'Employee is deactivated — previous payslip kept'],
  ]);
});

test('plan: removeWithoutSalary removes instead of skipping; includeNewEmployees=false adds nobody', () => {
  const p = planRerun({ existing, salaries, runCycleId: 'c1', options: { userIds: null, includeNewEmployees: false, removeWithoutSalary: true } });
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.remove.map(r => r.userId), ['u2', 'u3', 'u5']);
  assert.equal(p.remove[1].reason, 'No active salary');
  assert.deepEqual(p.skipped, []);
});

test('plan: a subset only touches the chosen people and explains ids it could not use', () => {
  const p = planRerun({ existing, salaries, runCycleId: 'c1', options: { userIds: ['u1', 'u4', 'u9'], includeNewEmployees: true, removeWithoutSalary: false } });
  assert.deepEqual(p.rebuild.map(r => r.userId), ['u1']);
  assert.deepEqual(p.add.map(r => r.userId), ['u4']);
  assert.deepEqual(p.skipped, [{ userId: 'u9', payslipId: null, reason: 'Not in this run and no active salary' }]);
  const q = planRerun({ existing, salaries, runCycleId: 'c1', options: { userIds: ['u4'], includeNewEmployees: false, removeWithoutSalary: false } });
  assert.deepEqual(q.add, []);
  assert.match(q.skipped[0].reason, /include new employees/);
});

test('plan: a run whose cycle was deleted behaves like the old recalculate (any salary, nobody added)', () => {
  const p = planRerun({ existing, salaries, runCycleId: null, options: { userIds: null, includeNewEmployees: true, removeWithoutSalary: false } });
  assert.deepEqual(p.rebuild.map(r => r.userId), ['u1', 'u2']);
  assert.deepEqual(p.add, []);
});

// ─── Diff / summary ──────────────────────────────────────────────────────────

test('diff: totals and only the lines that changed, with old/new/delta', () => {
  const before = fig([L('BASIC', 30000), L('HRA', 12000), L('PF_EMP', 1800, 'DEDUCTION')]);
  const after = fig([L('BASIC', 35000), L('HRA', 12000), L('PF_EMP', 1800, 'DEDUCTION'), L('BONUS', 500)], { paid: 29, lop: 1 });
  const d = diffSlip(before, after);
  assert.equal(d.changed, true);
  assert.deepEqual(d.gross, { old: 42000, new: 47500, delta: 5500 });
  assert.deepEqual(d.net, { old: 40200, new: 45700, delta: 5500 });
  assert.deepEqual(d.deductions.delta, 0);
  assert.deepEqual(d.lines.map(l => [l.code, l.old, l.new, l.delta]), [['BASIC', 30000, 35000, 5000], ['BONUS', null, 500, 500]]);
  assert.deepEqual(d.paidDays, { old: 30, new: 29, delta: -1 });
  assert.deepEqual(d.lopDays, { old: 0, new: 1, delta: 1 });
});

test('diff: identical payslips are unchanged; sub-paisa noise is ignored', () => {
  const a = fig([L('BASIC', 30000), L('PT', 200, 'DEDUCTION')]);
  const b = fig([L('BASIC', 30000.001), L('PT', 200, 'DEDUCTION')]);
  const d = diffSlip(a, b);
  assert.equal(d.changed, false);
  assert.deepEqual(d.lines, []);
});

test('diff: added and removed payslips compare against nothing', () => {
  const a = fig([L('BASIC', 10000)]);
  const added = diffSlip(null, a);
  assert.equal(added.changed, true);
  assert.deepEqual(added.net, { old: null, new: 10000, delta: 10000 });
  const removed = diffSlip(a, null);
  assert.deepEqual(removed.net, { old: 10000, new: null, delta: -10000 });
  assert.deepEqual(removed.lines.map(l => [l.code, l.old, l.new]), [['BASIC', 10000, null]]);
});

test('summary: sorted by largest absolute net change, unchanged last; totals add up', () => {
  const e = (name: string, before: number, after: number): ChangeEntry => ({ userId: name, name, payslipId: null, kind: 'UPDATED', diff: diffSlip(fig([L('BASIC', before)]), fig([L('BASIC', after)])) });
  const entries = [e('Asha', 100, 100), e('Bala', 100, 300), e('Chen', 500, 100), e('Dev', 100, 150)];
  assert.deepEqual(sortChanges(entries).map(x => x.name), ['Chen', 'Bala', 'Dev', 'Asha']);
  const s = summariseChanges(entries);
  assert.equal(s.changedCount, 3);
  assert.equal(s.unchangedCount, 1);
  assert.equal(s.totals.net, -150);
});

// ─── Adjustments ─────────────────────────────────────────────────────────────

test('adjustments are re-applied on top of fresh lines and totals recomputed; vanished codes reported', () => {
  const fresh = [L('BASIC', 35000), L('HRA', 14000), L('PF_EMP', 1800, 'DEDUCTION'), L('TA', 1000, 'REIMBURSEMENT')];
  const r = applyAdjustments(fresh, [{ code: 'HRA', amount: 10000 }, { code: 'OLD_BONUS', amount: 999 }]);
  assert.equal(r.lines.find(l => l.code === 'HRA')!.amount, 10000);
  assert.equal(r.lines.find(l => l.code === 'HRA')!.adjusted, true);
  assert.equal(fresh[1].amount, 14000, 'input not mutated');
  assert.deepEqual(r.missing, ['OLD_BONUS']);
  assert.equal(r.applied, 1);
  assert.deepEqual(r.totals, { earnings: 45000, deductions: 1800, reimbursements: 1000, employer: 0, net: 44200 });
});

// ─── Snapshot ────────────────────────────────────────────────────────────────

test('snapshot keeps totals, lines, days, attendance, template, status, e-mail and paid info', () => {
  const p = slip({ status: 'PAID', paidAt: new Date('2026-10-05T00:00:00Z'), emailedAt: new Date('2026-10-02T09:00:00Z') });
  const d = snapshotPayslip(p, { version: 1, finalizedAt: new Date('2026-10-01T12:00:00Z'), finalizedBy: 'mgr' });
  assert.equal(d.schema, 1);
  assert.equal(d.runVersion, 1);
  assert.equal(d.issuedAt, '2026-10-01T12:00:00.000Z');
  assert.equal(d.issuedBy, 'mgr');
  assert.equal(d.payslipNumber, 'PAY-2026-09-0001');
  assert.equal(d.status, 'PAID');
  assert.equal(d.paidAt, '2026-10-05T00:00:00.000Z');
  assert.equal(d.emailedAt, '2026-10-02T09:00:00.000Z');
  assert.equal(d.templateId, 'tpl1');
  assert.equal(d.paidNet, 40000);
  assert.deepEqual(d.totals, { gross: 42000, deductions: 2000, net: 40000, reimbursements: 0, employer: 1800 });
  assert.deepEqual(d.days, { working: 30, paid: 30, present: 28, leave: 2, lop: 0, half: 0, overtimeHours: 0 });
  assert.deepEqual(d.attendanceSummary, { source: 'attendance', byStatus: { PRESENT: 28 } });
  assert.equal(d.lines.length, 5);
  assert.deepEqual(Object.keys(d.lines[0]).sort(), ['adjusted', 'amount', 'basis', 'category', 'code', 'displayOrder', 'name', 'showOnPayslip']);
  assert.equal(typeof d.lines[0].amount, 'number');
  // JSON round-trip safe (stored in a JSONB column)
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
});

test('snapshot of an unpaid payslip has no paid net; a revised one is "issued" at its revision time', () => {
  const d = snapshotPayslip(slip({ revisedAt: new Date('2026-10-09T00:00:00Z'), version: 2 }), { version: 2, finalizedAt: new Date('2026-10-09T00:00:00Z'), finalizedBy: null });
  assert.equal(d.paidNet, null);
  assert.equal(d.issuedAt, '2026-10-09T00:00:00.000Z');
  assert.equal(slipChanged(d, figuresOfPayslip(slip())), false);
  assert.equal(slipChanged(d, figuresOfPayslip(slip({ lopDays: '1' }))), true);
});

// ─── Re-finalise decision & settlement ──────────────────────────────────────

const rev = (userId: string, payslipId: string | null, version: number, createdAt: string, data: Partial<RevisionData>): RevisionRow =>
  ({ userId, payslipId, version, createdAt, data: { ...snapshotPayslip(slip({ id: payslipId, userId }), { version: 1, finalizedAt: null }), ...data } as RevisionData });

test('paid baseline = latest PAID revision per person', () => {
  const b = paidBaselines([
    rev('u1', 'p1', 1, '2026-10-01', { status: 'PAID', paidNet: 40000, paidAt: '2026-10-05' }),
    rev('u1', 'p1', 2, '2026-10-10', { status: 'PAID', paidNet: 42000, paidAt: '2026-10-12' }),
    rev('u2', 'p2', 1, '2026-10-01', { status: 'GENERATED', paidNet: null }),
  ]);
  assert.equal(b.size, 1);
  assert.deepEqual(b.get('u1'), { userId: 'u1', payslipId: 'p1', version: 2, paidNet: 42000, paidAt: '2026-10-12' });
});

test('latest revision is found by payslip id, else by person (removed and re-added)', () => {
  const rows = [rev('u1', 'p1', 1, '2026-10-01', {}), rev('u1', 'p1', 2, '2026-10-10', {}), rev('u2', null, 1, '2026-10-01', {})];
  assert.equal(latestRevision(rows, 'p1', 'u1')!.version, 2);
  assert.equal(latestRevision(rows, 'pNEW', 'u2')!.userId, 'u2');
  assert.equal(latestRevision(rows, 'pX', 'u9'), null);
});

test('re-finalise: unchanged payslip is restored as it was (status, paid date, version, template)', () => {
  const prev = snapshotPayslip(slip({ status: 'PAID', paidAt: new Date('2026-10-05T00:00:00Z') }), { version: 1, finalizedAt: null });
  const d = refinalizeDecision(prev, 1, figuresOfPayslip(slip()), { userId: 'u1', payslipId: 'ps1', version: 1, paidNet: 40000, paidAt: prev.paidAt });
  assert.deepEqual(d, { revised: false, version: 1, status: 'PAID', paidAt: '2026-10-05T00:00:00.000Z', paidDifference: null, restoreTemplateId: 'tpl1' });
});

test('re-finalise: changed unpaid payslip → version+1, GENERATED, no paid difference', () => {
  const prev = snapshotPayslip(slip(), { version: 1, finalizedAt: null });
  const raised = figuresOfPayslip(slip({ lines: [L('BASIC', 35000), L('HRA', 12000), L('PF_EMP', 1800, 'DEDUCTION'), L('PT', 200, 'DEDUCTION')] }));
  const d = refinalizeDecision(prev, 1, raised, null);
  assert.deepEqual(d, { revised: true, version: 2, status: 'GENERATED', paidAt: null, paidDifference: null, restoreTemplateId: 'tpl1' });
});

test('re-finalise: changed paid payslip → arrears / recovery vs the paid net, or PAID when the net is the same', () => {
  const prev = snapshotPayslip(slip({ status: 'PAID', paidAt: new Date('2026-10-05T00:00:00Z') }), { version: 1, finalizedAt: null });
  const base = { userId: 'u1', payslipId: 'ps1', version: 1, paidNet: 40000, paidAt: '2026-10-05T00:00:00.000Z' };
  const mk = (basic: number, hra = 12000) => figuresOfPayslip(slip({ lines: [L('BASIC', basic), L('HRA', hra), L('PF_EMP', 1800, 'DEDUCTION'), L('PT', 200, 'DEDUCTION')] }));
  const up = refinalizeDecision(prev, 1, mk(32500), base);
  assert.equal(up.status, 'GENERATED'); assert.equal(up.paidDifference, 2500); assert.equal(up.version, 2);
  const down = refinalizeDecision(prev, 1, mk(29000), base);
  assert.equal(down.paidDifference, -1000);
  // Lines moved around but the net is what was paid: nothing to settle.
  const same = refinalizeDecision(prev, 1, mk(31000, 11000), base);
  assert.deepEqual([same.revised, same.status, same.paidDifference, same.paidAt], [true, 'PAID', 0, base.paidAt]);
});

test('re-finalise: a payslip first added while reopened is a version 1 issue', () => {
  assert.deepEqual(refinalizeDecision(null, null, fig([L('BASIC', 1)]), null), { revised: false, version: 1, status: 'GENERATED', paidAt: null, paidDifference: null, restoreTemplateId: null });
});

test('settlement: arrears, recovery, unchanged, not paid before, removed — with totals and settled state', () => {
  const baselines = paidBaselines([
    rev('u1', 'p1', 1, '2026-10-01', { status: 'PAID', paidNet: 40000, paidAt: '2026-10-05T00:00:00.000Z' }),
    rev('u2', 'p2', 1, '2026-10-01', { status: 'PAID', paidNet: 30000, paidAt: '2026-10-05T00:00:00.000Z' }),
    rev('u3', 'p3', 1, '2026-10-01', { status: 'PAID', paidNet: 20000, paidAt: '2026-10-05T00:00:00.000Z' }),
    rev('u5', null, 1, '2026-10-01', { status: 'PAID', paidNet: 15000, paidAt: '2026-10-05T00:00:00.000Z' }),
  ]);
  const current = [
    { userId: 'u1', name: 'Asha', payslipId: 'p1', net: 42500, status: 'GENERATED', paidAt: null },
    { userId: 'u2', name: 'Bala', payslipId: 'p2', net: 29000, status: 'GENERATED', paidAt: null },
    { userId: 'u3', name: 'Chen', payslipId: 'p3', net: 20000, status: 'PAID', paidAt: '2026-10-05T00:00:00.000Z' },
    { userId: 'u4', name: 'Dev', payslipId: 'p4', net: 10000, status: 'GENERATED', paidAt: null },
  ];
  const s = computeSettlement(current, baselines, new Map([['u5', 'Esha']]), 'PROCESSED');
  assert.equal(s.applicable, true);
  assert.deepEqual(s.rows.map(r => [r.name, r.kind, r.difference, r.settled]), [
    ['Esha', 'REMOVED', -15000, false],
    ['Dev', 'NOT_PAID_BEFORE', 10000, false],
    ['Asha', 'ARREARS', 2500, false],
    ['Bala', 'RECOVERY', -1000, false],
    ['Chen', 'NONE', 0, true],
  ]);
  assert.deepEqual(s.totals, { arrears: 12500, recovery: 16000, net: -3500, pendingArrears: 12500, pendingRecovery: 16000, pendingCount: 4 });
  const csv = settlementCsv(s).split('\n');
  assert.equal(csv[0], 'Employee,Paid net,Revised net,Difference,Type,Settled');
  assert.equal(csv[3], 'Asha,40000,42500,2500.00,ARREARS,no');
});

test('settlement: marking paid again after the baseline payment settles the difference', () => {
  const baselines = paidBaselines([rev('u1', 'p1', 1, '2026-10-01', { status: 'PAID', paidNet: 40000, paidAt: '2026-10-05T00:00:00.000Z' })]);
  const s = computeSettlement([{ userId: 'u1', name: 'Asha', payslipId: 'p1', net: 42500, status: 'PAID', paidAt: '2026-10-20T00:00:00.000Z' }], baselines, new Map(), 'PAID');
  assert.equal(s.rows[0].settled, true);
  assert.equal(s.rows[0].settledAt, '2026-10-20T00:00:00.000Z');
  assert.equal(s.totals.pendingCount, 0);
  assert.equal(s.totals.arrears, 2500);
});

test('settlement does not apply to runs that were never paid', () => {
  const s = computeSettlement([{ userId: 'u1', name: 'A', payslipId: 'p1', net: 1, status: 'GENERATED', paidAt: null }], new Map(), new Map(), 'PROCESSED');
  assert.equal(s.applicable, false);
  assert.deepEqual(s.rows, []);
});

// ─── History / misc ──────────────────────────────────────────────────────────

test('version history: one entry per issued version with reopen reason, then the current one', () => {
  const r = (v: number, createdAt: string, by: string, reason: string, status = 'GENERATED') => ({ createdAt, createdBy: by, reason, data: { ...snapshotPayslip(slip({ status }), { version: v, finalizedAt: `2026-10-0${v}T10:00:00Z`, finalizedBy: 'm1' }) } });
  const h = runVersionHistory(
    { version: 3, status: 'DRAFT', finalizedAt: '2026-10-04T10:00:00Z', finalizedBy: 'm2', payslipCount: 4 },
    [r(1, '2026-10-03T00:00:00Z', 'm2', 'Salary hike for Asha'), r(1, '2026-10-03T00:00:01Z', 'm2', 'Salary hike for Asha'), r(2, '2026-10-06T00:00:00Z', 'm1', 'Arrears correction', 'PAID')],
    new Map([['m1', 'Meera'], ['m2', 'Mohan']]),
  );
  assert.deepEqual(h.map(v => [v.version, v.issuedByName, v.reopenedByName, v.reason, v.payslipCount, v.status, v.current]), [
    [1, 'Meera', 'Mohan', 'Salary hike for Asha', 2, 'PROCESSED', false],
    [2, 'Meera', 'Meera', 'Arrears correction', 1, 'PAID', false],
    [3, null, null, null, 4, 'DRAFT', true],
  ]);
  assert.equal(h[0].issuedAt, '2026-10-01T10:00:00.000Z');
});

test('payslip numbers continue from the highest in use (no reuse after deletions)', () => {
  assert.equal(nextSequence(['PAY-2026-09-0001', 'PAY-2026-09-0003', 'PAY-2026-08-0009'], 'PAY-2026-09-'), 4);
  assert.equal(nextSequence([], 'PAY-2026-09-'), 1);
});

test('revised note text: version + superseded date, and the paid difference sign', () => {
  const m = (v: number) => `₹${v.toFixed(2)}`, d = (s: string) => s.slice(0, 10);
  assert.deepEqual(revisionNoteLines(null, m, d), []);
  assert.deepEqual(revisionNoteLines({ version: 1, supersedesIssuedAt: null, paidDifference: null }, m, d), []);
  assert.deepEqual(revisionNoteLines({ version: 2, supersedesIssuedAt: '2026-10-01T10:00:00Z', paidDifference: null }, m, d), ['Revised (v2) — supersedes payslip issued on 2026-10-01']);
  assert.deepEqual(revisionNoteLines({ version: 3, supersedesIssuedAt: null, paidDifference: 2500 }, m, d), ['Revised (v3)', 'Difference vs paid: +₹2500.00 arrears']);
  assert.deepEqual(revisionNoteLines({ version: 3, supersedesIssuedAt: null, paidDifference: -1000 }, m, d)[1], 'Difference vs paid: −₹1000.00 recovery');
  assert.equal(revisionNoteLines({ version: 2, supersedesIssuedAt: null, paidDifference: 0 }, m, d).length, 1);
});

test('every layout renders the revised note in HTML and the PDF still builds; v1 payslips show nothing', async () => {
  for (const l of LAYOUTS) {
    const doc = samplePayslipDoc({ layout: l.key }, { name: 'Zenkara', currency: 'INR' });
    assert.equal(doc.revision, null);
    assert.ok(!renderPayslipHtml(doc).includes('class="rev"'));
    doc.revision = { version: 2, supersedesIssuedAt: '2026-10-01T10:00:00Z', paidDifference: -1250 };
    const html = renderPayslipHtml(doc);
    assert.match(html, /Revised \(v2\) — supersedes payslip issued on 01 Oct 2026/);
    assert.match(html, /Difference vs paid: −₹1,250.00 recovery/);
    const pdf = await renderPayslipPdf(doc);
    assert.ok(pdf.subarray(0, 5).toString() === '%PDF-');
  }
  void figuresOfRevision;
});
