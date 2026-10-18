/**
 * Dashboard widget specs — what a dashboard stores per widget, and the pure
 * rules around it (validation against a viewer's catalog, availability for a
 * viewer, the dashboard-wide date range). No database here.
 *
 * A widget never stores data. A DATA widget is the query layer's WidgetSpec
 * (utils/analytics/answer.ts — what "Pin to dashboard" hands over) with a few
 * extra visualisations and display options; every view re-runs its query /
 * forecast as the viewer. A NOTE widget is either text a person wrote, or a
 * "how this projection works" note whose content is generated at render time
 * from a forecast's own method / assumptions / warnings — never text written
 * by a model.
 */
import { z } from 'zod';
import {
  QuerySpecSchema, ForecastSpecSchema, DateRangeSchema, LIMITS, zodIssues,
  type QuerySpec,
} from '../analytics/spec';
import { compileQuery, measureKey, QueryError } from '../analytics/compiler';
import type { DatasetDef, ResolvedDataset } from '../analytics/types';
import type { CompileEnv } from '../analytics/compiler';

/** Visualisations a data widget can use. The first nine are the query layer's VizType. */
export const WIDGET_VIZ = ['kpi', 'line', 'area', 'bar', 'stacked_bar', 'pie', 'table', 'leaderboard', 'forecast', 'hbar', 'donut', 'funnel'] as const;
export type WidgetViz = typeof WIDGET_VIZ[number];

/** What a KPI tile shows: the query total (with its comparison), or a figure from a forecast. */
export const KPI_VALUES = ['total', 'projected', 'derived', 'rate'] as const;

const ForecastConfigSchema = ForecastSpecSchema.omit({ series: true });
export type ForecastConfig = z.infer<typeof ForecastConfigSchema>;

const SourceSchema = z.object({
  kind: z.enum(['ai_answer', 'manual', 'ai_dashboard']).default('manual'),
  question: z.string().max(500).nullish(),
}).default({ kind: 'manual' });

export const DataWidgetSchema = z.object({
  version: z.literal(1).default(1),
  kind: z.literal('data'),
  title: z.string().trim().min(1).max(120),
  viz: z.object({
    type: z.enum(WIDGET_VIZ),
    x: z.string().max(80).nullish(),
    y: z.array(z.string().max(80)).max(12).default([]),
    series: z.string().max(80).nullish(),
  }),
  query: QuerySpecSchema,
  forecast: ForecastConfigSchema.nullish(),
  description: z.string().max(600).default(''),
  source: SourceSchema,
  options: z.object({
    kpi: z.object({ value: z.enum(KPI_VALUES).default('total'), derived: z.number().int().min(0).max(4).nullish() }).nullish(),
    /** pie / donut / bar: show the top N groups and add the rest up as "Other". */
    topN: z.number().int().min(2).max(20).nullish(),
    /** Keep this widget's own date range when the dashboard range changes. */
    ignoreDashboardRange: z.boolean().nullish(),
    /** table: rows per page. */
    pageSize: z.number().int().min(5).max(100).nullish(),
  }).default({}),
});

export const NoteWidgetSchema = z.object({
  version: z.literal(1).default(1),
  kind: z.literal('note'),
  title: z.string().trim().min(1).max(120),
  /** Plain text written by a person (rendered as text, never HTML). */
  text: z.string().max(4000).default(''),
  /** "How this projection works": rendered from this forecast's result at view time. */
  methodOf: z.object({ query: QuerySpecSchema, forecast: ForecastConfigSchema }).nullish(),
  source: SourceSchema,
});

export const WidgetSpecSchema = z.preprocess(v => {
  // Pinned AI answers (utils/analytics/answer.ts WidgetSpec) carry no `kind`.
  if (v && typeof v === 'object' && !Array.isArray(v) && !('kind' in v)) return { ...(v as object), kind: 'data' };
  return v;
}, z.discriminatedUnion('kind', [DataWidgetSchema, NoteWidgetSchema]));

export type DataWidgetSpec = z.infer<typeof DataWidgetSchema>;
export type NoteWidgetSpec = z.infer<typeof NoteWidgetSchema>;
export type DashboardWidgetSpec = DataWidgetSpec | NoteWidgetSpec;

