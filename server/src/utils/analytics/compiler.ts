/**
 * Catalog resolution + spec → SQL compiler. Pure: no database access, so the
 * whole security story (org scoping, area gating, record scopes, field
 * redaction, limits) is unit-tested in tests/unit/analytics.test.ts.
 *
 * Safety model
 *  - Identifiers: every table, column and expression comes from catalog.ts.
 *    A spec only *selects* entries by key; unknown keys are rejected.
 *  - Values: every literal from a spec is a bind parameter ($n). The only
 *    words interpolated are enum-checked keywords (bucket names, asc/desc)
 *    and generated column aliases built from catalog keys.
 *  - Tenancy: `t.org_id = $1` is always the first predicate.
 *  - Rows: the existing permission engine's scopedWhere() output is
 *    translated to SQL over the dataset's own columns (scopeColumns); an
 *    unrecognised shape fails CLOSED (FALSE), never open.
 *  - Fields: a field the caller's role has HIDDEN/MASKED (FieldPermission
 *    rules, incl. the sensitive payroll defaults) is not in their catalog at
 *    all, so it can't be measured, grouped, filtered or listed.
 */
import { scopedWhere, scopeFor, type PermCtx } from '../permissions';
import type { DatasetDef, FieldDef, ParamSink, ResolvedDataset, Bucket } from './types';
import {
  resolveRange, comparisonRange, bucketStart, addUnits, enumerateBuckets, isValidTimeZone,
  type ResolvedRange, type DateRangeInput,
} from './dates';
import { LIMITS, type QuerySpec, type FilterSpec, type MeasureSpec } from './spec';

export class QueryError extends Error {
  constructor(message: string, public hints: string[] = []) { super(message); this.name = 'QueryError'; }
}

// ─── Catalog resolution (area gating + permissions + redaction) ─────────────

export interface ResolveInput {
  ctx: PermCtx;
  /** EffectiveLicense.blockedModules — modules switched off for the org. */
  blockedModules: readonly string[];
}

/**
 * The datasets (and fields) this caller may use. A dataset disappears when
 * its module is off for the org (HR-only org → no CRM datasets), when the
 * caller's role lacks the read permission (or the role list for custom
 * modules), or when it needs org-wide scope the caller doesn't have.
 */
export function resolveCatalog(defs: DatasetDef[], { ctx, blockedModules }: ResolveInput): ResolvedDataset[] {
  const out: ResolvedDataset[] = [];
  for (const def of defs) {
    if (def.module && blockedModules.includes(def.module)) continue;
    if (def.roles && !def.roles.includes(ctx.role)) continue;
    const scope = def.permission ? scopeFor(ctx, def.permission) : 'ALL';
    if (scope === 'NONE') continue;
    if (def.requireAllScope && scope !== 'ALL') continue;

    const redactedFields: string[] = [];
    const fields = def.fields.filter(f => {
      const pf = f.permField ?? f.key;
      const ruleKey = pf.includes('.') ? pf : def.fieldResource ? `${def.fieldResource}.${pf}` : null;
      const rule = ruleKey ? ctx.fieldRules.get(ruleKey) : undefined;
      if (rule === 'HIDDEN' || rule === 'MASKED') { redactedFields.push(f.key); return false; }
      return true;
    });

    const where = def.permission && def.scopeResource ? scopedWhere(ctx, def.scopeResource, def.permission) : {};
    out.push({
      def, fields, redactedFields, scope,
      scopeSql: (p: ParamSink) => translateScope(where, def.scopeColumns ?? {}, p),
    });
  }
  return out;
}

/**
 * Prisma where-fragment from scopedWhere() → SQL. Handles exactly the shapes
 * that function produces ({}, {id:'__no_access__'}, {col:{in:[…]}},
 * {col:value}, {OR:[…]}); anything else becomes FALSE.
 */
