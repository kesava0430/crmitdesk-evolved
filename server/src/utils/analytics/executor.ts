/**
 * Executes compiled queries and forecasts for one caller. The only file in
 * the query layer that touches the database.
 *
 *  - getAnalyticsContext(): org settings (time zone, currency), the licence's
 *    switched-off modules, the caller's permission context and custom
 *    modules → their resolved catalog. Everything later is checked against it.
 *  - runQuery(): compile → run with a statement timeout in a read-only
 *    transaction → gap-fill time series → totals / comparison → meta.
 *  - runForecast(): a series query on complete buckets → forecast.ts →
 *    derived projections (rate × projection, with the rate's window stated).
 */
import { sqlTimeZone } from './timezone';
import crypto from 'crypto';
import { prisma } from '../prisma';
import { getPermCtx, type PermCtx } from '../permissions';
import { getEffectiveLicense } from '../licensing';
import { STATIC_DATASETS, customModuleDataset } from './catalog';
import {
  resolveCatalog, compileQuery, compareRangeFor, expectedBuckets, resolveSpecRange, QueryError,
  type CompiledQuery, type Column, type CompileEnv,
} from './compiler';
import { localToday, isValidTimeZone, resolveRange, bucketStart, addUnits, bucketLabel, humanSpan, addDays, parseDate, type ResolvedRange, type DateRangeInput } from './dates';
import { forecast as runForecastMath, leadingZeros, round, type ForecastResult } from './forecast';
import { LIMITS, QuerySpecSchema, ForecastSpecSchema, zodIssues, type QuerySpec, type ForecastSpec, type ForecastSpecInput, type QuerySpecInput } from './spec';
import type { ResolvedDataset, Bucket, FieldDef } from './types';

export interface AnalyticsUser { id: string; orgId: string; role: string }

export interface AnalyticsContext {
  user: AnalyticsUser;
  ctx: PermCtx;
  catalog: ResolvedDataset[];
  env: CompileEnv;
  currency: string;
  blockedModules: string[];
  /** Hash of what this caller can query — part of AI interpretation cache keys. */
  catalogVersion: string;
  /** Set when the org's time zone isn't known to the database and UTC is used. */
  tzWarning?: string;
}