export function parseWidgetSpec(input: unknown): { spec: DashboardWidgetSpec | null; errors: string[] } {
  const r = WidgetSpecSchema.safeParse(input);
  if (!r.success) return { spec: null, errors: zodIssues(r.error) };
  return { spec: normaliseWidgetSpec(r.data), errors: [] };
}

/**
 * Keeps viz.x / viz.y / viz.series in step with the query (they are column
 * keys of the result): after a builder or AI edit changed the query, the
 * stored keys would otherwise point at columns that no longer exist.
 */
export function normaliseWidgetSpec<T extends DashboardWidgetSpec>(spec: T): T {
  if (spec.kind !== 'data') return spec;
  const q = spec.query;
  const viz = { ...spec.viz };
  if (q.mode === 'list') {
    viz.x = null; viz.series = null;
    viz.y = q.fields.length ? [...q.fields] : viz.y;
  } else {
    // Column keys as the compiler names them: a bucketed date is "<field>_<bucket>".
    const col = (d?: QuerySpec['dimensions'][number]) => (d ? (d.bucket ? `${d.field}_${d.bucket}` : d.field) : null);
    viz.x = col(q.dimensions[0]);
    viz.series = col(q.dimensions[1]);
    viz.y = q.measures.map(m => measureKey(m));
  }
  return { ...spec, viz };
}

// ─── Fit between a visualisation and a query ────────────────────────────────

/** Why a viz can't draw this query (null = fine). Pure; used by validation and the builder. */
export function vizProblem(spec: DataWidgetSpec): string | null {
  const q = spec.query;
  const t = spec.viz.type;
  const dims = q.dimensions;
  const bucketed = dims.some(d => d.bucket);
  const kpi = spec.options?.kpi?.value ?? 'total';
  if (t === 'kpi') {
    if (kpi !== 'total') return spec.forecast ? null : `A "${kpi}" KPI needs a forecast.`;
    if (q.mode === 'list') return 'A KPI tile shows one number — use an aggregate query (count / sum / average).';
    if (dims.length) return 'A KPI tile shows one number — remove the group-by.';
    return null;
  }
  if (t === 'forecast') {
    if (!spec.forecast) return 'A forecast chart needs a forecast (horizon).';
    if (q.mode !== 'aggregate' || dims.length !== 1 || !bucketed || q.measures.length !== 1) {
      return 'A forecast needs exactly one measure and one date dimension with a bucket (day / week / month).';
    }
    return null;
  }
  if (spec.forecast) return 'Only forecast charts and KPI tiles use a forecast.';
  if (t === 'table') return null;
  if (q.mode === 'list') return 'Lists of records can only be shown as a table.';
  if (t === 'line' || t === 'area') return bucketed ? null : 'Line and area charts need a date dimension with a bucket (day / week / month).';
  if (t === 'stacked_bar') return dims.length === 2 ? null : 'A stacked bar needs two group-bys (e.g. week and status).';
  if (!dims.length) return 'This chart needs a group-by (e.g. status, source, owner).';
  if (t === 'funnel') return dims.length === 1 && !bucketed ? null : 'A funnel needs exactly one group-by on a stage/status field.';
  if (t === 'pie' || t === 'donut') return dims.length === 1 ? null : 'Pie and donut charts take one group-by.';
  return null; // bar, hbar, leaderboard
}

// ─── Validation against a viewer's catalog ──────────────────────────────────

export interface CatalogEnv { catalog: ResolvedDataset[]; env: CompileEnv }

function findDs(c: CatalogEnv, key: string): ResolvedDataset | null {
  return c.catalog.find(d => d.def.key === key) ?? null;
}

/**
 * Every problem with a widget for this viewer: schema, viz fit, a dry-run
 * compile of the query against their catalog (every key, value and limit),
 * forecast series shape and derived datasets. Empty = it will render.
 */
