/**
 * The query spec — the ONLY thing a caller (dashboard widget, API client or
 * the AI) can send to the query layer. It names datasets and fields by key
 * and carries values; it can never carry SQL, table names or Prisma
 * arguments. compiler.ts validates every key against the caller's resolved
 * catalog before anything is built.
 *
 * Kept deliberately small and enumerated so a small model (gpt-oss-20b) can
 * produce it reliably in JSON mode.
 */
import { z } from 'zod';
import { PRESETS } from './dates';

/** Preset names as one line, for prompts. */
export const PRESETS_TEXT = PRESETS.join(', ');

export const BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const MEASURE_FNS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export const FILTER_OPS = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'is_null', 'not_null'] as const;

/** Hard limits, enforced server-side whatever the spec asks for. */
export const LIMITS = {
  maxMeasures: 4,
  maxDimensions: 2,
  maxFilters: 10,
  maxListFields: 12,
  /** Groups an aggregate query may return (date buckets included). */
  maxGroups: 200,
  /** Rows a list query may return. */
  maxRows: 500,
  defaultGroups: 50,
  defaultRows: 50,
  /** Date buckets a series may span (2 years of days). */
  maxBuckets: 800,
  /** Postgres statement_timeout for one query. */
  timeoutMs: Number(process.env.ANALYTICS_QUERY_TIMEOUT_MS ?? 8000),
};

const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const FilterSchema = z.object({
  field: z.string().min(1).max(80),
  op: z.enum(FILTER_OPS),
  value: z.union([scalar, z.array(scalar).max(50)]).nullish(),
});

export const MeasureSchema = z.object({
  fn: z.enum(MEASURE_FNS),
  field: z.string().max(80).nullish(),
});

export const DimensionSchema = z.object({
  field: z.string().min(1).max(80),
  bucket: z.enum(BUCKETS).nullish(),
});

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are YYYY-MM-DD');

export const DateRangeSchema = z.object({
  field: z.string().max(80).nullish(),
  preset: z.enum(PRESETS as [string, ...string[]]).nullish(),
  last: z.object({ n: z.number().int().min(1).max(730), unit: z.enum(BUCKETS) }).nullish(),
  includeCurrent: z.boolean().nullish(),
  from: ymd.nullish(),
  to: ymd.nullish(),
});

export const QuerySpecSchema = z.object({
  dataset: z.string().min(1).max(80),
  mode: z.enum(['aggregate', 'list']).default('aggregate'),
  measures: z.array(MeasureSchema).max(LIMITS.maxMeasures).default([{ fn: 'count' }]),
  dimensions: z.array(DimensionSchema).max(LIMITS.maxDimensions).default([]),
  /** list mode: which fields to show (defaults to the dataset's list fields). */
  fields: z.array(z.string().max(80)).max(LIMITS.maxListFields).default([]),
  filters: z.array(FilterSchema).max(LIMITS.maxFilters).default([]),
  dateRange: DateRangeSchema.nullish(),
  compare: z.enum(['previous_period', 'previous_year']).nullish(),
  sort: z.object({ by: z.string().max(80), dir: z.enum(['asc', 'desc']).default('desc') }).nullish(),
  limit: z.number().int().min(1).max(LIMITS.maxRows).nullish(),
});

export type QuerySpec = z.infer<typeof QuerySpecSchema>;
export type QuerySpecInput = z.input<typeof QuerySpecSchema>;
export type FilterSpec = z.infer<typeof FilterSchema>;
export type MeasureSpec = z.infer<typeof MeasureSchema>;
export type DimensionSpec = z.infer<typeof DimensionSchema>;
export type DateRangeSpec = z.infer<typeof DateRangeSchema>;

/** Forecast request: a series query (one date dimension, one measure) + horizon + scenario. */
export const ForecastSpecSchema = z.object({
  series: QuerySpecSchema,
  /** Number of future buckets to project (days/weeks/months of the series' bucket). */
  horizon: z.number().int().min(1).max(366),
  scenario: z.object({
    /** What-if growth on top of the trend, % per month (e.g. 10 = +10%/month). */
    growthPctPerMonth: z.number().min(-90).max(500).nullish(),
  }).nullish(),
  cumulative: z.boolean().nullish(),
  seasonality: z.enum(['auto', 'none']).nullish(),
  /** Derived projections: projected total × (numerator ÷ denominator) over a stated window. */
  derived: z.array(z.object({
    label: z.string().min(1).max(80),
    numerator: z.object({ dataset: z.string(), measure: MeasureSchema, filters: z.array(FilterSchema).max(LIMITS.maxFilters).default([]) }),
    denominator: z.object({ dataset: z.string(), measure: MeasureSchema, filters: z.array(FilterSchema).max(LIMITS.maxFilters).default([]) }),
    window: DateRangeSchema.nullish(),
    /** 'projection' (default) or the index of an earlier derived entry to multiply. */
    of: z.union([z.literal('projection'), z.number().int().min(0).max(4)]).nullish(),
    format: z.enum(['number', 'money', 'percent']).nullish(),
  })).max(5).default([]),
});

export type ForecastSpec = z.infer<typeof ForecastSpecSchema>;
export type ForecastSpecInput = z.input<typeof ForecastSpecSchema>;

/** Readable zod error list ("measures.0.fn: Invalid enum value…"). */
export function zodIssues(err: z.ZodError): string[] {
  return err.issues.slice(0, 8).map(i => `${i.path.join('.') || 'spec'}: ${i.message}`);
}
