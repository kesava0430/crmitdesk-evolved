/**
 * Draws one dashboard widget from what the server rendered for THIS viewer
 * (POST /dashboards/:id/render). Every number comes from that response — this
 * file only formats (org currency and grouping, e.g. ₹1,58,500) and draws.
 *
 * Widget types: KPI tile (with comparison or a forecast figure), line / area,
 * forecast (solid actual, dashed projection, shaded 95% band), bar,
 * horizontal bar, stacked bar, pie / donut (with "Other"), table (sortable,
 * paginated, CSV), leaderboard, funnel, and notes (text, or a projection's
 * method generated from the forecast itself).
 */
import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell as PieCell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ComposedChart,
} from 'recharts';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Lock, Minus, RefreshCw, ArrowUpDown, Info } from 'lucide-react';
import type { AnalyticsColumn } from '../../../api/analytics';
import type { RenderedWidget, WidgetSpec, DataWidgetSpec, ForecastPayload, MethodNote } from '../../../api/dashboards';
import { formatCell } from '../AnalyticsAnswer';
import { useChartTheme } from '../../chartTheme';
import { Button } from '../Button';

// ─── Formatting helpers ─────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function bucketLabel(v: string, unit?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (unit === 'month') return `${MONTHS[mo - 1]} ${String(y).slice(2)}`;
  if (unit === 'quarter') return `Q${Math.floor((mo - 1) / 3) + 1} ${String(y).slice(2)}`;
  if (unit === 'year') return String(y);
  return `${d} ${MONTHS[mo - 1]}`;
}

export function fmtFormat(v: number | null | undefined, format: string, currency: string, compact = false): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (format === 'percent') return `${new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: 1 }).format(v * 100)}%`;
  return formatCell(format === 'money' ? v : Math.round(v * 10) / 10, { format: format === 'money' ? 'money' : 'number' }, currency, compact);
}

export function methodWords(m: string): string {
  if (m === 'none') return 'No projection (not enough history)';
  const base = m.startsWith('holt') ? 'Trend smoothing (Holt)' : 'Straight-line trend';
  return m.includes('+weekly') ? `${base} + weekly pattern` : base;
}

/** "How this was calculated" lines for any rendered widget. */
export function howCalculated(spec: WidgetSpec, r: RenderedWidget | undefined): string[] {
  if (!r || r.status !== 'ok') return [];
  if (r.forecast) {
    const f = r.forecast;
    return [`${f.description}.`, `Method: ${methodWords(f.method)}.`, ...f.assumptions, ...f.derived.map(d => d.explanation), ...f.warnings.map(w => `Note: ${w}`)];
  }
  if (r.result) {
    const m = r.result.meta;
    return [
      `${m.description}.`,
      ...(m.scope !== 'ALL' ? ['Counts only the records you have access to (your own / your team’s), as on the list pages.'] : []),
      ...(r.rangeApplied ? ['Uses the dashboard’s date range.'] : []),
      ...m.warnings.map(w => `Note: ${w}`),
      `Dates are in ${m.timezone}; amounts in ${m.currency}.`,
    ];
  }
  if (r.note?.method) return [r.note.method.description, ...r.note.method.assumptions];
  return spec.kind === 'data' ? [spec.description] : [];
}

/** CSV of a widget's data (the rows the viewer was shown). */
export function widgetCsv(r: RenderedWidget | undefined): string | null {
  if (!r || r.status !== 'ok') return null;
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  if (r.result) {
    const cols = r.result.columns.filter(c => !c.key.startsWith('__'));
    return [cols.map(c => esc(c.label)).join(','), ...r.result.rows.map(row => cols.map(c => esc(row[c.key])).join(','))].join('\n');
  }
  if (r.forecast) {
    const f = r.forecast;
    return ['period,actual,projected,lower_95,upper_95',
      ...f.history.map(p => `${p.bucket},${p.value},,,`),
      ...f.projection.map(p => `${p.bucket},,${p.value},${p.lower},${p.upper}`)].join('\n');
  }
  return null;
}

// ─── States ─────────────────────────────────────────────────────────────────

