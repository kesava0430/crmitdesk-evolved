/**
 * AI actions — the pure pieces of "run day-to-day work by typing":
 *  - the date parser (org timezone, weekday conventions, DST),
 *  - name → record resolution with ambiguity,
 *  - multi-step references and the stop-on-failure executor,
 *  - the registry: every action's validation, roles, permission engine,
 *    record scope, area switches and risk levels,
 *  - one step's full normalisation (dates + names + scope + preview) with
 *    the record lookups stubbed.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDate, formatInZone, describeToday, zonedToUtc } from '../../src/utils/aiActions/dates';
import { matchName, nameScore, normalizeName } from '../../src/utils/aiActions/resolve';
import { parseRef, collectRefs, checkStepRefs, substituteRefs } from '../../src/utils/aiActions/refs';
import { runSequential } from '../../src/utils/aiActions/executor';
import { ENTITIES, recordAllowed } from '../../src/utils/aiActions/entities';
import { normalizeStep, summarisePlan, refLabel, type NormalizeEnv } from '../../src/utils/aiActions/planner';
import {
  AI_ACTIONS, getAiAction, riskOf, roleBlockedReason, isActionAvailable, actionBlockedReason, actionMenuForPrompt, listActionsForRole, exampleFor,
} from '../../src/utils/ai-actions';
import type { PermCtx, Scope } from '../../src/utils/permissions';

// Sunday 18 Oct 2026, 11:30 in Kolkata (06:00 UTC)
const NOW = new Date('2026-10-18T06:00:00Z');
const IST = { now: NOW, timeZone: 'Asia/Kolkata' };
const ok = (r: ReturnType<typeof resolveDate>) => { assert.ok(r.ok, (r as any).error); return r as Extract<typeof r, { ok: true }>; };

// ─── Dates ───────────────────────────────────────────────────────────────────

test('dates: relative days in the org timezone', () => {
  assert.equal(ok(resolveDate('today', 'date', IST)).value, '2026-10-18');
  assert.equal(ok(resolveDate('tomorrow', 'date', IST)).value, '2026-10-19');
  assert.equal(ok(resolveDate('day after tomorrow', 'date', IST)).value, '2026-10-20');
  assert.equal(ok(resolveDate('yesterday', 'date', IST)).value, '2026-10-17');
  assert.equal(ok(resolveDate('in 3 days', 'date', IST)).value, '2026-10-21');
  assert.equal(ok(resolveDate('in 2 weeks', 'date', IST)).value, '2026-11-01');
  assert.equal(ok(resolveDate('in 14 days', 'date', IST)).value, '2026-11-01');
  // Late evening UTC is already "tomorrow" in Kolkata
  assert.equal(ok(resolveDate('today', 'date', { now: new Date('2026-10-18T20:00:00Z'), timeZone: 'Asia/Kolkata' })).value, '2026-10-19');
});

test('dates: weekday conventions (bare = next after today, this/next/last)', () => {
  // Today is Sunday 18 Oct
  assert.equal(ok(resolveDate('Friday', 'date', IST)).value, '2026-10-23');
  assert.equal(ok(resolveDate('Sunday', 'date', IST)).value, '2026-10-25', 'bare weekday never means today');
  assert.equal(ok(resolveDate('next Monday', 'date', IST)).value, '2026-10-19', 'Monday of next week');
  assert.equal(ok(resolveDate('this friday', 'date', IST)).value, '2026-10-16', 'Friday of the current Mon–Sun week');
  assert.equal(ok(resolveDate('next fri', 'date', IST)).value, '2026-10-23');
  assert.equal(ok(resolveDate('last Wednesday', 'date', IST)).value, '2026-10-14');
  assert.equal(ok(resolveDate('next week', 'date', IST)).value, '2026-10-19');
  assert.equal(ok(resolveDate('end of month', 'date', IST)).value, '2026-10-31');
  // From a Wednesday
  const wed = { now: new Date('2026-10-14T06:00:00Z'), timeZone: 'Asia/Kolkata' };
  assert.equal(ok(resolveDate('Friday', 'date', wed)).value, '2026-10-16');
  assert.equal(ok(resolveDate('next Friday', 'date', wed)).value, '2026-10-23');
  assert.equal(ok(resolveDate('Wednesday', 'date', wed)).value, '2026-10-21');
});

test('dates: explicit dates (ISO, day-first, month names, rolling to next year)', () => {
  assert.equal(ok(resolveDate('2026-11-02', 'date', IST)).value, '2026-11-02');
  assert.equal(ok(resolveDate('23/10/2026', 'date', IST)).value, '2026-10-23');
  assert.equal(ok(resolveDate('5/11', 'date', IST)).value, '2026-11-05');
  assert.equal(ok(resolveDate('1 November', 'date', IST)).value, '2026-11-01');
  assert.equal(ok(resolveDate('Nov 1st', 'date', IST)).value, '2026-11-01');
  assert.equal(ok(resolveDate('October 23, 2026', 'date', IST)).value, '2026-10-23');
  assert.equal(ok(resolveDate('2 Jan', 'date', IST)).value, '2027-01-02', 'a passed date with no year is next year');
  assert.equal(ok(resolveDate('on 23rd of October', 'date', IST)).value, '2026-10-23');
  assert.ok(!resolveDate('31/02/2026', 'date', IST).ok, 'impossible date is refused');
  assert.ok(!resolveDate('whenever suits', 'date', IST).ok);
  assert.ok(!resolveDate('', 'date', IST).ok);
});

test('dates: times of day become UTC instants via the org timezone', () => {
  const r = ok(resolveDate('Friday 11am', 'datetime', IST));
  assert.equal(r.value, '2026-10-23T05:30:00.000Z');
  assert.equal(r.label, 'Fri 23 Oct 2026, 11:00');
  assert.equal(ok(resolveDate('tomorrow at 3pm', 'datetime', IST)).value, '2026-10-19T09:30:00.000Z');
  assert.equal(ok(resolveDate('Monday 10:30 am', 'datetime', IST)).value, '2026-10-19T05:00:00.000Z');
  assert.equal(ok(resolveDate('next monday 14:00', 'datetime', IST)).value, '2026-10-19T08:30:00.000Z');
  assert.equal(ok(resolveDate('tomorrow noon', 'datetime', IST)).value, '2026-10-19T06:30:00.000Z');
  assert.equal(ok(resolveDate('tomorrow evening', 'datetime', IST)).value, '2026-10-19T12:30:00.000Z');
  assert.equal(ok(resolveDate('Saturday 10pm', 'datetime', IST)).value, '2026-10-24T16:30:00.000Z');
  assert.equal(ok(resolveDate('Friday at 3', 'datetime', IST)).value, '2026-10-23T09:30:00.000Z', '"at 3" in business hours is 15:00');
  // No time → 09:00, flagged
  const a = ok(resolveDate('tomorrow', 'datetime', IST));
  assert.equal(a.value, '2026-10-19T03:30:00.000Z');
  assert.equal(a.assumedTime, true);
  // Only a time: today if still ahead, else tomorrow
  assert.equal(ok(resolveDate('at 4pm', 'datetime', IST)).value, '2026-10-18T10:30:00.000Z');
  assert.equal(ok(resolveDate('9am', 'datetime', IST)).value, '2026-10-19T03:30:00.000Z');
  // A date-only kind ignores the time
  assert.equal(ok(resolveDate('Friday 11am', 'date', IST)).value, '2026-10-23');
});

test('dates: ISO inputs — with offset kept, without offset read as org wall-clock; past flagged', () => {
  assert.equal(ok(resolveDate('2026-10-23T05:30:00Z', 'datetime', IST)).value, '2026-10-23T05:30:00.000Z');
  assert.equal(ok(resolveDate('2026-10-23T11:00', 'datetime', IST)).value, '2026-10-23T05:30:00.000Z');
  assert.equal(ok(resolveDate('2026-10-23T05:30:00Z', 'date', IST)).value, '2026-10-23');
  assert.equal(ok(resolveDate('yesterday 10am', 'datetime', IST)).past, true);
  assert.equal(ok(resolveDate('yesterday', 'date', IST)).past, true);
});

test('dates: DST is honoured (America/New_York, clocks go back 1 Nov 2026)', () => {
  const ny = { now: new Date('2026-10-30T14:00:00Z'), timeZone: 'America/New_York' };
  assert.equal(ok(resolveDate('tomorrow 9am', 'datetime', ny)).value, '2026-10-31T13:00:00.000Z'); // EDT, UTC-4
  assert.equal(ok(resolveDate('Monday 9am', 'datetime', ny)).value, '2026-11-02T14:00:00.000Z');  // EST, UTC-5
  assert.equal(zonedToUtc({ y: 2026, m: 3, d: 9 }, { h: 9, min: 0 }, 'America/New_York').toISOString(), '2026-03-09T13:00:00.000Z');
});

test('dates: months for payroll and loans', () => {
  assert.equal(ok(resolveDate('October 2026', 'month', IST)).value, '2026-10');
  assert.equal(ok(resolveDate('October', 'month', IST)).value, '2026-10');
  assert.equal(ok(resolveDate('November', 'month', IST)).value, '2025-11', 'a future month with no year means the last one');
  assert.equal(ok(resolveDate('last month', 'month', IST)).value, '2026-09');
  assert.equal(ok(resolveDate('next month', 'month', IST)).value, '2026-11');
  assert.equal(ok(resolveDate('2026-12', 'month', IST)).value, '2026-12');
  assert.equal(ok(resolveDate('September payroll', 'month', IST)).value, '2026-09');
  assert.ok(!resolveDate('soonish', 'month', IST).ok);
});

test('dates: bad timezone falls back to UTC; helpers', () => {
  assert.equal(ok(resolveDate('Friday 11am', 'datetime', { now: NOW, timeZone: 'Mars/Olympus' })).value, '2026-10-23T11:00:00.000Z');
  assert.equal(formatInZone('2026-10-23T05:30:00.000Z', 'Asia/Kolkata'), 'Fri 23 Oct 2026, 11:00');
  assert.equal(describeToday(NOW, 'Asia/Kolkata'), '2026-10-18 (Sunday)');
});

// ─── Name resolution ─────────────────────────────────────────────────────────

const DEALS = [
  { id: 'd1', label: 'Acme ERP Implementation' }, { id: 'd2', label: 'Acme Cloud Migration' },
  { id: 'd3', label: 'Initech Data Warehouse' }, { id: 'd4', label: 'Globex Platform Licence' },
];

test('names: id, exact, fuzzy-unique, ambiguous, none', () => {
  assert.deepEqual(matchName('d3', DEALS), { status: 'ok', id: 'd3', label: 'Initech Data Warehouse', how: 'id' });
  assert.equal((matchName('globex platform licence', DEALS) as any).how, 'exact');
  const fuzzy = matchName('the initech warehouse deal', DEALS);
  assert.equal(fuzzy.status, 'ok'); assert.equal((fuzzy as any).id, 'd3');
  const amb = matchName('Acme', DEALS);
  assert.equal(amb.status, 'ambiguous');
  assert.deepEqual((amb as any).candidates.map((c: any) => c.id).sort(), ['d1', 'd2']);
  assert.equal((matchName('acme cloud', DEALS) as any).id, 'd2', 'a distinguishing word settles it');
  assert.equal(matchName('Wayne Enterprises', DEALS).status, 'none');
  assert.equal(matchName('', DEALS).status, 'none');
});

test('names: people, possessives, aliases (emails, invoice numbers), duplicates', () => {
  const people = [{ id: 'u1', label: 'Priya Sharma', aliases: ['priya@x.com'] }, { id: 'u2', label: 'Priyanka Rao' }, { id: 'u3', label: 'Dave Desk' }];
  assert.equal((matchName("Priya's", people) as any).id, 'u1');
  assert.equal((matchName('priya@x.com', people) as any).id, 'u1');
  assert.equal((matchName('dave', people) as any).id, 'u3');
  const invoices = [{ id: 'i1', label: 'INV-0007 Acme onboarding', aliases: ['INV-0007', '7'] }, { id: 'i2', label: 'INV-0008 Acme renewal', aliases: ['INV-0008', '8'] }];
  assert.equal((matchName('INV-0007', invoices) as any).id, 'i1');
  const twins = [{ id: 'a', label: 'Ravi Kumar' }, { id: 'b', label: 'Ravi Kumar' }];
  assert.equal(matchName('Ravi Kumar', twins).status, 'ambiguous', 'two people with the same name is a question');
  assert.equal(normalizeName('  The ACME, Inc. '), 'the acme inc.');
  assert.ok(nameScore('acme erp', 'Acme ERP Implementation') > nameScore('acme', 'Acme ERP Implementation'));
});

// ─── Step references & the executor ──────────────────────────────────────────

test('refs: parse forms, collect, order checks, substitution', () => {
  assert.deepEqual(parseRef('$1.id'), { step: 1, field: 'id' });
  assert.deepEqual(parseRef('$2'), { step: 2, field: 'id' });
  assert.deepEqual(parseRef('$step3.label'), { step: 3, field: 'label' });
  assert.deepEqual(parseRef('{{ step1.id }}'), { step: 1, field: 'id' });
  assert.equal(parseRef('$ 1'), null); assert.equal(parseRef('cost $1'), null); assert.equal(parseRef(5), null);
  assert.deepEqual([...collectRefs({ a: '$1.id', b: ['x', '$2.id'], c: { d: '$1.label' } })].sort(), [1, 2]);
  assert.deepEqual(checkStepRefs([{ params: {} }, { params: { leadId: '$1.id' } }]), []);
  assert.equal(checkStepRefs([{ params: { leadId: '$1.id' } }]).length, 1, 'self reference');
  assert.equal(checkStepRefs([{ params: {} }, { params: { x: '$3.id' } }, { params: {} }]).length, 1, 'forward reference');
  assert.equal(checkStepRefs([{ params: { x: '$9.id' } }]).length, 1, 'missing step');
  assert.deepEqual(substituteRefs({ leadId: '$1.id', ids: ['$1.id'], keep: 'Ravi' }, [{ id: 'L1' }]), { leadId: 'L1', ids: ['L1'], keep: 'Ravi' });
  assert.throws(() => substituteRefs({ leadId: '$1.id' }, [{}]), /didn't produce/);
});

test('executor: runs in order, feeds outputs forward, stops at the first failure and reports exactly', async () => {
  const ran: string[] = [];
  const steps: Array<{ action: string; label: string; params: Record<string, unknown> }> = [
    { action: 'CREATE_LEAD', label: 'Create a lead', params: { contactName: 'Ravi' } },
    { action: 'LOG_ACTIVITY', label: 'Log an activity', params: { leadId: '$1.id' } },
    { action: 'CONVERT_LEAD', label: 'Convert', params: { leadId: '$1.id' } },
    { action: 'CREATE_TASK', label: 'Create a task', params: { title: 'x' } },
  ];
  const report = await runSequential(steps, async (s, params: any, i) => {
    ran.push(`${i}:${s.action}:${params.leadId ?? ''}`);
    if (i === 1) return { summary: 'lead made', output: { id: 'L1', type: 'lead' } };
    if (i === 3) throw new Error('Lead already converted');
    return { summary: `step ${i} ok`, output: { id: `X${i}` } };
  });
  assert.deepEqual(ran, ['1:CREATE_LEAD:', '2:LOG_ACTIVITY:L1', '3:CONVERT_LEAD:L1']);
  assert.equal(report.ok, false);
  assert.equal(report.completed, 2);
  assert.equal(report.failedAt, 3);
  assert.deepEqual(report.steps.map(s => s.status), ['done', 'done', 'failed', 'skipped']);
  assert.equal(report.steps[2].error, 'Lead already converted');
  assert.match(report.summary, /^2 of 4 steps completed; step 3 \(Convert\) failed: Lead already converted 1 later step was not started\.$/);
});

test('executor: a reference to a step without output fails that step, nothing after it runs', async () => {
  const report = await runSequential(
    [{ action: 'A', label: 'A', params: {} }, { action: 'B', label: 'B', params: { id: '$1.id' } }, { action: 'C', label: 'C', params: {} }],
    async (_s, _p, i) => ({ summary: `ok ${i}`, output: i === 1 ? {} : { id: 'z' } }),
  );
  assert.deepEqual(report.steps.map(s => s.status), ['done', 'failed', 'skipped']);
  assert.match(report.steps[1].error!, /didn't produce/);
});

test('executor: all done → single summary or "All N steps completed"', async () => {
  const one = await runSequential([{ action: 'A', label: 'A', params: {} }], async () => ({ summary: 'Created it.' }));
  assert.equal(one.summary, 'Created it.'); assert.equal(one.ok, true);
  const two = await runSequential([{ action: 'A', label: 'A', params: {} }, { action: 'B', label: 'B', params: {} }], async () => ({ summary: 'ok' }));
  assert.equal(two.summary, 'All 2 steps completed.');
  const first = await runSequential([{ action: 'A', label: 'A', params: {} }, { action: 'B', label: 'B', params: {} }], async () => { throw new Error('nope'); });
  assert.match(first.summary, /^Nothing was changed; step 1 \(A\) failed: nope 1 later step was not started\.$/);
});

// ─── Registry: validation, roles, permissions, scope, areas, risk ────────────

const ROLES = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER', 'IT_AGENT', 'SALES_REP', 'EMPLOYEE'];

function perm(role: string, grants: Array<[string, Scope]> = [], extra: Partial<PermCtx> = {}): PermCtx {
  return {
    userId: 'me', orgId: 'org1', role, roleKey: role, roleId: null, employeeId: 'emp-me', departmentId: 'dep1',
    reportEmployeeIds: [], reportUserIds: [], teamEmployeeIds: [], grants: new Map(grants), fieldRules: new Map(), ...extra,
  };
}

const NEW_ACTIONS = [
  'ADD_EMPLOYEE', 'UPDATE_EMPLOYEE', 'REQUEST_WFH', 'APPLY_LEAVE_ON_BEHALF', 'MARK_ATTENDANCE', 'BULK_MARK_ATTENDANCE', 'START_PAYROLL_RUN',
  'ADD_LOAN', 'RECORD_LOAN_REPAYMENT', 'CHANGE_SALARY', 'CREATE_CONTACT', 'UPDATE_CONTACT', 'UPDATE_ACCOUNT', 'UPDATE_LEAD', 'CONVERT_LEAD',
  'CREATE_DEAL', 'UPDATE_DEAL', 'CREATE_QUOTE', 'CREATE_INVOICE', 'CREATE_CAMPAIGN', 'UPDATE_TICKET', 'CREATE_KB_ARTICLE', 'LINK_KB_ARTICLE',
  'CHECK_OUT_ASSET', 'CHECK_IN_ASSET', 'CREATE_CHANGE_REQUEST', 'CREATE_TASK', 'DECIDE_APPROVAL', 'INVITE_USER', 'DEACTIVATE_USER', 'UPDATE_CUSTOM_MODULE_RECORD',
];

test('registry: every action is complete — category, risk, example, sample that validates, junk that does not', () => {
  assert.ok(AI_ACTIONS.length >= 55, `expected the full registry, got ${AI_ACTIONS.length}`);
  for (const name of NEW_ACTIONS) assert.ok(getAiAction(name), `${name} is registered`);
  for (const a of AI_ACTIONS) {
    assert.ok(a.category, `${a.name} has a category`);
    assert.ok(a.risk, `${a.name} has a risk level`);
    assert.ok(a.example && a.description && a.paramsHint, `${a.name} has help text`);
    assert.ok(a.sample, `${a.name} has a sample`);
    const good = a.schema.safeParse(a.sample);
    assert.ok(good.success, `${a.name} sample validates: ${!good.success ? JSON.stringify(good.error.issues) : ''}`);
    assert.ok(!a.schema.safeParse({}).success, `${a.name} rejects empty params`);
    assert.ok(!a.schema.safeParse(Object.fromEntries(Object.keys(a.sample!).map(k => [k, { nested: 'garbage' }]))).success, `${a.name} rejects garbage values`);
    assert.ok(a.allowedRoles.length > 0, `${a.name} names its roles`);
    for (const r of a.allowedRoles) assert.ok([...ROLES].includes(r), `${a.name}: ${r} is a real role`);
  }
});

test('registry: specific validation rules', () => {
  const v = (n: string, p: object) => getAiAction(n)!.schema.safeParse(p).success;
  assert.ok(!v('ADD_EMPLOYEE', { firstName: 'A', joiningDate: '2026-11-01', invite: true }), 'invite needs an email');
  assert.ok(v('ADD_EMPLOYEE', { firstName: 'A', joiningDate: '2026-11-01', invite: true, email: 'a@b.co' }));
  assert.ok(!v('ADD_EMPLOYEE', { firstName: 'A', joiningDate: 'next week' }), 'dates must be resolved before validation');
  assert.ok(!v('UPDATE_EMPLOYEE', { employeeId: 'e1' }), 'an update must change something');
  assert.ok(!v('BULK_MARK_ATTENDANCE', { userIds: ['u1'], from: '2026-10-14', to: '2026-10-12', status: 'PRESENT', reason: 'x' }), 'from after to');
  assert.ok(!v('MARK_ATTENDANCE', { userId: 'u1', date: '2026-10-16', status: 'PARTYING', reason: 'x' }), 'status enum');
  assert.ok(!v('MARK_ATTENDANCE', { userId: 'u1', date: '2026-10-16', status: 'PRESENT' }), 'reason is mandatory (audited correction)');
  assert.ok(!v('START_PAYROLL_RUN', { month: '2026-13' }));
  assert.ok(!v('ADD_LOAN', { userId: 'u1', name: 'Adv', principal: 1000, startMonth: '2026-11' }), 'instalments or EMI needed');
  assert.ok(!v('ADD_LOAN', { userId: 'u1', name: 'Adv', principal: 0, instalments: 2, startMonth: '2026-11' }), 'principal > 0');
  assert.ok(!v('UPDATE_LEAD_STATUS', { leadId: 'l1', status: 'CONVERTED' }), 'conversion has its own action');
  assert.ok(!v('CHANGE_QUOTE_STATUS', { quoteId: 'q1', status: 'ACCEPTED' }), 'only the customer accepts a quote');
  assert.ok(!v('CREATE_QUOTE', { title: 'Q', lines: [] }), 'a quote needs lines');
  assert.ok(!v('CREATE_INVOICE', { title: 'I' }), 'an invoice needs a quote or lines');
  assert.ok(v('CREATE_INVOICE', { quoteId: '$1.id' }), 'an invoice can come from the quote an earlier step made');
  assert.ok(!v('DECIDE_APPROVAL', { approvalId: 'a', decision: 'REJECTED' }), 'rejecting needs a reason');
  assert.ok(!v('CREATE_TASK', { title: 'T', entityType: 'DEAL' }), 'a link needs both type and record');
  assert.ok(!v('CREATE_CHANGE_REQUEST', { title: 'T', description: 'd', plannedStart: '2026-10-24T16:30:00.000Z', plannedEnd: '2026-10-24T10:00:00.000Z' }));
  assert.ok(!v('INVITE_USER', { email: 'not-an-email' }));
  assert.ok(v('CREATE_TICKET', { title: 'VPN down', body: 'x', categoryName: 'Network' }), 'old categoryName param still accepted');
  assert.equal((getAiAction('CREATE_TICKET')!.schema.parse({ title: 'VPN down', body: 'x', categoryName: 'Network' }) as any).categoryId, 'Network');
});

test('registry: risk levels — money, payroll, access and outbound messages are high', () => {
  const r = (n: string, p: object = getAiAction(n)!.sample!) => riskOf(getAiAction(n)!, p);
  for (const n of ['START_PAYROLL_RUN', 'ADD_LOAN', 'RECORD_LOAN_REPAYMENT', 'CHANGE_SALARY', 'INVITE_USER', 'DEACTIVATE_USER', 'SEND_CAMPAIGN', 'SEND_WHATSAPP_NOW']) assert.equal(r(n), 'high', n);
  assert.equal(r('CHANGE_INVOICE_STATUS', { invoiceId: 'i', status: 'PAID' }), 'high');
  assert.equal(r('CHANGE_INVOICE_STATUS', { invoiceId: 'i', status: 'VOID' }), 'high');
  assert.equal(r('CHANGE_INVOICE_STATUS', { invoiceId: 'i', status: 'SENT' }), 'medium');
  assert.equal(r('UPDATE_EMPLOYEE', { employeeId: 'e', employmentStatus: 'EXITED' }), 'high');
  assert.equal(r('UPDATE_EMPLOYEE', { employeeId: 'e', designation: 'Lead' }), 'medium');
  assert.equal(r('ADD_EMPLOYEE', { firstName: 'A', joiningDate: '2026-11-01', invite: true, email: 'a@b.co' }), 'high');
  for (const n of ['ADD_NOTE', 'CREATE_TASK', 'REQUEST_LEAVE', 'REQUEST_WFH', 'CREATE_TICKET', 'LOG_ACTIVITY']) assert.equal(r(n), 'low', n);
});

test('roles: each action is allowed exactly for its route roles', () => {
  for (const a of AI_ACTIONS) for (const role of ROLES) {
    assert.equal(roleBlockedReason(a, role) === null, a.allowedRoles.includes(role as any), `${a.name} / ${role}`);
  }
  const can = (n: string, role: string) => roleBlockedReason(getAiAction(n)!, role) === null;
  // Employees: self-service only
  for (const n of ['REQUEST_LEAVE', 'REQUEST_WFH', 'CREATE_TASK', 'CREATE_TICKET', 'DECIDE_APPROVAL']) assert.ok(can(n, 'EMPLOYEE'), `EMPLOYEE may ${n}`);
  for (const n of ['START_PAYROLL_RUN', 'APPROVE_LEAVE', 'CREATE_DEAL', 'ASSIGN_TICKET', 'INVITE_USER', 'DEACTIVATE_USER', 'ADD_NOTE', 'MARK_ATTENDANCE', 'ADD_LOAN']) assert.ok(!can(n, 'EMPLOYEE'), `EMPLOYEE may not ${n}`);
  // IT agent: works tickets, not deals, assets or assignment (assignment is the IT managers' screen action)
  for (const n of ['UPDATE_TICKET_STATUS', 'UPDATE_TICKET', 'ADD_NOTE', 'CREATE_KB_ARTICLE', 'CREATE_CHANGE_REQUEST']) assert.ok(can(n, 'IT_AGENT'), `IT_AGENT may ${n}`);
  for (const n of ['ASSIGN_TICKET', 'CREATE_DEAL', 'CHECK_OUT_ASSET', 'START_PAYROLL_RUN', 'CHANGE_INVOICE_STATUS', 'DEACTIVATE_USER']) assert.ok(!can(n, 'IT_AGENT'), `IT_AGENT may not ${n}`);
  // Sales rep: CRM, not campaigns sending, HR or IT
  assert.ok(can('UPDATE_DEAL', 'SALES_REP') && !can('SEND_CAMPAIGN', 'SALES_REP') && !can('APPROVE_LEAVE', 'SALES_REP') && !can('CHECK_IN_ASSET', 'SALES_REP'));
});

test('permission engine: a custom HR-manager role on the EMPLOYEE enum can add people; a plain employee cannot', () => {
  const add = getAiAction('ADD_EMPLOYEE')!;
  const hrManager = perm('EMPLOYEE', [['hr.employee.create', 'ALL'], ['hr.employee.update', 'ALL']]);
  const employee = perm('EMPLOYEE', [['hr.employee.read', 'OWN']]);
  assert.equal(roleBlockedReason(add, 'EMPLOYEE', hrManager), null);
  assert.match(roleBlockedReason(add, 'EMPLOYEE', employee)!, /hr\.employee\.create/);
  // A sales rep whose role was narrowed to read-only on deals can't update one
  const readOnlyRep = perm('SALES_REP', [['crm.deal.read', 'ALL']]);
  assert.match(roleBlockedReason(getAiAction('UPDATE_DEAL')!, 'SALES_REP', readOnlyRep)!, /crm\.deal\.update/);
  assert.equal(roleBlockedReason(getAiAction('UPDATE_DEAL')!, 'SALES_REP', perm('SALES_REP', [['crm.deal.update', 'OWN']])), null);
  // Menus follow the same rule
  assert.ok(actionMenuForPrompt('EMPLOYEE', [], hrManager).some(a => a.name === 'ADD_EMPLOYEE'));
  assert.ok(!actionMenuForPrompt('EMPLOYEE', [], employee).some(a => a.name === 'ADD_EMPLOYEE'));
});

test('record scope: OWN / TEAM / ALL decide whose deal, ticket or person can be changed', () => {
  const own = perm('SALES_REP', [['crm.deal.update', 'OWN']]);
  const team = perm('SALES_REP', [['crm.deal.update', 'TEAM']], { reportUserIds: ['rep2'] });
  const all = perm('SALES_REP', [['crm.deal.update', 'ALL']]);
  assert.equal(recordAllowed(own, 'deal', 'crm.deal.update', { id: 'd', assignedTo: 'me' }), true);
  assert.equal(recordAllowed(own, 'deal', 'crm.deal.update', { id: 'd', assignedTo: 'rep2' }), false);
  assert.equal(recordAllowed(team, 'deal', 'crm.deal.update', { id: 'd', assignedTo: 'rep2' }), true);
  assert.equal(recordAllowed(team, 'deal', 'crm.deal.update', { id: 'd', assignedTo: 'rep3' }), false);
  assert.equal(recordAllowed(all, 'deal', 'crm.deal.update', { id: 'd', assignedTo: 'rep3' }), true);
  const hrDept = perm('EMPLOYEE', [['hr.employee.update', 'DEPARTMENT']]);
  assert.equal(recordAllowed(hrDept, 'employee', 'hr.employee.update', { id: 'e2', userId: 'x', departmentId: 'dep1' }), true);
  assert.equal(recordAllowed(hrDept, 'employee', 'hr.employee.update', { id: 'e3', userId: 'y', departmentId: 'dep9' }), false);
  // Types without a scope shape (campaigns) are role-gated only
  assert.equal(recordAllowed(own, 'campaign', 'crm.campaign.update', { id: 'c' }), true);
});

const HR_ONLY = ['crm', 'sales_docs', 'campaigns', 'itdesk', 'assets', 'knowledge_base', 'customer_portal'];
const CRM_ONLY = ['hr_core', 'attendance', 'payroll', 'itdesk', 'assets', 'knowledge_base', 'customer_portal'];

test('areas: an HR-only org has no CRM or IT Desk actions; a CRM-only org has no HR ones', () => {
  const hr = listActionsForRole('SUPER_ADMIN', HR_ONLY).map(a => a.name);
  for (const n of ['CREATE_DEAL', 'CREATE_LEAD', 'CREATE_QUOTE', 'CHANGE_INVOICE_STATUS', 'SEND_CAMPAIGN', 'CREATE_TICKET', 'CHECK_OUT_ASSET', 'CREATE_KB_ARTICLE', 'ADD_NOTE', 'SCHEDULE_WHATSAPP_REMINDER']) assert.ok(!hr.includes(n), `HR-only: no ${n}`);
  for (const n of ['ADD_EMPLOYEE', 'APPROVE_LEAVE', 'REQUEST_WFH', 'START_PAYROLL_RUN', 'MARK_ATTENDANCE', 'CREATE_TASK', 'INVITE_USER']) assert.ok(hr.includes(n), `HR-only keeps ${n}`);
  const crm = listActionsForRole('SUPER_ADMIN', CRM_ONLY).map(a => a.name);
  for (const n of ['ADD_EMPLOYEE', 'REQUEST_LEAVE', 'START_PAYROLL_RUN', 'MARK_ATTENDANCE', 'CREATE_TICKET']) assert.ok(!crm.includes(n), `CRM-only: no ${n}`);
  assert.ok(crm.includes('CREATE_DEAL') && crm.includes('ADD_NOTE'));
  // Sub-module switches: payroll off keeps leave
  assert.ok(!isActionAvailable('START_PAYROLL_RUN', ['payroll']) && isActionAvailable('APPROVE_LEAVE', ['payroll']));
  // A shared action with a record type from a switched-off area is refused for that type only
  assert.ok(actionBlockedReason('CREATE_TASK', { entityType: 'DEAL' }, HR_ONLY));
  assert.equal(actionBlockedReason('CREATE_TASK', { title: 'x' }, HR_ONLY), null);
  assert.equal(actionBlockedReason('ADD_NOTE', { entityType: 'TICKET' }, ['crm']), null);
});

test('menus: an employee\'s planner only sees self-service, low-risk actions', () => {
  const menu = actionMenuForPrompt('EMPLOYEE', [], perm('EMPLOYEE', [['core.task.create', 'OWN'], ['itdesk.ticket.create', 'OWN']]));
  const names = menu.map(m => m.name).sort();
  assert.deepEqual(names, ['CREATE_TASK', 'CREATE_TICKET', 'DECIDE_APPROVAL', 'REQUEST_LEAVE', 'REQUEST_WFH']);
  const help = listActionsForRole('EMPLOYEE', HR_ONLY, perm('EMPLOYEE', [['core.task.create', 'OWN']]));
  assert.ok(help.every(h => h.example && h.label && h.category));
  assert.ok(!help.some(h => h.name === 'CREATE_TICKET'), 'IT Desk off → no tickets in the help panel');
});

// ─── One step, normalised end to end (record lookups stubbed) ────────────────

function stubEntity(key: keyof typeof ENTITIES, rows: Array<Record<string, any>>, label: (r: any) => string) {
  const def = ENTITIES[key] as any;
  def.search = async (_o: string, _p: unknown, text: string) => rows
    .filter(r => !text || label(r).toLowerCase().split(' ').some((w: string) => text.toLowerCase().includes(w)))
    .map(r => ({ id: r.id, label: label(r) }));
  def.load = async (_o: string, id: string) => rows.find(r => r.id === id) ?? null;
}

const env = (role: string, grants: Array<[string, Scope]>, blocked: string[] = []): NormalizeEnv => ({
  user: { id: 'me', orgId: 'org1', role, email: 'me@x.com' }, perm: perm(role, grants), blockedModules: blocked, timeZone: 'Asia/Kolkata', now: NOW,
});

const DEAL_ROWS = [
  { id: 'cdealacmeerp0000000000001', title: 'Acme ERP Implementation', stage: 'Negotiation', assignedTo: 'me' },
  { id: 'cdealacmecloud00000000002', title: 'Acme Cloud Migration', stage: 'Demo Scheduled', assignedTo: 'rep2' },
];

test('normalise: an ambiguous name becomes a question with candidates; nothing is guessed', async () => {
  stubEntity('deal', DEAL_ROWS, r => r.title);
  const s = await normalizeStep(env('SALES_REP', [['crm.deal.update', 'ALL'], ['crm.deal.read', 'ALL']]), { action: 'MOVE_DEAL_STAGE', params: { dealId: 'Acme', stage: 'Proposal' } }, 1, [{ action: 'MOVE_DEAL_STAGE' }]);
  assert.equal(s.needs.length, 1);
  assert.equal(s.needs[0].param, 'dealId');
  assert.deepEqual(s.needs[0].candidates.map(c => c.label).sort(), ['Acme Cloud Migration', 'Acme ERP Implementation']);
  assert.equal(s.params.dealId, 'Acme', 'left unresolved until the user picks');
  const plan = summarisePlan([s], { planId: 'p', interactionLogId: null, explanation: '', confidence: 80, repaired: false });
  assert.equal(plan.ready, false);
});

test('normalise: the picked id resolves, the record is scope-checked and previewed before → after', async () => {
  stubEntity('deal', DEAL_ROWS, r => r.title);
  const ownOnly = env('SALES_REP', [['crm.deal.update', 'OWN'], ['crm.deal.read', 'ALL']]);
  const mine = await normalizeStep(ownOnly, { action: 'MOVE_DEAL_STAGE', params: { dealId: 'cdealacmeerp0000000000001', stage: 'Proposal' } }, 1, [{ action: 'MOVE_DEAL_STAGE' }]);
  assert.deepEqual(mine.errors, []);
  assert.equal(mine.allowed, true);
  assert.deepEqual(mine.preview.changes, [{ field: 'Stage', before: 'Negotiation', after: 'Proposal' }]);
  assert.equal(mine.preview.target?.label, 'Acme ERP Implementation');
  const theirs = await normalizeStep(ownOnly, { action: 'MOVE_DEAL_STAGE', params: { dealId: 'Acme Cloud', stage: 'Proposal' } }, 1, [{ action: 'MOVE_DEAL_STAGE' }]);
  assert.match(theirs.errors.join(' '), /don't have access to change this deal/);
});

test('normalise: dates in words + a reference to an earlier step; role and area blocks', async () => {
  const steps = [{ action: 'CREATE_LEAD' }, { action: 'LOG_ACTIVITY' }];
  const crmRep = env('SALES_REP', [['crm.activity.create', 'ALL']]);
  const s = await normalizeStep(crmRep, { action: 'log_activity', params: { type: 'CALL', title: 'Call Ravi', leadId: '$1.id', dueAt: 'Friday 11am', body: null } }, 2, steps);
  assert.deepEqual(s.errors, []);
  assert.equal(s.action, 'LOG_ACTIVITY', 'action names are case-insensitive');
  assert.equal(s.params.dueAt, '2026-10-23T05:30:00.000Z');
  assert.equal(s.params.leadId, '$1.id');
  assert.deepEqual(s.dependsOn, [1]);
  assert.ok(s.preview.changes.some(c => c.field === 'Due at' && c.after === 'Fri 23 Oct 2026, 11:00'));
  assert.ok(s.preview.changes.some(c => c.after === 'the new lead (step 1)'));
  assert.equal(refLabel(1, getAiAction('CONVERT_LEAD')), 'the result of step 1 (convert a lead to a deal)');

  const agent = await normalizeStep(env('IT_AGENT', []), { action: 'LOG_ACTIVITY', params: { type: 'CALL', title: 'x' } }, 1, [{ action: 'LOG_ACTIVITY' }]);
  assert.equal(agent.allowed, false);
  assert.match(agent.blockedReason!, /role/);
  const hrOnly = await normalizeStep(env('SUPER_ADMIN', [['crm.activity.create', 'ALL']], HR_ONLY), { action: 'LOG_ACTIVITY', params: { type: 'CALL', title: 'x' } }, 1, [{ action: 'LOG_ACTIVITY' }]);
  assert.equal(hrOnly.allowed, false);
  assert.match(hrOnly.blockedReason!, /area/);

  const bad = await normalizeStep(crmRep, { action: 'LOG_ACTIVITY', params: { type: 'LUNCH', title: 'x', dueAt: 'whenever' } }, 1, [{ action: 'LOG_ACTIVITY' }]);
  assert.ok(bad.errors.some(e => /dueAt/.test(e)) && bad.errors.some(e => /type/.test(e)));
  assert.ok(bad.modelErrors.length >= 2, 'model mistakes are collected for the repair round');
  const unknown = await normalizeStep(crmRep, { action: 'DROP_DATABASE', params: {} }, 1, [{ action: 'DROP_DATABASE' }]);
  assert.equal(unknown.allowed, false);
  assert.match(unknown.modelErrors[0], /unknown action/);
});

test('plan summary: risk is the highest step, high risk needs the second confirmation', () => {
  const step = (risk: 'low' | 'medium' | 'high') => ({ index: 1, action: 'X', label: 'X', category: 'CRM', params: {}, risk, allowed: true, errors: [], needs: [], warnings: [], preview: { title: 'x', changes: [] }, dependsOn: [] });
  const p = summarisePlan([step('low'), step('high'), step('medium')], { planId: 'p', interactionLogId: 'l', explanation: 'e', confidence: 90, repaired: false });
  assert.equal(p.risk, 'high'); assert.equal(p.requiresSecondConfirmation, true); assert.equal(p.ready, true);
  assert.equal(summarisePlan([], { planId: 'p', interactionLogId: null, explanation: '', confidence: 0, repaired: false }).ready, false);
});

test('help panel examples follow the org areas (no deal wording when CRM is off, no ticket wording when IT Desk is off)', () => {
  const itOnly = listActionsForRole('SUPER_ADMIN', ['crm', 'sales_docs', 'campaigns', 'hr_core', 'attendance', 'payroll']);
  for (const a of itOnly) assert.doesNotMatch(a.example, /\bdeals?\b|\bleads?\b/i, a.name);
  const crmOnly = listActionsForRole('SUPER_ADMIN', ['itdesk', 'assets', 'knowledge_base', 'customer_portal', 'hr_core', 'attendance', 'payroll']);
  for (const a of crmOnly) assert.doesNotMatch(a.example, /\btickets?\b/i, a.name);
  assert.equal(exampleFor(getAiAction('ADD_NOTE')!, []), getAiAction('ADD_NOTE')!.example);
});
