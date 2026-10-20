/**
 * FIX — the public quote page crashed right after the customer signed.
 *
 * POST /quotes/public/:id/accept answered with the quote + lines only, and
 * PublicQuotePage replaces its state with that response; it renders
 * quote.org.name, so the customer saw "Something went wrong" the moment they
 * accepted (the acceptance itself was saved). The response now has the same
 * shape as the public GET (lines, org, deal).
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../../src/utils/prisma';
import { publicAccept } from '../../src/modules/quotes/quotes.controller';

test('accept response includes org and deal like the public view', async () => {
  process.env.QUOTE_SHARE_SECRET = 'unit-secret';
  const token = crypto.createHmac('sha256', 'unit-secret').update('q1').digest('hex').slice(0, 32);
  let include: any = null;
  (prisma as any).quote = {
    findUnique: async () => ({ id: 'q1', status: 'SENT', orgId: 'o1' }),
    update: async (args: any) => { include = args.include; return { id: 'q1', orgId: 'o1', title: 'Q', lines: [], org: { name: 'Acme' } }; },
  };
  (prisma as any).invoice = { count: async () => 0, create: async () => ({}) };
  (prisma as any).workflowRule = { findMany: async () => [] };
  let body: any = null, err: any = null;
  await publicAccept(
    { params: { id: 'q1' }, body: { token, signerName: 'Jane Customer', signerEmail: 'jane@x.example', agreed: true }, ip: '1.2.3.4', socket: {} } as any,
    { json: (b: any) => { body = b; } } as any,
    (e: any) => { err = e; },
  );
  assert.equal(err, null);
  assert.equal(include.lines, true);
  assert.deepEqual(include.org, { select: { name: true, currency: true, timezone: true } });
  assert.deepEqual(include.deal, { select: { id: true, title: true } });
  assert.equal(body.org.name, 'Acme');
});