export async function getAnalyticsContext(user: AnalyticsUser, now = new Date()): Promise<AnalyticsContext> {
  if (!user.orgId) throw new QueryError('Analytics needs an organisation.');
  const [org, lic, ctx, modules] = await Promise.all([
    prisma.organization.findUnique({ where: { id: user.orgId }, select: { timezone: true, currency: true } }),
    getEffectiveLicense(user.orgId),
    getPermCtx(user),
    prisma.customModule.findMany({
      where: { orgId: user.orgId, isActive: true },
      select: { id: true, name: true, slug: true, description: true, stages: true, fields: { select: { fieldKey: true, label: true, fieldType: true, options: true }, orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),
  ]);
  // Resolved to a name Postgres knows — legacy aliases like "Asia/Calcutta"
  // aren't in newer servers' tzdata (see timezone.ts).
  const tzResolved = await sqlTimeZone(org?.timezone && isValidTimeZone(org.timezone) ? org.timezone : 'UTC');
  const timezone = tzResolved.timezone;
  const defs = [...STATIC_DATASETS, ...modules.map(m => customModuleDataset(m as any))];
  const catalog = resolveCatalog(defs, { ctx, blockedModules: lic.blockedModules });
  const catalogVersion = crypto.createHash('sha1')
    .update(JSON.stringify(catalog.map(d => [d.def.key, d.scope, d.fields.map(f => f.key + ':' + (f.values ?? []).join('|'))])))
    .digest('hex').slice(0, 16);
  return {
    user, ctx, catalog, currency: org?.currency || 'USD', blockedModules: lic.blockedModules,
    env: { orgId: user.orgId, userId: user.id, timezone, today: localToday(now, timezone), currency: org?.currency || 'USD' },
    catalogVersion,
    ...(tzResolved.warning ? { tzWarning: tzResolved.warning } : {}),
  };
}

export function findDataset(actx: AnalyticsContext, key: string): ResolvedDataset {
  const ds = actx.catalog.find(d => d.def.key === key);
  if (ds) return ds;
  const known = STATIC_DATASETS.find(d => d.key === key);
  if (known) {
    const off = known.module && actx.blockedModules.includes(known.module);
    throw new QueryError(off
      ? `${known.label} aren't available: that part of the product is switched off for your organisation.`
      : `You don't have access to ${known.label.toLowerCase()}.`);
  }
  throw new QueryError(`Unknown dataset "${key}".`, [`Datasets: ${actx.catalog.map(d => d.def.key).join(', ')}`]);
}

// ─── Catalog for clients ────────────────────────────────────────────────────

export function publicCatalog(actx: AnalyticsContext) {
  return {
    version: actx.catalogVersion,
    timezone: actx.env.timezone,
    currency: actx.currency,
    today: actx.env.today,
    limits: { maxMeasures: LIMITS.maxMeasures, maxDimensions: LIMITS.maxDimensions, maxFilters: LIMITS.maxFilters, maxGroups: LIMITS.maxGroups, maxRows: LIMITS.maxRows, maxBuckets: LIMITS.maxBuckets },
    datasets: actx.catalog.map(d => ({
      key: d.def.key,
      label: d.def.label,
      description: d.def.description,
      area: d.def.area ?? 'shared',
      module: d.def.module,
      permission: d.def.permission ?? null,
      scope: d.scope,
      defaultDateField: d.def.defaultDate,
      examples: d.def.examples ?? [],
      fields: d.fields.map(f => ({
        key: f.key, label: f.label, type: f.type,
        ...(f.values ? { values: f.values } : {}),
        ...(f.unit ? { unit: f.unit } : {}),
        groupable: f.groupable !== false && f.type !== 'number' && f.type !== 'money',
        filterable: f.filterable !== false,
        aggregations: f.type === 'number' || f.type === 'money' ? (f.aggregations ?? ['sum', 'avg', 'min', 'max']) : [],
        buckets: f.type === 'date' || f.type === 'datetime' ? ['day', 'week', 'month', 'quarter', 'year'] : undefined,
        ...(f.isUser ? { acceptsMe: true } : {}),
      })),
      ...(d.redactedFields.length ? { restrictedFields: d.redactedFields } : {}),
    })),
  };
}

// ─── Running SQL ────────────────────────────────────────────────────────────

async function runSql(c: Pick<CompiledQuery, 'sql' | 'params'>): Promise<Record<string, unknown>[]> {
  const ms = Math.max(500, Math.min(60_000, Math.floor(LIMITS.timeoutMs)));
  try {
    return await prisma.$transaction(async (tx: any) => {
      // Read-only and time-boxed: a pathological spec can't hold a connection or write anything.
      await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
      return tx.$queryRawUnsafe(c.sql, ...c.params) as Promise<Record<string, unknown>[]>;
    }, { timeout: ms + 2000 });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/statement timeout|canceling statement/i.test(msg)) throw new QueryError('That query took too long. Try a shorter period, fewer groups or more filters.');
    throw err;
  }
}

function normaliseRow(row: Record<string, unknown>, columns: Column[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = Number(v);
    else if (v && typeof v === 'object' && typeof (v as any).toNumber === 'function') out[k] = (v as any).toNumber();
    else out[k] = v;
  }
  for (const c of columns) {
    if (c.role === 'measure') {
      const v = out[c.key];
      out[c.key] = v === null || v === undefined ? null : round(Number(v), c.format === 'money' ? 2 : 4);
    }
  }
  return out;
}

// ─── Query ──────────────────────────────────────────────────────────────────

export interface QueryResult {
  columns: Column[];
  rows: Record<string, unknown>[];
  meta: {
    dataset: { key: string; label: string };
    description: string;
    kind: 'aggregate' | 'list';
    range: { from: string | null; to: string | null; label: string; human: string; field: string | null; partial: boolean };
    bucket: { key: string; unit: Bucket } | null;
    appliedFilters: string[];
    scope: string;
    totals: Record<string, number | null>;
    comparison: null | {
      label: string; human: string; range: { from: string | null; to: string | null };
      totals: Record<string, number | null>;
      change: Record<string, { abs: number | null; pct: number | null }>;
    };
    rowCount: number;
    truncated: boolean;
    currency: string;
    timezone: string;
    warnings: string[];
    spec: QuerySpec;
  };
}

export function parseQuerySpec(input: unknown): QuerySpec {
  const r = QuerySpecSchema.safeParse(input);
  if (!r.success) throw new QueryError('Invalid query spec.', zodIssues(r.error));
  return r.data;
}

export async function runQuery(actx: AnalyticsContext, specInput: QuerySpecInput | QuerySpec): Promise<QueryResult> {
  const spec = parseQuerySpec(specInput);
  const ds = findDataset(actx, spec.dataset);
  const compiled = compileQuery(ds, spec, actx.env);
  const warnings = [...compiled.warnings, ...(actx.tzWarning ? [actx.tzWarning] : [])];

  let rows = (await runSql(compiled)).map(r => normaliseRow(r, compiled.columns));
  const truncated = rows.length > compiled.limit;
  if (truncated) {
    rows = rows.slice(0, compiled.limit);
    warnings.push(compiled.kind === 'list'
      ? `Showing the first ${compiled.limit} rows — there are more.`
      : `Showing the first ${compiled.limit} groups — there are more.`);
  }

  const measures = compiled.columns.filter(c => c.role === 'measure');
  const dims = compiled.columns.filter(c => c.role === 'dimension');

  // Gap-fill a single date dimension so a chart shows quiet weeks as 0, not as missing.
  if (compiled.bucket && dims.length === 1 && !spec.sort && !truncated) {
    const want = expectedBuckets(compiled.range, compiled.bucket.unit);
    if (want) {
      const byKey = new Map(rows.map(r => [String(r[compiled.bucket!.key]), r]));
      rows = want.map(b => byKey.get(b) ?? Object.fromEntries([
        [compiled.bucket!.key, b],
        ...measures.map(m => [m.key, /^(count|distinct_|sum_)/.test(m.key) ? 0 : null]),
      ]));
    }
    if (compiled.range.partial) warnings.push(`The last ${compiled.bucket.unit} (${bucketLabel(bucketStart(actx.env.today, compiled.bucket.unit), compiled.bucket.unit)}) isn't over yet.`);
  }

  // Totals: one ungrouped run (correct for averages and distinct counts too).
  let totals: Record<string, number | null> = {};
  let currencyProbe: { min: string | null; max: string | null } | null = null;
  if (compiled.kind === 'aggregate') {
    if (dims.length) {
      const t = compileQuery(ds, spec, actx.env, { totalsOnly: true });
      const [row] = (await runSql(t)).map(r => normaliseRow(r, t.columns));
      totals = Object.fromEntries(measures.map(m => [m.key, (row?.[m.key] as number) ?? null]));
    } else {
      totals = Object.fromEntries(measures.map(m => [m.key, (rows[0]?.[m.key] as number) ?? null]));
    }
    if (ds.def.currencySql) currencyProbe = await probeCurrency(actx, ds, spec);
  }
  if (currencyProbe && (currencyProbe.min && currencyProbe.min !== actx.currency || currencyProbe.max && currencyProbe.max !== actx.currency)) {
    warnings.push(`Some ${ds.def.label.toLowerCase()} are recorded in ${[...new Set([currencyProbe.min, currencyProbe.max])].join(' / ')}, not your organisation currency ${actx.currency}; amounts were added as recorded, without conversion.`);
  }

  // Comparison with the previous period / year.
  let comparison: QueryResult['meta']['comparison'] = null;
  const cmpRange = compiled.kind === 'aggregate' ? compareRangeFor(compiled.range, spec.compare) : null;
  if (spec.compare && !cmpRange) warnings.push('A comparison needs a bounded date range, so none was made.');
  if (cmpRange) {
    const t = compileQuery(ds, spec, actx.env, { totalsOnly: true, rangeOverride: cmpRange });
    const [row] = (await runSql(t)).map(r => normaliseRow(r, t.columns));
    const prev = Object.fromEntries(measures.map(m => [m.key, (row?.[m.key] as number) ?? null]));
    const change = Object.fromEntries(measures.map(m => {
      const a = totals[m.key], b = prev[m.key];
      if (a == null || b == null) return [m.key, { abs: null, pct: null }];
      return [m.key, { abs: round(a - b, 2), pct: b === 0 ? null : round(((a - b) / Math.abs(b)) * 100, 1) }];
    }));
    comparison = { label: cmpRange.label, human: cmpRange.human, range: { from: cmpRange.from, to: cmpRange.toExclusive ? addDays(cmpRange.toExclusive, -1) : null }, totals: prev, change };
    if (compiled.range.partial) warnings.push(`The current period isn't over, so it's compared with the same number of days of the ${cmpRange.label}.`);
  }

  return {
    columns: compiled.columns,
    rows,
    meta: {
      dataset: compiled.dataset,
      description: compiled.description,
      kind: compiled.kind,
      range: {
        from: compiled.range.from, to: compiled.range.toExclusive ? addDays(compiled.range.toExclusive, -1) : null,
        label: compiled.range.label, human: compiled.range.human, field: compiled.rangeField?.key ?? null, partial: compiled.range.partial,
      },
      bucket: compiled.bucket,
      appliedFilters: compiled.appliedFilters,
      scope: ds.scope,
      totals, comparison,
      rowCount: rows.length, truncated,
      currency: actx.currency, timezone: actx.env.timezone,
      warnings, spec,
    },
  };
}

async function probeCurrency(actx: AnalyticsContext, ds: ResolvedDataset, spec: QuerySpec) {
  // Same WHERE as the query (scope, range, filters) — reuse the compiler with a
  // MIN/MAX of the currency column as the only "measure".
  const probeField: FieldDef = { key: '__cur', label: 'Currency', type: 'string', sql: ds.def.currencySql!, filterable: false };
  const probeDs: ResolvedDataset = { ...ds, fields: [...ds.fields, probeField] };
  const c = compileQuery(probeDs, { ...spec, measures: [{ fn: 'count' }], dimensions: [], compare: null, sort: null }, actx.env, { totalsOnly: true });
  const sql = c.sql.replace(/^SELECT .*$/m, `SELECT MIN(${ds.def.currencySql}) AS "min", MAX(${ds.def.currencySql}) AS "max"`);
  const [row] = await runSql({ sql, params: c.params });
  return { min: (row?.min as string) ?? null, max: (row?.max as string) ?? null };
}

// ─── Forecast ───────────────────────────────────────────────────────────────

const DEFAULT_HISTORY: Record<Bucket, DateRangeInput> = {
  day: { last: { n: 90, unit: 'day' }, includeCurrent: false },
  week: { last: { n: 26, unit: 'week' }, includeCurrent: false },
  month: { last: { n: 24, unit: 'month' }, includeCurrent: false },
  quarter: { last: { n: 12, unit: 'quarter' }, includeCurrent: false },
  year: { last: { n: 10, unit: 'year' }, includeCurrent: false },
};

export interface DerivedResult {
  label: string;
  rate: number | null;
  numerator: number | null;
  denominator: number | null;
  numeratorDescription: string;
  denominatorDescription: string;
  window: { label: string; human: string };
  projected: number | null;
  lower: number | null;
  upper: number | null;
  format: 'number' | 'money' | 'percent';
  explanation: string;
}

export interface ForecastResponse {
  columns: Column[];
  history: Array<{ bucket: string; label: string; value: number }>;
  projection: Array<{ bucket: string; label: string; value: number; lower: number; upper: number; baseline?: number; cumulative?: number; cumulativeLower?: number; cumulativeUpper?: number }>;
  method: ForecastResult['method'];
  totals: ForecastResult['totals'];
  historyWindow: { from: string | null; to: string | null; points: number; human: string };
  horizon: { buckets: number; unit: Bucket; from: string; to: string; human: string };
  measure: { key: string; label: string; format: string };
  params: Record<string, number>;
  holdout: ForecastResult['holdout'];
  seasonality: ForecastResult['seasonality'];
  derived: DerivedResult[];
  description: string;
  assumptions: string[];
  warnings: string[];
  currency: string;
  timezone: string;
  spec: ForecastSpec;
}

export function parseForecastSpec(input: unknown): ForecastSpec {
  const r = ForecastSpecSchema.safeParse(input);
  if (!r.success) throw new QueryError('Invalid forecast spec.', zodIssues(r.error));
  return r.data;
}

export async function runForecast(actx: AnalyticsContext, input: ForecastSpecInput | ForecastSpec): Promise<ForecastResponse> {
  const fs = parseForecastSpec(input);
  const spec: QuerySpec = { ...fs.series, mode: 'aggregate', compare: null, sort: null, limit: null };
  const dim = spec.dimensions.find(d => d.bucket);
  if (!dim || spec.dimensions.length !== 1 || spec.measures.length !== 1) {
    throw new QueryError('A forecast needs a series: exactly one measure and one date dimension with a bucket (day / week / month).');
  }
  const unit = dim.bucket as Bucket;
  const ds = findDataset(actx, spec.dataset);
  const today = actx.env.today;
  const curStart = bucketStart(today, unit);

  // History = complete buckets only: the current day/week/month isn't over, and
  // counting it as a low value would drag the trend down.
  const { range: asked } = resolveSpecRange(ds, { ...spec, dateRange: spec.dateRange ?? null }, actx.env);
  const base = spec.dateRange ? asked : resolveRange(DEFAULT_HISTORY[unit], today);
  const from = base.from ? bucketStart(base.from, unit) : null;
  if (!from) throw new QueryError('A forecast needs a bounded history window (e.g. the last 90 days).');
  const toEx = base.toExclusive && base.toExclusive < curStart ? bucketStart(base.toExclusive, unit) : curStart;
  const histRange: ResolvedRange = {
    from, toExclusive: toEx, unit, partial: false,
    label: `last ${Math.max(0, (expectedBuckets({ from, toExclusive: toEx } as ResolvedRange, unit) ?? []).length)} complete ${unit}s`,
    human: toEx > from ? humanSpan(from, addDays(toEx, -1)) : '—',
  };
  const compiled = compileQuery(ds, spec, actx.env, { rangeOverride: histRange });
  const measure = compiled.columns.find(c => c.role === 'measure')!;
  const raw = (await runSql(compiled)).map(r => normaliseRow(r, compiled.columns));
  const byKey = new Map(raw.map(r => [String(r[compiled.bucket!.key]), Number(r[measure.key] ?? 0)]));
  let buckets = expectedBuckets(histRange, unit) ?? [];
  let values = buckets.map(b => byKey.get(b) ?? 0);

  const warnings: string[] = [];
  const additive = /^(count|distinct_|sum_)/.test(measure.key);
  if (!additive) warnings.push('Averages and min/max are projected as a trend of the per-period value; missing periods count as 0.');
  const lead = additive ? leadingZeros(values) : 0;
  if (lead > 0 && lead < values.length) {
    warnings.push(`History starts at the first recorded value (${bucketLabel(buckets[lead], unit)}); the ${lead} empty ${unit}${lead === 1 ? '' : 's'} before it were left out.`);
    buckets = buckets.slice(lead); values = values.slice(lead);
  }

  const result = runForecastMath(values, {
    horizon: fs.horizon, unit,
    seasonality: fs.seasonality ?? 'auto',
    growthPctPerMonth: fs.scenario?.growthPctPerMonth ?? null,
    cumulative: !!fs.cumulative,
  });

  const projStart = toEx;
  const projection = result.projection.map((p, i) => {
    const b = addUnits(projStart, unit, i);
    return { bucket: b, label: bucketLabel(b, unit), ...p };
  });
  const horizonTo = projection.length ? addDays(addUnits(projection[projection.length - 1].bucket, unit, 1), -1) : projStart;
  const assumptions = [...result.assumptions];
  if (projStart <= today) assumptions.push(`The current ${unit} (${bucketLabel(curStart, unit)}) isn't complete, so it is projected, not counted.`);

  // Derived projections.
  const derived: DerivedResult[] = [];
  for (const [i, d] of fs.derived.entries()) {
    const win = d.window ? toWindow(d.window) : { last: { n: 90, unit: 'day' as Bucket }, includeCurrent: false };
    const wRange = resolveRange(win, today);
    const numQ = await totalOf(actx, d.numerator.dataset, d.numerator.measure, d.numerator.filters, wRange);
    const denQ = await totalOf(actx, d.denominator.dataset, d.denominator.measure, d.denominator.filters, wRange);
    const rate = numQ.value != null && denQ.value ? numQ.value / denQ.value : null;
    const ofIdx = d.of === 'projection' || d.of == null ? null : d.of;
    if (ofIdx != null && ofIdx >= i) throw new QueryError(`Derived "${d.label}" can only build on an earlier derived value.`);
    const src = ofIdx == null ? (result.totals ? { projected: result.totals.projected, lower: result.totals.lower, upper: result.totals.upper } : null) : derived[ofIdx];
    const mul = (v: number | null | undefined) => (v == null || rate == null ? null : round(v * rate, 2));
    const srcLabel = ofIdx == null ? `projected ${measure.label.toLowerCase()}` : derived[ofIdx].label.toLowerCase();
    derived.push({
      label: d.label,
      rate: rate == null ? null : round(rate, 6),
      numerator: numQ.value, denominator: denQ.value,
      numeratorDescription: numQ.description, denominatorDescription: denQ.description,
      window: { label: wRange.label, human: wRange.human },
      projected: mul(src?.projected), lower: mul(src?.lower), upper: mul(src?.upper),
      format: d.format ?? 'number',
      explanation: rate == null
        ? `Couldn't compute ${d.label.toLowerCase()}: the ${denQ.description.toLowerCase()} was zero or missing.`
        : derivedExplanation(d.label, srcLabel, rate, numQ, denQ, wRange.label, actx.currency),
    });
  }

  return {
    columns: compiled.columns,
    history: buckets.map((b, i) => ({ bucket: b, label: bucketLabel(b, unit), value: values[i] })),
    projection,
    method: result.method,
    totals: result.totals,
    historyWindow: { from: buckets[0] ?? null, to: buckets.length ? addDays(addUnits(buckets[buckets.length - 1], unit, 1), -1) : null, points: values.length, human: buckets.length ? humanSpan(buckets[0], addDays(addUnits(buckets[buckets.length - 1], unit, 1), -1)) : '—' },
    horizon: { buckets: fs.horizon, unit, from: projStart, to: horizonTo, human: humanSpan(projStart, horizonTo) },
    measure: { key: measure.key, label: measure.label, format: measure.format },
    params: result.params,
    holdout: result.holdout,
    seasonality: result.seasonality,
    derived,
    description: `${measure.label} per ${unit}: ${values.length} ${unit}s of history (${buckets.length ? humanSpan(buckets[0], addDays(toEx, -1)) : '—'}), projected ${fs.horizon} ${unit}${fs.horizon === 1 ? '' : 's'} ahead${fs.scenario?.growthPctPerMonth ? ` with ${fs.scenario.growthPctPerMonth > 0 ? '+' : ''}${fs.scenario.growthPctPerMonth}%/month growth` : ''}${compiled.appliedFilters.length ? `, where ${compiled.appliedFilters.join(' and ')}` : ''}`,
    assumptions,
    warnings: [...warnings, ...result.warnings],
    currency: actx.currency,
    timezone: actx.env.timezone,
    spec: fs,
  };
}

function toWindow(r: NonNullable<ForecastSpec['derived'][number]['window']>): DateRangeInput {
  const out: DateRangeInput = {};
  if (r.preset) out.preset = r.preset as DateRangeInput['preset'];
  if (r.last) out.last = r.last;
  if (r.includeCurrent != null) out.includeCurrent = r.includeCurrent;
  if (r.from) out.from = r.from;
  if (r.to) out.to = r.to;
  return out;
}

async function totalOf(actx: AnalyticsContext, dataset: string, measure: QuerySpec['measures'][number], filters: QuerySpec['filters'], range: ResolvedRange) {
  const ds = findDataset(actx, dataset);
  const spec = parseQuerySpec({ dataset, measures: [measure], filters });
  const c = compileQuery(ds, spec, actx.env, { totalsOnly: true, rangeOverride: range });
  const [row] = (await runSql(c)).map(r => normaliseRow(r, c.columns));
  const m = c.columns.find(x => x.role === 'measure')!;
  return { value: (row?.[m.key] as number) ?? null, format: m.format, description: c.description.replace(/ — .*$/, '') + (c.appliedFilters.length ? ` where ${c.appliedFilters.join(' and ')}` : '') };
}

/**
 * "Projected revenue = projected conversions × ₹1,58,500 (…: ₹31,70,000 ÷ 20)"
 * — amounts in the org currency and grouping, a count-over-count rate as a
 * plain ratio and a percentage, never a raw "× 158500".
 */
export function derivedExplanation(
  label: string, srcLabel: string, rate: number,
  num: { value: number | null; format: string; description: string },
  den: { value: number | null; format: string; description: string },
  windowLabel: string, currency: string,
): string {
  const loc = currency === 'INR' ? 'en-IN' : 'en-US';
  const fmt = (v: number, format: string, frac = 2) => {
    if (format === 'money') {
      try { return new Intl.NumberFormat(loc, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v); } catch { /* unknown code */ }
    }
    return new Intl.NumberFormat(loc, { maximumFractionDigits: frac }).format(v);
  };
  const moneyRate = num.format === 'money' && den.format !== 'money';
  const rateTxt = moneyRate ? fmt(rate, 'money') : `${fmt(round(rate, 4), 'number', 4)}${rate <= 1 ? ` (${fmt(round(rate * 100, 1), 'number', 1)}%)` : ''}`;
  return `${label} = ${srcLabel} × ${rateTxt} — ${num.description} ÷ ${den.description}, ${windowLabel}: ${fmt(num.value ?? 0, num.format)} ÷ ${fmt(den.value ?? 0, den.format)}.`;
}

export { QueryError, parseDate };
