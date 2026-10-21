import qs from 'qs';

/**
 * Express's default ("extended") query parser turns `?status[not]=CLOSED`
 * into `{ status: { not: 'CLOSED' } }`. Controllers read query values as
 * strings and drop them straight into Prisma where-clauses
 * (`if (status) where.status = status`), so a caller could inject Prisma
 * operators — `not`, `in`, `startsWith`, `contains` (a blind oracle on
 * whatever column the filter targets) — that the code never meant to offer.
 *
 * The app only ever sends flat values and repeated keys / `a[]=` arrays, so
 * this keeps exactly those: strings, and arrays of strings. Any nested
 * object (incl. arrays qs had to turn into objects) is dropped, as if the
 * parameter had not been sent.
 */
export function parseQueryString(str: string): Record<string, string | string[]> {
  const parsed = qs.parse(str, { allowPrototypes: false, depth: 1, arrayLimit: 100, parameterLimit: 1000 });
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) {
      const strings = v.filter((x): x is string => typeof x === 'string');
      if (strings.length) out[k] = strings;
    }
  }
  return out;
}
