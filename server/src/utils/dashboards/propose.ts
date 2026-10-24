/**
 * "Ask AI to build a dashboard" and "Ask AI to change this widget".
 *
 * Same contract as Ask anything (utils/analytics/ask.ts): the model is a
 * TRANSLATOR. It sees the caller's compact catalog (dataset / field names and
 * enum values — never rows) and returns JSON widgets: a query spec, an
 * optional forecast config and a visualisation. Every widget is validated
 * against the caller's catalog (zod + viz fit + dry-run compile); on failure
 * ONE repair call lists the exact errors; widgets still invalid after that
 * are dropped and named in `warnings`. Numbers never come from the model —
 * the client previews the proposal by rendering it with real data — and a
 * model can't write a note: the "how the projection works" note is built
 * from the forecast's own method / assumptions / warnings at render time.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { designDashboardJson } from '../ai';
import { readPersistentCache, writePersistentCache } from '../aiCache';
import { getAnalyticsContext, type AnalyticsContext, type AnalyticsUser } from '../analytics/executor';
import { relevantDatasets, fitCatalog, byPriority, catalogText, type PromptCatalog } from '../analytics/ask';
import type { ResolvedDataset } from '../analytics/types';
import { compileQuery } from '../analytics/compiler';
import { PRESETS_TEXT, QuerySpecSchema, zodIssues } from '../analytics/spec';
import { parseDate } from '../analytics/dates';
import {
  validateWidget, WIDGET_VIZ, type DashboardWidgetSpec, type DataWidgetSpec, type CatalogEnv,
} from './widget';
import { normaliseLayout, defaultSize, type Layout } from './layout';

export const MAX_WIDGETS = 8;

// ─── Model formats ──────────────────────────────────────────────────────────

const ModelWidgetSchema = z.object({
  title: z.string().max(120).nullish(),
  viz: z.string().max(30),
  query: z.unknown().optional(),
  forecast: z.unknown().optional(),
  kpi: z.string().max(30).nullish(),
  noteFor: z.coerce.number().int().min(0).max(20).nullish(),
  /** KPI tiles of a projection: reuse widget N's query + forecast instead of repeating them (keeps replies short). */
  forecastOf: z.coerce.number().int().min(0).max(20).nullish(),
  text: z.string().max(4000).nullish(),
});

const ProposalSchema = z.object({
  title: z.string().max(120).nullish(),
  description: z.string().max(500).nullish(),
  widgets: z.array(z.unknown()).max(20).default([]),
});

export interface Proposal {
  title: string;
  description: string;
  widgets: DashboardWidgetSpec[];
  /** Default desktop layout, keyed by widget index ("0", "1", …). */
  layout: Layout;
}

/** Drops explicit nulls/empties a small model emits for "not set" so zod defaults apply. */
function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined || x === '') continue;
      out[k] = tidy(x);
    }
    return out;
  }
  return v;
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  const t = s.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch {
    const i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch { /* fallthrough */ } }
    return null;
  }
}

/** "derived:1" → { value: 'derived', derived: 1 }. */
export function parseKpi(s: string | null | undefined): { value: 'total' | 'projected' | 'derived' | 'rate'; derived?: number } {
  const m = /^(total|projected|derived|rate)(?::(\d))?$/.exec(String(s ?? 'total').trim().toLowerCase());
  if (!m) return { value: 'total' };
  const value = m[1] as 'total' | 'projected' | 'derived' | 'rate';
  return m[2] != null ? { value, derived: Number(m[2]) } : (value === 'derived' || value === 'rate' ? { value, derived: 0 } : { value });
}

const VIZ_ALIASES: Record<string, string> = {
  chart: 'bar', column: 'bar', bars: 'bar', horizontal_bar: 'hbar', 'horizontal-bar': 'hbar', number: 'kpi', metric: 'kpi',
  stat: 'kpi', tile: 'kpi', trend: 'line', projection: 'forecast', doughnut: 'donut', ranking: 'leaderboard', list: 'table',
  pipeline: 'funnel', text: 'note', markdown: 'note', stacked: 'stacked_bar',
};

/**
 * One model widget → a widget spec (not yet validated). Notes are only
 * accepted as "explain widget N's forecast"; free text from the model is
 * never stored.
 */