export function translateScope(where: Record<string, unknown>, columns: Record<string, string>, p: ParamSink): string {
  const keys = Object.keys(where);
  if (!keys.length) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = (where as any)[k];
    if (k === 'OR' && Array.isArray(v)) {
      const ors = v.map(x => translateScope(x, columns, p) || 'TRUE');
      parts.push(ors.length ? `(${ors.join(' OR ')})` : 'FALSE');
      continue;
    }
    if (k === 'id' && v === '__no_access__') { parts.push('FALSE'); continue; }
    const col = columns[k];
    if (!col) { parts.push('FALSE'); continue; }
    if (v && typeof v === 'object' && Array.isArray((v as any).in)) {
      const ids = ((v as any).in as unknown[]).filter(x => typeof x === 'string');
      parts.push(ids.length ? `${col} = ANY(${p.add(ids)}::text[])` : 'FALSE');
    } else if (typeof v === 'string') {
      parts.push(`${col} = ${p.add(v)}`);
    } else {
      parts.push('FALSE');
    }
  }
  return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
}

// ─── Output description ─────────────────────────────────────────────────────

export type ColumnFormat = 'number' | 'money' | 'date' | 'datetime' | 'text' | 'boolean' | 'enum';

/** IN_PROGRESS → In progress (enum values only — names like "IT" stay as they are). */
export function humanEnum(s: string): string {
  return /^[A-Z][A-Z0-9_]+$/.test(s) ? (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, ' ') : s;
}

export interface Column {
  key: string;
  label: string;
  role: 'dimension' | 'measure' | 'field';
  format: ColumnFormat;
  bucket?: Bucket;
  unit?: string;
  /** relation dimensions: the column holding the id behind the label. */
  idKey?: string;
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  kind: 'aggregate' | 'list';
  columns: Column[];
  dataset: { key: string; label: string };
  range: ResolvedRange;
  rangeField: { key: string; label: string } | null;
  /** The single date-bucket dimension, when the result is a time series. */
  bucket: { key: string; unit: Bucket } | null;
  limit: number;
  description: string;
  appliedFilters: string[];
  warnings: string[];
}

export interface CompileEnv {
  orgId: string;
  userId: string;
  timezone: string;
  /** Org-local today (dates.localToday). */
  today: string;
  /** Org currency — only used to write money filters in words ("over ₹50,000"). */
  currency?: string;
}