export function validateWidget(c: CatalogEnv, input: unknown): { spec: DashboardWidgetSpec | null; errors: string[] } {
  const { spec, errors } = parseWidgetSpec(input);
  if (!spec) return { spec: null, errors };
  const out: string[] = [];
  const checkQuery = (q: QuerySpec, label: string) => {
    const ds = findDs(c, q.dataset);
    if (!ds) { out.push(`${label}: dataset "${q.dataset}" is not available (datasets: ${c.catalog.map(d => d.def.key).join(', ')}).`); return; }
    try { compileQuery(ds, q, c.env); } catch (err) {
      if (err instanceof QueryError) out.push(`${label}: ${err.message}${err.hints.length ? ` (${err.hints.join('; ')})` : ''}`);
      else throw err;
    }
  };
  const checkForecast = (q: QuerySpec, f: ForecastConfig, label: string) => {
    const bucketDims = q.dimensions.filter(d => d.bucket);
    if (q.mode !== 'aggregate' || q.dimensions.length !== 1 || bucketDims.length !== 1 || q.measures.length !== 1) {
      out.push(`${label}: a forecast needs exactly one measure and one date dimension with a bucket.`);
    }
    f.derived.forEach((d, i) => {
      for (const part of [d.numerator, d.denominator]) {
        if (!findDs(c, part.dataset)) out.push(`${label}: forecast.derived.${i} uses dataset "${part.dataset}", which is not available.`);
      }
      if (typeof d.of === 'number' && d.of >= i) out.push(`${label}: forecast.derived.${i}.of must point at an earlier derived entry.`);
    });
  };
  if (spec.kind === 'note') {
    if (!spec.text.trim() && !spec.methodOf) out.push('note: needs text or a forecast to explain.');
    if (spec.methodOf) { checkQuery(spec.methodOf.query, 'note'); checkForecast(spec.methodOf.query, spec.methodOf.forecast, 'note'); }
  } else {
    const vp = vizProblem(spec);
    if (vp) out.push(`viz: ${vp}`);
    checkQuery(spec.query, 'query');
    if (spec.forecast) {
      checkForecast(spec.query, spec.forecast, 'forecast');
      const k = spec.options?.kpi;
      if (k && (k.value === 'derived' || k.value === 'rate') && (k.derived == null || k.derived >= spec.forecast.derived.length)) {
        out.push(`options.kpi.derived must be the index of one of the forecast's ${spec.forecast.derived.length} derived values.`);
      }
    }
  }
  return { spec: out.length ? null : spec, errors: out };
}

// ─── Availability for a viewer ──────────────────────────────────────────────

/** Datasets and field keys a widget depends on. */
export function widgetDependencies(spec: DashboardWidgetSpec): Array<{ dataset: string; fields: string[] }> {
  const deps = new Map<string, Set<string>>();
  const add = (ds: string, f?: string | null) => {
    if (!deps.has(ds)) deps.set(ds, new Set());
    if (f) deps.get(ds)!.add(f);
  };
  const fromQuery = (q: QuerySpec) => {
    add(q.dataset);
    for (const m of q.measures) add(q.dataset, m.field);
    for (const d of q.dimensions) add(q.dataset, d.field);
    for (const f of q.filters) add(q.dataset, f.field);
    for (const f of q.fields) add(q.dataset, f);
    if (q.dateRange?.field) add(q.dataset, q.dateRange.field);
  };
  const fromForecast = (f: ForecastConfig) => {
    for (const d of f.derived) {
      for (const p of [d.numerator, d.denominator]) {
        add(p.dataset, p.measure.field);
        for (const fl of p.filters) add(p.dataset, fl.field);
      }
    }
  };
  if (spec.kind === 'note') {
    if (spec.methodOf) { fromQuery(spec.methodOf.query); fromForecast(spec.methodOf.forecast); }
  } else {
    fromQuery(spec.query);
    if (spec.forecast) fromForecast(spec.forecast);
  }
  return [...deps.entries()].map(([dataset, f]) => ({ dataset, fields: [...f] }));
}

export type Availability = { ok: true } | { ok: false; reason: string };

