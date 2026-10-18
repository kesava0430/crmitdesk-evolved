/**
 * Renders an "Ask anything" answer: the sentence, a small chart or table of
 * the data behind it, and "How this was calculated". Used by the dashboard's
 * Ask AI card and (compact) by the chat bubble. Every number shown here is a
 * value the server returned from a permission-checked query — this component
 * only formats.
 *
 * `onPin` (optional) shows a "Pin to dashboard" button that hands over the
 * answer's widgetSpec — the dashboards feature supplies it.
 */
import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ComposedChart, Area,
} from 'recharts';
import { ChevronDown, Pin, Info, AlertTriangle } from 'lucide-react';
import type { AnalyticsColumn, AnalyticsForecastResult, AnalyticsViz, AnalyticsWidgetSpec, AskAnswer } from '../../api/analytics';
import { useChartTheme } from '../chartTheme';
import { Button } from './Button';

export interface AnswerView {
  status: 'answered' | 'unanswerable';
  answer?: string;
  title?: string;
  chart: AnalyticsViz | null;
  columns?: AnalyticsColumn[];
  rows?: Array<Record<string, any>>;
  currency: string;
  truncated?: boolean;
  description?: string;
  comparison?: AskAnswer['results'][number]['meta']['comparison'];
  forecast?: Pick<AnalyticsForecastResult, 'history' | 'projection' | 'totals' | 'measure' | 'method' | 'description' | 'currency'> | null;
  howCalculated: string[];
  warnings: string[];
  widgetSpec: AnalyticsWidgetSpec | null;
}

