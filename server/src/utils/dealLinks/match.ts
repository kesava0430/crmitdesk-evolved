/**
 * "Related deals" matching rules — pure logic, no database.
 *
 * Owner's scenario (a construction company): two deals on the same flat were
 * lost, a third deal on that flat comes in, and whoever works it should see
 * the first two and why they were lost. "The same flat" is whatever the org
 * says it is: one or more fields two deals must share — a DEAL custom field
 * such as "Flat / Unit", or the deal's Account / Contact / Pipeline.
 *
 * Matching is on the stored value only (no guessing from titles): ids for
 * Account/Contact/Pipeline, and for custom-field text the value lower-cased
 * with surrounding whitespace trimmed and inner runs of whitespace collapsed,
 * so "Tower B - 502" and " tower b  -  502 " are the same unit. The SQL in
 * service.ts mirrors normaliseValue() exactly — change both together.
 */
import { z } from 'zod';

export const LinkFieldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('custom'), fieldId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('account') }),
  z.object({ kind: z.literal('contact') }),
  z.object({ kind: z.literal('pipeline') }),
]);
export type LinkField = z.infer<typeof LinkFieldSchema>;

export const LinkRuleSchema = z.object({
  fields: z.array(LinkFieldSchema).max(5),
  mode: z.enum(['ALL', 'ANY']).default('ALL'),
});
export type LinkRule = z.infer<typeof LinkRuleSchema>;

/** Stable identity of one rule field, e.g. "custom:ck…" or "account". */
export function linkFieldKey(f: LinkField): string {
  return f.kind === 'custom' ? `custom:${f.fieldId}` : f.kind;
}

/** Drops duplicate fields (same key twice would be a no-op AND, a confusing ANY). */
export function dedupeFields(fields: LinkField[]): LinkField[] {
  const seen = new Set<string>();
  return fields.filter(f => {
    const k = linkFieldKey(f);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Parse a stored row leniently: a malformed row reads as "not set up", never a crash. */
export function parseStoredRule(row: { fields: unknown; mode: string } | null | undefined): LinkRule | null {
  if (!row) return null;
  const p = LinkRuleSchema.safeParse({ fields: row.fields, mode: row.mode });
  if (!p.success || !p.data.fields.length) return null;
  return { ...p.data, fields: dedupeFields(p.data.fields) };
}

/** Case- and whitespace-insensitive form of a text value; null when blank. */
export function normaliseValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ').toLowerCase();
  return s ? s : null;
}

/** The facts about one deal that matching looks at. */
export interface MatchableDeal {
  id: string;
  accountId?: string | null;
  contactId?: string | null;
  pipelineId?: string | null;
  /** Custom field values keyed by CustomField.id (raw, un-normalised). */
  custom?: Record<string, string | null | undefined>;
}

/** The comparable value a deal has for one rule field (null = no value). */
export function valueFor(f: LinkField, d: MatchableDeal): string | null {
  switch (f.kind) {
    case 'account': return d.accountId || null;
    case 'contact': return d.contactId || null;
    case 'pipeline': return d.pipelineId || null;
    case 'custom': return normaliseValue(d.custom?.[f.fieldId]);
  }
}

export interface MatchKeys {
  /** Fields with a value on this deal, and that value. */
  present: Array<{ field: LinkField; value: string }>;
  /** Fields this deal has no value for. */
  missing: LinkField[];
  /** Whether matching can run at all: ALL needs every field, ANY needs one. */
  usable: boolean;
}

export function matchKeys(rule: LinkRule, d: MatchableDeal): MatchKeys {
  const present: MatchKeys['present'] = [];
  const missing: LinkField[] = [];
  for (const f of rule.fields) {
    const v = valueFor(f, d);
    if (v === null) missing.push(f);
    else present.push({ field: f, value: v });
  }
  const usable = rule.fields.length > 0 && (rule.mode === 'ALL' ? missing.length === 0 : present.length > 0);
  return { present, missing, usable };
}

/** True when `other` is related to `base` under the rule. A deal is never related to itself. */
export function dealsMatch(rule: LinkRule, base: MatchableDeal, other: MatchableDeal): boolean {
  if (base.id === other.id) return false;
  const k = matchKeys(rule, base);
  if (!k.usable) return false;
  const hits = k.present.map(p => valueFor(p.field, other) === p.value);
  return rule.mode === 'ALL' ? hits.every(Boolean) : hits.some(Boolean);
}

/**
 * Combines per-field candidate id sets: intersection for ALL, union for ANY.
 * The database does the per-field lookups; this decides how they combine.
 */
export function combineCandidates(mode: LinkRule['mode'], sets: Array<Set<string>>, excludeId?: string): Set<string> {
  let out: Set<string>;
  if (!sets.length) out = new Set();
  else if (mode === 'ALL') {
    const [first, ...rest] = [...sets].sort((a, b) => a.size - b.size);
    out = new Set([...first].filter(id => rest.every(s => s.has(id))));
  } else {
    out = new Set(sets.flatMap(s => [...s]));
  }
  if (excludeId) out.delete(excludeId);
  return out;
}

/**
 * For every deal in `targets`, how many related deals in `pool` are lost / won.
 * Used for the board-card and create-form hints; `pool` must already be
 * limited to deals the viewer may see.
 */
export function relatedOutcomeCounts(
  rule: LinkRule,
  targets: MatchableDeal[],
  pool: Array<MatchableDeal & { status: string }>,
): Map<string, { lost: number; won: number; open: number }> {
  const out = new Map<string, { lost: number; won: number; open: number }>();
  // Index the pool by each field's value once, so this is linear rather than
  // targets × pool comparisons.
  const index = new Map<string, Map<string, string[]>>();
  for (const f of rule.fields) {
    const byValue = new Map<string, string[]>();
    for (const d of pool) {
      const v = valueFor(f, d);
      if (v === null) continue;
      const list = byValue.get(v);
      if (list) list.push(d.id); else byValue.set(v, [d.id]);
    }
    index.set(linkFieldKey(f), byValue);
  }
  const statusOf = new Map(pool.map(d => [d.id, d.status]));
  for (const t of targets) {
    const k = matchKeys(rule, t);
    if (!k.usable) continue;
    const sets = k.present.map(p => new Set(index.get(linkFieldKey(p.field))?.get(p.value) ?? []));
    const ids = combineCandidates(rule.mode, sets, t.id);
    const c = { lost: 0, won: 0, open: 0 };
    for (const id of ids) {
      const s = statusOf.get(id);
      if (s === 'LOST') c.lost++; else if (s === 'WON') c.won++; else if (s === 'OPEN') c.open++;
    }
    if (c.lost || c.won || c.open) out.set(t.id, c);
  }
  return out;
}