export function convertModelWidget(raw: unknown, all: unknown[], c: CatalogEnv, question: string): { spec: unknown | null; error?: string; skipped?: string } {
  const p = ModelWidgetSchema.safeParse(tidy(raw));
  if (!p.success) return { spec: null, error: zodIssues(p.error).join('; ') };
  const w = p.data;
  const vizRaw = w.viz.trim().toLowerCase();
  const viz = (VIZ_ALIASES[vizRaw] ?? vizRaw) as string;
  const source = { kind: 'ai_dashboard' as const, question: question.slice(0, 500) };
  if (viz === 'note') {
    if (w.noteFor == null) return { spec: null, skipped: 'a text note (notes are generated from the data, not written by the AI)' };
    const target = ModelWidgetSchema.safeParse(tidy(all[w.noteFor]));
    if (!target.success || !target.data.forecast) return { spec: null, error: `noteFor ${w.noteFor} must point at a widget with a forecast.` };
    return {
      spec: {
        kind: 'note', version: 1, title: w.title?.trim() || 'How the projection works', text: '',
        methodOf: { query: target.data.query, forecast: forecastConfig(target.data.forecast) }, source,
      },
    };
  }
  if (!(WIDGET_VIZ as readonly string[]).includes(viz)) return { spec: null, error: `viz "${w.viz}" is not one of ${[...WIDGET_VIZ, 'note'].join(', ')}.` };
  if (w.forecastOf != null && (!w.query || !w.forecast)) {
    const target = ModelWidgetSchema.safeParse(tidy(all[w.forecastOf]));
    if (!target.success || !target.data.forecast || !target.data.query) return { spec: null, error: `forecastOf ${w.forecastOf} must point at a widget with a query and a forecast.` };
    w.query = w.query ?? target.data.query;
    w.forecast = w.forecast ?? target.data.forecast;
  }
  const kpi = viz === 'kpi' ? parseKpi(w.kpi) : null;
  const usesForecast = viz === 'forecast' || (kpi && kpi.value !== 'total');
  let description = '';
  try {
    const q = (w.query && typeof w.query === 'object') ? (w.query as Record<string, unknown>) : null;
    const ds = q && c.catalog.find(d => d.def.key === q.dataset);
    if (ds) description = compileQuery(ds, QuerySpecSchema.parse(tidy(q)), c.env).description;
  } catch { /* validation reports it */ }
  return {
    spec: {
      kind: 'data', version: 1, title: w.title?.trim() || 'Untitled',
      viz: { type: viz, y: [] },
      query: tidy(w.query),
      ...(usesForecast && w.forecast ? { forecast: forecastConfig(w.forecast) } : {}),
      description,
      source,
      options: kpi ? { kpi } : {},
    },
  };
}

/** Model forecast block → ForecastConfig input (growth % becomes a scenario). */
function forecastConfig(f: unknown): Record<string, unknown> {
  const o = (tidy(f) ?? {}) as Record<string, unknown>;
  const growth = o.growthPctPerMonth != null ? Number(o.growthPctPerMonth) : null;
  return {
    horizon: o.horizon != null ? Number(o.horizon) : 30,
    ...(growth ? { scenario: { growthPctPerMonth: growth } } : {}),
    cumulative: o.cumulative === true,
    derived: Array.isArray(o.derived) ? o.derived : [],
  };
}

/** Widget spec → the compact shape the model reads (for "change this widget"). */
export function widgetToModel(spec: DashboardWidgetSpec): Record<string, unknown> {
  if (spec.kind === 'note') return { title: spec.title, viz: 'note' };
  const k = spec.options?.kpi;
  return {
    title: spec.title,
    viz: spec.viz.type,
    query: spec.query,
    forecast: spec.forecast
      ? { horizon: spec.forecast.horizon, growthPctPerMonth: spec.forecast.scenario?.growthPctPerMonth ?? null, cumulative: !!spec.forecast.cumulative, derived: spec.forecast.derived }
      : null,
    ...(k && k.value !== 'total' ? { kpi: k.derived != null ? `${k.value}:${k.derived}` : k.value } : {}),
  };
}

export interface ProposalCheck {
  proposal: Proposal | null;
  /** Problems a repair call should fix (empty when valid). */
  errors: string[];
  /** Kept for the user: widgets dropped or adjusted. */
  warnings: string[];
  /** Index-aligned: valid specs (null where invalid). */
  specs: Array<DashboardWidgetSpec | null>;
}

