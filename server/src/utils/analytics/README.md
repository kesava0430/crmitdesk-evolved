# Analytics query layer (`server/src/utils/analytics/`)

Real, permission-checked numbers for dashboards and AI answers. No raw SQL or
Prisma from callers or the model: a **query spec** (JSON, zod-validated) names
datasets and fields from the **catalog**, the **compiler** turns it into
parameterised SQL using only catalog expressions, and the **executor** runs it
read-only with a statement timeout.

| File | What |
|---|---|
| `types.ts` | Dataset / field definitions |
| `catalog.ts` | All datasets (real columns from `schema.prisma`) + custom-module datasets |
| `dates.ts` | Org-time-zone calendar maths: presets, "last N", comparison periods, buckets (pure) |
| `spec.ts` | Query / forecast spec schemas (zod) and hard limits |
| `compiler.ts` | Catalog resolution (areas, permissions, field redaction) + spec → SQL (pure) |
| `executor.ts` | DB: context, run query (gap-fill, totals, comparison, currency check), run forecast |
| `forecast.ts` | Linear / Holt / weekly seasonality, holdout selection, intervals, scenarios (pure) |
| `answer.ts` | Formatting, deterministic answers, chart choice, `WidgetSpec`, number checking (pure) |
| `ask.ts` | AI "Ask anything": question → plan → validate (+1 repair) → execute → answer |

Tests: `server/tests/unit/analytics.test.ts`.

## Endpoints

All require a signed-in org user (`ALL_USERS`). **Not plan-gated**: they power
dashboards on every plan and expose nothing a caller couldn't already list —
each dataset is filtered by the org's areas and the caller's record scope and
field rules. (The prebuilt `/analytics/overview|tickets|crm` reports keep their
`advanced_analytics` gate and the CRM/IT surface gate; `modules.ts` now gates
only those paths, so HR-only orgs can use the query layer.) AI answers
(`POST /api/ai/query`, `/api/ai/chat`) stay behind `ai_advanced`.

### `GET /api/analytics/catalog`
```json
{ "version": "f32c3ec033d7e430", "timezone": "Asia/Kolkata", "currency": "INR", "today": "2026-10-18",
  "limits": { "maxMeasures": 4, "maxDimensions": 2, "maxFilters": 10, "maxGroups": 200, "maxRows": 500, "maxBuckets": 800 },
  "datasets": [ { "key": "tickets", "label": "Tickets", "area": "itdesk", "module": "itdesk", "permission": "itdesk.ticket.read",
      "scope": "OWN", "defaultDateField": "createdAt", "examples": ["…"],
      "fields": [ { "key": "status", "label": "Status", "type": "enum", "values": ["OPEN","IN_PROGRESS","PENDING","RESOLVED","CLOSED"], "groupable": true, "filterable": true, "aggregations": [] },
                  { "key": "assignee", "label": "Assignee (agent)", "type": "relation", "acceptsMe": true, "groupable": true, "filterable": true, "aggregations": [] },
                  { "key": "resolutionHours", "label": "Resolution time (hours)", "type": "number", "unit": "hours", "aggregations": ["avg","min","max"], "groupable": false, "filterable": true },
                  { "key": "resolvedAt", "label": "Resolved", "type": "datetime", "buckets": ["day","week","month","quarter","year"], "groupable": true, "filterable": true, "aggregations": [] } ],
      "restrictedFields": ["…fields hidden by the caller's field rules…"] } ] }
```
Field types: `number | money | date | datetime | enum | string | boolean | relation`.
`version` changes whenever what the caller may query changes.

### `POST /api/analytics/query`
Body = a query spec (or `{ "spec": … }`):
```json
{ "dataset": "tickets",
  "mode": "aggregate",                       // or "list" (records, with "fields")
  "measures": [{ "fn": "count" }],           // count | count_distinct | sum | avg | min | max (+ "field")
  "dimensions": [{ "field": "assignee" }],   // ≤ 2; date fields need "bucket": day|week|month|quarter|year
  "filters": [{ "field": "status", "op": "in", "value": ["RESOLVED","CLOSED"] }],
  "dateRange": { "field": "resolvedAt", "preset": "this_month" },
  "compare": "previous_period",              // or previous_year
  "sort": { "by": "count", "dir": "desc" },  // a column key (measure keys: count, sum_<f>, avg_<f>, min_<f>, max_<f>, distinct_<f>)
  "limit": 5 }
```
- Filter ops by type — enum: eq/neq/in/not_in (case-insensitive, normalised); string: eq/neq/in/not_in/contains; number/money: eq/neq/gt/gte/lt/lte/between/in/not_in (`"₹50,000"` accepted); date: eq/gt/gte/lt/lte/between (`YYYY-MM-DD`); boolean: eq/neq; relation: eq/neq/in/not_in/contains on the name or id, `"me"` = caller for person fields; any: is_null/not_null.
- `dateRange`: `preset` (today, yesterday, this_/last_ week|month|quarter|year, last_7/30/90/365_days, next_7/30_days, all_time) **or** `last: {n, unit}` (+ `includeCurrent`, default true; false = N complete units) **or** `from`/`to` (inclusive). Field defaults to the bucketed dimension's field, else the dataset's default date. A bucketed query with no range defaults to day→last 30 days, week→12 weeks, month→12 months, quarter→8 quarters (said in `warnings`).
- Ranges are computed in the org time zone; TIMESTAMP columns are bucketed in that zone; form-picked dates stored as UTC midnight (due/close dates) are read as dates.