export function WidgetSkeleton({ viz }: { viz: string }) {
  if (viz === 'kpi') return <div className="space-y-2 py-1" aria-hidden><div className="h-8 w-28 skeleton" /><div className="h-3 w-40 skeleton" /></div>;
  return <div className="h-full min-h-[120px] w-full skeleton" aria-hidden />;
}

function Unavailable({ reason }: { reason?: string }) {
  return (
    <div className="h-full min-h-[84px] flex flex-col items-center justify-center text-center gap-2 px-3 py-4 rounded-card bg-surface-sunken border border-dashed border-line" data-testid="widget-unavailable">
      <Lock size={16} className="text-fg-subtle" />
      <p className="text-[12.5px] font-medium text-fg">Not available to you</p>
      {reason && <p className="text-[11.5px] text-fg-muted leading-relaxed max-w-[320px]">{reason}</p>}
    </div>
  );
}

function ErrorState({ reason, onRetry }: { reason?: string; onRetry?: () => void }) {
  return (
    <div className="h-full min-h-[84px] flex flex-col items-center justify-center text-center gap-2 px-3 py-4" role="alert">
      <AlertTriangle size={16} className="text-danger" />
      <p className="text-[12px] text-fg-muted leading-relaxed max-w-[320px] break-words">{reason || 'Couldn’t load this widget.'}</p>
      {onRetry && <Button size="xs" variant="secondary" icon={<RefreshCw size={12} />} onClick={onRetry}>Retry</Button>}
    </div>
  );
}

function Empty({ text = 'No data for this period.' }: { text?: string }) {
  return <div className="h-full min-h-[84px] flex items-center justify-center text-[12px] text-fg-muted text-center px-3">{text}</div>;
}

// ─── KPI ────────────────────────────────────────────────────────────────────

function Change({ abs, pct, prev, label, col, currency }: { abs: number | null; pct: number | null; prev: number | null; label: string; col: AnalyticsColumn; currency: string }) {
  if (abs == null) return null;
  const up = abs > 0, down = abs < 0;
  const Icon = up ? ArrowUp : down ? ArrowDown : Minus;
  return (
    <p className="text-[12px] leading-snug flex flex-wrap items-center gap-x-1.5">
      <span className={`inline-flex items-center gap-0.5 font-semibold ${up ? 'text-success-fg' : down ? 'text-danger-fg' : 'text-fg-muted'}`}>
        <Icon size={12} aria-hidden />
        {pct != null ? `${Math.abs(pct)}%` : formatCell(Math.abs(abs), col, currency)}
        <span className="sr-only">{up ? 'up' : down ? 'down' : 'unchanged'}</span>
      </span>
      <span className="text-fg-muted">vs {formatCell(prev, col, currency)} ({label})</span>
    </p>
  );
}