/** Validates a whole model proposal against the caller's catalog. */
export function checkProposal(c: CatalogEnv, raw: unknown, question: string): ProposalCheck {
  if (!raw || typeof raw !== 'object') return { proposal: null, errors: ['The reply was not a JSON object.'], warnings: [], specs: [] };
  const p = ProposalSchema.safeParse(tidy(raw));
  if (!p.success) return { proposal: null, errors: zodIssues(p.error), warnings: [], specs: [] };
  if (!p.data.widgets.length) return { proposal: null, errors: ['"widgets" is empty.'], warnings: [], specs: [] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const specs: Array<DashboardWidgetSpec | null> = [];
  p.data.widgets.forEach((w, i) => {
    const conv = convertModelWidget(w, p.data.widgets, c, question);
    if (conv.skipped) { warnings.push(`Left out ${conv.skipped}.`); specs.push(null); return; }
    if (!conv.spec) { errors.push(`widgets.${i}: ${conv.error}`); specs.push(null); return; }
    const v = validateWidget(c, conv.spec);
    if (!v.spec) { errors.push(...v.errors.map(e => `widgets.${i}: ${e}`)); specs.push(null); return; }
    specs.push(v.spec);
  });
  return { proposal: errors.length ? null : finish(p.data.title, p.data.description, specs, warnings), errors, warnings, specs };
}

/** Valid widgets → proposal: cap at MAX_WIDGETS, add the method note a forecast needs, default layout. */
function finish(title: string | null | undefined, description: string | null | undefined, specs: Array<DashboardWidgetSpec | null>, warnings: string[]): Proposal {
  let widgets = specs.filter((s): s is DashboardWidgetSpec => !!s);
  const forecastW = widgets.find((w): w is DataWidgetSpec => w.kind === 'data' && w.viz.type === 'forecast' && !!w.forecast);
  const hasNote = widgets.some(w => w.kind === 'note' && !!w.methodOf);
  if (forecastW && !hasNote) {
    widgets.push({
      kind: 'note', version: 1, title: 'How the projection works', text: '',
      methodOf: { query: forecastW.query, forecast: forecastW.forecast! }, source: forecastW.source,
    });
  }
  if (widgets.length > MAX_WIDGETS) {
    warnings.push(`Kept the first ${MAX_WIDGETS} widgets.`);
    // Never cut the method note of a projection.
    const note = widgets.find(w => w.kind === 'note');
    widgets = widgets.filter(w => w !== note).slice(0, note ? MAX_WIDGETS - 1 : MAX_WIDGETS);
    if (note) widgets.push(note);
  }
  const ids = widgets.map((_, i) => String(i));
  // A projection's method note sits beside the forecast chart, at its height.
  const sizes = Object.fromEntries(widgets.map((w, i) => [String(i), w.kind === 'note' && w.methodOf ? { w: 4, h: defaultSize('forecast').h } : defaultSize(w.kind === 'note' ? 'note' : w.viz.type)]));
  return {
    title: (title ?? '').trim().slice(0, 120) || 'New dashboard',
    description: (description ?? '').trim().slice(0, 500),
    widgets,
    layout: normaliseLayout(ids, {}, sizes),
  };
}

/** After the repair call: keep what's valid, name what was dropped. */
export function salvage(check: ProposalCheck, raw: unknown): { proposal: Proposal; warnings: string[] } | null {
  const valid = check.specs.filter(Boolean).length;
  if (!valid) return null;
  const p = ProposalSchema.safeParse(tidy(raw));
  const skipped = check.warnings.filter(w => w.startsWith('Left out')).length;
  const dropped = check.specs.length - valid - skipped;
  const warnings = [...check.warnings];
  if (dropped > 0) warnings.push(`${dropped} proposed widget${dropped === 1 ? '' : 's'} couldn't be built from your data and ${dropped === 1 ? 'was' : 'were'} left out.`);
  return { proposal: finish(p.success ? p.data.title : null, p.success ? p.data.description : null, check.specs, warnings), warnings };
}

// ─── Prompts ────────────────────────────────────────────────────────────────
//
// Groq's free tier allows 8,000 tokens per minute for the whole account and
// counts prompt + max_tokens per request up front. The first version of these
// prompts sent the caller's ENTIRE catalog (~2.4k tokens for a full-access
// admin) plus three worked examples, with max_tokens 2500: ~7.3k tokens for one
// build and the same again for the repair call, so a build plus anything else
// in the same minute was refused. Now the model reads only the datasets the
// request is about (others by name only), examples for those datasets only,
// a compact reply format (KPI tiles point at the forecast widget instead of
// repeating it), and the repair call gets a small prompt of its own. Budgets
// are asserted in tests/unit/dashboards.test.ts.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Output caps. A full 8-widget lead projection in the compact format is ~700 tokens (o200k);
    gpt-oss also spends some of max_tokens on (low-effort) reasoning, hence the headroom. */
export const BUILD_MAX_TOKENS = 1400;
export const EDIT_MAX_TOKENS = 600;
/** Catalog share of a build prompt; datasets beyond it are listed by name only. */
export const BUILD_CATALOG_BUDGET = 950;
const REPAIR_CATALOG_BUDGET = 900;
const EDIT_CATALOG_BUDGET = 700;

/** Datasets a dashboard request is about (relevant first, then the most-used ones), within budget. */
export function dashboardCatalog(catalog: ResolvedDataset[], request: string, budget = BUILD_CATALOG_BUDGET): PromptCatalog {
  const picked = relevantDatasets(catalog, request, 6);
  return fitCatalog(catalog, picked.length < catalog.length ? picked : byPriority(catalog), budget);
}

const QUERY_SHAPE = 'QUERY = {"dataset":"<key>","mode":"aggregate"|"list","measures":[{"fn":"count"} or {"fn":"sum|avg|min|max|count_distinct","field":"<field>"}],"dimensions":[{"field":"<field>"} or {"field":"<date field>","bucket":"day|week|month|quarter|year"}],"fields":["<field>"],"filters":[{"field":"<field>","op":"eq|neq|in|not_in|gt|gte|lt|lte|between|contains|is_null|not_null","value":<value or [values]>}],"dateRange":{"field":"<date field>","preset":"<preset>"} or {"field":"<date field>","last":{"n":<number>,"unit":"day|week|month|quarter|year"},"includeCurrent":true|false},"compare":null|"previous_period","sort":{"by":"<measure key or field>","dir":"asc|desc"},"limit":<number>}';
const WIDGET_SHAPE = 'WIDGET = {"title":"short title","viz":"kpi|line|area|bar|hbar|stacked_bar|pie|donut|table|leaderboard|funnel|forecast|note","query":QUERY,"forecast":null|FORECAST,"kpi":"total|projected|derived:<i>|rate:<i>","forecastOf":<index of the forecast widget, for projection KPI tiles, instead of query+forecast>,"noteFor":<index of a forecast widget, only for viz note>}';
const FORECAST_SHAPE = 'FORECAST = {"horizon":<buckets ahead>,"growthPctPerMonth":null|number,"cumulative":true,"derived":[{"label":"...","numerator":{"dataset":"<key>","measure":{"fn":"count"},"filters":[...]},"denominator":{"dataset":"<key>","measure":{"fn":"count"},"filters":[...]},"of":<earlier derived index, optional>,"format":"number|money"}]}';

type Example = { keys: string[]; text: string };

/** Worked examples for the datasets the model is shown (never for one it can't see). */
function exampleList(shown: ResolvedDataset[]): Example[] {
  const has = (k: string) => shown.some(d => d.def.key === k);
  const ex: Example[] = [];
  if (has('leads')) {
    const derived = [
      '{"label":"Projected conversions","numerator":{"dataset":"leads","measure":{"fn":"count"},"filters":[{"field":"status","op":"eq","value":"CONVERTED"}]},"denominator":{"dataset":"leads","measure":{"fn":"count"}}}',
      ...(has('deals') ? ['{"label":"Projected revenue","numerator":{"dataset":"deals","measure":{"fn":"sum","field":"value"},"filters":[{"field":"status","op":"eq","value":"WON"}]},"denominator":{"dataset":"deals","measure":{"fn":"count"},"filters":[{"field":"status","op":"eq","value":"WON"}]},"of":0,"format":"money"}'] : []),
    ];
    const fi = has('deals') ? 4 : 3;
    ex.push({ keys: ['leads', 'deals'], text: `Request: Dashboard projecting our leads for the next month\n{"title":"Lead projection","description":"Lead trend and where we will be in 30 days if things continue","widgets":[`
      + '{"title":"Leads — last 30 days","viz":"kpi","kpi":"total","query":{"dataset":"leads","measures":[{"fn":"count"}],"dateRange":{"field":"createdAt","preset":"last_30_days"},"compare":"previous_period"}},'
      + `{"title":"Projected leads — next 30 days","viz":"kpi","kpi":"projected","forecastOf":${fi}},`
      + `{"title":"Projected conversions","viz":"kpi","kpi":"derived:0","forecastOf":${fi}},`
      + (has('deals') ? `{"title":"Projected revenue","viz":"kpi","kpi":"derived:1","forecastOf":${fi}},` : '')
      + `{"title":"Leads per day and 30-day projection","viz":"forecast","query":{"dataset":"leads","measures":[{"fn":"count"}],"dimensions":[{"field":"createdAt","bucket":"day"}]},"forecast":{"horizon":30,"growthPctPerMonth":null,"cumulative":true,"derived":[${derived.join(',')}]}},`
      + '{"title":"Leads by source","viz":"hbar","query":{"dataset":"leads","measures":[{"fn":"count"}],"dimensions":[{"field":"source"}],"dateRange":{"field":"createdAt","preset":"last_90_days"},"sort":{"by":"count","dir":"desc"},"limit":8}},'
      + '{"title":"Lead status funnel","viz":"funnel","query":{"dataset":"leads","measures":[{"fn":"count"}],"dimensions":[{"field":"status"}],"dateRange":{"field":"createdAt","preset":"last_90_days"}}},'
      + `{"title":"How the projection works","viz":"note","noteFor":${fi}}]}` });
  }
  if (has('attendance') || has('employees') || has('leave_requests')) {
    const w: string[] = [];
    if (has('employees')) w.push('{"title":"Headcount by department","viz":"hbar","query":{"dataset":"employees","measures":[{"fn":"count"}],"dimensions":[{"field":"department"}],"filters":[{"field":"employmentStatus","op":"neq","value":"EXITED"}]}}');
    if (has('attendance')) w.push('{"title":"Attendance per week","viz":"stacked_bar","query":{"dataset":"attendance","measures":[{"fn":"count"}],"dimensions":[{"field":"date","bucket":"week"},{"field":"status"}],"filters":[{"field":"status","op":"in","value":["PRESENT","LATE","ABSENT","WFH"]}],"dateRange":{"field":"date","last":{"n":8,"unit":"week"}}}}');
    if (has('leave_requests')) w.push('{"title":"Approved leave days by type","viz":"donut","query":{"dataset":"leave_requests","measures":[{"fn":"sum","field":"days"}],"dimensions":[{"field":"leaveType"}],"filters":[{"field":"status","op":"eq","value":"APPROVED"}],"dateRange":{"field":"startDate","preset":"this_year"}}}');
    ex.push({ keys: ['employees', 'attendance', 'leave_requests'], text: `Request: HR overview\n{"title":"HR overview","description":"Headcount, attendance and leave","widgets":[${w.join(',')}]}` });
  }
  if (has('tickets')) {
    ex.push({ keys: ['tickets'], text: 'Request: Help desk dashboard\n{"title":"Help desk","description":"Ticket volume and agents","widgets":['
      + '{"title":"Open tickets","viz":"kpi","kpi":"total","query":{"dataset":"tickets","measures":[{"fn":"count"}],"filters":[{"field":"isOpen","op":"eq","value":true}]}},'
      + '{"title":"Tickets per week","viz":"line","query":{"dataset":"tickets","measures":[{"fn":"count"}],"dimensions":[{"field":"createdAt","bucket":"week"}],"dateRange":{"field":"createdAt","last":{"n":12,"unit":"week"}}}},'
      + '{"title":"Top agents by resolved tickets","viz":"leaderboard","query":{"dataset":"tickets","measures":[{"fn":"count"}],"dimensions":[{"field":"assignee"}],"filters":[{"field":"status","op":"in","value":["RESOLVED","CLOSED"]}],"dateRange":{"field":"resolvedAt","preset":"this_month"},"sort":{"by":"count","dir":"desc"},"limit":5}}]}' });
  }
  if (!ex.length && shown.length) {
    // Nothing above applies: one tiny example on the first dataset shown.
    const d = shown[0];
    const date = d.def.defaultDate;
    ex.push({ keys: [d.def.key], text: `Request: ${d.def.label} overview\n{"title":"${d.def.label}","description":"${d.def.label} over time","widgets":[`
      + `{"title":"${d.def.label} — last 30 days","viz":"kpi","kpi":"total","query":{"dataset":"${d.def.key}","measures":[{"fn":"count"}],"dateRange":{"field":"${date}","preset":"last_30_days"},"compare":"previous_period"}},`
      + `{"title":"${d.def.label} per month","viz":"line","query":{"dataset":"${d.def.key}","measures":[{"fn":"count"}],"dimensions":[{"field":"${date}","bucket":"month"}],"dateRange":{"field":"${date}","last":{"n":12,"unit":"month"}}}}]}` });
  }
  return ex;
}

/** At most two examples: those for the datasets shown first (i.e. most relevant). */
function examples(shown: ResolvedDataset[]): string {
  const order = (e: Example) => { const i = shown.findIndex(d => e.keys.includes(d.def.key)); return i < 0 ? 999 : i; };
  return exampleList(shown).sort((a, b) => order(a) - order(b)).slice(0, 2).map(e => e.text).join('\n\n');
}

function header(actx: AnalyticsContext, pc: PromptCatalog): string[] {
  const dow = WEEKDAYS[parseDate(actx.env.today).getUTCDay()];
  return [
    `Today is ${actx.env.today} (${dow}), time zone ${actx.env.timezone}; money is in ${actx.currency}.`,
    WIDGET_SHAPE,
    QUERY_SHAPE,
    FORECAST_SHAPE,
    'Rules:',
    '- Use ONLY catalog datasets and fields; copy enum values exactly. Relative periods use presets or "last"; never invent dates.',
    '- kpi = one number: "total" = the query total (aggregate, no dimensions; "compare":"previous_period" shows the change); "projected" / "derived:<i>" / "rate:<i>" = a figure from a forecast → give "forecastOf":<forecast widget index>.',
    '- line/area: one date dimension with a bucket. bar/hbar/pie/donut/leaderboard/funnel: one non-date dimension (funnel: a status/stage enum). stacked_bar: a date bucket + one dimension. table: anything (mode "list" for records).',
    '- Projections ("project", "forecast", "if it continues", "where will we be", "next N days") → viz "forecast": query = ONE measure + ONE date dimension with a bucket and NO dateRange; FORECAST.horizon = buckets ahead. Add KPI tiles for the projected total and derived values, and {"viz":"note","noteFor":<forecast index>}.',
    '- Projected conversions/revenue only via FORECAST.derived as in the example, and only with those datasets in the catalog.',
    '- No free-text notes. Compact JSON, no comments.',
    `Presets: ${PRESETS_TEXT}`,
    'CATALOG',
    catalogText(pc),
  ];
}

export function buildProposalPrompt(actx: AnalyticsContext, request = ''): string {
  const pc = dashboardCatalog(actx.catalog, request);
  return [
    'You design analytics dashboards: translate a request into JSON widget specs for an analytics engine. Never invent data, datasets or fields; never write numbers or SQL.',
    'Return ONE JSON object: {"title":"dashboard title","description":"one sentence","widgets":[WIDGET, …3 to 8 widgets]}',
    ...header(actx, pc),
    'EXAMPLES',
    examples(pc.shown),
  ].join('\n');
}

/** Datasets a widget (or a model reply) refers to, in the caller's catalog. */
function datasetsIn(catalog: ResolvedDataset[], v: unknown): ResolvedDataset[] {
  const keys = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) { if (k === 'dataset' && typeof y === 'string') keys.add(y); else walk(y); }
  };
  walk(v);
  return catalog.filter(d => keys.has(d.def.key));
}

