/**
 * Manual widget builder: dataset → measure → group by → filters → date range
 * → visualisation → optional forecast, with a live preview rendered by the
 * server as the current user. Only what GET /analytics/catalog offers this
 * user appears (their areas, record scope and field rules), and the server
 * validates the spec again on save.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, BarChart3, StickyNote } from 'lucide-react';
import { useAnalyticsCatalog, type AnalyticsCatalog, type AnalyticsBucket, type AnalyticsQuerySpec } from '../../../api/analytics';
import { renderSpecs, apiError, type WidgetSpec, type DataWidgetSpec, type WidgetViz, type RenderedWidget } from '../../../api/dashboards';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Field, Input, Select, Textarea, Checkbox } from '../Field';
import { Alert } from '../Alert';
import { WidgetView } from './WidgetView';

type Ds = AnalyticsCatalog['datasets'][number];
type F = Ds['fields'][number];

const PRESET_OPTIONS = [
  ['', 'Default for the widget'], ['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'], ['last_90_days', 'Last 90 days'], ['last_365_days', 'Last 365 days'],
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'],
  ['this_quarter', 'This quarter'], ['last_quarter', 'Last quarter'], ['this_year', 'This year'], ['last_year', 'Last year'], ['all_time', 'All time'], ['custom', 'Custom dates…'],
] as const;

const VIZ_OPTIONS: Array<[WidgetViz, string]> = [
  ['kpi', 'KPI tile'], ['line', 'Line'], ['area', 'Area'], ['bar', 'Bar (columns)'], ['hbar', 'Horizontal bar'], ['stacked_bar', 'Stacked bar'],
  ['pie', 'Pie'], ['donut', 'Donut'], ['table', 'Table'], ['leaderboard', 'Leaderboard'], ['funnel', 'Funnel'], ['forecast', 'Forecast (projection)'],
];

const OPS: Record<string, Array<[string, string]>> = {
  enum: [['eq', 'is'], ['neq', 'is not'], ['in', 'is any of']],
  string: [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains']],
  relation: [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains']],
  boolean: [['eq', 'is']],
  number: [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '=']],
  money: [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '=']],
  date: [['gte', 'on or after'], ['lte', 'on or before'], ['eq', 'on']],
  datetime: [['gte', 'on or after'], ['lte', 'on or before']],
};

const isDate = (f?: F) => !!f && (f.type === 'date' || f.type === 'datetime');
const humanEnum = (s: string) => (/^[A-Z][A-Z0-9_]+$/.test(s) ? (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, ' ') : s);

interface Draft {
  kind: 'data' | 'note';
  title: string;
  text: string;
  dataset: string;
  mode: 'aggregate' | 'list';
  fn: string;
  measureField: string;
  group1: string;
  bucket: AnalyticsBucket;
  group2: string;
  listFields: string[];
  filters: Array<{ field: string; op: string; value: string }>;
  dateField: string;
  preset: string;
  from: string;
  to: string;
  compare: boolean;
  viz: WidgetViz;
  horizon: number;
  growth: string;
  kpiValue: 'total' | 'projected';
  sortDesc: boolean;
  limit: string;
}

function draftFrom(spec: WidgetSpec | null, cat: AnalyticsCatalog | undefined): Draft {
  const first = cat?.datasets[0];
  const d: Draft = {
    kind: 'data', title: '', text: '', dataset: first?.key ?? '', mode: 'aggregate', fn: 'count', measureField: '', group1: '', bucket: 'week', group2: '',
    listFields: [], filters: [], dateField: first?.defaultDateField ?? '', preset: 'last_30_days', from: '', to: '', compare: false, viz: 'kpi',
    horizon: 30, growth: '', kpiValue: 'total', sortDesc: true, limit: '',
  };
  if (!spec) return d;
  if (spec.kind === 'note') return { ...d, kind: 'note', title: spec.title, text: spec.text };
  const q = spec.query;
  const dims = q.dimensions ?? [];
  const r = q.dateRange;
  return {
    ...d,
    title: spec.title, dataset: q.dataset, mode: q.mode ?? 'aggregate',
    fn: q.measures?.[0]?.fn ?? 'count', measureField: q.measures?.[0]?.field ?? '',
    group1: dims[0]?.field ?? '', bucket: (dims.find(x => x.bucket)?.bucket ?? 'week') as AnalyticsBucket, group2: dims[1]?.field ?? '',
    listFields: q.fields ?? [],
    filters: (q.filters ?? []).map(f => ({ field: f.field, op: f.op, value: Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '') })),
    dateField: r?.field ?? (dims.find(x => x.bucket)?.field ?? cat?.datasets.find(x => x.key === q.dataset)?.defaultDateField ?? ''),
    preset: r?.from || r?.to ? 'custom' : r?.preset ?? (r?.last ? `last:${r.last.n}:${r.last.unit}` : ''),
    from: r?.from ?? '', to: r?.to ?? '', compare: q.compare === 'previous_period',
    viz: spec.viz.type, horizon: spec.forecast?.horizon ?? 30, growth: spec.forecast?.scenario?.growthPctPerMonth ? String(spec.forecast.scenario.growthPctPerMonth) : '',
    kpiValue: spec.options?.kpi?.value === 'projected' ? 'projected' : 'total',
    sortDesc: q.sort ? q.sort.dir === 'desc' : true, limit: q.limit ? String(q.limit) : '',
  };
}

function coerce(v: string, f: F | undefined, op: string): unknown {
  const parts = op === 'in' ? v.split(',').map(s => s.trim()).filter(Boolean) : [v.trim()];
  const one = (s: string) => (f?.type === 'number' || f?.type === 'money' ? Number(s.replace(/[^\d.-]/g, '')) : f?.type === 'boolean' ? s === 'true' : s);
  return op === 'in' ? parts.map(one) : one(parts[0] ?? '');
}

/** Draft → widget spec (the server re-validates everything). */
export function specFromDraft(d: Draft, ds: Ds | undefined, original?: WidgetSpec | null): WidgetSpec {
  if (d.kind === 'note') return { version: 1, kind: 'note', title: d.title.trim() || 'Note', text: d.text, source: original?.source ?? { kind: 'manual' } };
  const field = (k: string) => ds?.fields.find(f => f.key === k);
  const forecasting = d.viz === 'forecast' || (d.viz === 'kpi' && d.kpiValue === 'projected');
  const dims: NonNullable<AnalyticsQuerySpec['dimensions']> = [];
  if (forecasting) {
    dims.push({ field: d.dateField || ds?.defaultDateField || 'createdAt', bucket: d.bucket === 'quarter' || d.bucket === 'year' ? 'month' : d.bucket });
  } else if (d.mode === 'aggregate' && d.viz !== 'kpi') {
    if (d.group1) dims.push(isDate(field(d.group1)) ? { field: d.group1, bucket: d.bucket } : { field: d.group1 });
    if (d.group2 && d.group2 !== d.group1) dims.push(isDate(field(d.group2)) ? { field: d.group2, bucket: d.bucket } : { field: d.group2 });
  }
  let dateRange: AnalyticsQuerySpec['dateRange'] = null;
  if (!forecasting && d.preset) {
    const f = d.dateField || null;
    if (d.preset === 'custom') dateRange = { field: f, from: d.from || null, to: d.to || null };
    else if (d.preset.startsWith('last:')) { const [, n, unit] = d.preset.split(':'); dateRange = { field: f, last: { n: Number(n), unit: unit as AnalyticsBucket } }; }
    else dateRange = { field: f, preset: d.preset };
  }
  const measureKey = d.fn === 'count' ? 'count' : d.fn === 'count_distinct' ? `distinct_${d.measureField}` : `${d.fn}_${d.measureField}`;
  const query: AnalyticsQuerySpec = {
    dataset: d.dataset,
    mode: forecasting ? 'aggregate' : d.mode,
    measures: [d.fn === 'count' ? { fn: 'count' } : { fn: d.fn as any, field: d.measureField }],
    dimensions: dims,
    fields: d.mode === 'list' && !forecasting ? d.listFields : [],
    filters: d.filters.filter(f => f.field && (f.value !== '' || f.op === 'is_null')).map(f => ({ field: f.field, op: f.op, value: coerce(f.value, field(f.field), f.op) })),
    dateRange,
    compare: d.viz === 'kpi' && !forecasting && d.compare ? 'previous_period' : null,
    sort: !forecasting && d.mode === 'aggregate' && dims.length && !dims.some(x => x.bucket) && ['bar', 'hbar', 'leaderboard', 'table'].includes(d.viz) ? { by: measureKey, dir: d.sortDesc ? 'desc' : 'asc' } : null,
    limit: d.limit ? Number(d.limit) : null,
  };
  const growth = Number(d.growth);
  const prevOptions = original?.kind === 'data' ? original.options : {};
  return {
    version: 1, kind: 'data',
    title: d.title.trim() || `${ds?.label ?? 'Data'}`,
    viz: { type: d.viz, y: [] },
    query,
    forecast: forecasting ? { horizon: Math.max(1, Math.min(366, d.horizon || 30)), cumulative: true, ...(growth ? { scenario: { growthPctPerMonth: growth } } : {}), derived: original?.kind === 'data' ? original.forecast?.derived ?? [] : [] } : null,
    description: '',
    source: original?.source ?? { kind: 'manual' },
    options: { ...prevOptions, kpi: d.viz === 'kpi' ? { value: d.kpiValue } : null },
  } as DataWidgetSpec;
}