class Params implements ParamSink {
  values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const q = (alias: string) => {
  if (!ALIAS_RE.test(alias)) throw new QueryError(`Bad column alias ${alias}`);
  return `"${alias}"`;
};

function formatOf(f: FieldDef): ColumnFormat {
  switch (f.type) {
    case 'money': return 'money';
    case 'number': return 'number';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'boolean': return 'boolean';
    case 'enum': return 'enum';
    default: return 'text';
  }
}

function fieldOf(ds: ResolvedDataset, key: string | null | undefined, purpose: string): FieldDef {
  const f = key ? ds.fields.find(x => x.key === key) : undefined;
  if (f) return f;
  if (key && ds.redactedFields.includes(key)) {
    throw new QueryError(`"${key}" on ${ds.def.label} isn't available to your role, so it can't be used for ${purpose}.`);
  }
  throw new QueryError(`Unknown field "${key ?? ''}" on ${ds.def.label} (for ${purpose}).`,
    [`Fields: ${ds.fields.map(x => x.key).join(', ')}`]);
}

export function measureKey(m: MeasureSpec): string {
  if (m.fn === 'count') return 'count';
  return m.fn === 'count_distinct' ? `distinct_${m.field}` : `${m.fn}_${m.field}`;
}

function measureLabel(ds: ResolvedDataset, m: MeasureSpec, f?: FieldDef): string {
  switch (m.fn) {
    case 'count': return `Number of ${ds.def.label.toLowerCase()}`;
    case 'count_distinct': return `Distinct ${f!.label.toLowerCase()}`;
    case 'sum': return `Total ${f!.label.toLowerCase()}`;
    case 'avg': return `Average ${f!.label.toLowerCase()}`;
    case 'min': return `Lowest ${f!.label.toLowerCase()}`;
    case 'max': return `Highest ${f!.label.toLowerCase()}`;
  }
}

/** Default window for a time series with no date range (kept honest in the description). */
const DEFAULT_SERIES_RANGE: Record<Bucket, DateRangeInput> = {
  day: { preset: 'last_30_days' },
  week: { last: { n: 12, unit: 'week' } },
  month: { last: { n: 12, unit: 'month' } },
  quarter: { last: { n: 8, unit: 'quarter' } },
  year: { preset: 'all_time' },
};

function toRangeInput(r: QuerySpec['dateRange']): DateRangeInput | undefined {
  if (!r) return undefined;
  const out: DateRangeInput = {};
  if (r.preset) out.preset = r.preset as DateRangeInput['preset'];
  if (r.last) out.last = r.last;
  if (r.includeCurrent != null) out.includeCurrent = r.includeCurrent;
  if (r.from) out.from = r.from;
  if (r.to) out.to = r.to;
  return out.preset || out.last || out.from || out.to ? out : undefined;
}

// ─── SQL fragments ──────────────────────────────────────────────────────────

/** Local-time expression of a field (TIMESTAMP columns hold UTC). */
function localExpr(f: FieldDef, tz: () => string): string {
  return f.type === 'datetime' ? `((${f.sql}) AT TIME ZONE 'UTC') AT TIME ZONE ${tz()}` : `(${f.sql})::timestamp`;
}

function bucketExpr(f: FieldDef, unit: Bucket, tz: () => string): string {
  return `to_char(date_trunc('${unit}', ${localExpr(f, tz)}), 'YYYY-MM-DD')`;
}

/** `field >= local date` (inclusive) or `<` (exclusive), index-friendly for TIMESTAMP columns. */
function dateBound(f: FieldDef, op: '>=' | '<', date: string, p: ParamSink, tz: () => string): string {
  if (f.type === 'datetime') return `${f.sql} ${op} ((${p.add(date)}::timestamp AT TIME ZONE ${tz()}) AT TIME ZONE 'UTC')`;
  return `${f.sql} ${op} ${p.add(date)}::date`;
}

function rangeSql(f: FieldDef, r: ResolvedRange, p: ParamSink, tz: () => string): string[] {
  const out: string[] = [];
  if (r.from) out.push(dateBound(f, '>=', r.from, p, tz));
  if (r.toExclusive) out.push(dateBound(f, '<', r.toExclusive, p, tz));
  return out;
}

function numText(n: number, f: FieldDef, env: CompileEnv): string {
  const cur = env.currency || 'USD';
  const loc = cur === 'INR' ? 'en-IN' : 'en-US';
  if (f.type === 'money') {
    try { return new Intl.NumberFormat(loc, { style: 'currency', currency: cur, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n); } catch { /* fallthrough */ }
  }
  return new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(n);
}

function asNumber(v: unknown, field: FieldDef): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s₹$€£]/g, '')) : NaN;
  if (!Number.isFinite(n)) throw new QueryError(`"${String(v)}" isn't a number (filter on ${field.label}).`);
  return n;
}

function asDate(v: unknown, field: FieldDef): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new QueryError(`"${String(v)}" isn't a YYYY-MM-DD date (filter on ${field.label}).`);
  return v;
}

function asBool(v: unknown, field: FieldDef): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'yes' || v === 1) return true;
  if (v === 'false' || v === 'no' || v === 0) return false;
  throw new QueryError(`"${String(v)}" isn't true/false (filter on ${field.label}).`);
}

