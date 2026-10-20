/**
 * Turning query results into words, charts and dashboard widgets — pure.
 *
 * Numbers in an AI answer must come from the data, so the default answer is
 * a deterministic template filled from the result rows (formatted here, in
 * the org's currency). When a model does write the sentence (multi-query
 * answers), checkNumbers() verifies every number it wrote appears in the
 * results; otherwise the template is used instead.
 */
import type { QueryResult, ForecastResponse } from './executor';
import { humanEnum, type Column } from './compiler';
import type { QuerySpec, ForecastSpec } from './spec';
import { bucketLabel } from './dates';
import type { Bucket } from './types';

// ─── Formatting ─────────────────────────────────────────────────────────────

export function localeFor(currency: string): string {
  return currency === 'INR' ? 'en-IN' : 'en-US';
}

export function fmtNumber(v: number, currency: string, maxFrac = 1): string {
  return new Intl.NumberFormat(localeFor(currency), { maximumFractionDigits: Number.isInteger(v) ? 0 : maxFrac }).format(v);
}

export function fmtMoney(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat(localeFor(currency), { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v);
  } catch {
    return `${currency} ${fmtNumber(v, currency, 2)}`;
  }
}

export function fmtValue(v: unknown, col: Pick<Column, 'format' | 'unit' | 'bucket'>, currency: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (col.format === 'money') return fmtMoney(Number(v), currency);
  if (col.format === 'number') {
    const s = fmtNumber(Number(v), currency, 1);
    return col.unit && col.unit !== '%' ? `${s} ${col.unit}` : col.unit === '%' ? `${s}%` : s;
  }
  if (col.format === 'date' && col.bucket && typeof v === 'string') return bucketLabel(v, col.bucket);
  if (col.format === 'boolean') return v ? 'Yes' : 'No';
  if (col.format === 'enum') return humanEnum(String(v));
  return String(v);
}

export { humanEnum };

// ─── Chart choice ───────────────────────────────────────────────────────────

export type VizType = 'kpi' | 'line' | 'area' | 'bar' | 'stacked_bar' | 'pie' | 'table' | 'leaderboard' | 'forecast';

/** What a result's shape supports; a model's suggestion is only taken when it fits. */
export function chooseViz(r: Pick<QueryResult, 'columns' | 'rows'> & { meta: Pick<QueryResult['meta'], 'kind' | 'bucket'> }, suggested?: string | null, hasForecast = false): VizType {
  if (hasForecast) return 'forecast';
  if (r.meta.kind === 'list') return 'table';
  const dims = r.columns.filter(c => c.role === 'dimension');
  const measures = r.columns.filter(c => c.role === 'measure');
  if (!dims.length) return 'kpi';
  if (r.meta.bucket) {
    if (dims.length === 2) return suggested === 'line' ? 'line' : 'stacked_bar';
    return suggested === 'bar' || suggested === 'area' ? suggested : 'line';
  }
  if (dims.length === 2) return 'stacked_bar';
  if (suggested === 'pie' && measures.length === 1 && r.rows.length <= 8 && r.rows.every(x => Number(x[measures[0].key] ?? 0) >= 0)) return 'pie';
  if (suggested === 'table') return 'table';
  if (suggested === 'leaderboard' || (r.rows.length <= 10 && /top|rank|leader/i.test(String(suggested ?? '')))) return 'leaderboard';
  return 'bar';
}

// ─── Widget spec (shared with the dashboards) ───────────────────────────────

export interface WidgetSpec {
  version: 1;
  title: string;
  viz: { type: VizType; x?: string; y: string[]; series?: string };
  /** Re-run with POST /api/analytics/query (and as the forecast's `series`). */
  query: QuerySpec;
  /** When set, re-run with POST /api/analytics/forecast { series: query, ...forecast }. */
  forecast?: Omit<ForecastSpec, 'series'>;
  /** The query in human words ("Number of leads per week — last 12 weeks …"). */
  description: string;
  source: { kind: 'ai_answer' | 'manual'; question?: string };
}

export function buildWidgetSpec(opts: {
  title: string;
  result: QueryResult;
  viz: VizType;
  forecast?: Omit<ForecastSpec, 'series'> | null;
  question?: string;
}): WidgetSpec {
  const { result, viz } = opts;
  const dims = result.columns.filter(c => c.role === 'dimension');
  const measures = result.columns.filter(c => c.role === 'measure').map(c => c.key);
  const fields = result.columns.filter(c => c.role === 'field').map(c => c.key);
  return {
    version: 1,
    title: opts.title.slice(0, 120),
    viz: {
      type: viz,
      ...(dims[0] ? { x: dims[0].key } : {}),
      y: measures.length ? measures : fields,
      ...(dims[1] ? { series: dims[1].key } : {}),
    },
    query: result.meta.spec,
    ...(opts.forecast ? { forecast: opts.forecast } : {}),
    description: result.meta.description,
    source: { kind: 'ai_answer', ...(opts.question ? { question: opts.question.slice(0, 500) } : {}) },
  };
}