function Kpi({ spec, r, currency }: { spec: DataWidgetSpec; r: RenderedWidget; currency: string }) {
  const k = spec.options?.kpi?.value ?? 'total';
  const big = (s: string) => <p className="text-[26px] sm:text-[28px] font-semibold text-fg tabular-nums leading-tight break-words">{s}</p>;
  if (k !== 'total') {
    const f = r.forecast;
    if (!f) return <Empty />;
    if (f.method === 'none' || !f.totals) return <Empty text={f.warnings[0] ?? 'Not enough history to project.'} />;
    if (k === 'projected') {
      const money = f.measure.format === 'money';
      // A projected count is shown as a whole number (294, not 294.5).
      const fmt = (v: number) => fmtFormat(money ? v : Math.round(v), money ? 'money' : 'number', currency);
      return (
        <div className="space-y-1 min-w-0">
          {big(fmt(f.totals.projected))}
          <p className="text-[12px] text-fg-muted leading-snug">95% range {fmt(f.totals.lower)}–{fmt(f.totals.upper)} · {f.horizon.human}</p>
        </div>
      );
    }
    const d = f.derived[spec.options?.kpi?.derived ?? 0];
    if (!d) return <Empty />;
    if (k === 'rate') {
      return (
        <div className="space-y-1 min-w-0">
          {big(d.rate == null ? '—' : d.format === 'money' ? fmtFormat(d.rate, 'money', currency) : fmtFormat(d.rate, 'percent', currency))}
          <p className="text-[12px] text-fg-muted leading-snug">{fmtFormat(d.numerator, 'number', currency)} of {fmtFormat(d.denominator, 'number', currency)} · {d.window.label}</p>
        </div>
      );
    }
    if (d.projected == null) return <Empty text={d.explanation} />;
    const whole = (v: number | null) => (v == null || d.format !== 'number' ? v : Math.round(v));
    const rateLine = d.rate != null && d.format !== 'money' && d.rate <= 1
      ? `at ${fmtFormat(d.rate, 'percent', currency)} (${d.window.label})`
      : `${f.horizon.human}`;
    return (
      <div className="space-y-1 min-w-0">
        {big(fmtFormat(whole(d.projected), d.format, currency))}
        <p className="text-[12px] text-fg-muted leading-snug">95% range {fmtFormat(whole(d.lower), d.format, currency)}–{fmtFormat(whole(d.upper), d.format, currency)} · {rateLine}</p>
      </div>
    );
  }
  const res = r.result;
  if (!res) return <Empty />;
  const m = res.columns.find(c => c.role === 'measure');
  if (!m) return <Empty />;
  const v = res.meta.totals[m.key];
  const cmp = res.meta.comparison;
  return (
    <div className="space-y-1 min-w-0">
      {big(formatCell(v, m, currency))}
      {cmp && <Change abs={cmp.change[m.key]?.abs ?? null} pct={cmp.change[m.key]?.pct ?? null} prev={cmp.totals[m.key]} label={cmp.label} col={m} currency={currency} />}
      {res.meta.range.human && res.meta.range.from && <p className="text-[11.5px] text-fg-subtle">{res.meta.range.human}</p>}
    </div>
  );
}

// ─── Charts ─────────────────────────────────────────────────────────────────