export function buildWidgetEditPrompt(actx: AnalyticsContext, current?: DashboardWidgetSpec, instruction = ''): string {
  // The widget's own datasets first, then whatever the change request mentions.
  const own = current ? datasetsIn(actx.catalog, current) : [];
  const mentioned = instruction ? relevantDatasets(actx.catalog, instruction, 3) : [];
  const ordered = [...own, ...(mentioned.length < actx.catalog.length ? mentioned : [])];
  const pc = ordered.length ? fitCatalog(actx.catalog, ordered, EDIT_CATALOG_BUDGET) : dashboardCatalog(actx.catalog, instruction, EDIT_CATALOG_BUDGET);
  return [
    'You modify one dashboard widget: translate the change request into the widget\'s new JSON spec for an analytics engine. Keep everything the request doesn\'t mention. Never invent datasets or fields; never write numbers or SQL.',
    'Return ONE JSON object: WIDGET (with its own "query" and "forecast"; no "forecastOf").',
    ...header(actx, pc),
  ].join('\n');
}

/**
 * The repair call: NOT the whole build prompt again. The model gets the
 * format, the errors and its own previous reply, and the catalog of only the
 * datasets that reply used — widened to the request's relevant datasets when
 * it used one it can't have or produced nothing usable.
 */
export function buildRepairPrompt(actx: AnalyticsContext, request: string, previous: unknown): string {
  const used = datasetsIn(actx.catalog, previous);
  const relevant = dashboardCatalog(actx.catalog, request, REPAIR_CATALOG_BUDGET).shown;
  const pc = fitCatalog(actx.catalog, [...used, ...relevant], REPAIR_CATALOG_BUDGET);
  return [
    'You fix a rejected analytics-dashboard proposal. Return the corrected JSON object only, same format: {"title":"...","description":"...","widgets":[WIDGET, …]}. Keep the widgets that were fine; fix or drop the rejected ones. Never invent datasets or fields.',
    ...header(actx, pc),
  ].join('\n');
}