// ─── Deterministic answers ──────────────────────────────────────────────────

function rangePhrase(r: QueryResult): string {
  const rg = r.meta.range;
  if (!rg.from && !rg.to) return '';
  const bare = /^(today|yesterday|this |last (week|month|quarter|year)$|next )/.test(rg.label);
  return ` ${bare ? rg.label : `in the ${rg.label}`} (${rg.human})`;
}

function labelOfRow(row: Record<string, unknown>, cols: Column[], currency: string): string {
  return cols.map(c => fmtValue(row[c.key], c, currency)).join(' · ');
}

/** One-sentence-ish answer for a single query result. */
export function answerFor(r: QueryResult): string {
  const cur = r.meta.currency;
  const dims = r.columns.filter(c => c.role === 'dimension');
  const measures = r.columns.filter(c => c.role === 'measure');
  const filt = r.meta.appliedFilters.length ? ` where ${r.meta.appliedFilters.join(' and ')}` : '';

  if (r.meta.kind === 'list') {
    const cols = r.columns.filter(c => c.role === 'field');
    // Name-like columns first, then the first amount, so a row reads "INV-0012 · Globex · ₹1,41,600".
    const nameCols = cols.filter(c => c.format === 'text').slice(0, 2);
    const amount = cols.find(c => c.format === 'money') ?? (nameCols.length ? undefined : cols.find(c => c.format === 'number'));
    const show = [...(nameCols.length ? nameCols : cols.slice(0, 2)), ...(amount ? [amount] : [])];
    const n = r.rows.length;
    const what = r.meta.dataset.label.toLowerCase();
    const cond = [...r.meta.appliedFilters].join(', ');
    const where = `${cond}${rangePhrase(r) ? `${cond ? ',' : ''}${rangePhrase(r)}` : ''}`.trim();
    if (!n) return `No ${what} found${where ? ` (${where})` : ''}.`;
    const shown = r.rows.slice(0, 8).map(row => labelOfRow(row, show, cur));
    const more = n > 8 ? `; and ${n - 8} more` : '';
    return `${r.meta.truncated ? `More than ${n}` : n} ${what}${where ? ` (${where})` : ''}: ${shown.join('; ')}${more}.`;
  }

  const m = measures[0];
  const total = r.meta.totals[m.key];
  const totalTxt = total == null ? 'no data' : fmtValue(total, m, cur);
  let cmp = '';
  if (r.meta.comparison && total != null) {
    const prev = r.meta.comparison.totals[m.key];
    const ch = r.meta.comparison.change[m.key];
    if (prev != null) {
      const dir = ch.abs == null || ch.abs === 0 ? 'unchanged' : ch.abs > 0 ? 'up' : 'down';
      cmp = dir === 'unchanged'
        ? ` — unchanged from the ${r.meta.comparison.label} (${fmtValue(prev, m, cur)})`
        : ` — ${dir}${ch.pct != null ? ` ${fmtNumber(Math.abs(ch.pct), cur)}%` : ''} from ${fmtValue(prev, m, cur)} in the ${r.meta.comparison.label} (${r.meta.comparison.human})`;
    }
  }

  if (!dims.length) {
    const extra = measures.slice(1).map(x => `${x.label.toLowerCase()} ${fmtValue(r.meta.totals[x.key], x, cur)}`).join(', ');
    return `${m.label}${filt}${rangePhrase(r)}: ${totalTxt}${cmp}${extra ? ` (${extra})` : ''}.`;
  }

  if (r.meta.bucket && dims.length === 1) {
    const d = dims[0];
    const pts = r.rows.filter(x => x[m.key] != null);
    if (!pts.length) return `${m.label}${filt}${rangePhrase(r)}: no data.`;
    const max = pts.reduce((a, b) => (Number(b[m.key]) > Number(a[m.key]) ? b : a));
    const min = pts.reduce((a, b) => (Number(b[m.key]) < Number(a[m.key]) ? b : a));
    const last = pts[pts.length - 1];
    const additive = /^(count|distinct_|sum_)/.test(m.key);
    const unit = d.bucket as Bucket;
    return `${m.label} per ${unit}${filt}${rangePhrase(r)}: ${additive ? `${totalTxt} in total${cmp}, ` : ''}`
      + `highest ${fmtValue(max[d.key], d, cur)} (${fmtValue(max[m.key], m, cur)}), lowest ${fmtValue(min[d.key], d, cur)} (${fmtValue(min[m.key], m, cur)}), `
      + `latest ${fmtValue(last[d.key], d, cur)}: ${fmtValue(last[m.key], m, cur)}${r.meta.range.partial ? ' so far' : ''}.`;
  }

  const top = r.rows.slice(0, 10).map(row => `${labelOfRow(row, dims, cur)} ${fmtValue(row[m.key], m, cur)}`);
  const lead = r.meta.spec.limit && r.meta.spec.limit <= 20 ? `Top ${r.rows.length} by ${m.label.toLowerCase()}` : `${m.label} by ${dims.map(x => x.label.toLowerCase()).join(' and ')}`;
  const more = r.rows.length > 10 ? `, and ${r.rows.length - 10} more` : '';
  return `${lead}${filt}${rangePhrase(r)}: ${top.join(', ')}${more} (total ${totalTxt}${cmp}).`;
}