function enumValue(v: unknown, field: FieldDef): string {
  const s = String(v ?? '').trim();
  const hit = field.values!.find(x => x.toLowerCase() === s.toLowerCase() || x.toLowerCase() === s.toLowerCase().replace(/[\s-]+/g, '_'));
  if (!hit) throw new QueryError(`"${s}" isn't a valid ${field.label} (one of ${field.values!.join(', ')}).`);
  return hit;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

function filterSql(ds: ResolvedDataset, flt: FilterSpec, p: ParamSink, env: CompileEnv, tz: () => string): { sql: string; text: string; joins: string[] } {
  const f = fieldOf(ds, flt.field, 'filtering');
  if (f.filterable === false) throw new QueryError(`${f.label} can't be filtered on.`);
  const joins = f.joins ?? [];
  const op = flt.op;
  const L = f.label;
  if (op === 'is_null') return { sql: `${f.sql} IS NULL`, text: `${L} is empty`, joins };
  if (op === 'not_null') return { sql: `${f.sql} IS NOT NULL`, text: `${L} is set`, joins };
  const vals = list(flt.value);
  if (!vals.length) throw new QueryError(`Filter on ${L} needs a value.`);

  switch (f.type) {
    case 'enum': {
      if (!['eq', 'neq', 'in', 'not_in'].includes(op)) throw new QueryError(`${L} supports eq / neq / in / not_in.`);
      const vs = vals.map(v => enumValue(v, f));
      const neg = op === 'neq' || op === 'not_in';
      return { sql: `${f.sql}::text ${neg ? '<>' : '='} ${neg ? 'ALL' : 'ANY'}(${p.add(vs)}::text[])`, text: `${L} ${neg ? 'is not' : 'is'} ${vs.map(humanEnum).join(' or ')}`, joins };
    }
    case 'string': {
      if (op === 'contains') {
        const s = String(vals[0]);
        return { sql: `${f.sql} ILIKE ${p.add(`%${likeEscape(s)}%`)}`, text: `${L} contains "${s}"`, joins };
      }
      if (!['eq', 'neq', 'in', 'not_in'].includes(op)) throw new QueryError(`${L} supports eq / neq / in / not_in / contains.`);
      const vs = vals.map(v => String(v).toLowerCase());
      const neg = op === 'neq' || op === 'not_in';
      return { sql: `lower(${f.sql}) ${neg ? '<>' : '='} ${neg ? 'ALL' : 'ANY'}(${p.add(vs)}::text[])`, text: `${L} ${neg ? 'is not' : 'is'} ${vals.join(' or ')}`, joins };
    }
    case 'relation': {
      const label = f.labelSql ?? f.sql;
      if (op === 'contains') {
        const s = String(vals[0]);
        return { sql: `${label} ILIKE ${p.add(`%${likeEscape(s)}%`)}`, text: `${L} contains "${s}"`, joins };
      }
      if (!['eq', 'neq', 'in', 'not_in'].includes(op)) throw new QueryError(`${L} supports eq / neq / in / not_in / contains.`);
      // "me" = the caller (user relations only); other values match the id or the label, case-insensitively.
      const ids: string[] = [], names: string[] = [];
      for (const v of vals) {
        const s = String(v).trim();
        if (f.isUser && s.toLowerCase() === 'me') ids.push(env.userId); else { ids.push(s); names.push(s.toLowerCase()); }
      }
      const neg = op === 'neq' || op === 'not_in';
      const pos = `(${f.sql} = ANY(${p.add(ids)}::text[]) OR lower(${label}) = ANY(${p.add(names)}::text[]))`;
      const text = `${L} ${neg ? 'is not' : 'is'} ${vals.map(v => (f.isUser && String(v).toLowerCase() === 'me' ? 'you' : String(v))).join(' or ')}`;
      return { sql: neg ? `(${f.sql} IS NULL OR NOT ${pos})` : pos, text, joins };
    }
    case 'boolean': {
      if (op !== 'eq' && op !== 'neq') throw new QueryError(`${L} supports eq / neq.`);
      let b = asBool(vals[0], f);
      if (op === 'neq') b = !b;
      return { sql: b ? `(${f.sql}) IS TRUE` : `(${f.sql}) IS NOT TRUE`, text: booleanPhrase(L, b), joins };
    }
    case 'number': case 'money': {
      const cmp: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      if (op === 'between') {
        if (vals.length !== 2) throw new QueryError(`"between" on ${L} needs two values.`);
        const [a, b] = vals.map(v => asNumber(v, f));
        return { sql: `${f.sql} BETWEEN ${p.add(a)}::numeric AND ${p.add(b)}::numeric`, text: `${L} between ${numText(a, f, env)} and ${numText(b, f, env)}`, joins };
      }
      if (op === 'in' || op === 'not_in') {
        const ns = vals.map(v => asNumber(v, f));
        return { sql: `${f.sql} ${op === 'in' ? '=' : '<>'} ${op === 'in' ? 'ANY' : 'ALL'}(${p.add(ns)}::numeric[])`, text: `${L} ${op === 'in' ? 'in' : 'not in'} ${ns.map(x => numText(x, f, env)).join(', ')}`, joins };
      }
      if (!cmp[op]) throw new QueryError(`${L} supports eq / neq / gt / gte / lt / lte / between.`);
      const n = asNumber(vals[0], f);
      const words: Record<string, string> = { eq: 'is', neq: 'is not', gt: 'over', gte: 'at least', lt: 'under', lte: 'at most' };
      return { sql: `${f.sql} ${cmp[op]} ${p.add(n)}::numeric`, text: `${L} ${words[op]} ${numText(n, f, env)}`, joins };
    }
    case 'date': case 'datetime': {
      const d = (v: unknown) => asDate(v, f);
      const next = (s: string) => addUnits(s, 'day', 1);
      switch (op) {
        case 'eq': { const a = d(vals[0]); return { sql: [dateBound(f, '>=', a, p, tz), dateBound(f, '<', next(a), p, tz)].join(' AND '), text: `${L} on ${a}`, joins }; }
        case 'gt': { const a = d(vals[0]); return { sql: dateBound(f, '>=', next(a), p, tz), text: `${L} after ${a}`, joins }; }
        case 'gte': { const a = d(vals[0]); return { sql: dateBound(f, '>=', a, p, tz), text: `${L} on or after ${a}`, joins }; }
        case 'lt': { const a = d(vals[0]); return { sql: dateBound(f, '<', a, p, tz), text: `${L} before ${a}`, joins }; }
        case 'lte': { const a = d(vals[0]); return { sql: dateBound(f, '<', next(a), p, tz), text: `${L} on or before ${a}`, joins }; }
        case 'between': {
          if (vals.length !== 2) throw new QueryError(`"between" on ${L} needs two dates.`);
          const [a, b] = vals.map(d);
          return { sql: [dateBound(f, '>=', a, p, tz), dateBound(f, '<', next(b), p, tz)].join(' AND '), text: `${L} between ${a} and ${b}`, joins };
        }
        default: throw new QueryError(`${L} supports eq / gt / gte / lt / lte / between (dates as YYYY-MM-DD) — use dateRange for relative periods.`);
      }
    }
  }
}

function collectJoins(def: DatasetDef, keys: string[]): string[] {
  const order: string[] = [];
  const visit = (k: string, depth = 0) => {
    if (order.includes(k) || depth > 5) return;
    if (!def.joins?.[k]) throw new QueryError(`Internal: dataset ${def.key} has no join "${k}"`);
    for (const r of def.joinRequires?.[k] ?? []) visit(r, depth + 1);
    order.push(k);
  };
  for (const k of [...(def.alwaysJoins ?? []), ...keys]) visit(k);
  return order.map(k => def.joins![k]);
}

// ─── Compile ────────────────────────────────────────────────────────────────

export interface CompileOptions {
  /** Override the resolved date range (comparison periods, forecast history windows). */
  rangeOverride?: ResolvedRange;
  /** Skip dimensions (used for the totals row). */
  totalsOnly?: boolean;
}

export function resolveSpecRange(ds: ResolvedDataset, spec: QuerySpec, env: CompileEnv): { range: ResolvedRange; field: FieldDef | null; defaulted: boolean } {
  const bucketDim = spec.mode === 'aggregate' ? spec.dimensions.find(d => d.bucket) : undefined;
  const fieldKey = spec.dateRange?.field || bucketDim?.field || ds.def.defaultDate;
  const input = toRangeInput(spec.dateRange);
  const field = fieldOf(ds, fieldKey, 'the date range');
  if (field.type !== 'date' && field.type !== 'datetime') throw new QueryError(`${field.label} isn't a date field.`);
  if (!input && bucketDim?.bucket) {
    return { range: resolveRange(DEFAULT_SERIES_RANGE[bucketDim.bucket], env.today), field, defaulted: true };
  }
  return { range: resolveRange(input, env.today), field: input ? field : null, defaulted: false };
}

export function compileQuery(ds: ResolvedDataset, spec: QuerySpec, env: CompileEnv, opts: CompileOptions = {}): CompiledQuery {
  if (!isValidTimeZone(env.timezone)) throw new QueryError(`Unknown time zone ${env.timezone}`);
  const p = new Params();
  const orgP = p.add(env.orgId);
  // Bound only when an expression needs it (Postgres rejects unused parameters).
  let tzRef: string | null = null;
  const tz = () => (tzRef ??= `${p.add(env.timezone)}::text`);
  const warnings: string[] = [];
  const joinKeys: string[] = [];
  const where: string[] = [`t.org_id = ${orgP}`];

  const scope = ds.scopeSql(p);
  if (scope) where.push(scope);
  if (ds.def.baseWhere) where.push(ds.def.baseWhere(p));

  // Date range
  const rr = resolveSpecRange(ds, spec, env);
  const range = opts.rangeOverride ?? rr.range;
  const rangeField = rr.field ?? (range.from || range.toExclusive ? fieldOf(ds, spec.dateRange?.field || ds.def.defaultDate, 'the date range') : null);
  if (rr.defaulted && !opts.rangeOverride) warnings.push(`No period was given, so this shows the ${range.label}.`);
  if (rangeField) {
    joinKeys.push(...(rangeField.joins ?? []));
    where.push(...rangeSql(rangeField, range, p, tz));
  }

  // Filters
  const appliedFilters: string[] = [];
  for (const flt of spec.filters) {
    const r = filterSql(ds, flt, p, env, tz);
    where.push(r.sql);
    joinKeys.push(...r.joins);
    appliedFilters.push(r.text);
  }

  const columns: Column[] = [];
  const select: string[] = [];
  let groupBy: string[] = [];
  let orderBy = '';
  let bucket = null as CompiledQuery['bucket'];
  let limit: number;

  if (spec.mode === 'list') {
    const keys = spec.fields.length ? spec.fields : ds.fields.filter(f => f.listDefault).map(f => f.key);
    if (!keys.length) keys.push(...ds.fields.slice(0, 6).map(f => f.key));
    for (const k of [...new Set(keys)]) {
      const f = fieldOf(ds, k, 'listing');
      joinKeys.push(...(f.joins ?? []));
      const expr = f.type === 'relation' ? (f.labelSql ?? f.sql)
        : f.type === 'datetime' ? `to_char(((${f.sql}) AT TIME ZONE 'UTC') AT TIME ZONE ${tz()}, 'YYYY-MM-DD HH24:MI')`
        : f.type === 'date' ? `to_char(${f.sql}, 'YYYY-MM-DD')`
        : f.type === 'number' || f.type === 'money' ? `ROUND((${f.sql})::numeric, 2)::float8`
        : f.sql;
      select.push(`${expr} AS ${q(f.key)}`);
      columns.push({ key: f.key, label: f.label, role: 'field', format: formatOf(f), unit: f.unit });
    }
    select.push(`t.id AS "__id"`);
    limit = Math.min(spec.limit ?? LIMITS.defaultRows, LIMITS.maxRows);
    const sortKey = spec.sort?.by;
    if (sortKey) {
      const f = fieldOf(ds, sortKey, 'sorting');
      joinKeys.push(...(f.joins ?? []));
      orderBy = `${f.type === 'relation' ? (f.labelSql ?? f.sql) : f.sql} ${spec.sort!.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
    } else {
      const df = rangeField ?? ds.fields.find(f => f.key === ds.def.defaultDate);
      orderBy = df ? `${df.sql} DESC NULLS LAST` : 't.id';
    }
  } else {
    // Measures
    if (!spec.measures.length) throw new QueryError('An aggregate query needs at least one measure.');
    const mkeys = new Set<string>();
    for (const m of spec.measures) {
      let f: FieldDef | undefined;
      let expr: string;
      if (m.fn === 'count') expr = 'COUNT(*)';
      else {
        f = fieldOf(ds, m.field, `${m.fn}`);
        joinKeys.push(...(f.joins ?? []));
        if (m.fn === 'count_distinct') expr = `COUNT(DISTINCT ${f.sql})`;
        else {
          if (f.type !== 'number' && f.type !== 'money') throw new QueryError(`Can't ${m.fn} ${f.label} — it isn't a number. Numeric fields: ${ds.fields.filter(x => x.type === 'number' || x.type === 'money').map(x => x.key).join(', ') || 'none'}.`);
          if (f.aggregations && !f.aggregations.includes(m.fn)) throw new QueryError(`${m.fn} of ${f.label} isn't meaningful; use ${f.aggregations.join(' / ')}.`);
          expr = m.fn === 'sum' ? `COALESCE(SUM(${f.sql}), 0)` : `${m.fn.toUpperCase()}(${f.sql})`;
        }
      }
      const key = measureKey(m);
      if (mkeys.has(key)) throw new QueryError(`Measure ${key} is listed twice.`);
      mkeys.add(key);
      select.push(`(${expr})::float8 AS ${q(key)}`);
      columns.push({ key, label: measureLabel(ds, m, f), role: 'measure', format: f?.type === 'money' && m.fn !== 'count_distinct' ? 'money' : 'number', unit: m.fn === 'count' || m.fn === 'count_distinct' ? undefined : f?.unit });
    }

    // Dimensions
    const dimCols: Column[] = [];
    if (!opts.totalsOnly) {
      const bucketDims = spec.dimensions.filter(d => d.bucket);
      if (bucketDims.length > 1) throw new QueryError('Only one date dimension (bucket) per query.');
      spec.dimensions.forEach((d, i) => {
        const f = fieldOf(ds, d.field, 'grouping');
        joinKeys.push(...(f.joins ?? []));
        if (d.bucket) {
          if (f.type !== 'date' && f.type !== 'datetime') throw new QueryError(`${f.label} isn't a date, so it can't be bucketed by ${d.bucket}.`);
          const key = `${f.key}_${d.bucket}`;
          select.push(`${bucketExpr(f, d.bucket, tz)} AS ${q(key)}`);
          groupBy.push(String(select.length));
          dimCols.push({ key, label: `${f.label} (${d.bucket})`, role: 'dimension', format: 'date', bucket: d.bucket });
          bucket = { key, unit: d.bucket };
        } else {
          if (f.type === 'date' || f.type === 'datetime') throw new QueryError(`Group ${f.label} by a bucket (day / week / month / quarter / year).`);
          if (f.groupable === false || f.type === 'number' || f.type === 'money') throw new QueryError(`${f.label} can't be grouped by.`);
          if (f.type === 'relation') {
            select.push(`${f.labelSql ?? f.sql} AS ${q(f.key)}`);
            groupBy.push(String(select.length));
            select.push(`${f.sql} AS ${q(`${f.key}__id`)}`);
            groupBy.push(String(select.length));
            dimCols.push({ key: f.key, label: f.label, role: 'dimension', format: 'text', idKey: `${f.key}__id` });
          } else {
            select.push(`${f.type === 'enum' ? `(${f.sql})::text` : f.sql} AS ${q(f.key)}`);
            groupBy.push(String(select.length));
            dimCols.push({ key: f.key, label: f.label, role: 'dimension', format: formatOf(f) });
          }
        }
        void i;
      });
    }
    // Dimensions first in the output, then measures.
    columns.unshift(...dimCols);
    // Move dimension selects before measure selects to match `columns` (GROUP BY uses positions).
    const nMeasures = spec.measures.length;
    const measureSel = select.slice(0, nMeasures);
    const dimSel = select.slice(nMeasures);
    select.length = 0;
    select.push(...dimSel, ...measureSel);
    groupBy = dimSel.map((_, i) => String(i + 1));

    const isSeries = !!bucket && spec.dimensions.length === 1;
    const groupsCap = LIMITS.maxGroups;
    limit = Math.min(spec.limit ?? (bucket ? groupsCap : LIMITS.defaultGroups), groupsCap);

    // Sorting: explicit, else chronological for series, else biggest first.
    const measureCols = columns.filter(c => c.role === 'measure');
    const allDims = columns.filter(c => c.role === 'dimension');
    if (spec.sort?.by) {
      const by = spec.sort.by;
      const col = columns.find(c => c.key === by)
        ?? allDims.find(c => c.key.startsWith(`${by}_`))
        ?? measureCols.find(c => c.key.endsWith(`_${by}`))
        ?? (by === 'count' || by === 'value' ? measureCols[0] : undefined);
      if (!col) throw new QueryError(`Can't sort by "${by}" — sort by one of: ${columns.map(c => c.key).join(', ')}.`);
      orderBy = `${q(col.key)} ${spec.sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
    } else if (bucket) {
      orderBy = `${q((bucket as { key: string }).key)} ASC`;
    } else if (measureCols.length && allDims.length) {
      orderBy = `${q(measureCols[0].key)} DESC NULLS LAST`;
    }
    if (orderBy && allDims.length && !orderBy.startsWith(q(allDims[0].key))) orderBy += `, ${q(allDims[0].key)} ASC`;

    if (isSeries && range.from && range.toExclusive) {
      const n = enumerateBuckets(range.from, range.toExclusive, bucket!.unit, LIMITS.maxBuckets + 1).length;
      if (n > LIMITS.maxBuckets) throw new QueryError(`That's ${n}+ ${bucket!.unit} buckets — use a shorter period or a bigger bucket (week / month).`);
    }
  }

  const joins = collectJoins(ds.def, [...new Set(joinKeys)]);
  const sql = [
    `SELECT ${select.join(', ')}`,
    `FROM ${ds.def.table} t`,
    ...joins,
    `WHERE ${where.join(' AND ')}`,
    groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : '',
    orderBy ? `ORDER BY ${orderBy}` : '',
    // One extra row tells the executor the result was cut off.
    spec.mode === 'list' || groupBy.length ? `LIMIT ${limit + 1}` : '',
  ].filter(Boolean).join('\n');

  const compiled: CompiledQuery = {
    sql, params: p.values, kind: spec.mode, columns,
    dataset: { key: ds.def.key, label: ds.def.label },
    range, rangeField: rangeField ? { key: rangeField.key, label: rangeField.label } : null,
    bucket, limit, appliedFilters, warnings, description: '',
  };
  compiled.description = describe(ds, spec, compiled);
  return compiled;
}

