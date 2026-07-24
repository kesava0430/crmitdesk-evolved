import https from 'https';
import { prisma } from './prisma';

/**
 * Low-level Twilio REST call (no SDK — direct HTTPS request). Mirrors the
 * private sendTwilioMessage() in inbox.controller.ts (kept separate rather
 * than refactored to share code, to avoid touching the already-working
 * Inbox WhatsApp reply flow) — used here by the Schedule poller and the
 * workflow engine's SEND_WHATSAPP action, neither of which has an existing
 * Conversation to reply on.
 */
async function sendTwilioMessage(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string,
): Promise<{ sid: string }> {
  const params = new URLSearchParams({ From: from, To: to, Body: body }).toString();
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(json.message || `Twilio error (${res.statusCode})`));
            } else {
              resolve({ sid: json.sid });
            }
          } catch {
            reject(new Error('Invalid Twilio response'));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(params);
    req.end();
  });
}

/**
 * Sends a WhatsApp message on behalf of an org, using whatever WhatsApp
 * account is connected under Inbox → Settings (the same Twilio config
 * two-way conversations already use). Reused by the Schedule poller and the
 * workflow engine's SEND_WHATSAPP action — neither of those has a
 * "conversation" to hang off of, so this takes a raw phone number instead.
 *
 * `toNumber` should be a plain E.164 number (e.g. +14155551234) — the
 * `whatsapp:` prefix Twilio requires is added here.
 */
export async function sendWhatsApp(orgId: string, toNumber: string, body: string): Promise<{ sid: string }> {
  const waConfig = await prisma.whatsAppConfig.findUnique({ where: { orgId } });
  if (!waConfig) throw new Error('No WhatsApp account connected for this organization. Go to Inbox → Settings.');
  if (!toNumber) throw new Error('No recipient phone number available.');

  const to = toNumber.startsWith('whatsapp:') ? toNumber : `whatsapp:${toNumber}`;
  const from = waConfig.phoneNumber.startsWith('whatsapp:') ? waConfig.phoneNumber : `whatsapp:${waConfig.phoneNumber}`;

  return sendTwilioMessage(waConfig.accountSid, waConfig.authToken, from, to, body);
}
