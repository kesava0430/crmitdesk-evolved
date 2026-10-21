/**
 * SEC-AUTH regression tests.
 *
 *  1. API keys passed requireRole('PLATFORM_ADMIN'): the old ceiling let a key
 *     through any gate that listed a role outside {SUPER_ADMIN, IT_MANAGER,
 *     CRM_MANAGER}, and PLATFORM_ADMIN is outside that set.
 *  2. Update handlers read the record back with an unscoped findUnique, so
 *     PATCH with another org's id returned that org's record.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../src/utils/prisma';
import { requireRole, apiKeyMayPass, ADMIN, MANAGERS, IT_MANAGERS, CRM_MANAGERS, ALL_USERS, ALL_STAFF, CRM_STAFF, IT_STAFF } from '../../src/middleware/authenticate';

function gate(roles: string[], role: string) {
  let err: any = null, passed = false;
  try { requireRole(...roles)({ user: { id: 'u', orgId: 'o', role, email: '' } } as any, {} as any, () => { passed = true; }); }
  catch (e) { err = e; }
  return { passed, err };
}

test('API keys never pass a PLATFORM_ADMIN gate', () => {
  const { passed, err } = gate(['PLATFORM_ADMIN'], 'API');
  assert.equal(passed, false);
  assert.equal(err?.statusCode, 403);
});

test('API keys still pass staff-level gates and never manager/admin gates', () => {
  for (const r of [ALL_USERS, ALL_STAFF, CRM_STAFF, IT_STAFF]) assert.equal(apiKeyMayPass(r), true);
  for (const r of [ADMIN, MANAGERS, IT_MANAGERS, CRM_MANAGERS, ['PLATFORM_ADMIN'], ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER']]) {
    assert.equal(apiKeyMayPass(r), false);
  }
});

test('a real PLATFORM_ADMIN user still passes its gate', () => {
  assert.equal(gate(['PLATFORM_ADMIN'], 'PLATFORM_ADMIN').passed, true);
  assert.equal(gate(['PLATFORM_ADMIN'], 'SUPER_ADMIN').passed, false);
});

const READ_BACK: Array<[string, string, string]> = [
  ['account', '../../src/modules/crm/accounts/accounts.controller', 'update'],
  ['asset', '../../src/modules/itdesk/assets/assets.controller', 'update'],
  ['knowledgeArticle', '../../src/modules/itdesk/articles/articles.controller', 'update'],
  ['category', '../../src/modules/itdesk/categories/categories.controller', 'update'],
  ['changeRequest', '../../src/modules/changemanagement/changeRequests.controller', 'update'],
  ['campaign', '../../src/modules/campaigns/campaigns.controller', 'update'],
];

for (const [model, path, fn] of READ_BACK) {
  test(`${model} update reads back within the caller's org and 404s for a foreign id`, async () => {
    let readWhere: any = null;
    (prisma as any)[model] = {
      updateMany: async () => ({ count: 0 }),
      findFirst: async (a: any) => { readWhere = a.where; return null; },
      findUnique: async () => ({ id: 'foreign', orgId: 'orgB' }),
    };
    const handler = require(path)[fn];
    let err: any = null, body: any = undefined;
    await handler({ user: { id: 'u1', role: 'SUPER_ADMIN', orgId: 'orgA' }, params: { id: 'foreign' }, body: {} } as any,
      { json: (b: any) => { body = b; } } as any, (e: any) => { err = e; });
    assert.equal(body, undefined, 'must not return the foreign record');
    assert.equal(err?.statusCode, 404);
    assert.deepEqual(readWhere, { id: 'foreign', orgId: 'orgA' });
  });
}

test('payroll cycle save refuses another org\'s cycle before writing anything', async () => {
  const { saveCycle } = require('../../src/modules/hr/payroll/payrollConfig.controller');
  const writes: string[] = [];
  (prisma as any).payrollCycle = {
    findFirst: async () => null, // not in the caller's org
    update: async () => { writes.push('update'); return { id: 'c', orgId: 'orgB' }; },
    updateMany: async () => { writes.push('updateMany'); return { count: 1 }; },
    create: async () => { writes.push('create'); return {}; },
  };
  let err: any = null;
  await saveCycle({ user: { id: 'u1', role: 'SUPER_ADMIN', orgId: 'orgA' }, params: { id: 'cB' }, body: { name: 'x', isDefault: true } } as any,
    { json: () => {} } as any, (e: any) => { err = e; });
  assert.equal(err?.statusCode, 404);
  assert.deepEqual(writes, []);
});

test('fieldEscalations: a masked caller cannot hand out an unmasked role', () => {
  const { fieldEscalations, SENSITIVE_FIELD_DEFAULTS } = require('../../src/utils/permissions');
  const masked = new Map<string, string>();
  const allMaskedRows: any[] = [];
  for (const [resource, fields] of Object.entries(SENSITIVE_FIELD_DEFAULTS) as any) {
    for (const f of fields) { masked.set(`${resource}.${f}`, 'MASKED'); allMaskedRows.push({ resource, field: f, access: 'MASKED' }); }
  }
  // HR Manager / custom role with no masks → refused
  assert.ok(fieldEscalations(masked, []).includes('employee.bankAccountNumber'));
  // Built-in roles carrying the same masks → allowed
  assert.deepEqual(fieldEscalations(masked, allMaskedRows), []);
  // A caller who sees everything may assign anything
  assert.deepEqual(fieldEscalations(new Map(), []), []);
  // HIDDEN is stricter than MASKED
  assert.deepEqual(fieldEscalations(new Map([['employee.taxId', 'HIDDEN']]), [{ resource: 'employee', field: 'taxId', access: 'MASKED' }]), ['employee.taxId']);
});
