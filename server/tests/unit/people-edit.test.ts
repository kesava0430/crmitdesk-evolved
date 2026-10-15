/**
 * PEOPLE — one Add form, one Edit path, and who may change what.
 *
 * The owner's complaint: "Add person, Add employee and all are at different
 * places … and there is no option to update the details of employees." The
 * fix routes every add through POST /people and every edit through
 * PATCH /people/:id (or PATCH /people/me for an employee's own contact
 * details). These tests pin the pure rules those endpoints rely on:
 *
 *   - the edit schema: nullable (so HR can clear a field), strict (so an
 *     unknown or HR-only key is refused, not silently ignored);
 *   - the self-service schema refuses HR fields outright;
 *   - role changes follow the same rank rules as Administration → Users;
 *   - attendance policy pinning edits group applicability correctly;
 *   - reporting-loop detection; change detection; audit redaction.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PersonUpdateSchema,
  SelfUpdateSchema,
  changedKeys,
  auditChanges,
  dropMaskedEchoes,
  checkRoleChange,
  createsReportingLoop,
  planPolicyGroupMembership,
  explicitGroupFor,
  type PolicyGroupRow,
} from '../../src/modules/people/personRules';
import { rankOf, assertCanAssign, assertCanManage, toLegacyRole } from '../../src/utils/roleRank';

const SRC = path.join(__dirname, '../../src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

function status(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    return e?.status ?? e?.statusCode ?? -1;
  }
}

// ─── Edit schema ─────────────────────────────────────────────────────────────

test('edit schema: null and "" clear a field, undefined leaves it alone', () => {
  const parsed = PersonUpdateSchema.parse({ managerId: null, phone: '', designation: 'Lead' });
  assert.equal(parsed.managerId, null);
  assert.equal(parsed.phone, null);
  assert.equal(parsed.designation, 'Lead');
  assert.equal('lastName' in parsed && parsed.lastName !== undefined, false);
});

test('edit schema: unknown keys are refused rather than silently dropped', () => {
  assert.equal(PersonUpdateSchema.safeParse({ salary: 1000 }).success, false);
  assert.equal(PersonUpdateSchema.safeParse({ orgId: 'other-org' }).success, false);
  assert.equal(PersonUpdateSchema.safeParse({ userId: 'someone-else' }).success, false);
});

test('edit schema: first name, employee ID and joining date cannot be blanked', () => {
  assert.equal(PersonUpdateSchema.safeParse({ firstName: '' }).success, false);
  assert.equal(PersonUpdateSchema.safeParse({ employeeCode: '' }).success, false);
  assert.equal(PersonUpdateSchema.safeParse({ joiningDate: null }).success, false);
  assert.equal(PersonUpdateSchema.safeParse({ joiningDate: 'next tuesday' }).success, false);
  assert.equal(PersonUpdateSchema.safeParse({ joiningDate: '2026-04-01' }).success, true);
});

test('edit schema: email is normalised, enums are enforced', () => {
  assert.equal(PersonUpdateSchema.parse({ email: '  Jane@Example.COM ' }).email, 'jane@example.com');
  assert.equal(PersonUpdateSchema.safeParse({ email: 'not-an-email' }).success, false);
  assert.equal(PersonUpdateSchema.safeParse({ employmentStatus: 'FIRED' }).success, false);
  assert.equal(PersonUpdateSchema.safeParse({ employmentType: 'CONTRACT' }).success, true);
});

test('edit schema: emergency contact needs name, relationship and phone', () => {
  assert.equal(PersonUpdateSchema.safeParse({ emergencyContact: { name: 'A' } }).success, false);
  assert.equal(
    PersonUpdateSchema.safeParse({ emergencyContact: { name: 'A', relationship: 'Spouse', phone: '98765' } }).success,
    true
  );
  assert.equal(PersonUpdateSchema.parse({ emergencyContact: null }).emergencyContact, null);
});

// ─── Self-service schema ─────────────────────────────────────────────────────

test('self-service: contact and address fields are accepted', () => {
  const r = SelfUpdateSchema.safeParse({
    phone: '+91 98765 43210',
    city: 'Hyderabad',
    personalEmail: 'me@home.example',
    emergencyContact: { name: 'Mum', relationship: 'Parent', phone: '12345' },
  });
  assert.equal(r.success, true);
});

test('self-service: HR-only fields are refused (an employee cannot promote themselves)', () => {
  for (const key of ['designation', 'departmentId', 'managerId', 'employmentStatus', 'roleId', 'bankAccountNumber', 'employeeCode', 'joiningDate']) {
    assert.equal(SelfUpdateSchema.safeParse({ [key]: 'x' }).success, false, `${key} must not be self-editable`);
  }
});

// ─── Role rank rules ─────────────────────────────────────────────────────────

test('role rank: unknown roles rank lowest, custom legacy values map to EMPLOYEE', () => {
  assert.equal(rankOf('API'), 0);
  assert.equal(rankOf(undefined), 0);
  assert.equal(rankOf('SUPER_ADMIN'), 3);
  assert.equal(toLegacyRole('HR_MANAGER'), 'EMPLOYEE');
  assert.equal(toLegacyRole('IT_AGENT'), 'IT_AGENT');
});

test('role rank: a manager cannot mint a Super Admin or manage one', () => {
  assert.equal(status(() => assertCanAssign('IT_MANAGER', 'SUPER_ADMIN')), 403);
  assert.equal(status(() => assertCanManage('CRM_MANAGER', 'SUPER_ADMIN')), 403);
  assert.equal(status(() => assertCanAssign('IT_MANAGER', 'CRM_MANAGER')), null);
  assert.equal(status(() => assertCanAssign('SUPER_ADMIN', 'SUPER_ADMIN')), null);
});

test('checkRoleChange: no login, own role, outranked target, escalation', () => {
  const base = { callerUserId: 'me', callerRole: 'IT_MANAGER', targetUserId: 'u1', targetRole: 'IT_AGENT', newRole: 'SALES_REP' };
  assert.equal(status(() => checkRoleChange(base)), null);
  assert.equal(status(() => checkRoleChange({ ...base, targetUserId: null })), 400);
  assert.equal(status(() => checkRoleChange({ ...base, targetUserId: 'me' })), 403);
  assert.equal(status(() => checkRoleChange({ ...base, targetRole: 'SUPER_ADMIN' })), 403);
  assert.equal(status(() => checkRoleChange({ ...base, newRole: 'SUPER_ADMIN' })), 403);
  // An HR Manager custom role rides on EMPLOYEE: it can never hand out a staff role.
  assert.equal(status(() => checkRoleChange({ ...base, callerRole: 'EMPLOYEE', targetRole: 'EMPLOYEE' })), 403);
});

// ─── Change detection / audit ────────────────────────────────────────────────

test('changedKeys: untouched, empty-vs-null and same-day dates are not changes', () => {
  const before = { phone: null, designation: 'Tech', joiningDate: new Date('2026-03-18T00:00:00.000Z'), city: '' };
  assert.deepEqual(changedKeys(before, { phone: '', designation: 'Tech', joiningDate: '2026-03-18', city: null }), []);
  assert.deepEqual(changedKeys(before, { designation: 'Lead', joiningDate: '2026-03-19' }), ['designation', 'joiningDate']);
});

test('auditChanges: sensitive values are logged by name only', () => {
  const out: any = auditChanges(
    { bankAccountNumber: '111', designation: 'A' },
    { bankAccountNumber: '222', designation: 'B' },
    ['bankAccountNumber', 'designation']
  );
  assert.deepEqual(out.fields, ['bankAccountNumber', 'designation']);
  assert.equal(out.values.bankAccountNumber, undefined);
  assert.deepEqual(out.values.designation, { from: 'A', to: 'B' });
});

test('dropMaskedEchoes: a masked value sent back is never saved over the real one', () => {
  assert.deepEqual(dropMaskedEchoes({ bankAccountNumber: '••••••1234', bankName: 'HDFC' }), { bankName: 'HDFC' });
});

// ─── Reporting loops ─────────────────────────────────────────────────────────

test('createsReportingLoop: self, direct and indirect loops; a clean chain passes', async () => {
  // c → b → a (a is the top)
  const managers: Record<string, string | null> = { a: null, b: 'a', c: 'b', d: null };
  const managerOf = async (id: string) => managers[id] ?? null;
  assert.equal(await createsReportingLoop('a', 'a', managerOf), true);
  assert.equal(await createsReportingLoop('a', 'c', managerOf), true); // a would report to its own grand-report
  assert.equal(await createsReportingLoop('d', 'c', managerOf), false);
  // Existing bad data (x ↔ y) must not spin forever.
  const bad: Record<string, string> = { x: 'y', y: 'x' };
  assert.equal(await createsReportingLoop('z', 'x', async id => bad[id] ?? null), false);
});

// ─── Attendance policy pinning ───────────────────────────────────────────────

const groups = (): PolicyGroupRow[] => [
  { id: 'def', isDefault: true, isActive: true, applicability: null },
  { id: 'night', isDefault: false, isActive: true, applicability: { userIds: ['u2'] } },
  { id: 'branch', isDefault: false, isActive: true, applicability: { locationIds: ['loc1'], userIds: ['u1'] } },
  { id: 'old', isDefault: false, isActive: false, applicability: null },
];

test('policy pinning: moving a person removes them from their old group and keeps other filters', () => {
  const updates = planPolicyGroupMembership(groups(), 'u1', 'night');
  const byId = Object.fromEntries(updates.map(u => [u.id, u.applicability]));
  assert.deepEqual(byId.night, { userIds: ['u2', 'u1'] });
  assert.deepEqual(byId.branch, { locationIds: ['loc1'], userIds: [] });
  assert.equal(byId.def, undefined);
});

test('policy pinning: null means automatic; re-pinning to the same group is a no-op', () => {
  assert.deepEqual(planPolicyGroupMembership(groups(), 'u1', null).map(u => u.id), ['branch']);
  assert.deepEqual(planPolicyGroupMembership(groups(), 'u2', 'night'), []);
});

test('policy pinning: default, inactive and unknown groups are refused', () => {
  assert.equal(status(() => planPolicyGroupMembership(groups(), 'u1', 'def')), 400);
  assert.equal(status(() => planPolicyGroupMembership(groups(), 'u1', 'old')), 400);
  assert.equal(status(() => planPolicyGroupMembership(groups(), 'u1', 'nope')), 404);
});

test('explicitGroupFor finds the active group naming the login', () => {
  assert.equal(explicitGroupFor(groups(), 'u2')?.id, 'night');
  assert.equal(explicitGroupFor(groups(), 'u9'), null);
});

// ─── Structural guards ───────────────────────────────────────────────────────

test('routes: people writes are permission-checked in the handler and closed to API keys', () => {
  const routes = read('modules', 'people', 'people.routes.ts');
  assert.match(routes, /router\.patch\('\/me',[^\n]*noApiKeys/);
  assert.match(routes, /router\.post\('\/',[^\n]*noApiKeys/);
  assert.match(routes, /router\.patch\('\/:id',[^\n]*noApiKeys/);
  // /me must be registered before /:id or 'me' would be read as an id.
  assert.ok(routes.indexOf("'/me'") < routes.indexOf("'/:id'"));

  const ctrl = read('modules', 'people', 'people.controller.ts');
  assert.match(ctrl, /assertCan\(ctx, 'hr\.employee\.update'\)/);
  assert.match(ctrl, /canAccessRecord\(ctx, 'employee', 'hr\.employee\.update'/);
  assert.match(ctrl, /assertOrgRefs\(/);
  assert.match(ctrl, /logAction\(req\.user!\.id, 'UPDATE', 'EMPLOYEE'/);
});

test('every role-granting People path applies the rank rules', () => {
  const ctrl = read('modules', 'people', 'people.controller.ts');
  // create (loginMode password/invite) and grant-login both assert; changeRole goes through checkRoleChange.
  assert.ok((ctrl.match(/assertCanAssign\(req\.user!\.role/g) ?? []).length >= 2);
  assert.match(ctrl, /checkRoleChange\(\{/);
  assert.doesNotMatch(read('modules', 'core', 'users', 'usersAdmin.controller.ts'), /const ROLE_RANK/);
});
