import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AnalyticsQuerySpec, AnalyticsQueryResult, AnalyticsColumn, AnalyticsBucket } from './analytics';

// ─── Dashboards (server/src/modules/dashboards, utils/dashboards) ────────────
// Widgets store query specs, never data: /render re-runs them as the viewer.

export type WidgetViz = 'kpi' | 'line' | 'area' | 'bar' | 'stacked_bar' | 'pie' | 'table' | 'leaderboard' | 'forecast' | 'hbar' | 'donut' | 'funnel';

export interface ForecastConfig {
  horizon: number;
  scenario?: { growthPctPerMonth?: number | null } | null;
  cumulative?: boolean | null;
  seasonality?: 'auto' | 'none' | null;
  derived?: Array<Record<string, unknown>>;
}

export interface DataWidgetSpec {
  version: 1;
  kind: 'data';
  title: string;
  viz: { type: WidgetViz; x?: string | null; y: string[]; series?: string | null };
  query: AnalyticsQuerySpec;
  forecast?: ForecastConfig | null;
  description: string;
  source: { kind: 'ai_answer' | 'manual' | 'ai_dashboard'; question?: string | null };
  options: {
    kpi?: { value: 'total' | 'projected' | 'derived' | 'rate'; derived?: number | null } | null;
    topN?: number | null;
    ignoreDashboardRange?: boolean | null;
    pageSize?: number | null;
  };
}

export interface NoteWidgetSpec {
  version: 1;
  kind: 'note';
  title: string;
  text: string;
  methodOf?: { query: AnalyticsQuerySpec; forecast: ForecastConfig } | null;
  source: DataWidgetSpec['source'];
}

export type WidgetSpec = DataWidgetSpec | NoteWidgetSpec;

export interface Cell { x: number; y: number; w: number; h: number }

export interface DashboardRange {
  preset?: string | null;
  last?: { n: number; unit: AnalyticsBucket } | null;
  includeCurrent?: boolean | null;
  from?: string | null;
  to?: string | null;
}

export interface DashboardAccess { view: boolean; edit: boolean; share: boolean; delete: boolean; duplicate: boolean; isOwner: boolean }

export interface DashboardSummary {
  id: string;
  title: string;
  description: string | null;
  visibility: 'PRIVATE' | 'ORG' | 'ROLES';
  owner: { id: string; name: string };
  widgetCount: number;
  updatedAt: string;
  access: DashboardAccess;
}

export interface Dashboard {
  id: string;
  title: string;
  description: string | null;
  visibility: 'PRIVATE' | 'ORG' | 'ROLES';
  roleIds: string[];
  legacyRoles: string[];
  owner: { id: string; name: string };
  dateRange: DashboardRange | null;
  refreshMinutes: number;
  layout: Record<string, Cell>;
  widgets: Array<{ id: string; position: number; spec: WidgetSpec }>;
  access: DashboardAccess;
  createdAt: string;
  updatedAt: string;
}

export interface ForecastPayload {
  columns: AnalyticsColumn[];
  history: Array<{ bucket: string; label: string; value: number }>;
  projection: Array<{ bucket: string; label: string; value: number; lower: number; upper: number; baseline?: number; cumulative?: number; cumulativeLower?: number; cumulativeUpper?: number }>;
  method: string;
  totals: { history: number; projected: number; lower: number; upper: number; baselineProjected?: number } | null;
  historyWindow: { from: string | null; to: string | null; points: number; human: string };
  horizon: { buckets: number; unit: AnalyticsBucket; from: string; to: string; human: string };
  measure: { key: string; label: string; format: string };
  derived: Array<{ label: string; rate: number | null; numerator: number | null; denominator: number | null; window: { label: string; human: string }; projected: number | null; lower: number | null; upper: number | null; format: 'number' | 'money' | 'percent'; explanation: string }>;
  description: string;
  assumptions: string[];
  warnings: string[];
  currency: string;
  timezone: string;
}

export interface MethodNote {
  description: string;
  method: string;
  historyWindow: ForecastPayload['historyWindow'];
  horizon: ForecastPayload['horizon'];
  assumptions: string[];
  warnings: string[];
  derived: Array<{ label: string; explanation: string }>;
}

export interface RenderedWidget {
  id: string;
  status: 'ok' | 'unavailable' | 'error';
  reason?: string;
  result?: AnalyticsQueryResult;
  forecast?: ForecastPayload;
  note?: { text?: string; method?: MethodNote };
  rangeApplied?: boolean;
}

export interface RenderResponse {
  widgets: RenderedWidget[];
  range: DashboardRange | null;
  timezone: string;
  currency: string;
  today: string;
  renderedAt: string;
}

export interface Proposal {
  title: string;
  description: string;
  widgets: WidgetSpec[];
  layout: Record<string, Cell>;
}

export interface ProposeResponse {
  status: 'proposed' | 'failed';
  proposal: Proposal | null;
  warnings: string[];
  message?: string;
  cached: boolean;
  modelCalls: number;
}

const KEY = ['dashboards'] as const;

