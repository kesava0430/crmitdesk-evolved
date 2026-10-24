/**
 * "Ask anything about your business" — question → query specs → real data →
 * short answer + chart + pinnable widget.
 *
 * The model is a TRANSLATOR only:
 *   1. interpret (one JSON-mode call, FAST tier): the question + a compact
 *      summary of the caller's own catalog (dataset/field names and enum
 *      values — never rows) → { queries[], forecast?, chart, title }.
 *      Validated with zod and a dry-run compile against the caller's catalog;
 *      on failure ONE repair call with the exact errors, then an honest
 *      "can't answer that, here's what you can ask".
 *   2. execute: the query layer runs each spec with the caller's permissions.
 *   3. answer: a deterministic template fills the sentence from the returned
 *      numbers. Only multi-query answers ask the model to write the sentence,
 *      from aggregated rows, and every number it writes is checked against
 *      the results (else the template is used).
 * Interpretations are cached per (org, catalog version, normalised question)
 * in ai_response_cache, so repeating a question costs no model call; dates
 * stay relative in the spec, so a cached "yesterday" still means yesterday.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { interpretAnalyticsQuestion, narrateAnalyticsAnswer } from '../ai';
import { readPersistentCache, writePersistentCache } from '../aiCache';
import {
  getAnalyticsContext, findDataset, runQuery, runForecast, parseQuerySpec,
  type AnalyticsContext, type AnalyticsUser, type QueryResult, type ForecastResponse,
} from './executor';
import { compileQuery, QueryError } from './compiler';
import { QuerySpecSchema, ForecastSpecSchema, zodIssues, PRESETS_TEXT, type QuerySpec, type ForecastSpec } from './spec';
import { answerFor, forecastAnswer, chooseViz, buildWidgetSpec, checkNumbers, numbersOf, type VizType, type WidgetSpec } from './answer';
import type { ResolvedDataset } from './types';
import { parseDate } from './dates';
import { estimateTokens } from '../aiRateLimit';

// ─── Plan schema (what the model must return) ───────────────────────────────

const PlanSchema = z.object({
  answerable: z.boolean().default(true),
  title: z.string().max(120).nullish(),
  chart: z.string().max(30).nullish(),
  queries: z.array(z.unknown()).max(3).default([]),
  forecast: z.object({
    horizon: z.coerce.number().int().min(1).max(366),
    growthPctPerMonth: z.coerce.number().min(-90).max(500).nullish(),
    cumulative: z.boolean().nullish(),
    derived: z.array(z.unknown()).max(5).nullish(),
  }).nullish(),
  reason: z.string().max(500).nullish(),
});

export interface Plan {
  answerable: boolean;
  title: string;
  chart: string | null;
  queries: QuerySpec[];
  forecast: (Omit<ForecastSpec, 'series'>) | null;
  reason: string | null;
}

// ─── Result shape ───────────────────────────────────────────────────────────

export interface AskResult {
  status: 'answered' | 'unanswerable';
  question: string;
  answer: string;
  title: string;
  chart: VizType | null;
  /** One entry per executed query (rows capped at 200). */
  results: QueryResult[];
  forecast: ForecastResponse | null;
  /** "How this was calculated": each query in words, scope, method, assumptions. */
  howCalculated: string[];
  widgetSpec: WidgetSpec | null;
  /** Unanswerable: what the caller can ask about instead. */
  available: Array<{ dataset: string; label: string; examples: string[] }>;
  warnings: string[];
  cached: boolean;
  modelCalls: number;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Compact, model-friendly catalog: names and allowed values only — never data. */
