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
