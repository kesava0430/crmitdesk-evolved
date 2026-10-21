/**
 * FIX — the built-in HR Manager role couldn't manage HR.
 *
 * Every HR route and HR scoping check used a hard-coded list of legacy roles
 * (Super Admin, IT Manager, Sales Manager). HR Manager users carry the legacy
 * role EMPLOYEE (the enum has no HR value), so they got the employee view of
 * attendance, leave and payroll, and HR Settings / Org Structure were denied.
 * utils/hrAccess.ts is now the one rule; these pin it.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hrAccessFor, managesAnyHr, requireHrManager, hrManagersWhere, HR_AREAS, canManageHr } from '../../src/utils/hrAccess';
import { roleBlockedReason } from '../../src/utils/ai-actions';
import { getAiAction } from '../../src/utils/ai-actions';

const ALL = Object.fromEntries(HR_AREAS.map(a => [a, true]));
const NONE = Object.fromEntries(HR_AREAS.map(a => [a, false]));

test('legacy manager roles keep full HR rights', () => {
  for (const role of ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER']) assert.deepEqual(hrAccessFor({ role }), ALL);
});

test('HR Manager role (legacy EMPLOYEE + Role.key HR_MANAGER) gets every HR area', () => {
  assert.deepEqual(hrAccessFor({ role: 'EMPLOYEE', roleKey: 'HR_MANAGER' }), ALL);
});

test('employees, IT agents, sales reps, finance and executives manage no HR', () => {
  assert.deepEqual(hrAccessFor({ role: 'EMPLOYEE', roleKey: 'EMPLOYEE', grants: new Map([['hr.leave.read', 'OWN'], ['hr.leave.create', 'OWN']]) }), NONE);
  assert.deepEqual(hrAccessFor({ role: 'IT_AGENT', roleKey: 'IT_AGENT' }), NONE);
  assert.deepEqual(hrAccessFor({ role: 'SALES_REP' }), NONE);
  assert.deepEqual(hrAccessFor({ role: 'EMPLOYEE', roleKey: 'FINANCE', grants: new Map([['hr.payslip.read', 'ALL'], ['hr.salary.read', 'ALL']]) }), NONE);
  assert.equal(managesAnyHr({ role: 'EMPLOYEE', roleKey: 'EXECUTIVE', grants: { 'hr.employee.read': 'ALL' } }), false);
});

test('custom roles get exactly the areas they hold at ALL scope', () => {
  const a = hrAccessFor({ role: 'EMPLOYEE', roleKey: 'LEAVE_APPROVER', grants: new Map([['hr.leave.update', 'ALL'], ['hr.salary.update', 'TEAM']]) });
  assert.deepEqual(a, { ...NONE, leave: true });
  assert.deepEqual(hrAccessFor({ role: 'EMPLOYEE', roleKey: 'PAYROLL', grants: { 'hr.salary.update': 'ALL' } }), { ...NONE, payroll: true });
});

test('canManageHr: legacy managers need no lookup; API keys never pass', async () => {
  assert.equal(await canManageHr({ id: 'u', orgId: 'o', role: 'SUPER_ADMIN' }, 'payroll'), true);
  assert.equal(await canManageHr({ id: 'k', orgId: 'o', role: 'API' }, 'payroll'), false);
});

test('requireHrManager: admits managers, refuses API keys and missing users', async () => {
  const run = (user: any) => new Promise<any>(r => requireHrManager('leave')({ user } as any, {} as any, (e?: any) => r(e ?? null)));
  assert.equal(await run({ id: 'u', orgId: 'o', role: 'CRM_MANAGER' }), null);
  assert.equal((await run({ id: 'k', orgId: 'o', role: 'API' }))?.statusCode, 403);
  assert.equal((await run(undefined))?.statusCode, 403);
});

test('approver lookup counts HR Manager and custom approver roles, not just legacy roles', () => {
  const w = hrManagersWhere('org1', 'leave', 'me');
  assert.equal(w.orgId, 'org1');
  assert.deepEqual(w.id, { not: 'me' });
  assert.deepEqual(w.OR[1], { roleRef: { is: { key: 'HR_MANAGER' } } });
  assert.deepEqual(w.OR[2], { roleRef: { is: { permissions: { some: { permissionKey: 'hr.leave.update', scope: 'ALL' } } } } });
});

test('HR AI actions are offered to HR Managers (same rule as the routes), not to employees', () => {
  const def = getAiAction('APPROVE_LEAVE')!;
  const hrPerm: any = { role: 'EMPLOYEE', roleKey: 'HR_MANAGER', grants: new Map() };
  const empPerm: any = { role: 'EMPLOYEE', roleKey: 'EMPLOYEE', grants: new Map() };
  assert.equal(roleBlockedReason(def, 'EMPLOYEE', hrPerm), null);
  assert.match(String(roleBlockedReason(def, 'EMPLOYEE', empPerm)), /isn't permitted/);
  assert.equal(roleBlockedReason(getAiAction('START_PAYROLL_RUN')!, 'EMPLOYEE', hrPerm), null);
  // ...but nothing outside HR
  assert.match(String(roleBlockedReason(getAiAction('MOVE_DEAL_STAGE')!, 'EMPLOYEE', hrPerm)), /isn't permitted/);
});