Response:
```json
{ "columns": [ { "key": "assignee", "label": "Assignee (agent)", "role": "dimension", "format": "text", "idKey": "assignee__id" },
               { "key": "count", "label": "Number of tickets", "role": "measure", "format": "number" } ],
  "rows": [ { "assignee": "Dave Desk", "assignee__id": "cmv…", "count": 17 }, { "assignee": "Ivy IT", "assignee__id": "cmv…", "count": 10 } ],
  "meta": { "dataset": { "key": "tickets", "label": "Tickets" },
    "description": "Number of tickets by assignee (agent) — resolved this month (1 Oct – 18 Oct 2026), where Status is Resolved or Closed; top 5",
    "kind": "aggregate",
    "range": { "from": "2026-10-01", "to": "2026-10-18", "label": "this month", "human": "1 Oct – 18 Oct 2026", "field": "resolvedAt", "partial": true },
    "bucket": null, "appliedFilters": ["Status is Resolved or Closed"], "scope": "ALL",
    "totals": { "count": 35 },
    "comparison": { "label": "previous period", "human": "1 Sep – 18 Sep 2026", "range": { "from": "2026-09-01", "to": "2026-09-18" },
                    "totals": { "count": 21 }, "change": { "count": { "abs": 14, "pct": 66.7 } } },
    "rowCount": 4, "truncated": false, "currency": "INR", "timezone": "Asia/Kolkata", "warnings": [], "spec": { "…normalised spec…": true } } }
```
Formats: `number | money | date (with bucket) | datetime | text | enum | boolean`. Series are gap-filled (quiet buckets = 0). List rows carry `__id`.
Errors: `400 { error, details[], code: "ANALYTICS_QUERY_INVALID" }` (unknown field, value not allowed, field hidden for the role, area switched off, too many buckets, timeout…).