export function useDashboards(enabled = true) {
  return useQuery<{ mine: DashboardSummary[]; shared: DashboardSummary[]; home: { dashboardId: string; replaceBuiltIn: boolean } | null; canManage: boolean }>({
    queryKey: KEY, queryFn: () => api.get('/dashboards').then(r => r.data), enabled,
  });
}

export function useDashboard(id: string | undefined) {
  return useQuery<Dashboard>({ queryKey: [...KEY, id], queryFn: () => api.get(`/dashboards/${id}`).then(r => r.data), enabled: !!id });
}

export function useHomeDashboard(enabled = true) {
  return useQuery<{ home: { dashboardId: string; title: string; replaceBuiltIn: boolean } | null }>({
    queryKey: [...KEY, 'home'], queryFn: () => api.get('/dashboards/home').then(r => r.data), enabled, staleTime: 60_000,
  });
}

export function useShareOptions(enabled: boolean) {
  return useQuery<{ roles: Array<{ id: string; key: string; name: string; legacyRole: string | null }> }>({
    queryKey: [...KEY, 'share-options'], queryFn: () => api.get('/dashboards/share-options').then(r => r.data), enabled, staleTime: 300_000,
  });
}

export function renderDashboard(id: string, body: { dateRange?: DashboardRange | null; widgetIds?: string[] } = {}): Promise<RenderResponse> {
  return api.post(`/dashboards/${id}/render`, body).then(r => r.data);
}

export function renderSpecs(specs: WidgetSpec[], dateRange?: DashboardRange | null): Promise<RenderResponse> {
  return api.post('/dashboards/render-specs', { specs, dateRange }).then(r => r.data);
}

/** All dashboard mutations refresh the list and the dashboard itself. */
function useDashMutation<TVars, TRes>(fn: (v: TVars) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useCreateDashboard = () => useDashMutation((b: { title: string; description?: string | null; widgets?: WidgetSpec[]; layout?: Record<string, Cell>; dateRange?: DashboardRange | null }) =>
  api.post('/dashboards', b).then(r => r.data as Dashboard));
export const useUpdateDashboard = () => useDashMutation(({ id, ...b }: { id: string; title?: string; description?: string | null; layout?: Record<string, Cell>; order?: string[]; dateRange?: DashboardRange | null; refreshMinutes?: number }) =>
  api.patch(`/dashboards/${id}`, b).then(r => r.data as Dashboard));
export const useShareDashboard = () => useDashMutation(({ id, ...b }: { id: string; visibility: 'PRIVATE' | 'ORG' | 'ROLES'; roleIds?: string[]; legacyRoles?: string[] }) =>
  api.put(`/dashboards/${id}/share`, b).then(r => r.data as Dashboard));
export const useDeleteDashboard = () => useDashMutation((id: string) => api.delete(`/dashboards/${id}`).then(() => id));
export const useDuplicateDashboard = () => useDashMutation((id: string) => api.post(`/dashboards/${id}/duplicate`, {}).then(r => r.data as Dashboard));
export const useAddWidget = () => useDashMutation(({ id, spec }: { id: string; spec: WidgetSpec | Record<string, unknown> }) =>
  api.post(`/dashboards/${id}/widgets`, { spec }).then(r => r.data as { widgetId: string; dashboard: Dashboard }));
export const useUpdateWidget = () => useDashMutation(({ id, widgetId, spec }: { id: string; widgetId: string; spec: WidgetSpec }) =>
  api.patch(`/dashboards/${id}/widgets/${widgetId}`, { spec }).then(r => r.data as Dashboard));
export const useRemoveWidget = () => useDashMutation(({ id, widgetId }: { id: string; widgetId: string }) =>
  api.delete(`/dashboards/${id}/widgets/${widgetId}`).then(r => r.data as Dashboard));
export const useDuplicateWidget = () => useDashMutation(({ id, widgetId }: { id: string; widgetId: string }) =>
  api.post(`/dashboards/${id}/widgets/${widgetId}/duplicate`, {}).then(r => r.data as { widgetId: string; dashboard: Dashboard }));
export const useSetHome = () => useDashMutation((b: { dashboardId: string | null; replaceBuiltIn?: boolean }) => api.put('/dashboards/home', b).then(r => r.data));

// _silent: both screens show the failure inline (AiErrorAlert), so no toast on top.
export function proposeDashboard(prompt: string): Promise<ProposeResponse> {
  return api.post('/dashboards/ai/propose', { prompt }, { _silent: true }).then(r => r.data);
}

export function aiModifyWidget(spec: WidgetSpec, instruction: string): Promise<{ status: 'modified' | 'failed'; spec: WidgetSpec | null; message?: string }> {
  return api.post('/dashboards/ai/modify-widget', { spec, instruction }, { _silent: true }).then(r => r.data);
}

/** Readable error from an axios failure. */
export function apiError(err: unknown, fallback = 'Something went wrong.'): string {
  return (err as any)?.response?.data?.error || (err as any)?.message || fallback;
}
