/**
 * Org-specific currency/time-zone formatting. Every $ amount and date/time
 * in the app should go through these rather than a bare `.toLocaleString()`
 * or a hardcoded `$${value}` template, both of which silently assumed USD
 * and the viewer's own browser time zone regardless of what org they're in.
 * Stored dates stay UTC in Postgres either way — this only ever affects
 * display formatting, never what's persisted.
 *
 * Prefer the useFormat() hook (hooks/useFormat.ts) over calling these
 * directly — it already knows the current org's currency/timezone, so call
 * sites don't each need their own useOrgSettings() + fallback boilerplate.
 * These are exported directly for the few places (PDF generation, printable
 * pages) that already have an explicit currency/timezone value in hand and
 * don't want the extra query.
 */

export function formatCurrency(value: number | string | null | undefined, currency = 'USD'): string {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(safe);
  } catch {
    // An org setting that somehow isn't a currency Intl recognizes
    // shouldn't take the whole page down — fall back to a plain number
    // prefixed with the code instead of a formatted symbol.
    return `${currency} ${safe.toLocaleString()}`;
  }
}

/** Just the currency symbol/prefix (e.g. "$", "€", "₹") — for the rare
 *  layout that builds its own structure around a bare number rather than
 *  calling formatCurrency for the whole string. Prefer formatCurrency. */
export function currencySymbol(currency = 'USD'): string {
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0);
    return parts.find(p => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(value: string | number | Date | null | undefined, timezone = 'UTC'): string {
  const d = toDate(value);
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric' }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

export function formatDateTime(value: string | number | Date | null | undefined, timezone = 'UTC'): string {
  const d = toDate(value);
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function formatTime(value: string | number | Date | null | undefined, timezone = 'UTC'): string {
  const d = toDate(value);
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}