### `POST /api/analytics/forecast`
```json
{ "series": { "dataset": "leads", "dimensions": [{ "field": "createdAt", "bucket": "day" }] },
  "horizon": 30,                                  // future buckets of the series' unit
  "scenario": { "growthPctPerMonth": 10 },        // optional what-if on top of the trend
  "cumulative": true,
  "seasonality": "auto",                          // or "none"
  "derived": [
    { "label": "Projected conversions",
      "numerator":   { "dataset": "leads", "measure": { "fn": "count" }, "filters": [{ "field": "status", "op": "eq", "value": "CONVERTED" }] },
      "denominator": { "dataset": "leads", "measure": { "fn": "count" } },
      "window": { "last": { "n": 90, "unit": "day" }, "includeCurrent": false } },     // default
    { "label": "Projected revenue", "of": 0, "format": "money",
      "numerator":   { "dataset": "deals", "measure": { "fn": "sum", "field": "value" }, "filters": [{ "field": "status", "op": "eq", "value": "WON" }] },
      "denominator": { "dataset": "deals", "measure": { "fn": "count" }, "filters": [{ "field": "status", "op": "eq", "value": "WON" }] } } ] }
```
History = complete buckets only (default day→90 days, week→26 weeks, month→24 months; the series' `dateRange` overrides); leading empty buckets are dropped (stated in warnings). Response:
```json
{ "method": "linear+weekly",
  "history":    [ { "bucket": "2026-07-20", "label": "20 Jul 2026", "value": 4 } ],
  "projection": [ { "bucket": "2026-10-18", "label": "18 Oct 2026", "step": 1, "value": 5.97, "lower": 2.34, "upper": 9.6, "cumulative": 5.97, "cumulativeLower": 2.3, "cumulativeUpper": 9.6 } ],
  "totals": { "history": 578, "projected": 294.49, "lower": 274.36, "upper": 314.61 },
  "historyWindow": { "from": "2026-07-20", "to": "2026-10-17", "points": 90, "human": "20 Jul – 17 Oct 2026" },
  "horizon": { "buckets": 30, "unit": "day", "from": "2026-10-18", "to": "2026-11-16", "human": "18 Oct – 16 Nov 2026" },
  "measure": { "key": "count", "label": "Number of leads", "format": "number" },
  "params": { "intercept": 2.8, "slope": 0.04 }, "holdout": { "size": 18, "mae": { "linear": 2.63, "holt": 2.59, "linear+weekly": 1.59, "holt+weekly": 1.64 } },
  "seasonality": { "detected": true, "strength": 0.514, "indices": [1.6, 1.08, 1.95, 0.66, 0.38, -2.6, -3.06] },
  "derived": [ { "label": "Projected conversions", "rate": 0.17474, "numerator": 101, "denominator": 578, "window": { "label": "previous 90 full days", "human": "20 Jul – 17 Oct 2026" },
                 "projected": 51.46, "lower": 47.94, "upper": 54.98, "format": "number", "explanation": "Projected conversions = projected number of leads × 0.1747 (… 101 ÷ 578)." } ],
  "description": "Number of leads per day: 90 days of history (…), projected 30 days ahead",
  "assumptions": ["Based on the last 90 complete days of history; assumes the recent trend continues.", "Method: …", "…"],
  "warnings": [], "currency": "INR", "timezone": "Asia/Kolkata", "columns": [], "spec": {} }
```

## Forecast rules (`forecast.ts`)
- Candidates: linear least squares, Holt (α 0.05–0.95, β 0.01–0.5 grid on one-step SSE), and each + weekly pattern when daily, ≥ 8 weeks, pattern explains ≥ 20% of de-trended variance.
- Selection: hold out the last ~20% (≤ horizon, ≤ 28, train ≥ 8); lowest MAE wins (must beat the simpler one by > 1%); refit on all history.
- Interval: ±1.96·σ (in-sample residual σ) × horizon factor (OLS prediction-interval formula / ETS(A,A,N) variance) — always widens. Totals: √Σσ² (independence assumed, stated).
- < 8 points → no projection (`method: "none"`, reason in `warnings`); < 14 → linear only + warning. Counts/amounts clamp at 0 (warned).
- Scenario: value × (1+g)^(months elapsed); `baseline` kept per point and in totals.
- Yearly seasonality is never modelled (stated).

## Security model
- Tenancy: `t.org_id = $1` is always the first predicate.
- Areas: a dataset whose module is in `EffectiveLicense.blockedModules` doesn't exist for the org (catalog, query, forecast, AI prompt).
- Records: `scopedWhere(ctx, resource, permission)` from `utils/permissions.ts`, translated to SQL over the dataset's `scopeColumns`; unknown shapes → `FALSE`. Scope `NONE` → dataset absent; `requireAllScope` datasets (payroll runs) need `ALL`; custom modules need a staff role (mirrors their routes).
- Fields: any field whose FieldPermission rule (incl. the sensitive payroll defaults) is `HIDDEN`/`MASKED` for the caller's role is removed from their catalog — it can't be measured, grouped, filtered, listed or offered to the model.
- Values are bind parameters; identifiers come only from the catalog. Read-only transaction, `statement_timeout` (`ANALYTICS_QUERY_TIMEOUT_MS`, default 8000), ≤ 200 groups / ≤ 500 rows / ≤ 800 buckets.

## Widget spec (for "Pin to dashboard")
Every AI answer returns `widgetSpec`; dashboards store it and re-run it as the **viewer** (so a shared dashboard shows each viewer only their data):
```ts
interface WidgetSpec {
  version: 1;
  title: string;
  viz: { type: 'kpi'|'line'|'area'|'bar'|'stacked_bar'|'pie'|'table'|'leaderboard'|'forecast'; x?: string; y: string[]; series?: string };
  query: QuerySpec;                   // POST /api/analytics/query  (relative dates stay relative → live data)
  forecast?: { horizon: number; scenario?: { growthPctPerMonth?: number }; cumulative?: boolean; seasonality?: 'auto'|'none'; derived?: Derived[] };
                                      // when set: POST /api/analytics/forecast { series: query, ...forecast }
  description: string;                // the query in words, as shown under "How this was calculated"
  source: { kind: 'ai_answer' | 'manual'; question?: string };
}
```
`x` / `y` / `series` are column keys of the query result. A dashboard-wide date filter can simply override `query.dateRange`. Client types: `client/src/api/analytics.ts` (`AnalyticsWidgetSpec`, `runAnalyticsQuery`, `runAnalyticsForecast`, `useAnalyticsCatalog`); rendering: `client/src/shared/components/AnalyticsAnswer.tsx` (accepts `onPin`).

## AI answers (`ask.ts`) — `answerQuestion(user, question, { exclude? })`
1. Prompt = rules + the caller's compact catalog (names, enum values; never rows) + examples only for datasets they have. JSON mode, FAST tier, temperature 0. Feature label `dashboard.query`.
2. Plan `{ answerable, title, chart, queries[≤3], forecast?: { horizon, growthPctPerMonth?, cumulative?, derived? }, reason? }` → zod + dry-run compile; one repair call listing the exact errors; else an honest "can't answer — here's what you can ask" (with the permission/area reason when that's why).
3. Execute with the caller's permissions; answer from a deterministic template. Multi-query answers ask the model (`dashboard.queryAnswer`) for 1–2 sentences from aggregated rows; every number must be in the results or the template is used.
4. Cache: validated plan per (org, catalog version, normalised question) in memory + `ai_response_cache` for 7 days; re-validated on read.
Response (`POST /api/ai/query`): `{ status, question, answer, title, chart, results[], forecast, howCalculated[], widgetSpec, available[], warnings[], cached, modelCalls }`. The chat copilot's `query` mode returns `{ type: 'reply', text, analytics }`; team chat (`@ai`, shared threads) excludes payroll datasets.