export function catalogSummary(catalog: ResolvedDataset[]): string {
  return catalog.map(d => {
    const dates = d.fields.filter(f => f.type === 'date' || f.type === 'datetime').map(f => f.key);
    const groups = d.fields.filter(f => f.groupable !== false && ['enum', 'relation', 'boolean', 'string'].includes(f.type)).map(f => {
      if (f.type === 'enum') return `${f.key}[${(f.values ?? []).slice(0, 12).join(',')}${(f.values ?? []).length > 12 ? ',…' : ''}]`;
      if (f.type === 'relation') return `${f.key}(${f.isUser ? 'person; "me" = asker' : 'name'})`;
      if (f.type === 'boolean') return `${f.key}(true/false)`;
      return f.key;
    });
    const nums = d.fields.filter(f => f.type === 'number' || f.type === 'money').map(f => `${f.key}${f.type === 'money' ? '($)' : ''}${f.aggregations ? `(${f.aggregations.join('/')})` : ''}`);
    const text = d.fields.filter(f => f.type === 'string' && f.groupable === false).map(f => f.key);
    return `- ${d.def.key}: ${d.def.label} — ${d.def.description}\n  dates: ${dates.join(', ') || 'none'} (default ${d.def.defaultDate})`
      + `\n  group/filter: ${groups.join(', ') || 'none'}`
      + (nums.length ? `\n  numbers: ${nums.join(', ')}` : '')
      + (text.length ? `\n  text (filter with contains): ${text.join(', ')}` : '');
  }).join('\n');
}

/** Worked examples, only for datasets this caller has (so the model never copies an unavailable one). */
function examples(catalog: ResolvedDataset[]): string {
  const has = (k: string) => catalog.some(d => d.def.key === k);
  const ex: string[] = [];
  if (has('leads')) {
    ex.push('Q: How many leads did we get each week for the last 12 weeks?\n{"answerable":true,"title":"Leads per week","chart":"line","queries":[{"dataset":"leads","measures":[{"fn":"count"}],"dimensions":[{"field":"createdAt","bucket":"week"}],"dateRange":{"field":"createdAt","last":{"n":12,"unit":"week"}}}],"forecast":null}');
    ex.push('Q: Where will our leads be in the next 30 days if nothing changes?\n{"answerable":true,"title":"Leads — next 30 days","chart":"line","queries":[{"dataset":"leads","measures":[{"fn":"count"}],"dimensions":[{"field":"createdAt","bucket":"day"}]}],"forecast":{"horizon":30,"growthPctPerMonth":null,"cumulative":false}}');
  }
  if (has('tickets')) ex.push('Q: Top 3 agents by tickets resolved last month\n{"answerable":true,"title":"Top agents by resolved tickets","chart":"leaderboard","queries":[{"dataset":"tickets","measures":[{"fn":"count"}],"dimensions":[{"field":"assignee"}],"filters":[{"field":"status","op":"in","value":["RESOLVED","CLOSED"]}],"dateRange":{"field":"resolvedAt","preset":"last_month"},"sort":{"by":"count","dir":"desc"},"limit":3}],"forecast":null}');
  if (has('attendance')) ex.push('Q: Who was on leave today?\n{"answerable":true,"title":"On leave today","chart":"table","queries":[{"dataset":"attendance","mode":"list","fields":["employee","department","status"],"filters":[{"field":"status","op":"in","value":["LEAVE","UNPAID_LEAVE"]}],"dateRange":{"field":"date","preset":"today"}}],"forecast":null}');
  if (has('deals')) ex.push('Q: Value of won deals this quarter compared with last quarter\n{"answerable":true,"title":"Won deal value","chart":"kpi","queries":[{"dataset":"deals","measures":[{"fn":"sum","field":"value"}],"filters":[{"field":"status","op":"eq","value":"WON"}],"dateRange":{"field":"closeDate","preset":"this_quarter"},"compare":"previous_period"}],"forecast":null}');
  ex.push('Q: What will the weather be tomorrow?\n{"answerable":false,"reason":"Weather isn\'t in your business data.","queries":[],"forecast":null}');
  return ex.join('\n\n');
}