export function WidgetBuilder({ open, onClose, initial, onSave, saving, title = 'Add widget' }: {
  open: boolean; onClose: () => void; initial?: WidgetSpec | null; onSave: (spec: WidgetSpec) => void; saving?: boolean; title?: string;
}) {
  const { data: cat, isLoading } = useAnalyticsCatalog(open);
  const [d, setD] = useState<Draft>(() => draftFrom(initial ?? null, cat));
  const [preview, setPreview] = useState<{ r?: RenderedWidget; loading: boolean; error?: string; currency: string }>({ loading: false, currency: 'USD' });
  const seq = useRef(0);

  useEffect(() => { if (open) setD(draftFrom(initial ?? null, cat)); }, [open, initial, cat]);

  const ds = cat?.datasets.find(x => x.key === d.dataset);
  const spec = useMemo(() => specFromDraft(d, ds, initial), [d, ds, initial]);
  const set = (p: Partial<Draft>) => setD(prev => ({ ...prev, ...p }));

  // Live preview, debounced, rendered by the server as you.
  useEffect(() => {
    if (!open || !ds && d.kind === 'data') return;
    if (d.kind === 'note') { setPreview(p => ({ ...p, r: undefined, loading: false, error: undefined })); return; }
    const n = ++seq.current;
    setPreview(p => ({ ...p, loading: true, error: undefined }));
    const t = setTimeout(() => {
      renderSpecs([spec]).then(res => { if (n === seq.current) setPreview({ r: res.widgets[0], loading: false, currency: res.currency }); })
        .catch(err => { if (n === seq.current) setPreview(p => ({ ...p, loading: false, error: apiError(err) })); });
    }, 450);
    return () => clearTimeout(t);
  }, [open, JSON.stringify(spec)]); // eslint-disable-line react-hooks/exhaustive-deps

  const byArea = useMemo(() => {
    const groups: Record<string, Ds[]> = {};
    for (const x of cat?.datasets ?? []) (groups[x.area] ??= []).push(x);
    return groups;
  }, [cat]);
  const AREA_LABEL: Record<string, string> = { crm: 'CRM', itdesk: 'IT Desk', hr: 'HR', shared: 'Shared' };

  const numeric = ds?.fields.filter(f => f.aggregations.length) ?? [];
  const groupable = ds?.fields.filter(f => f.groupable) ?? [];
  const dates = ds?.fields.filter(isDate) ?? [];
  const filterable = ds?.fields.filter(f => f.filterable) ?? [];
  const forecasting = d.viz === 'forecast' || (d.viz === 'kpi' && d.kpiValue === 'projected');
  const needsGroup = !['kpi', 'forecast'].includes(d.viz) && d.mode === 'aggregate';

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button onClick={() => onSave(spec)} loading={saving} disabled={d.kind === 'data' ? !ds || preview.r?.status === 'error' : !d.text.trim()}>Save widget</Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={title} size="xl" footer={footer}>
      {isLoading ? <div className="h-40 skeleton" /> : !cat?.datasets.length ? (
        <Alert tone="warning">There is no data you can build widgets from yet.</Alert>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 min-w-0">
          <div className="space-y-4 min-w-0">
            <div className="inline-flex rounded-btn border border-line p-0.5 bg-surface-sunken" role="radiogroup" aria-label="Widget kind">
              {(['data', 'note'] as const).map(k => (
                <button key={k} type="button" role="radio" aria-checked={d.kind === k} onClick={() => set({ kind: k })}
                  className={`h-8 px-3 rounded-[6px] text-[12.5px] inline-flex items-center gap-1.5 ${d.kind === k ? 'bg-surface text-fg shadow-ui-sm' : 'text-fg-muted'}`}>
                  {k === 'data' ? <><BarChart3 size={13} /> Chart / number</> : <><StickyNote size={13} /> Note</>}
                </button>
              ))}
            </div>
            <Field label="Title"><Input value={d.title} onChange={e => set({ title: e.target.value })} placeholder={d.kind === 'note' ? 'Note' : ds?.label} maxLength={120} /></Field>
            {d.kind === 'note' ? (
              <Field label="Text" hint="Plain text, shown as written."><Textarea rows={6} value={d.text} onChange={e => set({ text: e.target.value })} maxLength={4000} /></Field>
            ) : (
              <>
                <Field label="Data">
                  <Select value={d.dataset} onChange={e => { const nd = cat.datasets.find(x => x.key === e.target.value); set({ dataset: e.target.value, measureField: '', group1: '', group2: '', filters: [], listFields: [], dateField: nd?.defaultDateField ?? '' }); }}>
                    {Object.entries(byArea).map(([a, list]) => (
                      <optgroup key={a} label={AREA_LABEL[a] ?? a}>{list.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>
                    ))}
                  </Select>
                </Field>
                {ds?.scope && ds.scope !== 'ALL' && <p className="text-[11.5px] text-fg-muted -mt-2">You see {ds.scope === 'OWN' ? 'only your own' : 'your team’s'} {ds.label.toLowerCase()} here.</p>}
                <Field label="Show as">
                  <Select value={d.viz} onChange={e => set({ viz: e.target.value as WidgetViz, mode: e.target.value === 'table' ? d.mode : 'aggregate' })}>
                    {VIZ_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </Select>
                </Field>
                {d.viz === 'table' && (
                  <Field label="Rows">
                    <Select value={d.mode} onChange={e => set({ mode: e.target.value as Draft['mode'] })}>
                      <option value="aggregate">Grouped totals</option>
                      <option value="list">Individual records</option>
                    </Select>
                  </Field>
                )}
                {d.mode === 'list' && d.viz === 'table' ? (
                  <Field label="Columns">
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {ds?.fields.map(f => (
                        <Checkbox key={f.key} label={f.label} checked={d.listFields.includes(f.key)}
                          onChange={e => set({ listFields: e.target.checked ? [...d.listFields, f.key] : d.listFields.filter(k => k !== f.key) })} />
                      ))}
                    </div>
                  </Field>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Measure">
                      <Select value={d.fn} onChange={e => set({ fn: e.target.value, measureField: e.target.value === 'count' ? '' : d.measureField || numeric[0]?.key || '' })}>
                        <option value="count">Count of {ds?.label.toLowerCase()}</option>
                        {numeric.length > 0 && <><option value="sum">Sum of…</option><option value="avg">Average of…</option><option value="min">Minimum of…</option><option value="max">Maximum of…</option></>}
                      </Select>
                    </Field>
                    {d.fn !== 'count' && (
                      <Field label="Of">
                        <Select value={d.measureField} onChange={e => set({ measureField: e.target.value })}>
                          {numeric.filter(f => f.aggregations.includes(d.fn)).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </Select>
                      </Field>
                    )}
                  </div>
                )}
                {(needsGroup || forecasting) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {forecasting ? (
                      <Field label="Trend of">
                        <Select value={d.dateField} onChange={e => set({ dateField: e.target.value })}>
                          {dates.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </Select>
                      </Field>
                    ) : (
                      <Field label="Group by">
                        <Select value={d.group1} onChange={e => set({ group1: e.target.value })} placeholder="Choose…">
                          <optgroup label="Over time">{dates.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>
                          <optgroup label="By">{groupable.filter(f => !isDate(f)).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>
                        </Select>
                      </Field>
                    )}
                    {(forecasting || isDate(ds?.fields.find(f => f.key === d.group1))) && (
                      <Field label="Per">
                        <Select value={d.bucket} onChange={e => set({ bucket: e.target.value as AnalyticsBucket })}>
                          {(forecasting ? ['day', 'week', 'month'] : ['day', 'week', 'month', 'quarter', 'year']).map(b => <option key={b} value={b}>{b}</option>)}
                        </Select>
                      </Field>
                    )}
                    {d.viz === 'stacked_bar' && (
                      <Field label="Split by">
                        <Select value={d.group2} onChange={e => set({ group2: e.target.value })} placeholder="Choose…">
                          {groupable.filter(f => !isDate(f)).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </Select>
                      </Field>
                    )}
                    {['bar', 'hbar', 'leaderboard', 'table'].includes(d.viz) && !isDate(ds?.fields.find(f => f.key === d.group1)) && (
                      <Field label="Top">
                        <Select value={d.limit} onChange={e => set({ limit: e.target.value })}>
                          <option value="">All</option>{[3, 5, 10, 20].map(n => <option key={n} value={n}>Top {n}</option>)}
                        </Select>
                      </Field>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[12.5px] font-medium text-fg">Filters</p>
                    <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => set({ filters: [...d.filters, { field: filterable.find(f => !isDate(f))?.key ?? '', op: 'eq', value: '' }] })}>Add filter</Button>
                  </div>
                  {d.filters.map((f, i) => {
                    const fd = ds?.fields.find(x => x.key === f.field);
                    const ops = OPS[fd?.type ?? 'string'] ?? OPS.string;
                    const upd = (p: Partial<Draft['filters'][number]>) => set({ filters: d.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                    return (
                      <div key={i} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1.2fr_0.9fr_1.2fr_auto] gap-2 items-start">
                        <Select selectSize="sm" value={f.field} onChange={e => upd({ field: e.target.value, value: '', op: 'eq' })} aria-label="Filter field">
                          {filterable.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                        </Select>
                        <Button size="sm" variant="ghost" aria-label="Remove filter" icon={<Trash2 size={13} />} onClick={() => set({ filters: d.filters.filter((_, j) => j !== i) })} className="sm:order-last" />
                        <Select selectSize="sm" value={f.op} onChange={e => upd({ op: e.target.value })} aria-label="Filter operator">
                          {ops.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </Select>
                        {fd?.type === 'enum' && f.op !== 'in' ? (
                          <Select selectSize="sm" value={f.value} onChange={e => upd({ value: e.target.value })} placeholder="Choose…" aria-label="Filter value">
                            {fd.values?.map(v => <option key={v} value={v}>{humanEnum(v)}</option>)}
                          </Select>
                        ) : fd?.type === 'boolean' ? (
                          <Select selectSize="sm" value={f.value} onChange={e => upd({ value: e.target.value })} placeholder="Choose…" aria-label="Filter value">
                            <option value="true">Yes</option><option value="false">No</option>
                          </Select>
                        ) : (
                          <Input inputSize="sm" value={f.value} onChange={e => upd({ value: e.target.value })} aria-label="Filter value"
                            type={isDate(fd) ? 'date' : 'text'}
                            placeholder={fd?.type === 'enum' ? fd.values?.slice(0, 3).join(', ') : (fd as any)?.acceptsMe ? 'Name, or “me”' : ''} />
                        )}
                      </div>
                    );
                  })}
                </div>
                {!forecasting && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Period">
                      <Select value={d.preset} onChange={e => set({ preset: e.target.value })}>
                        {PRESET_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        {d.preset.startsWith('last:') && <option value={d.preset}>{d.preset.replace(/^last:(\d+):(\w+)$/, 'Last $1 $2s')}</option>}
                      </Select>
                    </Field>
                    {d.preset && dates.length > 1 && (
                      <Field label="Date field">
                        <Select value={d.dateField} onChange={e => set({ dateField: e.target.value })}>
                          {dates.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </Select>
                      </Field>
                    )}
                    {d.preset === 'custom' && (
                      <>
                        <Field label="From"><Input type="date" value={d.from} onChange={e => set({ from: e.target.value })} /></Field>
                        <Field label="To"><Input type="date" value={d.to} onChange={e => set({ to: e.target.value })} /></Field>
                      </>
                    )}
                  </div>
                )}
                {d.viz === 'kpi' && (
                  <div className="space-y-2">
                    <Field label="Number">
                      <Select value={d.kpiValue} onChange={e => set({ kpiValue: e.target.value as Draft['kpiValue'] })}>
                        <option value="total">Total for the period</option>
                        <option value="projected">Projected total (forecast)</option>
                      </Select>
                    </Field>
                    {d.kpiValue === 'total' && <Checkbox label="Compare with the previous period" checked={d.compare} onChange={e => set({ compare: e.target.checked })} />}
                  </div>
                )}
                {forecasting && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label={`Project ahead (${d.bucket}s)`}><Input type="number" min={1} max={366} value={d.horizon} onChange={e => set({ horizon: Number(e.target.value) })} /></Field>
                    <Field label="What-if growth (% per month)" hint="Optional, on top of the trend"><Input type="number" value={d.growth} onChange={e => set({ growth: e.target.value })} placeholder="e.g. 10" /></Field>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="min-w-0 lg:sticky lg:top-0 self-start w-full">
            <p className="text-[11px] font-semibold text-fg-subtle uppercase tracking-widest mb-2">Preview — your data</p>
            <div className="rounded-card border border-line bg-surface p-3 min-h-[200px]">
              <p className="text-[12.5px] font-semibold text-fg mb-2 truncate">{spec.title}</p>
              {preview.error ? <Alert tone="danger">{preview.error}</Alert> : (
                <WidgetView spec={spec} rendered={preview.r} loading={preview.loading} currency={preview.currency} chartHeight={220}
                  enumOrder={spec.kind === 'data' ? ds?.fields.find(f => f.key === spec.query.dimensions?.[0]?.field)?.values : undefined} />
              )}
            </div>
            {spec.kind === 'data' && preview.r?.result && <p className="text-[11px] text-fg-muted mt-2 leading-relaxed break-words">{preview.r.result.meta.description}</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}
