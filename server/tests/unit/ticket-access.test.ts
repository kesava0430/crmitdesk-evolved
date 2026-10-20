/**
 * FIX — an EMPLOYEE could open any colleague's ticket by id.
 *
 * GET /itdesk/tickets (list) already limited an EMPLOYEE to tickets they
 * raised, but GET /itdesk/tickets/:id only checked the org, so the ticket
 * body, history and assignee of anyone else's ticket came back to whoever
 * guessed or was sent its id. getOne now applies the same requester scope.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../src/utils/prisma';
import { getOne } from '../../src/modules/itdesk/tickets/tickets.controller';

async function run(role: string) {
  let where: any = null;
  (prisma as any).ticket = { findFirst: async (args: any) => { where = args.where; return null; } };
  let err: any = null;
  await getOne({ user: { id: 'u1', role, orgId: 'org1' }, params: { id: 't1' } } as any, { json: () => {} } as any, (e: any) => { err = e; });
  return { where, err };
}

test('EMPLOYEE lookup is scoped to tickets they requested (404 otherwise)', async () => {
  const { where, err } = await run('EMPLOYEE');
  assert.deepEqual(where, { id: 't1', orgId: 'org1', requesterId: 'u1' });
  assert.equal(err?.statusCode, 404);
});

for (const role of ['SUPER_ADMIN', 'IT_MANAGER', 'IT_AGENT', 'CRM_MANAGER', 'SALES_REP']) {
  test(`${role} keeps org-wide ticket access`, async () => {
    const { where } = await run(role);
    assert.deepEqual(where, { id: 't1', orgId: 'org1' });
  });
}