/**
 * Can this viewer see this widget at all? Decided BEFORE anything runs, from
 * their resolved catalog: a dataset of a switched-off area, one their role
 * has no access to, or a field their field rules hide all mean "not
 * available to you" — never an error, never someone else's numbers.
 */
export function widgetAvailability(catalog: ResolvedDataset[], spec: DashboardWidgetSpec, allDefs: DatasetDef[], blockedModules: string[]): Availability {
  for (const dep of widgetDependencies(spec)) {
    const ds = catalog.find(d => d.def.key === dep.dataset);
    if (!ds) {
      const def = allDefs.find(d => d.key === dep.dataset);
      if (!def) {
        return { ok: false, reason: dep.dataset.startsWith('custom_')
          ? 'This widget uses a custom module that isn\'t available to you (or was removed).'
          : `This widget uses data that no longer exists here (${dep.dataset}).` };
      }
      if (def.module && blockedModules.includes(def.module)) {
        return { ok: false, reason: `${def.label} aren't part of your organisation's product areas, so this widget isn't available.` };
      }
      return { ok: false, reason: `This widget uses ${def.label.toLowerCase()}, which your role doesn't have access to.` };
    }
    const hidden = dep.fields.filter(f => ds.redactedFields.includes(f));
    if (hidden.length) {
      const labels = hidden.map(h => ds.def.fields.find(f => f.key === h)?.label ?? h);
      return { ok: false, reason: `This widget uses ${labels.join(', ').toLowerCase()} on ${ds.def.label.toLowerCase()}, which your role can't see.` };
    }
  }
  return { ok: true };
}

/** Query errors that mean "you can't see this" rather than "this is broken". */
export function isAccessError(message: string): boolean {
  return /switched off|don't have access|isn't available to your role|not part of your organisation/i.test(message);
}

// ─── Dashboard-wide date range ──────────────────────────────────────────────

export const DashboardRangeSchema = DateRangeSchema.omit({ field: true }).refine(
  r => !!(r.preset || r.last || r.from || r.to),
  { message: 'A dashboard date range needs a preset, "last", or from/to.' },
);
export type DashboardRange = z.infer<typeof DashboardRangeSchema>;

/** Does this query use a relative period (so a dashboard range may replace it)? */
export function usesRelativeRange(q: QuerySpec): boolean {
  const r = q.dateRange;
  if (!r || (!r.preset && !r.last && !r.from && !r.to)) {
    // No range: a bucketed series defaults to "the last N buckets" (relative);
    // an ungrouped total with no range is all-time on purpose.
    return q.dimensions.some(d => d.bucket);
  }
  if (r.from || r.to) return false;
  if (r.preset === 'all_time') return false;
  return !!(r.preset || r.last);
}

/**
 * The query a widget runs under a dashboard date range. Replaces only
 * relative ranges (last 30 days, this month…) and keeps the date field the
 * widget chose; fixed from/to ranges, all-time totals, forecasts (whose
 * history window is part of the method) and widgets that opted out keep
 * their own.
 */
export function applyDashboardRange(spec: DashboardWidgetSpec, range: DashboardRange | null | undefined): { query: QuerySpec | null; applied: boolean } {
  if (spec.kind !== 'data') return { query: null, applied: false };
  const q = spec.query;
  if (!range || spec.forecast || spec.options?.ignoreDashboardRange || !usesRelativeRange(q)) return { query: q, applied: false };
  const field = q.dateRange?.field ?? q.dimensions.find(d => d.bucket)?.field ?? null;
  const dateRange = {
    field,
    preset: range.preset ?? null,
    last: range.last ?? null,
    includeCurrent: range.includeCurrent ?? null,
    from: range.from ?? null,
    to: range.to ?? null,
  };
  return { query: { ...q, dateRange }, applied: true };
}

/** Readable label for a range ("Last 30 days", "1 Oct – 18 Oct 2026"). */
export function rangeLabel(r: DashboardRange): string {
  if (r.preset) return r.preset.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  if (r.last) return `Last ${r.last.n} ${r.last.unit}${r.last.n === 1 ? '' : 's'}`;
  return `${r.from ?? '…'} – ${r.to ?? '…'}`;
}

export { LIMITS };