/* Words that point at a dataset even when its name isn't used. */
const DATASET_HINTS: Record<string, string[]> = {
  leads: ['lead', 'prospect', 'enquir', 'inquir', 'pipeline', 'conversion', 'convert', 'source'],
  deals: ['deal', 'opportunit', 'revenue', 'won', 'lost', 'pipeline', 'forecast revenue', 'sales'],
  contacts: ['contact', 'customer', 'client'],
  accounts: ['account', 'compan', 'customer', 'client'],
  activities: ['activit', 'call', 'meeting', 'follow'],
  quotes: ['quote', 'quotation', 'proposal'],
  invoices: ['invoice', 'billing', 'overdue', 'paid', 'unpaid', 'receivable', 'revenue', 'outstanding'],
  campaigns: ['campaign', 'email blast', 'newsletter'],
  tickets: ['ticket', 'agent', 'issue', 'support', 'helpdesk', 'help desk', 'sla', 'resolved', 'resolution', 'priority', 'incident'],
  assets: ['asset', 'laptop', 'device', 'equipment', 'hardware'],
  change_requests: ['change request', 'change'],
  kb_articles: ['article', 'knowledge', 'kb'],
  csat: ['csat', 'satisfaction', 'rating', 'feedback', 'survey'],
  employees: ['employee', ' hr ', 'staff', 'headcount', 'people', 'joiner', 'joined', 'department', 'team', 'hire', 'exit', 'attrition'],
  attendance: ['attendance', 'absent', 'present', 'late', 'leave today', 'on leave', 'check-in', 'check in', 'checked in', 'working days', 'wfh', 'work from home', 'overtime'],
  attendance_sessions: ['check-in', 'check in', 'session', 'hours worked', 'punch', 'overtime'],
  leave_requests: ['leave', 'vacation', 'holiday', 'time off', 'sick'],
  wfh_requests: ['wfh', 'work from home', 'remote'],
  payslips: ['payroll', 'salary', 'salaries', 'payslip', 'pay ', 'gross', 'net pay', 'ctc', 'cost', 'deduction', 'pf', 'tds'],
  payroll_runs: ['payroll', 'payroll run', 'salary cost', 'payout'],
  loans: ['loan', 'advance', 'emi'],
  tasks: ['task', 'to-do', 'todo', 'reminder'],
  approvals: ['approval', 'approve', 'pending approval'],
};

/**
 * Datasets worth showing the model for this question. The full catalog is
 * ~25 datasets (~2.5k tokens); Groq's free tier allows 8k tokens a minute
 * for the whole account, so sending all of it every time capped the product
 * at two questions a minute. Validation still runs against the caller's full
 * catalog — this only narrows what the model reads. No match → everything.
 */
