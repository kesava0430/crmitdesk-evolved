/**
 * Phone numbers for the WhatsApp assistant — pure and unit-tested.
 *
 * Twilio always reports the sender as `whatsapp:+<E.164>`. Profile phones are
 * typed by people ("+91 98765 43210", "098765 43210", "9876543210"), so the
 * two are compared leniently here — but a number only ever reaches org data
 * after the person has proven they hold it (a one-time code sent FROM that
 * phone, see identity.ts), and the link stores the exact E.164 Twilio saw.
 */

/** "whatsapp:+1 (415) 555-1234" → "+14155551234"; "0044…" → "+44…". Null when not international. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^whatsapp:/i, '').trim();
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) return null;
  const digits = s.replace(/\D/g, '');
  // E.164: up to 15 digits; shorter than 8 can't be a real subscriber number.
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  return `+${digits}`;
}

/**
 * Whether a phone typed on a profile denotes the (E.164) sender.
 *  - Profile in international form → must be the identical number.
 *  - Profile in national form ("098765 43210", "9876543210") → the sender
 *    must end with it once trunk zeros are dropped, and it must be long
 *    enough (≥ 8 digits) not to match by accident.
 */
export function phoneMatches(profilePhone: string | null | undefined, senderE164: string | null | undefined): boolean {
  const sender = toE164(senderE164);
  if (!sender || !profilePhone) return false;
  const intl = toE164(profilePhone);
  if (intl) return intl === sender;
  const national = String(profilePhone).replace(/\D/g, '').replace(/^0+/, '');
  if (national.length < 8) return false;
  return sender.slice(1).endsWith(national) && sender.length - 1 > national.length;
}

/** "+919876543210" → "+91 ••••• 43210" for messages and logs. */
export function maskPhone(e164: string | null | undefined): string {
  const s = toE164(e164) ?? String(e164 ?? '');
  if (s.length < 7) return s;
  return `${s.slice(0, 3)} ${'•'.repeat(Math.max(0, s.length - 8))}${s.slice(-5)}`;
}
