/**
 * SEC-INFRA — integration credentials are encrypted at rest.
 *
 * The per-org Twilio auth token (WhatsAppConfig.authToken) and each user's
 * Google Calendar OAuth tokens (CalendarConnection) were written to the
 * database as plain text, unlike mailbox passwords, Drive/S3 credentials and
 * Slack secrets. Anyone with a database dump or backup could send WhatsApp
 * messages as the org and read/write staff calendars. They now go through
 * encryptSecret(), and rows saved before the change (plain text) still work.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../src/utils/prisma';
import { connectWhatsApp, twilioWebhook } from '../../src/modules/inbox/inbox.controller';
import { twilioSignature } from '../../src/utils/assistantChannels/signatures';
import { decryptSecret } from '../../src/utils/crypto';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-encryption-key-123456';

function run(handler: any, req: any): Promise<{ body: any; status: number; err: any }> {
  return new Promise(resolve => {
    const out = { body: undefined as any, status: 200, err: null as any };
    const res: any = {
      status(c: number) { out.status = c; return res; },
      json(b: any) { out.body = b; resolve(out); return res; },
      send(b: any) { out.body = b; resolve(out); return res; },
    };
    handler(req, res, (e: any) => { out.err = e; resolve(out); });
  });
}

test('connectWhatsApp stores the Twilio auth token encrypted', async () => {
  let saved: any = null;
  (prisma as any).whatsAppConfig = {
    upsert: async (args: any) => { saved = args; return { id: 'w1', accountSid: 'AC1', phoneNumber: '+1555', notifyNumber: null }; },
  };
  const { err, body } = await run(connectWhatsApp, {
    user: { orgId: 'o1' },
    body: { accountSid: 'AC1', authToken: 'twilio-live-token', phoneNumber: '+1555' },
  });
  assert.equal(err, null);
  assert.notEqual(saved.create.authToken, 'twilio-live-token');
  assert.notEqual(saved.update.authToken, 'twilio-live-token');
  assert.equal(decryptSecret(saved.create.authToken), 'twilio-live-token');
  assert.equal(JSON.stringify(body).includes('twilio-live-token'), false);
});

function webhookReq(authToken: string, signWith: string) {
  const params = { From: 'whatsapp:+1999', To: 'whatsapp:+1555', Body: 'hi', MessageSid: 'SM1' };
  const host = 'api.example.com';
  const url = `https://${host}/api/inbox/whatsapp/webhook`;
  const sig = twilioSignature(url, params, signWith);
  return {
    body: params,
    originalUrl: '/api/inbox/whatsapp/webhook',
    protocol: 'https',
    header: (h: string) => ({ 'x-twilio-signature': sig, 'x-forwarded-proto': 'https', 'x-forwarded-host': host } as any)[h.toLowerCase()],
    get: () => host,
    _authToken: authToken,
  };
}

async function webhookWithStoredToken(stored: string, signWith: string) {
  (prisma as any).whatsAppConfig = { findFirst: async () => ({ orgId: 'o1', phoneNumber: '+1555', authToken: stored }) };
  (prisma as any).assistantChannelConfig = { findUnique: async () => null };
  // Past the signature check the handler writes the message; stop it there.
  (prisma as any).conversation = { findFirst: async () => { throw new Error('reached-inbox'); } };
  return run(twilioWebhook, webhookReq(stored, signWith));
}

test('Twilio webhook verifies signatures against the decrypted token', async () => {
  const { encryptSecret } = await import('../../src/utils/crypto');
  const ok = await webhookWithStoredToken(encryptSecret('tok-123'), 'tok-123');
  assert.equal(ok.err?.message, 'reached-inbox', 'valid signature must pass');
  const bad = await webhookWithStoredToken(encryptSecret('tok-123'), 'wrong');
  assert.equal(bad.status, 403);
});

test('Twilio webhook still accepts tokens saved in plain text before encryption', async () => {
  const ok = await webhookWithStoredToken('legacy-plain-token', 'legacy-plain-token');
  assert.equal(ok.err?.message, 'reached-inbox');
});