export function relevantDatasets(catalog: ResolvedDataset[], question: string, max = 6): ResolvedDataset[] {
  const q = ` ${question.toLowerCase()} `;
  const scored = catalog.map(d => {
    let score = 0;
    const key = d.def.key.replace(/^custom_/, '').replace(/_/g, ' ');
    if (q.includes(key.replace(/s$/, ''))) score += 5;
    if (q.includes(d.def.label.toLowerCase().replace(/s$/, ''))) score += 5;
    for (const h of DATASET_HINTS[d.def.key] ?? []) if (q.includes(h)) score += 2;
    return { d, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return catalog;
  const picked = scored.slice(0, max).map(x => x.d);
  // Revenue / conversion projections need deals next to leads.
  const has = (k: string) => picked.some(d => d.def.key === k);
  for (const pair of [['leads', 'deals'], ['deals', 'leads']] as const) {
    if (has(pair[0]) && !has(pair[1])) { const other = catalog.find(d => d.def.key === pair[1]); if (other) picked.push(other); }
  }
  return picked;
}

// ─── Fitting the catalog into a token budget ────────────────────────────────

/* When a question names nothing specific, show the datasets people ask about
   most, across areas, before the long tail. */
export const CATALOG_PRIORITY = [
  'leads', 'deals', 'tickets', 'employees', 'attendance', 'invoices', 'tasks', 'leave_requests', 'activities',
  'accounts', 'contacts', 'csat', 'assets', 'quotes', 'payslips', 'approvals', 'change_requests', 'kb_articles',
  'campaigns', 'wfh_requests', 'attendance_sessions', 'payroll_runs', 'loans',
];

export function byPriority(catalog: ResolvedDataset[]): ResolvedDataset[] {
  const rank = (d: ResolvedDataset) => { const i = CATALOG_PRIORITY.indexOf(d.def.key); return i < 0 ? 999 : i; };
  return [...catalog].sort((a, b) => rank(a) - rank(b));
}

export interface PromptCatalog { shown: ResolvedDataset[]; others: ResolvedDataset[] }

/**
 * The ordered candidates that fit a token budget, in full; everything else
 * by name only. At least one dataset is always shown in full.
 */
export function fitCatalog(all: ResolvedDataset[], ordered: ResolvedDataset[], budget: number): PromptCatalog {
  const shown: ResolvedDataset[] = [];
  let used = 0;
  for (const d of ordered) {
    if (shown.includes(d)) continue;
    const t = estimateTokens(catalogSummary([d]).length + 1);
    if (shown.length && used + t > budget) continue;
    shown.push(d); used += t;
  }
  return { shown, others: all.filter(d => !shown.includes(d)) };
}

export function catalogText(pc: PromptCatalog): string {
  return catalogSummary(pc.shown)
    + (pc.others.length ? `\nAlso available (fields not listed; use only if essential): ${pc.others.map(d => d.def.key).join(', ')}` : '');
}

/** Catalog share of an Ask prompt (tokens); the "wide" retry gets more. */
export const ASK_CATALOG_BUDGET = 1300;
export const ASK_WIDE_CATALOG_BUDGET = 1700;

/**
 * Datasets an Ask prompt shows. Narrow: the relevant ones (or, with no
 * match, the most-used ones within budget). Wide (the retry after "not
 * answerable" from a narrow view): relevant first, then the rest by priority,
 * within a larger budget — never the whole 25-dataset catalog, which alone
 * was ~2.4k tokens of Groq's 8k-a-minute allowance.
 */
export function askCatalog(catalog: ResolvedDataset[], question?: string, wide = false): PromptCatalog {
  const picked = question ? relevantDatasets(catalog, question, wide ? 10 : 6) : catalog;
  const matched = picked.length < catalog.length;
  const ordered = matched ? (wide ? [...picked, ...byPriority(catalog)] : picked) : byPriority(catalog);
  // No match: the first call already gets the wide view, so a "not answerable" needs no second call.
  return fitCatalog(catalog, ordered, wide || !matched ? ASK_WIDE_CATALOG_BUDGET : ASK_CATALOG_BUDGET);
}

export function buildSystemPrompt(actx: AnalyticsContext, question?: string, wide = false): string {
  const pc = askCatalog(actx.catalog, question, wide);
  const shown = pc.shown;
  const dow = WEEKDAYS[parseDate(actx.env.today).getUTCDay()];
  return [
    'You translate a business question into JSON query specs for an analytics engine. You never answer from your own knowledge, never invent datasets or fields, and never write SQL.',
    `Today is ${actx.env.today} (${dow}), time zone ${actx.env.timezone}; money is in ${actx.currency}.`,
    '',
    'Return ONE JSON object:',
    '{"answerable":true|false,"title":"short chart title","chart":"kpi|line|bar|pie|table|leaderboard","queries":[QUERY],"forecast":null|{"horizon":N,"growthPctPerMonth":null|number,"cumulative":false},"reason":"only when answerable is false"}',
    'QUERY = {"dataset":"<key>","mode":"aggregate"|"list","measures":[{"fn":"count"} or {"fn":"sum|avg|min|max|count_distinct","field":"<field>"}],"dimensions":[{"field":"<field>"} or {"field":"<date field>","bucket":"day|week|month|quarter|year"}],"fields":["<field>"],"filters":[{"field":"<field>","op":"eq|neq|in|not_in|gt|gte|lt|lte|between|contains|is_null|not_null","value":<value or [values]>}],"dateRange":{"field":"<date field>","preset":"<preset>"} or {"field":"<date field>","last":{"n":<number>,"unit":"day|week|month|quarter|year"},"includeCurrent":true|false},"compare":null|"previous_period"|"previous_year","sort":{"by":"<measure key or field>","dir":"asc|desc"},"limit":<number>}',
    '',
    'Rules:',
    '- Use ONLY the datasets and fields in the catalog; copy enum values exactly.',
    '- Counts / totals / averages → mode "aggregate". "Who / which / list / show" individual records → mode "list" with "fields".',
    '- "each day/week/month" or a trend → one dimension with a bucket. "Top N" → a dimension, sort desc by the measure, limit N.',
    '- Relative periods → dateRange with a preset or "last"; set dateRange.field to the date that matches the question (e.g. resolvedAt for "resolved", closeDate for "closed"). "Last 3 months" of complete months → {"last":{"n":3,"unit":"month"},"includeCurrent":false}.',
    '- Projections / forecasts ("project", "forecast", "next N days", "where will we be") → ONE query with a day/week/month bucket dimension and NO dateRange, plus "forecast":{"horizon":<number of buckets ahead>}. "+10% a month" → growthPctPerMonth 10.',
    '- Measure keys for sort: "count", "sum_<field>", "avg_<field>", "min_<field>", "max_<field>", "distinct_<field>".',
    '- Money filter values are plain numbers (no symbols or commas): "over ₹50,000" → {"op":"gt","value":50000}.',
    '- Person filters accept a name or "me" (the person asking).',
    '- If the question needs data that is not in the catalog, return {"answerable":false,"reason":"..."}.',
    '- At most 3 queries. No comments, no markdown.',
    `Presets: ${PRESETS_TEXT}`,
    '',
    'CATALOG',
    catalogText(pc),
    '',
    'EXAMPLES',
    examples(shown),
  ].join('\n');
}

// ─── Plan validation ────────────────────────────────────────────────────────

function safeJson(s: string | null): unknown {
  if (!s) return null;
  const t = s.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch {
    const i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch { /* fallthrough */ } }
    return null;
  }
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

export function validatePlan(actx: AnalyticsContext, raw: unknown): { plan: Plan | null; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { plan: null, errors: ['The reply was not a JSON object.'] };
  const p = PlanSchema.safeParse(raw);
  if (!p.success) return { plan: null, errors: zodIssues(p.error) };
  const d = p.data;
  if (!d.answerable) {
    return { plan: { answerable: false, title: '', chart: null, queries: [], forecast: null, reason: d.reason ?? null }, errors: [] };
  }
  if (!d.queries.length) return { plan: null, errors: ['answerable is true but "queries" is empty.'] };
  const errors: string[] = [];
  const queries: QuerySpec[] = [];
  d.queries.forEach((q, i) => {
    const r = QuerySpecSchema.safeParse(tidy(q));
    if (!r.success) { errors.push(...zodIssues(r.error).map(e => `queries.${i}.${e}`)); return; }
    try {
      const ds = findDataset(actx, r.data.dataset);
      compileQuery(ds, r.data, actx.env); // dry run: every key, value and limit checked
      queries.push(r.data);
    } catch (err) {
      if (err instanceof QueryError) errors.push(`queries.${i}: ${err.message}${err.hints.length ? ` (${err.hints.join('; ')})` : ''}`);
      else throw err;
    }
  });
  let forecast: Plan['forecast'] = null;
  if (d.forecast && !errors.length) {
    const series = queries[0];
    const bucketDims = series.dimensions.filter(x => x.bucket);
    if (series.mode !== 'aggregate' || series.dimensions.length !== 1 || bucketDims.length !== 1 || series.measures.length !== 1) {
      errors.push('A forecast needs queries[0] to have exactly one measure and one dimension with a bucket (day/week/month).');
    } else {
      const fr = ForecastSpecSchema.safeParse(tidy({
        series, horizon: d.forecast.horizon,
        scenario: d.forecast.growthPctPerMonth ? { growthPctPerMonth: d.forecast.growthPctPerMonth } : undefined,
        cumulative: d.forecast.cumulative ?? false,
        derived: d.forecast.derived ?? [],
      }));
      if (!fr.success) errors.push(...zodIssues(fr.error).map(e => `forecast.${e}`));
      else {
        for (const [i, dv] of fr.data.derived.entries()) {
          for (const part of [dv.numerator, dv.denominator]) {
            try { findDataset(actx, part.dataset); } catch (err) { errors.push(`forecast.derived.${i}: ${(err as Error).message}`); }
          }
        }
        const { series: _s, ...rest } = fr.data;
        void _s;
        forecast = rest;
      }
    }
  }
  if (errors.length) return { plan: null, errors };
  return {
    plan: { answerable: true, title: d.title?.trim() || '', chart: d.chart ?? null, queries, forecast, reason: null },
    errors: [],
  };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

export function normaliseQuestion(q: string): string {
  return q.toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').replace(/[?.!\s]+$/g, '').trim();
}

const memory = new Map<string, { plan: string; expires: number }>();
const PLAN_TTL_MS = 7 * 24 * 3600_000;

function planKey(actx: AnalyticsContext, question: string) {
  return crypto.createHash('sha256').update(`analytics.ask|v1|${actx.env.orgId}|${actx.catalogVersion}|${normaliseQuestion(question)}`).digest('hex');
}

async function readPlan(actx: AnalyticsContext, key: string): Promise<string | null> {
  const m = memory.get(key);
  if (m && m.expires > Date.now()) return m.plan;
  return readPersistentCache(actx.env.orgId, key);
}

async function writePlan(actx: AnalyticsContext, key: string, plan: Plan) {
  const s = JSON.stringify(plan);
  memory.set(key, { plan: s, expires: Date.now() + PLAN_TTL_MS });
  if (memory.size > 1000) for (const [k, v] of memory) if (v.expires < Date.now()) memory.delete(k);
  await writePersistentCache(actx.env.orgId, key, 'dashboard.query', s, PLAN_TTL_MS);
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

function availableList(actx: AnalyticsContext): AskResult['available'] {
  return actx.catalog.filter(d => !d.def.key.startsWith('custom_') || actx.catalog.length < 30).map(d => ({ dataset: d.def.key, label: d.def.label, examples: d.def.examples ?? [] }));
}

function unanswerable(question: string, actx: AnalyticsContext, reason: string | null, modelCalls: number): AskResult {
  const avail = availableList(actx);
  // Lower-case the first letter only, unless it starts an acronym ("IT assets").
  const names = avail.slice(0, 12).map(a => (/^[A-Z]{2}/.test(a.label) ? a.label : a.label.charAt(0).toLowerCase() + a.label.slice(1)));
  const ex = avail.flatMap(a => a.examples).slice(0, 4);
  const answer = (reason ? `I can't answer that from your data: ${reason.replace(/\.$/, '')}. ` : "I couldn't turn that into a question about your data. ")
    + (names.length ? `I can answer questions about ${names.join(', ')}${avail.length > 12 ? ' and more' : ''}.` : 'There is no data you have access to yet.')
    + (ex.length ? ` For example: "${ex.join('", "')}".` : '');
  return { status: 'unanswerable', question, answer, title: '', chart: null, results: [], forecast: null, howCalculated: [], widgetSpec: null, available: avail, warnings: [], cached: false, modelCalls };
}

export interface AskOptions {
  /** Override "now" (tests). */
  now?: Date;
  /** Datasets not to use (e.g. payroll in a shared team-chat thread, where everyone reads the answer). */
  exclude?: string[];
}

export async function answerQuestion(user: AnalyticsUser, question: string, opts: AskOptions = {}): Promise<AskResult> {
  const q = question.trim().slice(0, 500);
  const actx = await getAnalyticsContext(user, opts.now);
  if (opts.exclude?.length) {
    actx.catalog = actx.catalog.filter(d => !opts.exclude!.includes(d.def.key));
    actx.catalogVersion += `-x${opts.exclude.length}`;
  }
  if (!actx.catalog.length) return unanswerable(q, actx, 'you don’t have access to any reports', 0);

  const key = planKey(actx, q);
  let plan: Plan | null = null;
  let cached = false;
  let modelCalls = 0;

  const hit = await readPlan(actx, key);
  if (hit) {
    // Re-validate a cached plan: permissions or fields may have changed since.
    const v = validatePlan(actx, JSON.parse(hit));
    if (v.plan) { plan = v.plan; cached = true; }
  }

  if (!plan) {
    const system = buildSystemPrompt(actx, q);
    const first = await interpretAnalyticsQuestion(system, `Question: ${q}`);
    modelCalls++;
    let raw = safeJson(first);
    let v = validatePlan(actx, raw);
    if (!v.plan) {
      // One repair attempt with the exact problems.
      const repair = await interpretAnalyticsQuestion(system,
        `Question: ${q}\n\nYour previous reply:\n${(raw && typeof raw === 'object' ? JSON.stringify(raw) : (first ?? '')).slice(0, 2500)}\n\nIt was rejected because:\n- ${v.errors.slice(0, 8).map(e => e.replace(/\s*\((?:datasets|Datasets): [^)]*\)/g, '').slice(0, 300)).join('\n- ')}\n\nReturn the corrected JSON object only.`);
      modelCalls++;
      raw = safeJson(repair);
      v = validatePlan(actx, raw);
    }
    if (!v.plan) {
      // Say why when the model asked for something this caller can't have
      // (a masked field, a switched-off area) rather than a generic shrug.
      const why = v.errors.find(e => /available to your role|switched off|don't have access/.test(e));
      return unanswerable(q, actx, why ? why.replace(/^queries\.\d+: /, '') : null, modelCalls);
    }
    plan = v.plan;
    // The model only saw the datasets that looked relevant. If it says "not
    // answerable" from that partial view, ask once more with everything so a
    // trimmed prompt can never cause a wrong refusal.
    if (!plan.answerable && askCatalog(actx.catalog, q, true).shown.length > askCatalog(actx.catalog, q).shown.length) {
      const full = await interpretAnalyticsQuestion(buildSystemPrompt(actx, q, true), `Question: ${q}`);
      modelCalls++;
      const vf = validatePlan(actx, safeJson(full));
      if (vf.plan) plan = vf.plan;
    }
  }

  if (!plan.answerable) {
    if (!cached) await writePlan(actx, key, plan);
    return unanswerable(q, actx, plan.reason, modelCalls);
  }

  // Execute.
  const warnings: string[] = [];
  const howCalculated: string[] = [];
  const results: QueryResult[] = [];
  let forecast: ForecastResponse | null = null;
  if (plan.forecast) {
    forecast = await runForecast(actx, { series: plan.queries[0], ...plan.forecast });
    howCalculated.push(forecast.description + '.');
    howCalculated.push(...forecast.assumptions);
    for (const d of forecast.derived) howCalculated.push(d.explanation);
    warnings.push(...forecast.warnings);
  } else {
    for (const spec of plan.queries) {
      const r = await runQuery(actx, spec);
      results.push(r);
      howCalculated.push(`${r.meta.description}.`);
      warnings.push(...r.meta.warnings);
    }
  }
  const scopes = new Set([...(forecast ? [findDataset(actx, plan.queries[0].dataset).scope] : results.map(r => r.meta.scope))]);
  if ([...scopes].some(s => s !== 'ALL')) howCalculated.push('Counts only the records you have access to (your own / your team’s), as on the list pages.');
  howCalculated.push(`Dates are in ${actx.env.timezone}; amounts in ${actx.currency}.`);

  // Answer text.
  let answer: string;
  if (forecast) answer = forecastAnswer(forecast);
  else if (results.length === 1) answer = answerFor(results[0]);
  else answer = await narrate(q, results).then(t => t ?? results.map(answerFor).join(' '));
  if (!cached) await writePlan(actx, key, plan);
  modelCalls += results.length > 1 ? 1 : 0;

  const primary = results[0];
  const viz = forecast ? 'forecast' as VizType : chooseViz(primary, plan.chart);
  const title = plan.title || (forecast ? forecast.measure.label : primary.meta.dataset.label);
  const widgetSpec: WidgetSpec = forecast
    ? {
      version: 1, title, viz: { type: 'forecast', x: forecast.columns.find(c => c.role === 'dimension')?.key, y: [forecast.measure.key] },
      query: parseQuerySpec(plan.queries[0]), forecast: plan.forecast!, description: forecast.description,
      source: { kind: 'ai_answer', question: q },
    }
    : buildWidgetSpec({ title, result: primary, viz, question: q });

  return {
    status: 'answered', question: q, answer, title, chart: viz,
    results: results.map(r => ({ ...r, rows: r.rows.slice(0, 200) })),
    forecast, howCalculated, widgetSpec, available: [], warnings: [...new Set(warnings)], cached, modelCalls,
  };
}

/**
 * Multi-query answers: the model writes 1–2 sentences from aggregated rows
 * (never list rows), and every number it uses must exist in the results.
 */
async function narrate(question: string, results: QueryResult[]): Promise<string | null> {
  if (results.some(r => r.meta.kind === 'list')) return null;
  const payload = results.map(r => ({
    query: r.meta.description,
    totals: r.meta.totals,
    comparison: r.meta.comparison ? { period: r.meta.comparison.human, totals: r.meta.comparison.totals, change: r.meta.comparison.change } : null,
    rows: r.rows.slice(0, 20),
  }));
  let text: string | null = null;
  try {
    text = await narrateAnalyticsAnswer(
      'Write a 1–2 sentence answer to the question using ONLY numbers that appear in the data below. Do not compute new numbers, do not round differently, no markdown.',
      `Question: ${question}\nData: ${JSON.stringify(payload).slice(0, 6000)}`,
    );
  } catch { return null; }
  if (!text) return null;
  const allowed = results.flatMap(numbersOf);
  return checkNumbers(text, allowed).ok ? text.trim().slice(0, 800) : null;
}
