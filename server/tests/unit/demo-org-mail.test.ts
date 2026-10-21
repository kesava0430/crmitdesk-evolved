/**
 * SEC-INFRA — the public demo can't be used as a phishing relay.
 *
 * POST /auth/demo-login gives any anonymous visitor a SUPER_ADMIN session in
 * a demo org. From there, inviting victim@anywhere sent "You've been invited
 * to join <whatever the visitor typed in Branding>" from the platform's own
 * mail domain, with no quota (invites are essential mail). Mail from demo
 * orgs now only reaches the seeded demo mailboxes unless the operator sets
 * DEMO_ORG_EXTERNAL_EMAIL=true; real orgs are untouched.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../src/utils/prisma';
import { demoOrgMailBlocked, isDemoMailbox, _resetDemoOrgCache } from '../../src/utils/demoOrgs';

function orgs(map: Record<string, string>) {
  (prisma as any).organization = {
    findUnique: async ({ where }: any) => (map[where.id] ? { slug: map[where.id] } : null),
  };
  _resetDemoOrgCache();
}

test('demo mailboxes are recognised', () => {
  assert.equal(isDemoMailbox('admin@crmitdesk.com'), true);
  assert.equal(isDemoMailbox('Sales@Meridian-Health.demo'), true);
  assert.equal(isDemoMailbox('victim@gmail.com'), false);
  assert.equal(isDemoMailbox('x@demo.evil.com'), false);
});

test('demo org mail to an outside address is blocked', async () => {
  delete process.env.DEMO_ORG_EXTERNAL_EMAIL;
  orgs({ d1: 'techcorp', r1: 'acme-industries' });
  assert.equal(await demoOrgMailBlocked('d1', 'victim@gmail.com'), true);
  assert.equal(await demoOrgMailBlocked('d1', 'admin@crmitdesk.com, victim@gmail.com'), true);
});

test('demo org mail between demo mailboxes still flows', async () => {
  orgs({ d1: 'techcorp' });
  assert.equal(await demoOrgMailBlocked('d1', 'itagent@crmitdesk.com'), false);
});

test('real orgs and platform mail are never blocked', async () => {
  orgs({ r1: 'acme-industries', r2: 'techcorp-1' });
  assert.equal(await demoOrgMailBlocked('r1', 'someone@gmail.com'), false);
  assert.equal(await demoOrgMailBlocked('r2', 'someone@gmail.com'), false);
  assert.equal(await demoOrgMailBlocked(undefined, 'someone@gmail.com'), false);
});

test('operator can opt demo orgs back in', async () => {
  orgs({ d1: 'techcorp' });
  process.env.DEMO_ORG_EXTERNAL_EMAIL = 'true';
  try {
    assert.equal(await demoOrgMailBlocked('d1', 'victim@gmail.com'), false);
  } finally {
    delete process.env.DEMO_ORG_EXTERNAL_EMAIL;
  }
});

test('a failed org lookup never blocks mail', async () => {
  (prisma as any).organization = { findUnique: async () => { throw new Error('db down'); } };
  _resetDemoOrgCache();
  assert.equal(await demoOrgMailBlocked('x1', 'someone@gmail.com'), false);
});
