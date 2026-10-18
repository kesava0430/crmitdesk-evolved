/**
 * Rendering dashboard widgets for ONE viewer.
 *
 * Every call builds the viewer's own analytics context (their areas, record
 * scope and field rules) and re-runs each widget's query / forecast with it.
 * Nothing is cached across requests or users: within one request identical
 * specs share a run (a forecast chart and the KPI tiles built on the same
 * forecast), which is the same viewer and the same moment.
 */
import { STATIC_DATASETS } from '../analytics/catalog';
import { runQuery, runForecast, type AnalyticsContext, type QueryResult, type ForecastResponse } from '../analytics/executor';
import { QueryError } from '../analytics/compiler';
import {
  parseWidgetSpec, widgetAvailability, applyDashboardRange, isAccessError,
  type DashboardWidgetSpec, type DashboardRange,
} from './widget';

export interface MethodNote {
  description: string;
  method: string;
  historyWindow: ForecastResponse['historyWindow'];
  horizon: ForecastResponse['horizon'];
  assumptions: string[];
  warnings: string[];
  derived: Array<{ label: string; explanation: string }>;
}

export interface RenderedWidget {
  id: string;
  status: 'ok' | 'unavailable' | 'error';
  /** Why it isn't shown (unavailable / error). */
  reason?: string;
  result?: QueryResult;
  forecast?: Omit<ForecastResponse, 'spec' | 'columns'> & { columns: ForecastResponse['columns'] };
  note?: { text?: string; method?: MethodNote };
  /** The dashboard date range replaced this widget's relative range. */
  rangeApplied?: boolean;
}

const MAX_ROWS = 500;
const CONCURRENCY = 4;

function trimForecast(f: ForecastResponse): RenderedWidget['forecast'] {
  const { spec: _s, ...rest } = f;
  void _s;
  return rest;
}

function methodNote(f: ForecastResponse): MethodNote {
  return {
    description: f.description,
    method: f.method,
    historyWindow: f.historyWindow,
    horizon: f.horizon,
    assumptions: f.assumptions,
    warnings: f.warnings,
    derived: f.derived.map(d => ({ label: d.label, explanation: d.explanation })),
  };
}

export async function renderWidgets(
  actx: AnalyticsContext,
  widgets: Array<{ id: string; spec: unknown }>,
  range: DashboardRange | null,
): Promise<RenderedWidget[]> {
  const queryRuns = new Map<string, Promise<QueryResult>>();
  const forecastRuns = new Map<string, Promise<ForecastResponse>>();
  const q = (spec: Parameters<typeof runQuery>[1]) => {
    const k = JSON.stringify(spec);
    if (!queryRuns.has(k)) queryRuns.set(k, runQuery(actx, spec));
    return queryRuns.get(k)!;
  };
  const fc = (body: Parameters<typeof runForecast>[1]) => {
    const k = JSON.stringify(body);
    if (!forecastRuns.has(k)) forecastRuns.set(k, runForecast(actx, body));
    return forecastRuns.get(k)!;
  };

  const one = async (w: { id: string; spec: unknown }): Promise<RenderedWidget> => {
    const { spec, errors } = parseWidgetSpec(w.spec);
    if (!spec) return { id: w.id, status: 'error', reason: `This widget's settings are invalid: ${errors.slice(0, 2).join('; ')}` };
    const avail = widgetAvailability(actx.catalog, spec, STATIC_DATASETS, actx.blockedModules);
    if (!avail.ok) return { id: w.id, status: 'unavailable', reason: avail.reason };
    try {
      return await renderOne(w.id, spec);
    } catch (err) {
      if (err instanceof QueryError) {
        return { id: w.id, status: isAccessError(err.message) ? 'unavailable' : 'error', reason: err.message };
      }
      console.error('[dashboards] widget render failed', w.id, err);
      return { id: w.id, status: 'error', reason: "Couldn't load this widget. Try again." };
    }
  };

  const renderOne = async (id: string, spec: DashboardWidgetSpec): Promise<RenderedWidget> => {
    if (spec.kind === 'note') {
      if (!spec.methodOf) return { id, status: 'ok', note: { text: spec.text } };
      const f = await fc({ series: spec.methodOf.query, ...spec.methodOf.forecast });
      return { id, status: 'ok', note: { text: spec.text || undefined, method: methodNote(f) } };
    }
    if (spec.forecast) {
      const f = await fc({ series: spec.query, ...spec.forecast });
      return { id, status: 'ok', forecast: trimForecast(f) };
    }
    const { query, applied } = applyDashboardRange(spec, range);
    const r = await q(query!);
    return { id, status: 'ok', result: { ...r, rows: r.rows.slice(0, MAX_ROWS) }, rangeApplied: applied };
  };

  const out: RenderedWidget[] = new Array(widgets.length);
  for (let i = 0; i < widgets.length; i += CONCURRENCY) {
    const chunk = widgets.slice(i, i + CONCURRENCY);
    const done = await Promise.all(chunk.map(one));
    done.forEach((r, j) => { out[i + j] = r; });
  }
  return out;
}