export function forecastAnswer(f: ForecastResponse): string {
  const fmt = (v: number) => (f.measure.format === 'money' ? fmtMoney(v, f.currency) : fmtNumber(Math.round(v), f.currency));
  if (f.method === 'none' || !f.totals) {
    return `I can't project this honestly: ${f.warnings[0] ?? 'there is not enough history.'}`;
  }
  const what = f.measure.label.replace(/^Number of /, '').replace(/^Total /, 'total ').toLowerCase();
  const perHist = f.historyWindow.points ? (f.totals.history / f.historyWindow.points) * f.horizon.buckets : 0;
  let s = `If things continue the same way, about ${fmt(f.totals.projected)} ${what} over the next ${f.horizon.buckets} ${f.horizon.unit}${f.horizon.buckets === 1 ? '' : 's'} (${f.horizon.human}); 95% range ${fmt(f.totals.lower)}–${fmt(f.totals.upper)}. `
    + `For comparison: ${fmt(f.totals.history)} in the last ${f.historyWindow.points} ${f.horizon.unit}s (${f.historyWindow.human}), about ${fmt(perHist)} per ${f.horizon.buckets} ${f.horizon.unit}s.`;
  if (f.totals.baselineProjected != null) s += ` Without the what-if growth: ${fmt(f.totals.baselineProjected)}.`;
  for (const d of f.derived) {
    if (d.projected == null) continue;
    const v = d.format === 'money' ? fmtMoney(d.projected, f.currency) : fmtNumber(Math.round(d.projected), f.currency);
    s += ` ${d.label}: ${v}.`;
  }
  // A lumpy history (see sparseHistory) gets its caveat in the answer itself,
  // not only under "how this was calculated".
  const caveat = f.warnings.find(w => /unreliable until/.test(w));
  if (caveat) s += ` Caution: ${caveat}`;
  return s;
}

// ─── Number checking for model-written text ─────────────────────────────────

/** Every number in `text` must match a number in `allowed` (as written, or rounded). */
export function checkNumbers(text: string, allowed: number[]): { ok: boolean; unknown: string[] } {
  const found = text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  const unknown: string[] = [];
  for (const tok of found) {
    const v = Number(tok.replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    // Small integers (1–31, years) are dates, ordinals or periods ("last 12 weeks", "2026").
    if (Number.isInteger(v) && (Math.abs(v) <= 31 || (v >= 1990 && v <= 2100))) continue;
    const ok = allowed.some(a => Math.abs(a - v) < 0.01 || Math.round(a) === v || Math.abs(a - v) / Math.max(1, Math.abs(a)) < 0.005);
    if (!ok) unknown.push(tok);
  }
  return { ok: unknown.length === 0, unknown };
}

/** All numbers a result exposes (rows, totals, comparison, percentages). */
export function numbersOf(r: QueryResult): number[] {
  const out: number[] = [];
  const push = (v: unknown) => { if (typeof v === 'number' && Number.isFinite(v)) out.push(v); };
  for (const row of r.rows) for (const v of Object.values(row)) push(v);
  for (const v of Object.values(r.meta.totals)) push(v);
  if (r.meta.comparison) {
    for (const v of Object.values(r.meta.comparison.totals)) push(v);
    for (const c of Object.values(r.meta.comparison.change)) { push(c.abs); push(c.pct); if (c.abs != null) push(Math.abs(c.abs)); if (c.pct != null) push(Math.abs(c.pct)); }
  }
  out.push(r.rows.length);
  return out;
}