/** Repair errors without the long dataset lists some validators append (the catalog is in the prompt). */
export function compactErrors(errors: string[], max = 8): string[] {
  return errors.slice(0, max).map(e => e.replace(/\s*\((?:datasets|Datasets): [^)]*\)/g, '').slice(0, 300));
}

/** The previous reply for the repair call: re-serialised compactly when it parsed. */
export function previousReply(raw: unknown, text: string | null, maxChars = 5000): string {
  const s = raw && typeof raw === 'object' ? JSON.stringify(raw) : (text ?? '');
  return s.slice(0, maxChars);
}

// ─── Pipelines ──────────────────────────────────────────────────────────────

export interface ProposeResult {
  status: 'proposed' | 'failed';
  proposal: Proposal | null;
  warnings: string[];
  /** When failed: why, in words. */
  message?: string;
  cached: boolean;
  modelCalls: number;
}

const memory = new Map<string, { value: string; expires: number }>();
const TTL_MS = 7 * 24 * 3600_000;

function cacheKey(actx: AnalyticsContext, kind: string, text: string) {
  const norm = text.toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').replace(/[?.!\s]+$/g, '').trim();
  return crypto.createHash('sha256').update(`dashboards.${kind}|v1|${actx.env.orgId}|${actx.catalogVersion}|${norm}`).digest('hex');
}