/** POST /ai/query → view model (first result drives the chart). */
export function answerViewFromAsk(r: AskAnswer): AnswerView {
  const first = r.results[0];
  return {
    status: r.status, answer: r.answer, title: r.title, chart: r.chart,
    columns: first?.columns, rows: first?.rows, currency: first?.meta.currency ?? r.forecast?.currency ?? 'USD',
    truncated: first?.meta.truncated, description: first?.meta.description, comparison: first?.meta.comparison,
    forecast: r.forecast, howCalculated: r.howCalculated, warnings: r.warnings, widgetSpec: r.widgetSpec,
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const localeFor = (currency: string) => (currency === 'INR' ? 'en-IN' : 'en-US');

function bucketShort(v: string, bucket?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (bucket === 'month') return `${MONTHS[mo - 1]} ${String(y).slice(2)}`;
  if (bucket === 'quarter') return `Q${Math.floor((mo - 1) / 3) + 1} ${String(y).slice(2)}`;
  if (bucket === 'year') return String(y);
  return `${d} ${MONTHS[mo - 1]}`;
}

function humanEnum(s: string) {
  return /^[A-Z][A-Z0-9_]+$/.test(s) ? (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, ' ') : s;
}

export function formatCell(v: unknown, col: Pick<AnalyticsColumn, 'format' | 'unit' | 'bucket'>, currency: string, compact = false): string {
  if (v === null || v === undefined || v === '') return '—';
  const loc = localeFor(currency);
  if (col.format === 'money') {
    const n = Number(v);
    try {
      return new Intl.NumberFormat(loc, { style: 'currency', currency, notation: compact && Math.abs(n) >= 100000 ? 'compact' : 'standard', minimumFractionDigits: 0, maximumFractionDigits: Math.abs(n) >= 100 || n === 0 ? 0 : 2 }).format(n);
    } catch { return `${currency} ${n}`; }
  }
  if (col.format === 'number') {
    const n = Number(v);
    const s = new Intl.NumberFormat(loc, { notation: compact && Math.abs(n) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: Number.isInteger(n) ? 0 : 1 }).format(n);
    return col.unit === '%' ? `${s}%` : col.unit && !compact ? `${s} ${col.unit}` : s;
  }
  if (col.format === 'date' && col.bucket) return bucketShort(String(v), col.bucket);
  if (col.format === 'boolean') return v ? 'Yes' : 'No';
  if (col.format === 'enum') return humanEnum(String(v));
  return String(v);
}

// ─── Charts ─────────────────────────────────────────────────────────────────

function ChartBox({ height, children }: { height: number; children: React.ReactElement }) {
  return (
    <div className="w-full min-w-0" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

function AnswerChart({ view, compact }: { view: AnswerView; compact: boolean }) {
  const t = useChartTheme();
  const cols = view.columns ?? [];
  const rows = view.rows ?? [];
  const dims = cols.filter(c => c.role === 'dimension');
  const measures = cols.filter(c => c.role === 'measure');
  const h = compact ? 150 : 210;
  const cur = view.currency;

  const forecastData = useMemo(() => {
    const f = view.forecast;
    if (!f) return [];
    const hist = f.history.map(p => ({ label: bucketShort(p.bucket, 'day'), actual: p.value }));
    const proj = f.projection.map(p => ({ label: bucketShort(p.bucket, 'day'), projected: p.value, band: [p.lower ?? p.value, p.upper ?? p.value] as [number, number] }));
    // Join the two lines at the last actual point.
    if (hist.length && proj.length) (hist[hist.length - 1] as any).projected = hist[hist.length - 1].actual;
    return [...hist, ...proj];
  }, [view.forecast]);

  if (view.chart === 'forecast' && view.forecast) {
    const money = view.forecast.measure.format === 'money';
    const fmt = (v: number) => formatCell(v, { format: money ? 'money' : 'number' }, view.forecast!.currency, true);
    return (
      <ChartBox height={h + 20}>
        <ComposedChart data={forecastData} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
          <XAxis dataKey="label" tick={t.tick(10)} stroke={t.axis} interval="preserveStartEnd" minTickGap={28} />
          <YAxis tick={t.tick(10)} stroke={t.axis} tickFormatter={fmt} width={48} allowDecimals={false} />
          <Tooltip contentStyle={t.tooltip.contentStyle} labelStyle={t.tooltip.labelStyle} itemStyle={t.tooltip.itemStyle} cursor={t.lineCursor}
            formatter={(v: any, name: string) => [Array.isArray(v) ? `${fmt(v[0])} – ${fmt(v[1])}` : fmt(Number(v)), name === 'band' ? '95% range' : name === 'actual' ? 'Actual' : 'Projected']} />
          <Area dataKey="band" stroke="none" fill={t.fade(t.series[0], 0.18)} isAnimationActive={false} name="band" />
          <Line dataKey="actual" stroke={t.series[0]} strokeWidth={2} dot={false} isAnimationActive={false} name="actual" />
          <Line dataKey="projected" stroke={t.series[0]} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} name="projected" />
        </ComposedChart>
      </ChartBox>
    );
  }

  if (!rows.length || !measures.length) return null;
  const m = measures[0];
  const fmtM = (v: number) => formatCell(v, m, cur, true);

  if (view.chart === 'kpi') {
    const v = rows[0]?.[m.key];
    const cmp = view.comparison;
    const ch = cmp?.change[m.key];
    return (
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <p className="text-3xl font-semibold text-fg tabular-nums leading-none break-all">{formatCell(v, m, cur)}</p>
        {cmp && ch && ch.abs != null && (
          <p className={`text-sm font-medium ${ch.abs > 0 ? 'text-success-fg' : ch.abs < 0 ? 'text-danger-fg' : 'text-fg-muted'}`}>
            {ch.abs > 0 ? '▲' : ch.abs < 0 ? '▼' : '='} {ch.pct != null ? `${Math.abs(ch.pct)}%` : formatCell(Math.abs(ch.abs), m, cur)}
            <span className="text-fg-muted font-normal"> vs {formatCell(cmp.totals[m.key], m, cur)} ({cmp.label})</span>
          </p>
        )}
      </div>
    );
  }

  if ((view.chart === 'line' || view.chart === 'area') && dims[0]) {
    const d = dims[0];
    return (
      <ChartBox height={h}>
        <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
          <XAxis dataKey={d.key} tickFormatter={(v: string) => formatCell(v, d, cur)} tick={t.tick(10)} stroke={t.axis} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={t.tick(10)} stroke={t.axis} tickFormatter={fmtM} width={48} allowDecimals={false} />
          <Tooltip contentStyle={t.tooltip.contentStyle} labelStyle={t.tooltip.labelStyle} itemStyle={t.tooltip.itemStyle} cursor={t.lineCursor}
            labelFormatter={(v: string) => formatCell(v, d, cur)} formatter={(v: any, _n: string, p: any) => [fmtM(Number(v)), measures.find(x => x.key === p.dataKey)?.label ?? '']} />
          {measures.slice(0, 3).map((mm, i) => (
            <Line key={mm.key} dataKey={mm.key} stroke={t.series[i]} strokeWidth={2} dot={rows.length <= 16} isAnimationActive={false} />
          ))}
        </LineChart>
      </ChartBox>
    );
  }

  if (view.chart === 'pie' && dims[0]) {
    const d = dims[0];
    const data = rows.slice(0, 8).map(r => ({ name: formatCell(r[d.key], d, cur), value: Number(r[m.key] ?? 0) }));
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <ChartBox height={h}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" isAnimationActive={false}>
              {data.map((_, i) => <Cell key={i} fill={t.series[i % t.series.length]} />)}
            </Pie>
            <Tooltip contentStyle={t.tooltip.contentStyle} itemStyle={t.tooltip.itemStyle} formatter={(v: any) => fmtM(Number(v))} />
          </PieChart>
        </ChartBox>
        <ul className="text-xs space-y-1 min-w-0 sm:w-48 shrink-0">
          {data.map((x, i) => (
            <li key={x.name} className="flex items-center gap-2 min-w-0">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: t.series[i % t.series.length] }} />
              <span className="truncate text-fg-muted">{x.name}</span>
              <span className="ml-auto tabular-nums text-fg font-medium">{fmtM(x.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if ((view.chart === 'bar' || view.chart === 'leaderboard' || view.chart === 'stacked_bar') && dims[0]) {
    const d = dims[0];
    const data = rows.slice(0, 10).map(r => ({ ...r, __label: formatCell(r[d.key], d, cur) }));
    const barH = compact ? 26 : 28;
    return (
      <ChartBox height={Math.max(80, data.length * barH + 24)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} horizontal={false} />
          <XAxis type="number" tick={t.tick(10)} stroke={t.axis} tickFormatter={fmtM} allowDecimals={false} />
          <YAxis type="category" dataKey="__label" tick={t.tick(compact ? 10 : 11)} stroke={t.axis} width={compact ? 84 : 110} interval={0} />
          <Tooltip contentStyle={t.tooltip.contentStyle} labelStyle={t.tooltip.labelStyle} itemStyle={t.tooltip.itemStyle} cursor={t.barCursor}
            formatter={(v: any) => [fmtM(Number(v)), m.label]} />
          <Bar dataKey={m.key} fill={t.series[0]} radius={[0, 3, 3, 0]} isAnimationActive={false} barSize={compact ? 12 : 14} />
        </BarChart>
      </ChartBox>
    );
  }
  return null;
}

// ─── Data table ─────────────────────────────────────────────────────────────

export function AnswerTable({ view, max = 20 }: { view: AnswerView; max?: number }) {
  const cols = (view.columns ?? []).filter(c => !c.key.startsWith('__'));
  const rows = view.rows ?? [];
  if (!cols.length) return null;
  if (!rows.length) return <p className="text-xs text-fg-muted">No rows.</p>;
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-fg-muted border-b border-line-subtle">
            {cols.map(c => <th key={c.key} className={`py-1.5 pr-3 font-medium whitespace-nowrap ${c.role === 'measure' || c.format === 'money' || c.format === 'number' ? 'text-right' : ''}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i} className="border-b border-line-subtle last:border-0">
              {cols.map(c => (
                <td key={c.key} className={`py-1.5 pr-3 align-top ${c.role === 'measure' || c.format === 'money' || c.format === 'number' ? 'text-right tabular-nums whitespace-nowrap' : 'min-w-[6rem]'}`}>
                  {formatCell(r[c.key], c, view.currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(rows.length > max || view.truncated) && (
        <p className="text-[11px] text-fg-subtle mt-1">{rows.length > max ? `Showing ${max} of ${rows.length} rows.` : 'More rows exist than are shown.'}</p>
      )}
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

export function AnalyticsAnswer({ view, compact = false, hideText = false, onPin }: {
  view: AnswerView;
  compact?: boolean;
  /** The chat bubble already shows the sentence. */
  hideText?: boolean;
  onPin?: (spec: AnalyticsWidgetSpec) => void;
}) {
  const [open, setOpen] = useState(false);
  const tableOnly = view.chart === 'table';
  const hasData = !!(view.rows?.length || view.forecast);

  return (
    <div className="space-y-3 min-w-0">
      {!hideText && view.answer && <p className="text-sm leading-relaxed text-fg">{view.answer}</p>}
      {view.status === 'answered' && hasData && (
        <div className="rounded-card border border-line-subtle bg-surface p-3 space-y-2 min-w-0">
          {view.title && <p className="text-xs font-semibold text-fg truncate">{view.title}</p>}
          {tableOnly ? <AnswerTable view={view} max={compact ? 8 : 20} /> : <AnswerChart view={view} compact={compact} />}
          {view.forecast?.totals && (
            <p className="text-[11px] text-fg-muted">
              Solid line: actual · dashed: projected · band: 95% range ({view.forecast.method.replace('+weekly', ' + weekly pattern')})
            </p>
          )}
        </div>
      )}
      {view.warnings.length > 0 && (
        <ul className="space-y-1">
          {view.warnings.slice(0, 3).map(w => (
            <li key={w} className="flex gap-1.5 text-[11.5px] text-warning-fg"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> <span className="min-w-0">{w}</span></li>
          ))}
        </ul>
      )}
      {view.status === 'answered' && view.howCalculated.length > 0 && (
        <div>
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
            <Info size={12} /> How this was calculated
            <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <div className="mt-2 space-y-2 min-w-0">
              <ul className="list-disc pl-4 space-y-1 text-[11.5px] text-fg-muted">
                {view.howCalculated.map(h => <li key={h} className="break-words">{h}</li>)}
              </ul>
              {!tableOnly && view.rows && view.rows.length > 0 && (
                <div className="rounded-card border border-line-subtle p-2"><AnswerTable view={view} max={compact ? 10 : 31} /></div>
              )}
            </div>
          )}
        </div>
      )}
      {onPin && view.widgetSpec && view.status === 'answered' && (
        <Button variant="secondary" size="xs" icon={<Pin size={12} />} onClick={() => onPin(view.widgetSpec!)}>Pin to dashboard</Button>
      )}
    </div>
  );
}