function Box({ height, children }: { height: number; children: React.ReactElement }) {
  return (
    <div className="w-full min-w-0" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

function ForecastChart({ f, height, currency }: { f: ForecastPayload; height: number; currency: string }) {
  const t = useChartTheme();
  const money = f.measure.format === 'money';
  const fmt = (v: number) => fmtFormat(v, money ? 'money' : 'number', currency, true);
  const data = useMemo(() => {
    const hist: any[] = f.history.map(p => ({ label: bucketLabel(p.bucket, f.horizon.unit), actual: p.value }));
    const proj = f.projection.map(p => ({ label: bucketLabel(p.bucket, f.horizon.unit), projected: p.value, band: [p.lower, p.upper] }));
    if (hist.length && proj.length) hist[hist.length - 1].projected = hist[hist.length - 1].actual;
    return [...hist, ...proj];
  }, [f]);
  if (f.method === 'none') return <Empty text={f.warnings[0] ?? 'Not enough history to project.'} />;
  return (
    <Box height={height}>
      <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey="label" tick={t.tick(10)} stroke={t.axis} interval="preserveStartEnd" minTickGap={28} />
        <YAxis tick={t.tick(10)} stroke={t.axis} tickFormatter={fmt} width={52} allowDecimals={false} />
        <Tooltip contentStyle={t.tooltip.contentStyle} labelStyle={t.tooltip.labelStyle} itemStyle={t.tooltip.itemStyle} cursor={t.lineCursor}
          formatter={(v: any, name: string) => [Array.isArray(v) ? `${fmt(v[0])} – ${fmt(v[1])}` : fmt(Number(v)), name]} />
        <Legend wrapperStyle={{ ...t.legend.wrapperStyle, fontSize: 11 }} iconSize={10} formatter={(v: string) => <span style={{ color: t.muted }}>{v}</span>} />
        <Area dataKey="band" name="95% range" stroke="none" fill={t.fade(t.series[0], 0.16)} isAnimationActive={false} legendType="square" />
        <Line dataKey="actual" name="Actual" stroke={t.series[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="projected" name="Projected" stroke={t.series[0]} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
      </ComposedChart>
    </Box>
  );
}

function SeriesChart({ type, rows, cols, height, currency }: { type: 'line' | 'area' | 'bar'; rows: any[]; cols: AnalyticsColumn[]; height: number; currency: string }) {
  const t = useChartTheme();
  const d = cols.find(c => c.role === 'dimension')!;
  const ms = cols.filter(c => c.role === 'measure').slice(0, 3);
  const fmtY = (v: number) => formatCell(v, ms[0], currency, true);
  const fmtX = (v: string) => formatCell(v, d, currency);
  const common = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
      <XAxis dataKey={d.key} tickFormatter={fmtX} tick={t.tick(10)} stroke={t.axis} interval="preserveStartEnd" minTickGap={24} />
      <YAxis tick={t.tick(10)} stroke={t.axis} tickFormatter={fmtY} width={52} allowDecimals={false} />
      <Tooltip contentStyle={t.tooltip.contentStyle} labelStyle={t.tooltip.labelStyle} itemStyle={t.tooltip.itemStyle}
        cursor={type === 'bar' ? t.barCursor : t.lineCursor} labelFormatter={fmtX}
        formatter={(v: any, _n: any, p: any) => [formatCell(Number(v), ms.find(x => x.key === p.dataKey) ?? ms[0], currency), ms.find(x => x.key === p.dataKey)?.label ?? '']} />
      {ms.length > 1 && <Legend wrapperStyle={{ ...t.legend.wrapperStyle, fontSize: 11 }} iconSize={10} formatter={(k: string) => ms.find(x => x.key === k)?.label ?? k} />}
    </>
  );
  const margin = { top: 6, right: 8, bottom: 0, left: -10 };
  if (type === 'bar') {
    return <Box height={height}><BarChart data={rows} margin={margin}>{common}{ms.map((m, i) => <Bar key={m.key} dataKey={m.key} fill={t.series[i]} radius={[3, 3, 0, 0]} isAnimationActive={false} maxBarSize={36} />)}</BarChart></Box>;
  }
  if (type === 'area') {
    return <Box height={height}><AreaChart data={rows} margin={margin}>{common}{ms.map((m, i) => <Area key={m.key} dataKey={m.key} stroke={t.series[i]} fill={t.fade(t.series[i], 0.18)} strokeWidth={2} isAnimationActive={false} />)}</AreaChart></Box>;
  }
  return <Box height={height}><LineChart data={rows} margin={margin}>{common}{ms.map((m, i) => <Line key={m.key} dataKey={m.key} stroke={t.series[i]} strokeWidth={2} dot={rows.length <= 16} isAnimationActive={false} />)}</LineChart></Box>;
}

/** Top N groups plus "Other" (the rest added up), so a long tail doesn't become slivers. */
export function topNWithOther(rows: any[], dimKey: string, measureKey: string, n: number): Array<{ name: string; value: number; other?: boolean }> {
  const sorted = [...rows].sort((a, b) => Number(b[measureKey] ?? 0) - Number(a[measureKey] ?? 0));
  const head = sorted.slice(0, n).map(r => ({ name: String(r[dimKey] ?? '—'), value: Number(r[measureKey] ?? 0) }));
  const rest = sorted.slice(n).reduce((s, r) => s + Number(r[measureKey] ?? 0), 0);
  return rest > 0 ? [...head, { name: 'Other', value: rest, other: true }] : head;
}

function PieView({ donut, rows, cols, height, currency, topN }: { donut: boolean; rows: any[]; cols: AnalyticsColumn[]; height: number; currency: string; topN: number }) {
  const t = useChartTheme();
  const d = cols.find(c => c.role === 'dimension')!;
  const m = cols.find(c => c.role === 'measure')!;
  const data = topNWithOther(rows.map(r => ({ ...r, [d.key]: formatCell(r[d.key], d, currency) })), d.key, m.key, topN).filter(x => x.value > 0);
  if (!data.length) return <Empty />;
  const total = data.reduce((s, x) => s + x.value, 0);
  const color = (i: number, other?: boolean) => (other ? t.neutral : t.series[i % t.series.length]);
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 h-full min-w-0">
      <div className="sm:flex-1 min-w-0" style={{ height: Math.max(140, Math.min(height, 220)) }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={donut ? '58%' : 0} outerRadius="88%" isAnimationActive={false} stroke="none">
              {data.map((x, i) => <PieCell key={x.name} fill={color(i, x.other)} />)}
            </Pie>
            <Tooltip contentStyle={t.tooltip.contentStyle} itemStyle={t.tooltip.itemStyle} formatter={(v: any) => formatCell(Number(v), m, currency)} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="text-[12px] space-y-1.5 min-w-0 sm:w-[46%] shrink-0">
        {data.map((x, i) => (
          <li key={x.name} className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color(i, x.other) }} />
            <span className="truncate text-fg-muted">{x.name}</span>
            <span className="ml-auto tabular-nums text-fg font-medium whitespace-nowrap">{formatCell(x.value, m, currency, true)}</span>
            <span className="tabular-nums text-fg-subtle w-10 text-right">{Math.round((x.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HBar({ rows, cols, height, currency, topN }: { rows: any[]; cols: AnalyticsColumn[]; height: number; currency: string; topN: number }) {
  const t = useChartTheme();
  const d = cols.find(c => c.role === 'dimension')!;
  const m = cols.find(c => c.role === 'measure')!;
  const data = topNWithOther(rows.map(r => ({ ...r, [d.key]: formatCell(r[d.key], d, currency) })), d.key, m.key, topN);
  const h = Math.max(height, data.length * 26 + 24);
  return (
    <Box height={Math.min(h, Math.max(height, 120))}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 14, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} horizontal={false} />
        <XAxis type="number" tick={t.tick(10)} stroke={t.axis} tickFormatter={(v: number) => formatCell(v, m, currency, true)} allowDecimals={false} />
        <YAxis type="category" dataKey="name" tick={t.tick(11)} stroke={t.axis} width={96} interval={0} tickFormatter={(s: string) => (s.length > 14 ? s.slice(0, 13) + '…' : s)} />
        <Tooltip contentStyle={t.tooltip.contentStyle} labelStyle={t.tooltip.labelStyle} itemStyle={t.tooltip.itemStyle} cursor={t.barCursor} formatter={(v: any) => [formatCell(Number(v), m, currency), m.label]} />
        <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={false} barSize={14}>
          {data.map((x, i) => <PieCell key={i} fill={x.other ? t.neutral : t.series[0]} />)}
        </Bar>
      </BarChart>
    </Box>
  );
}

function StackedBar({ rows, cols, height, currency }: { rows: any[]; cols: AnalyticsColumn[]; height: number; currency: string }) {
  const t = useChartTheme();
  const dims = cols.filter(c => c.role === 'dimension');
  const m = cols.find(c => c.role === 'measure')!;
  const [x, s] = dims;
  const { data, series } = useMemo(() => {
    const seriesKeys: string[] = [];
    const byX = new Map<string, any>();
    for (const r of rows) {
      const xv = String(r[x.key]);
      const sv = formatCell(r[s.key], s, currency);
      if (!seriesKeys.includes(sv)) seriesKeys.push(sv);
      if (!byX.has(xv)) byX.set(xv, { [x.key]: r[x.key] });
      byX.get(xv)[sv] = (byX.get(xv)[sv] ?? 0) + Number(r[m.key] ?? 0);
    }
    return { data: [...byX.values()], series: seriesKeys.slice(0, 8) };
  }, [rows, x, s, m, currency]);
  return (
    <Box height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey={x.key} tickFormatter={(v: string) => formatCell(v, x, currency)} tick={t.tick(10)} stroke={t.axis} interval="preserveStartEnd" minTickGap={20} />
        <YAxis tick={t.tick(10)} stroke={t.axis} tickFormatter={(v: number) => formatCell(v, m, currency, true)} width={52} allowDecimals={false} />
        <Tooltip contentStyle={t.tooltip.contentStyle} labelStyle={t.tooltip.labelStyle} itemStyle={t.tooltip.itemStyle} cursor={t.barCursor} labelFormatter={(v: string) => formatCell(v, x, currency)} formatter={(v: any) => formatCell(Number(v), m, currency)} />
        <Legend wrapperStyle={{ ...t.legend.wrapperStyle, fontSize: 11 }} iconSize={10} />
        {series.map((k, i) => <Bar key={k} dataKey={k} stackId="a" fill={t.series[i % t.series.length]} isAnimationActive={false} maxBarSize={36} />)}
      </BarChart>
    </Box>
  );
}

function Leaderboard({ rows, cols, currency }: { rows: any[]; cols: AnalyticsColumn[]; currency: string }) {
  const d = cols.find(c => c.role === 'dimension')!;
  const m = cols.find(c => c.role === 'measure')!;
  const sorted = [...rows].sort((a, b) => Number(b[m.key] ?? 0) - Number(a[m.key] ?? 0)).slice(0, 10);
  const max = Math.max(1, ...sorted.map(r => Number(r[m.key] ?? 0)));
  return (
    <ol className="space-y-2">
      {sorted.map((r, i) => (
        <li key={i} className="min-w-0">
          <div className="flex items-center gap-2 text-[12.5px] min-w-0">
            <span className={`w-5 h-5 rounded-full text-[10.5px] font-semibold flex items-center justify-center shrink-0 ${i === 0 ? 'bg-accent text-accent-fg' : 'bg-surface-sunken text-fg-muted'}`}>{i + 1}</span>
            <span className="truncate text-fg">{formatCell(r[d.key], d, currency)}</span>
            <span className="ml-auto tabular-nums font-semibold text-fg whitespace-nowrap">{formatCell(r[m.key], m, currency)}</span>
          </div>
          <div className="ml-7 mt-1 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${(Number(r[m.key] ?? 0) / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

const DROPPED = /LOST|UNQUALIFIED|REJECTED|CANCEL|DISQUALIF|CLOSED_LOST|ABANDON/i;

/**
 * Funnel over a status/stage field, in the field's own order. Each bar is
 * "reached this stage or a later one" — honest only when stages are passed
 * in order, which the caption says; drop-out statuses are listed apart.
 */
export function funnelSteps(rows: any[], dimKey: string, measureKey: string, order: string[]): { steps: Array<{ name: string; count: number; reached: number }>; dropped: Array<{ name: string; count: number }> } {
  const counts = new Map(rows.map(r => [String(r[dimKey]), Number(r[measureKey] ?? 0)]));
  const known = order.length ? order : rows.map(r => String(r[dimKey]));
  const stages = known.filter(s => !DROPPED.test(s));
  const extra = [...counts.keys()].filter(k => !known.includes(k) && !DROPPED.test(k));
  const all = [...stages, ...extra];
  const steps = all.map((name, i) => ({ name, count: counts.get(name) ?? 0, reached: all.slice(i).reduce((s, n) => s + (counts.get(n) ?? 0), 0) }));
  const dropped = [...new Set([...known, ...counts.keys()])].filter(s => DROPPED.test(s)).map(name => ({ name, count: counts.get(name) ?? 0 })).filter(x => x.count > 0);
  return { steps, dropped };
}

function Funnel({ rows, cols, currency, order }: { rows: any[]; cols: AnalyticsColumn[]; currency: string; order: string[] }) {
  const t = useChartTheme();
  const d = cols.find(c => c.role === 'dimension')!;
  const m = cols.find(c => c.role === 'measure')!;
  const { steps, dropped } = funnelSteps(rows, d.key, m.key, order);
  const top = steps[0]?.reached || 1;
  return (
    <div className="space-y-2 min-w-0">
      {steps.map((s, i) => {
        const pct = (s.reached / top) * 100;
        return (
          <div key={s.name} className="min-w-0">
            <div className="flex items-baseline gap-2 text-[12px] min-w-0">
              <span className="text-fg truncate">{formatCell(s.name, d, currency)}</span>
              <span className="ml-auto tabular-nums font-semibold text-fg whitespace-nowrap">{formatCell(s.reached, m, currency)}</span>
              <span className="tabular-nums text-fg-subtle w-11 text-right">{i === 0 ? '100%' : `${Math.round(pct)}%`}</span>
            </div>
            <div className="mt-1 h-3 rounded-sm bg-surface-sunken overflow-hidden">
              <div className="h-full rounded-sm" style={{ width: `${Math.max(pct, 1.5)}%`, background: t.series[0], opacity: 1 - i * 0.12 }} />
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-fg-subtle leading-relaxed">
        Reached this stage or a later one (assumes stages are passed in order).
        {dropped.length > 0 && <> Dropped out: {dropped.map(x => `${formatCell(x.name, d, currency)} ${formatCell(x.count, m, currency)}`).join(', ')}.</>}
      </p>
    </div>
  );
}

function TableView({ rows, cols, currency, pageSize }: { rows: any[]; cols: AnalyticsColumn[]; currency: string; pageSize: number }) {
  const visible = cols.filter(c => !c.key.startsWith('__'));
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [rows, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const p = Math.min(page, pages - 1);
  const num = (c: AnalyticsColumn) => c.role === 'measure' || c.format === 'money' || c.format === 'number';
  if (!rows.length) return <Empty />;
  return (
    <div className="min-w-0">
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-fg-muted border-b border-line-subtle">
              {visible.map(c => (
                <th key={c.key} className={`py-1.5 pr-3 font-medium whitespace-nowrap ${num(c) ? 'text-right' : ''}`}>
                  <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setSort(s => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
                    {c.label}
                    <ArrowUpDown size={10} className={sort?.key === c.key ? 'text-accent' : 'opacity-40'} aria-hidden />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(p * pageSize, p * pageSize + pageSize).map((r, i) => (
              <tr key={i} className="border-b border-line-subtle last:border-0">
                {visible.map(c => (
                  <td key={c.key} className={`py-1.5 pr-3 align-top ${num(c) ? 'text-right tabular-nums whitespace-nowrap' : 'min-w-[5.5rem]'}`}>{formatCell(r[c.key], c, currency)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-1.5 mt-2 text-[11.5px] text-fg-muted">
          <span className="mr-1 tabular-nums">{p * pageSize + 1}–{Math.min(sorted.length, (p + 1) * pageSize)} of {sorted.length}</span>
          <Button size="xs" variant="ghost" aria-label="Previous page" disabled={p === 0} onClick={() => setPage(p - 1)} icon={<ChevronLeft size={13} />} />
          <Button size="xs" variant="ghost" aria-label="Next page" disabled={p >= pages - 1} onClick={() => setPage(p + 1)} icon={<ChevronRight size={13} />} />
        </div>
      )}
    </div>
  );
}

// ─── Notes ──────────────────────────────────────────────────────────────────

function MethodNoteView({ m, text }: { m: MethodNote; text?: string }) {
  return (
    <div className="space-y-2 text-[12px] leading-relaxed min-w-0">
      {text && <p className="text-fg whitespace-pre-wrap break-words">{text}</p>}
      <p className="text-fg">
        <span className="font-medium">{methodWords(m.method)}</span> on {m.historyWindow.points} {m.horizon.unit}s of history ({m.historyWindow.human}), projected {m.horizon.buckets} {m.horizon.unit}s ahead ({m.horizon.human}).
      </p>
      <ul className="list-disc pl-4 space-y-1 text-fg-muted">
        {m.assumptions.filter(a => !a.startsWith('Method:')).map(a => <li key={a} className="break-words">{a}</li>)}
        {m.derived.map(d => <li key={d.label} className="break-words">{d.explanation}</li>)}
      </ul>
      {m.warnings.length > 0 && (
        <ul className="space-y-1">
          {m.warnings.map(w => <li key={w} className="flex gap-1.5 text-warning-fg"><AlertTriangle size={12} className="shrink-0 mt-0.5" /><span className="min-w-0 break-words">{w}</span></li>)}
        </ul>
      )}
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

export interface WidgetViewProps {
  spec: WidgetSpec;
  rendered?: RenderedWidget;
  loading?: boolean;
  currency: string;
  /** Pixel height for charts (desktop grid: from the cell; phones: a default). */
  chartHeight: number;
  onRetry?: () => void;
  /** Enum order for funnels (from the catalog). */
  enumOrder?: string[];
}

export function WidgetView({ spec, rendered: r, loading, currency, chartHeight, onRetry, enumOrder = [] }: WidgetViewProps) {
  const viz = spec.kind === 'note' ? 'note' : spec.viz.type;
  if (spec.kind === 'note' && !spec.methodOf) {
    return <p className="text-[12.5px] text-fg whitespace-pre-wrap break-words leading-relaxed">{spec.text}</p>;
  }
  if (loading && !r) return <WidgetSkeleton viz={viz} />;
  if (!r) return <WidgetSkeleton viz={viz} />;
  if (r.status === 'unavailable') return <Unavailable reason={r.reason} />;
  if (r.status === 'error') return <ErrorState reason={r.reason} onRetry={onRetry} />;
  if (spec.kind === 'note') return r.note?.method ? <MethodNoteView m={r.note.method} text={r.note.text} /> : <p className="text-[12.5px] whitespace-pre-wrap">{r.note?.text}</p>;

  const s = spec as DataWidgetSpec;
  if (s.viz.type === 'kpi') return <Kpi spec={s} r={r} currency={currency} />;
  if (s.viz.type === 'forecast') return r.forecast ? <ForecastChart f={r.forecast} height={chartHeight} currency={currency} /> : <Empty />;
  const res = r.result;
  if (!res) return <Empty />;
  const rows = res.rows;
  const hasValues = rows.some(row => res.columns.some(c => c.role !== 'dimension' && row[c.key] != null && row[c.key] !== 0));
  if (!rows.length || (res.meta.kind === 'aggregate' && !hasValues)) return <Empty />;
  const topN = s.options?.topN ?? (s.viz.type === 'pie' || s.viz.type === 'donut' ? 6 : 8);
  switch (s.viz.type) {
    case 'line': case 'area':
      return <SeriesChart type={s.viz.type} rows={rows} cols={res.columns} height={chartHeight} currency={currency} />;
    case 'bar':
      return res.meta.bucket ? <SeriesChart type="bar" rows={rows} cols={res.columns} height={chartHeight} currency={currency} /> : <HBar rows={rows} cols={res.columns} height={chartHeight} currency={currency} topN={topN} />;
    case 'hbar':
      return <HBar rows={rows} cols={res.columns} height={chartHeight} currency={currency} topN={topN} />;
    case 'stacked_bar':
      return res.columns.filter(c => c.role === 'dimension').length === 2 ? <StackedBar rows={rows} cols={res.columns} height={chartHeight} currency={currency} /> : <SeriesChart type="bar" rows={rows} cols={res.columns} height={chartHeight} currency={currency} />;
    case 'pie': case 'donut':
      return <PieView donut={s.viz.type === 'donut'} rows={rows} cols={res.columns} height={chartHeight} currency={currency} topN={topN} />;
    case 'leaderboard':
      return <Leaderboard rows={rows} cols={res.columns} currency={currency} />;
    case 'funnel':
      return <Funnel rows={rows} cols={res.columns} currency={currency} order={enumOrder} />;
    case 'table':
    default:
      return <TableView rows={rows} cols={res.columns} currency={currency} pageSize={s.options?.pageSize ?? 8} />;
  }
}

/** Small "how calculated" list for popovers / dialogs. */
export function HowCalculated({ spec, rendered }: { spec: WidgetSpec; rendered?: RenderedWidget }) {
  const lines = howCalculated(spec, rendered);
  if (!lines.length) return <p className="text-[12px] text-fg-muted">Nothing to explain yet — the widget hasn’t loaded.</p>;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-fg"><Info size={13} className="text-accent" /> How this was calculated</p>
      <ul className="list-disc pl-4 space-y-1 text-[12px] text-fg-muted leading-relaxed">
        {lines.map(l => <li key={l} className="break-words">{l}</li>)}
      </ul>
    </div>
  );
}