async function readCache(actx: AnalyticsContext, key: string): Promise<string | null> {
  const m = memory.get(key);
  if (m && m.expires > Date.now()) return m.value;
  return readPersistentCache(actx.env.orgId, key);
}

async function writeCache(actx: AnalyticsContext, key: string, feature: string, value: string) {
  memory.set(key, { value, expires: Date.now() + TTL_MS });
  if (memory.size > 500) for (const [k, v] of memory) if (v.expires < Date.now()) memory.delete(k);
  await writePersistentCache(actx.env.orgId, key, feature, value, TTL_MS);
}

export async function proposeDashboard(user: AnalyticsUser, prompt: string): Promise<ProposeResult> {
  const q = prompt.trim().slice(0, 800);
  const actx = await getAnalyticsContext(user);
  if (!actx.catalog.length) return { status: 'failed', proposal: null, warnings: [], message: 'You don’t have access to any data to build a dashboard from.', cached: false, modelCalls: 0 };
  const c: CatalogEnv = { catalog: actx.catalog, env: actx.env };
  const key = cacheKey(actx, 'propose', q);

  // A cached model reply is re-validated: permissions or fields may have changed since.
  const hit = await readCache(actx, key);
  if (hit) {
    const chk = checkProposal(c, JSON.parse(hit), q);
    if (chk.proposal) return { status: 'proposed', proposal: chk.proposal, warnings: chk.warnings, cached: true, modelCalls: 0 };
  }

  const system = buildProposalPrompt(actx, q);
  const first = await designDashboardJson(system, `Request: ${q}`, 'dashboard.build', BUILD_MAX_TOKENS);
  let modelCalls = 1;
  let raw = safeJson(first);
  let chk = checkProposal(c, raw, q);
  if (!chk.proposal) {
    const repair = await designDashboardJson(buildRepairPrompt(actx, q, raw),
      `Request: ${q}\n\nYour previous reply:\n${previousReply(raw, first)}\n\nIt was rejected because:\n- ${compactErrors(chk.errors).join('\n- ')}\n\nReturn the corrected JSON object only.`, 'dashboard.build', BUILD_MAX_TOKENS);
    modelCalls++;
    const raw2 = safeJson(repair);
    const chk2 = checkProposal(c, raw2, q);
    if (chk2.proposal) { raw = raw2; chk = chk2; }
    else {
      // Keep whatever is valid from the better of the two replies.
      const best = chk2.specs.filter(Boolean).length >= chk.specs.filter(Boolean).length ? { chk: chk2, raw: raw2 } : { chk, raw };
      const salvaged = salvage(best.chk, best.raw);
      if (!salvaged) {
        const why = [...chk2.errors, ...chk.errors].find(e => /available to your role|switched off|don't have access|not available/.test(e));
        return {
          status: 'failed', proposal: null, warnings: [], cached: false, modelCalls,
          message: `I couldn't build that dashboard from your data${why ? `: ${why.replace(/^widgets\.\d+: (query: )?/, '')}` : '.'} You can build one with: ${actx.catalog.slice(0, 10).map(d => d.def.label.toLowerCase()).join(', ')}.`,
        };
      }
      return { status: 'proposed', proposal: salvaged.proposal, warnings: salvaged.warnings, cached: false, modelCalls };
    }
  }
  if (chk.proposal) await writeCache(actx, key, 'dashboard.build', JSON.stringify(raw));
  return { status: 'proposed', proposal: chk.proposal, warnings: chk.warnings, cached: false, modelCalls };
}

export interface ModifyResult {
  status: 'modified' | 'failed';
  spec: DashboardWidgetSpec | null;
  message?: string;
  modelCalls: number;
}

export async function modifyWidget(user: AnalyticsUser, current: DashboardWidgetSpec, instruction: string): Promise<ModifyResult> {
  if (current.kind === 'note') return { status: 'failed', spec: null, message: 'Notes are edited directly — the AI doesn’t write notes.', modelCalls: 0 };
  const actx = await getAnalyticsContext(user);
  const c: CatalogEnv = { catalog: actx.catalog, env: actx.env };
  const system = buildWidgetEditPrompt(actx, current, instruction);
  const ask = (extra = '') => designDashboardJson(system, `Current widget: ${JSON.stringify(widgetToModel(current))}\nChange: ${instruction.trim().slice(0, 500)}${extra}`, 'dashboard.widgetEdit', EDIT_MAX_TOKENS);
  const attempt = (reply: string | null) => {
    const raw = safeJson(reply);
    if (!raw || typeof raw !== 'object') return { spec: null, errors: ['The reply was not a JSON object.'] };
    const conv = convertModelWidget(raw, [raw], c, current.source?.question ?? instruction);
    if (!conv.spec) return { spec: null, errors: [conv.error ?? conv.skipped ?? 'invalid widget'] };
    // Keep the original source / options the model doesn't know about.
    const merged = { ...(conv.spec as Record<string, unknown>), source: current.source, options: { ...current.options, ...((conv.spec as any).options ?? {}) } };
    return validateWidget(c, merged);
  };
  const first = await ask();
  let v = attempt(first);
  let modelCalls = 1;
  if (!v.spec) {
    const second = await ask(`\n\nYour previous reply:\n${previousReply(safeJson(first), first, 2500)}\n\nIt was rejected because:\n- ${compactErrors(v.errors).join('\n- ')}\n\nReturn the corrected JSON object only.`);
    modelCalls++;
    v = attempt(second);
  }
  if (!v.spec) return { status: 'failed', spec: null, message: `I couldn't make that change: ${v.errors[0] ?? 'the result wasn’t valid'}.`, modelCalls };
  return { status: 'modified', spec: v.spec, modelCalls };
}