/** Boolean filter in words: "open (not resolved/closed)" / "not overdue" — not "Open: yes". */
export function booleanPhrase(label: string, value: boolean): string {
  const l = /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
  return value ? l : `not ${l}`;
}

/** "Number of tickets by assignee (agent) — resolved at this month (1 – 18 Oct 2026), where status is RESOLVED; top 5" */
export function describe(ds: ResolvedDataset, spec: QuerySpec, c: Pick<CompiledQuery, 'columns' | 'range' | 'rangeField' | 'appliedFilters' | 'limit' | 'bucket' | 'kind'>): string {
  const parts: string[] = [];
  if (c.kind === 'list') {
    parts.push(`${ds.def.label}`);
  } else {
    const ms = c.columns.filter(x => x.role === 'measure').map(x => x.label);
    let s = ms.join(', ');
    const dims = c.columns.filter(x => x.role === 'dimension');
    const by = dims.map(d => (d.bucket ? `per ${d.bucket}` : `by ${d.label.toLowerCase()}`));
    if (by.length) s += ` ${by.join(' and ')}`;
    parts.push(s);
  }
  if (c.range.from || c.range.toExclusive) {
    const fl = c.rangeField && c.rangeField.key !== ds.def.defaultDate ? `${c.rangeField.label.toLowerCase()} ` : '';
    parts.push(`— ${fl}${c.range.label} (${c.range.human})`);
  }
  if (c.appliedFilters.length) parts.push(`, where ${c.appliedFilters.join(' and ')}`);
  const hasDims = c.columns.some(x => x.role === 'dimension');
  if (spec.limit && (c.kind === 'list' || (hasDims && !c.bucket))) parts.push(`; ${c.kind === 'list' ? `first ${spec.limit}` : `top ${spec.limit}`}`);
  return parts.join(' ').replace(/ ([,;])/g, '$1');
}

/** The comparison-period range for a spec, or null. */
export function compareRangeFor(range: ResolvedRange, kind: QuerySpec['compare']): ResolvedRange | null {
  return kind ? comparisonRange(range, kind) : null;
}

/** Bucket starts the series should have (gap filling), or null when unbounded. */
export function expectedBuckets(range: ResolvedRange, unit: Bucket): string[] | null {
  if (!range.from || !range.toExclusive) return null;
  return enumerateBuckets(range.from, range.toExclusive, unit, LIMITS.maxBuckets);
}

export { bucketStart };
