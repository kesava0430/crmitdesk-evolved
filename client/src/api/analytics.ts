import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface OverviewData {
  tickets: { current: number; change: number };
  leads: { current: number; change: number };
  revenue: { current: number; change: number };
  avgResolutionHours: number | null;
}

export interface TicketAnalytics {
  volume: { labels: string[]; created: number[]; resolved: number[]; forecast: number[] };
  byStatus: { status: string; count: number }[];
  byPriority: { priority: string; count: number }[];
  byCategory: { category: string; count: number }[];
  avgResolutionHours: number | null;
  slaCompliance: number | null;
}

export interface CrmAnalytics {
  leads: {
    byStatus: { status: string; count: number }[];
    overTime: { labels: string[]; values: number[] };
    conversionRate: number;
  };
  deals: {
    pipeline: { stage: string; count: number; value: number }[];
    winRate: number | null;
    revenue: { labels: string[]; values: number[] };
  };
}

/* The three analytics endpoints are guarded by three *different* role groups on
   the server — overview is MANAGERS, tickets is IT_MANAGERS, crm is CRM_MANAGERS
   — so a manager of one side is refused the other side's chart. Each hook takes
   `enabled` so a caller can ask only for the slice its role covers. */

export function useAnalyticsOverview(enabled = true) {
  return useQuery<OverviewData>({ queryKey: ['analytics-overview'], queryFn: () => api.get('/analytics/overview').then(r => r.data), enabled });
}

export function useTicketAnalytics(days = 30, enabled = true) {
  return useQuery<TicketAnalytics>({ queryKey: ['analytics-tickets', days], queryFn: () => api.get(`/analytics/tickets?days=${days}`).then(r => r.data), enabled });
}

export function useCrmAnalytics(days = 30, enabled = true) {
  return useQuery<CrmAnalytics>({ queryKey: ['analytics-crm', days], queryFn: () => api.get(`/analytics/crm?days=${days}`).then(r => r.data), enabled });
}

// ─── Semantic query layer (server/src/utils/analytics/README.md) ─────────────
// Shared by the dashboard "Ask AI" card, the chat bubble and dashboards. All
// numbers come from POST /analytics/query | /analytics/forecast, filtered by
// the org's areas and the viewer's own permissions.

export type AnalyticsBucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface AnalyticsColumn {
  key: string;
  label: string;
  role: 'dimension' | 'measure' | 'field';
  format: 'number' | 'money' | 'date' | 'datetime' | 'text' | 'boolean' | 'enum';
  bucket?: AnalyticsBucket;
  unit?: string;
  idKey?: string;
}

/** The query spec (server: utils/analytics/spec.ts QuerySpecSchema). */
export interface AnalyticsQuerySpec {
  dataset: string;
  mode?: 'aggregate' | 'list';
  measures?: Array<{ fn: 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max'; field?: string | null }>;
  dimensions?: Array<{ field: string; bucket?: AnalyticsBucket | null }>;
  fields?: string[];
  filters?: Array<{ field: string; op: string; value?: unknown }>;
  dateRange?: { field?: string | null; preset?: string | null; last?: { n: number; unit: AnalyticsBucket } | null; includeCurrent?: boolean | null; from?: string | null; to?: string | null } | null;
  compare?: 'previous_period' | 'previous_year' | null;
  sort?: { by: string; dir: 'asc' | 'desc' } | null;
  limit?: number | null;
}

export interface AnalyticsQueryResult {
  columns: AnalyticsColumn[];
  rows: Array<Record<string, any>>;
  meta: {
    dataset: { key: string; label: string };
    description: string;
    kind: 'aggregate' | 'list';
    range: { from: string | null; to: string | null; label: string; human: string; field: string | null; partial: boolean };
    bucket: { key: string; unit: AnalyticsBucket } | null;
    appliedFilters: string[];
    scope: string;
    totals: Record<string, number | null>;
    comparison: null | { label: string; human: string; totals: Record<string, number | null>; change: Record<string, { abs: number | null; pct: number | null }> };
    rowCount: number;
    truncated: boolean;
    currency: string;
    timezone: string;
    warnings: string[];
    spec: AnalyticsQuerySpec;
  };
}

export interface AnalyticsForecastPoint { bucket: string; label: string; value: number; lower?: number; upper?: number; baseline?: number; cumulative?: number; cumulativeLower?: number; cumulativeUpper?: number }

export interface AnalyticsForecastResult {
  history: AnalyticsForecastPoint[];
  projection: AnalyticsForecastPoint[];
  method: string;
  totals: { history: number; projected: number; lower: number; upper: number; baselineProjected?: number } | null;
  measure: { key: string; label: string; format: string };
  description: string;
  currency: string;
  assumptions?: string[];
  warnings?: string[];
  derived?: Array<{ label: string; projected: number | null; lower: number | null; upper: number | null; format: string; explanation: string }>;
}

/** A dashboard widget — the shape "Pin to dashboard" saves (see the server README). */
export interface AnalyticsWidgetSpec {
  version: 1;
  title: string;
  viz: { type: AnalyticsViz; x?: string; y: string[]; series?: string };
  query: AnalyticsQuerySpec;
  forecast?: { horizon: number; scenario?: { growthPctPerMonth?: number | null } | null; cumulative?: boolean | null; derived?: unknown[] };
  description: string;
  source: { kind: 'ai_answer' | 'manual'; question?: string };
}

export type AnalyticsViz = 'kpi' | 'line' | 'area' | 'bar' | 'stacked_bar' | 'pie' | 'table' | 'leaderboard' | 'forecast';

/** POST /ai/query response. */
export interface AskAnswer {
  status: 'answered' | 'unanswerable';
  question: string;
  answer: string;
  title: string;
  chart: AnalyticsViz | null;
  results: AnalyticsQueryResult[];
  forecast: AnalyticsForecastResult | null;
  howCalculated: string[];
  widgetSpec: AnalyticsWidgetSpec | null;
  available: Array<{ dataset: string; label: string; examples: string[] }>;
  warnings: string[];
  cached: boolean;
  modelCalls: number;
}

export interface AnalyticsCatalog {
  version: string;
  timezone: string;
  currency: string;
  today: string;
  datasets: Array<{
    key: string; label: string; description: string; area: string; scope: string; defaultDateField: string; examples: string[];
    fields: Array<{ key: string; label: string; type: string; values?: string[]; unit?: string; groupable: boolean; filterable: boolean; aggregations: string[]; buckets?: AnalyticsBucket[] }>;
  }>;
}

export function useAnalyticsCatalog(enabled = true) {
  return useQuery<AnalyticsCatalog>({ queryKey: ['analytics-catalog'], queryFn: () => api.get('/analytics/catalog').then(r => r.data), enabled, staleTime: 60_000 });
}

export function runAnalyticsQuery(spec: AnalyticsQuerySpec): Promise<AnalyticsQueryResult> {
  return api.post('/analytics/query', spec).then(r => r.data);
}

export function runAnalyticsForecast(body: { series: AnalyticsQuerySpec; horizon: number; scenario?: { growthPctPerMonth?: number | null }; cumulative?: boolean; derived?: unknown[] }): Promise<AnalyticsForecastResult> {
  return api.post('/analytics/forecast', body).then(r => r.data);
}
