/**
 * Analytics query layer (utils/analytics/): dates, catalog resolution
 * (areas, permissions, field redaction), the spec → SQL compiler, forecast
 * maths, answers and AI-plan validation. All pure — no database.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PermCtx, Scope, Access } from '../../src/utils/permissions';
import { STATIC_DATASETS, customModuleDataset } from '../../src/utils/analytics/catalog';
import { resolveCatalog, compileQuery, translateScope, QueryError, type CompileEnv } from '../../src/utils/analytics/compiler';
import { QuerySpecSchema, ForecastSpecSchema, LIMITS } from '../../src/utils/analytics/spec';
import {
  resolveRange, comparisonRange, localToday, bucketStart, enumerateBuckets, addMonths, bucketLabel,
} from '../../src/utils/analytics/dates';
import {
  forecast, linearFit, holtFit, detectWeekly, MIN_POINTS, WARN_POINTS, monthsPerBucket,
} from '../../src/utils/analytics/forecast';
import { checkNumbers, chooseViz, answerFor, buildWidgetSpec, forecastAnswer } from '../../src/utils/analytics/answer';
import { validatePlan, catalogSummary, buildSystemPrompt, normaliseQuestion } from '../../src/utils/analytics/ask';
import type { AnalyticsContext, QueryResult } from '../../src/utils/analytics/executor';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function ctx(role: string, grants: Record<string, Scope>, fieldRules: Record<string, Access> = {}, extra: Partial<PermCtx> = {}): PermCtx {
  return {
    userId: 'u_me', orgId: 'org_1', role, roleKey: role, roleId: null, employeeId: 'e_me', departmentId: 'd_it',
    reportEmployeeIds: [], reportUserIds: [], teamEmployeeIds: [],
    grants: new Map(Object.entries(grants)), fieldRules: new Map(Object.entries(fieldRules)), ...extra,
  };
}
const ALL_READ: Record<string, Scope> = Object.fromEntries([
  'crm.lead.read', 'crm.contact.read', 'crm.account.read', 'crm.deal.read', 'crm.quote.read', 'crm.invoice.read', 'crm.campaign.read', 'crm.activity.read',
  'itdesk.ticket.read', 'itdesk.asset.read', 'itdesk.article.read', 'itdesk.change.read',
  'hr.employee.read', 'hr.attendance.read', 'hr.leave.read', 'hr.payslip.read', 'hr.salary.read', 'core.task.read', 'core.approval.read',
].map(k => [k, 'ALL' as Scope]));
const PAYSLIP_MASKED: Record<string, Access> = Object.fromEntries(
  ['basic', 'hra', 'allowances', 'grossPay', 'netPay', 'pf', 'professionalTax', 'otherDeductions', 'totalDeductions'].map(f => [`payslip.${f}`, 'MASKED' as Access]));
// What every user holds (utils/permissions.ts BASELINE_SELF_GRANTS, reads only).
const BASELINE: Record<string, Scope> = {
  'hr.attendance.read': 'OWN', 'hr.leave.read': 'OWN', 'hr.payslip.read': 'OWN', 'hr.employee.read': 'OWN',
  'core.task.read': 'OWN', 'core.approval.read': 'OWN', 'itdesk.ticket.read': 'OWN', 'itdesk.article.read': 'ALL',
};

const ENV: CompileEnv = { orgId: 'org_1', userId: 'u_me', timezone: 'Asia/Kolkata', today: '2026-10-18', currency: 'INR' };
const admin = () => resolveCatalog(STATIC_DATASETS, { ctx: ctx('SUPER_ADMIN', ALL_READ), blockedModules: [] });
const ds = (cat: ReturnType<typeof admin>, key: string) => {
  const d = cat.find(x => x.def.key === key);
  assert.ok(d, `dataset ${key} missing`);
  return d!;
};
const spec = (s: unknown) => QuerySpecSchema.parse(s);
const compile = (cat: ReturnType<typeof admin>, s: unknown) => { const q = spec(s); return compileQuery(ds(cat, q.dataset), q, ENV); };

// ─── Dates ──────────────────────────────────────────────────────────────────

test('dates: "today" is decided in the org time zone', () => {
  // 20:00 UTC on the 17th is 01:30 on the 18th in India and still the 17th in New York.
  const now = new Date('2026-10-17T20:00:00Z');
  assert.equal(localToday(now, 'Asia/Kolkata'), '2026-10-18');
  assert.equal(localToday(now, 'America/New_York'), '2026-10-17');
  assert.equal(localToday(now, 'Not/AZone'), '2026-10-17'); // invalid → UTC
});

test('dates: presets and "last N" ranges', () => {
  const t = '2026-10-18'; // a Sunday
  assert.deepEqual([resolveRange({ preset: 'yesterday' }, t).from, resolveRange({ preset: 'yesterday' }, t).toExclusive], ['2026-10-17', '2026-10-18']);
  const tm = resolveRange({ preset: 'this_month' }, t);
  assert.deepEqual([tm.from, tm.toExclusive, tm.partial], ['2026-10-01', '2026-10-19', true]);
  const lm = resolveRange({ preset: 'last_month' }, t);
  assert.deepEqual([lm.from, lm.toExclusive, lm.partial], ['2026-09-01', '2026-10-01', false]);
  assert.equal(resolveRange({ preset: 'last_30_days' }, t).from, '2026-09-19');
  const w = resolveRange({ last: { n: 12, unit: 'week' } }, t);
  assert.deepEqual([w.from, w.toExclusive], ['2026-07-27', '2026-10-19']); // 12 Monday-weeks incl. this one
  const m3 = resolveRange({ last: { n: 3, unit: 'month' }, includeCurrent: false }, t);
  assert.deepEqual([m3.from, m3.toExclusive, m3.label], ['2026-07-01', '2026-10-01', 'previous 3 full months']);
  const q = resolveRange({ preset: 'last_quarter' }, t);
  assert.deepEqual([q.from, q.toExclusive], ['2026-07-01', '2026-10-01']);
  assert.throws(() => resolveRange({ from: '2026-10-05', to: '2026-10-01' }, t));
  assert.throws(() => resolveRange({ from: '2026-02-30' }, t));
});

test('dates: comparison periods', () => {
  const t = '2026-10-18';
  const mtd = comparisonRange(resolveRange({ preset: 'this_month' }, t), 'previous_period')!;
  assert.deepEqual([mtd.from, mtd.toExclusive], ['2026-09-01', '2026-09-19']); // same days of last month
  const d30 = comparisonRange(resolveRange({ preset: 'last_30_days' }, t), 'previous_period')!;
  assert.deepEqual([d30.from, d30.toExclusive], ['2026-08-20', '2026-09-19']);
  const m3 = comparisonRange(resolveRange({ last: { n: 3, unit: 'month' }, includeCurrent: false }, t), 'previous_period')!;
  assert.deepEqual([m3.from, m3.toExclusive], ['2026-04-01', '2026-07-01']);
  const py = comparisonRange(resolveRange({ preset: 'last_month' }, t), 'previous_year')!;
  assert.deepEqual([py.from, py.toExclusive], ['2025-09-01', '2025-10-01']);
  assert.equal(comparisonRange(resolveRange({ preset: 'all_time' }, t), 'previous_period'), null);
});

test('dates: buckets', () => {
  assert.equal(bucketStart('2026-10-18', 'week'), '2026-10-12'); // Sunday → Monday
  assert.equal(bucketStart('2026-10-12', 'week'), '2026-10-12');
  assert.equal(bucketStart('2026-11-30', 'quarter'), '2026-10-01');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.deepEqual(enumerateBuckets('2026-07-01', '2026-10-01', 'month'), ['2026-07-01', '2026-08-01', '2026-09-01']);
  assert.equal(enumerateBuckets('2026-07-27', '2026-10-19', 'week').length, 12);
  assert.equal(bucketLabel('2026-10-01', 'quarter'), 'Q4 2026');
});

// ─── Catalog resolution: areas, permissions, redaction ──────────────────────

test('areas: an HR-only org has no CRM or IT Desk datasets', () => {
  const blocked = ['crm', 'sales_docs', 'campaigns', 'itdesk', 'assets', 'knowledge_base', 'customer_portal'];
  const keys = resolveCatalog(STATIC_DATASETS, { ctx: ctx('SUPER_ADMIN', ALL_READ), blockedModules: blocked }).map(d => d.def.key);
  for (const k of ['leads', 'deals', 'contacts', 'invoices', 'quotes', 'campaigns', 'tickets', 'assets', 'csat', 'kb_articles']) assert.ok(!keys.includes(k), k);
  for (const k of ['employees', 'attendance', 'leave_requests', 'payslips', 'tasks', 'approvals']) assert.ok(keys.includes(k), k);
  // Payroll off inside HR: payslips, runs and loans go; attendance stays.
  const noPayroll = resolveCatalog(STATIC_DATASETS, { ctx: ctx('SUPER_ADMIN', ALL_READ), blockedModules: ['payroll'] }).map(d => d.def.key);
  assert.ok(!noPayroll.includes('payslips') && !noPayroll.includes('payroll_runs') && !noPayroll.includes('loans'));
  assert.ok(noPayroll.includes('attendance'));
});

test('permissions: an employee cannot aggregate salaries', () => {
  const cat = resolveCatalog(STATIC_DATASETS, { ctx: ctx('EMPLOYEE', BASELINE, PAYSLIP_MASKED), blockedModules: [] });
  const keys = cat.map(d => d.def.key);
  assert.ok(!keys.includes('loans'), 'no hr.salary.read → no loans');
  assert.ok(!keys.includes('payroll_runs'), 'payroll runs need ALL scope');
  assert.ok(!keys.includes('leads') && !keys.includes('invoices'));
  const payslips = ds(cat, 'payslips');
  for (const f of ['grossPay', 'netPay', 'employerCost', 'employerContributions', 'basic']) {
    assert.ok(!payslips.fields.some(x => x.key === f), `${f} must be hidden`);
    assert.ok(payslips.redactedFields.includes(f));
  }
  assert.throws(() => compile(cat, { dataset: 'payslips', measures: [{ fn: 'sum', field: 'grossPay' }] }), (e: any) => e instanceof QueryError && /isn't available to your role/.test(e.message));
  assert.throws(() => compile(cat, { dataset: 'payslips', filters: [{ field: 'netPay', op: 'gt', value: 1 }] }), QueryError);
  assert.throws(() => compile(cat, { dataset: 'payslips', mode: 'list', fields: ['employee', 'grossPay'] }), QueryError);
  // …while counting their own payslips is fine, and scoped to them.
  const own = compile(cat, { dataset: 'payslips' });
  assert.match(own.sql, /t\.user_id = ANY\(\$\d+::text\[\]\)/);
  assert.ok(own.params.some(p => Array.isArray(p) && (p as string[]).includes('u_me')));
});

test('permissions: an IT manager sees payslip counts but not pay; HR roles see pay', () => {
  const itm = resolveCatalog(STATIC_DATASETS, { ctx: ctx('IT_MANAGER', ALL_READ, PAYSLIP_MASKED), blockedModules: [] });
  assert.ok(!ds(itm, 'payslips').fields.some(f => f.key === 'grossPay'));
  assert.ok(!ds(itm, 'payroll_runs').fields.some(f => f.key === 'totalGross'), 'cross-resource rule payslip.grossPay applies');
  const sql = compile(admin(), { dataset: 'payslips', measures: [{ fn: 'sum', field: 'employerCost' }], dimensions: [{ field: 'department' }] }).sql;
  assert.match(sql, /SUM\(\(t\.gross_pay \+ COALESCE\(t\.employer_contributions, 0\)\)\)/);
});

test('permissions: an IT agent on OWN scope only aggregates their own tickets', () => {
  const cat = resolveCatalog(STATIC_DATASETS, { ctx: ctx('IT_AGENT', { 'itdesk.ticket.read': 'OWN' }), blockedModules: [] });
  assert.deepEqual(cat.map(d => d.def.key).sort(), ['csat', 'tickets']);
  const c = compile(cat, { dataset: 'tickets', dimensions: [{ field: 'assignee' }] });
  assert.match(c.sql, /WHERE t\.org_id = \$1 AND t\.assigned_to = ANY\(\$\d+::text\[\]\)/);
  assert.deepEqual(c.params[0], 'org_1');
  assert.ok(c.params.some(p => JSON.stringify(p) === '["u_me"]'));
  // CSAT ratings are scoped through their ticket.
  assert.match(compile(cat, { dataset: 'csat' }).sql, /jt\.assigned_to = ANY/);
});

test('permissions: TEAM / DEPARTMENT / NONE scopes', () => {
  const team = resolveCatalog(STATIC_DATASETS, { ctx: ctx('CRM_MANAGER', { 'crm.lead.read': 'TEAM' }, {}, { reportUserIds: ['u_rep1', 'u_rep2'] }), blockedModules: [] });
  const c = compile(team, { dataset: 'leads' });
  assert.ok(c.params.some(p => JSON.stringify(p) === '["u_me","u_rep1","u_rep2"]'));
  const dept = resolveCatalog(STATIC_DATASETS, { ctx: ctx('HR', { 'hr.employee.read': 'DEPARTMENT' }), blockedModules: [] });
  const e = compile(dept, { dataset: 'employees' });
  assert.match(e.sql, /t\.department_id = \$2/);
  assert.equal(e.params[1], 'd_it');
  const none = resolveCatalog(STATIC_DATASETS, { ctx: ctx('X', { 'crm.lead.read': 'NONE' }), blockedModules: [] });
  assert.ok(!none.some(d => d.def.key === 'leads'));
});

test('permissions: unknown scope shapes fail closed', () => {
  const p = { values: [] as unknown[], add(v: unknown) { this.values.push(v); return `$${this.values.length}`; } };
  assert.equal(translateScope({}, {}, p), '');
  assert.equal(translateScope({ id: '__no_access__' }, { id: 't.id' }, p), 'FALSE');
  assert.equal(translateScope({ somethingElse: { in: ['a'] } }, { assignedTo: 't.assigned_to' }, p), 'FALSE');
  assert.equal(translateScope({ assignedTo: { notIn: ['a'] } }, { assignedTo: 't.assigned_to' }, p), 'FALSE');
  assert.equal(translateScope({ OR: [{ assignedTo: { in: ['a'] } }, { x: 1 }] }, { assignedTo: 't.assigned_to' }, p), '(t.assigned_to = ANY($1::text[]) OR FALSE)');
});

test('custom roles: datasets follow role lists (custom modules = staff only)', () => {
  const mod = customModuleDataset({
    id: 'mod_1', name: 'Vehicles', slug: 'vehicles', fields: [
      { fieldKey: 'price', label: 'Price', fieldType: 'CURRENCY' },
      { fieldKey: 'bad key"; DROP', label: 'Evil', fieldType: 'TEXT' },
      { fieldKey: 'fuel', label: 'Fuel', fieldType: 'DROPDOWN', options: ['Petrol', 'EV'] },
      { fieldKey: 'sold_on', label: 'Sold on', fieldType: 'DATE' },
    ],
  });
  assert.equal(mod.key, 'custom_vehicles');
  assert.ok(!mod.fields.some(f => f.label === 'Evil'), 'unsafe field keys are skipped');
  const staff = resolveCatalog([mod], { ctx: ctx('SALES_REP', {}), blockedModules: [] });
  assert.equal(staff.length, 1);
  assert.equal(resolveCatalog([mod], { ctx: ctx('EMPLOYEE', BASELINE), blockedModules: [] }).length, 0);
  const c = compileQuery(staff[0], spec({ dataset: 'custom_vehicles', measures: [{ fn: 'sum', field: 'f_price' }], dimensions: [{ field: 'f_fuel' }] }), ENV);
  assert.match(c.sql, /t\.module_id = \$2/);
  assert.equal(c.params[1], 'mod_1');
  assert.match(c.sql, /CASE WHEN \(t\.data->>'price'\) ~ /, 'numbers are cast safely');
  assert.throws(() => compileQuery(staff[0], spec({ dataset: 'custom_vehicles', filters: [{ field: 'f_fuel', op: 'eq', value: 'Diesel' }] }), ENV), /isn't a valid Fuel/);
});

// ─── Compiler ───────────────────────────────────────────────────────────────

test('compiler: every dataset compiles in list, total and bucketed form', () => {
  const cat = admin();
  for (const d of cat) {
    for (const s of [
      { dataset: d.def.key },
      { dataset: d.def.key, mode: 'list', limit: 5 },
      { dataset: d.def.key, dimensions: [{ field: d.def.defaultDate, bucket: 'month' }], dateRange: { preset: 'this_year' } },
    ]) {
      const c = compile(cat, s);
      assert.match(c.sql, /^SELECT /);
      assert.match(c.sql, new RegExp(`FROM ${d.def.table} t`));
      assert.match(c.sql, /WHERE t\.org_id = \$1/, `${d.def.key} must be org scoped`);
      // Postgres rejects unreferenced parameters: every $n must appear.
      c.params.forEach((_, i) => assert.ok(c.sql.includes(`$${i + 1}`), `${d.def.key}: $${i + 1} unused`));
    }
  }
});

test('compiler: time zones — TIMESTAMP columns bucket and filter in org time, DATE columns do not shift', () => {
  const c = compile(admin(), { dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'week' }], dateRange: { last: { n: 12, unit: 'week' } } });
  assert.match(c.sql, /date_trunc\('week', \(\(t\.created_at\) AT TIME ZONE 'UTC'\) AT TIME ZONE \$\d+::text\)/);
  assert.match(c.sql, /t\.created_at >= \(\(\$\d+::timestamp AT TIME ZONE \$\d+::text\) AT TIME ZONE 'UTC'\)/);
  assert.ok(c.params.includes('Asia/Kolkata') && c.params.includes('2026-07-27') && c.params.includes('2026-10-19'));
  assert.equal(c.bucket?.unit, 'week');
  const a = compile(admin(), { dataset: 'attendance', mode: 'list', dateRange: { preset: 'yesterday' } });
  assert.match(a.sql, /t\.date >= \$\d+::date AND t\.date < \$\d+::date/);
  assert.ok(!a.params.includes('Asia/Kolkata'), 'no time-zone parameter for DATE-only queries');
  // Due dates are calendar dates saved as UTC midnight — read as dates, never shifted.
  assert.match(compile(admin(), { dataset: 'invoices', dimensions: [{ field: 'dueDate', bucket: 'month' }] }).sql, /\(t\.due_date\)::date/);
});

test('compiler: values are always bound, never spliced into SQL', () => {
  const evil = "x'); DROP TABLE users; --";
  const c = compile(admin(), {
    dataset: 'tickets', mode: 'list',
    filters: [{ field: 'title', op: 'contains', value: evil }, { field: 'assignee', op: 'eq', value: evil }],
  });
  assert.ok(!c.sql.includes('DROP TABLE'));
  assert.ok(c.params.some(p => String(p).includes('DROP TABLE')));
  assert.ok(c.params.includes(`%x'); DROP TABLE users; --%`), 'LIKE wildcards in values are escaped but the text is a parameter');
  assert.throws(() => compile(admin(), { dataset: 'tickets', dimensions: [{ field: 'status; DROP' }] }), QueryError);
  assert.throws(() => compile(admin(), { dataset: 'users' }), /Unknown dataset|dataset users missing/);
  assert.throws(() => compile(admin(), { dataset: 'tickets', sort: { by: '1; DROP', dir: 'desc' } }), QueryError);
});

test('compiler: filters by type', () => {
  const cat = admin();
  const money = compile(cat, { dataset: 'invoices', mode: 'list', filters: [{ field: 'total', op: 'gt', value: '₹50,000' }, { field: 'isOverdue', op: 'eq', value: true }] });
  assert.ok(money.params.includes(50000));
  assert.deepEqual(money.appliedFilters, ['Total (incl. tax) over ₹50,000', 'Overdue: yes']);
  assert.throws(() => compile(cat, { dataset: 'tickets', filters: [{ field: 'status', op: 'eq', value: 'WAITING' }] }), /isn't a valid Status/);
  const en = compile(cat, { dataset: 'tickets', filters: [{ field: 'status', op: 'in', value: ['resolved', 'in progress'] }] });
  assert.ok(en.params.some(p => JSON.stringify(p) === '["RESOLVED","IN_PROGRESS"]'), 'enum values are normalised');
  const me = compile(cat, { dataset: 'tickets', filters: [{ field: 'assignee', op: 'eq', value: 'me' }] });
  assert.ok(me.params.some(p => JSON.stringify(p) === '["u_me"]'));
  assert.throws(() => compile(cat, { dataset: 'leads', filters: [{ field: 'createdAt', op: 'contains', value: 'x' }] }), QueryError);
  assert.throws(() => compile(cat, { dataset: 'deals', measures: [{ fn: 'sum', field: 'stage' }] }), /isn't a number/);
  assert.throws(() => compile(cat, { dataset: 'csat', measures: [{ fn: 'sum', field: 'rating' }] }), /isn't meaningful/);
  assert.throws(() => compile(cat, { dataset: 'leads', dimensions: [{ field: 'createdAt' }] }), /bucket/);
});

test('compiler: limits and defaults', () => {
  const cat = admin();
  assert.throws(() => QuerySpecSchema.parse({ dataset: 'leads', limit: LIMITS.maxRows + 1 }));
  assert.throws(() => QuerySpecSchema.parse({ dataset: 'leads', dimensions: [{ field: 'a' }, { field: 'b' }, { field: 'c' }] }));
  assert.throws(() => compile(cat, { dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'day' }], dateRange: { from: '2020-01-01', to: '2026-10-18' } }), /buckets/);
  const top = compile(cat, { dataset: 'tickets', dimensions: [{ field: 'assignee' }], sort: { by: 'count', dir: 'desc' }, limit: 5 });
  assert.match(top.sql, /ORDER BY "count" DESC NULLS LAST, "assignee" ASC\nLIMIT 6$/, 'one extra row detects truncation');
  const series = compile(cat, { dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'week' }] });
  assert.match(series.warnings[0], /No period was given/);
  assert.equal(series.range.label, 'last 12 weeks');
  assert.match(series.description, /^Number of leads per week — last 12 weeks \(27 Jul – 18 Oct 2026\)$/);
  const list = compile(cat, { dataset: 'invoices', mode: 'list' });
  assert.match(list.sql, /LIMIT 51$/);
});

// ─── Forecast ───────────────────────────────────────────────────────────────

const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

test('forecast: a perfect line is projected exactly, with a zero-width band', () => {
  const y = series(30, i => 3 + 2 * i);
  const fit = linearFit(y);
  assert.ok(Math.abs(fit.a - 3) < 1e-9 && Math.abs(fit.b - 2) < 1e-9);
  const r = forecast(y, { horizon: 5, unit: 'day' });
  assert.deepEqual(r.projection.map(p => p.value), [63, 65, 67, 69, 71]);
  assert.equal(r.method, 'linear');
  assert.equal(r.totals!.projected, 335);
  assert.ok(r.warnings.some(w => /fits the trend exactly/.test(w)));
});

test('forecast: Holt tracks a line and a constant', () => {
  const h = holtFit(series(40, i => 10 + 0.5 * i));
  assert.ok(Math.abs(h.trend - 0.5) < 0.05, `trend ${h.trend}`);
  const flat = forecast(series(30, () => 7), { horizon: 10, unit: 'day' });
  assert.ok(flat.projection.every(p => Math.abs(p.value - 7) < 1e-6));
});

test('forecast: minimum history — refuse under 8 points, warn under 14', () => {
  const r = forecast([1, 2, 3, 4, 5], { horizon: 3, unit: 'week' });
  assert.equal(r.method, 'none');
  assert.equal(r.projection.length, 0);
  assert.equal(r.totals, null);
  assert.match(r.warnings[0], /at least 8 are needed/);
  const short = forecast(series(10, i => i + (i % 2)), { horizon: 3, unit: 'week' });
  assert.equal(short.method, 'linear');
  assert.ok(short.warnings.some(w => /fewer than 14/.test(w)));
  assert.equal(MIN_POINTS, 8); assert.equal(WARN_POINTS, 14);
});

test('forecast: intervals widen with the horizon', () => {
  const y = series(60, i => 20 + 0.3 * i + ((i * 7919) % 11) - 5);
  for (const unit of ['day', 'week'] as const) {
    const r = forecast(y, { horizon: 20, unit, seasonality: 'none' });
    const widths = r.projection.map(p => p.upper - p.lower);
    for (let i = 1; i < widths.length; i++) assert.ok(widths[i] >= widths[i - 1] - 1e-9, `${unit}: band shrank at ${i}`);
    assert.ok(widths[19] > widths[0]);
  }
});

test('forecast: weekly seasonality is detected and chosen by holdout when real', () => {
  const pattern = [8, 7, 7, 6, 5, 1, 0];
  const y = series(84, i => 10 + 0.05 * i + pattern[i % 7]);
  const s = detectWeekly(y, 'day');
  assert.ok(s.detected && s.strength > 0.9);
  const r = forecast(y, { horizon: 14, unit: 'day' });
  assert.ok(r.method.endsWith('+weekly'), r.method);
  assert.ok(r.holdout && r.holdout.size > 0);
  // The projection keeps the weekly shape: day 85 is position 0 (high), day 89 is position 5 (low).
  assert.ok(r.projection[0].value > r.projection[5].value + 5);
  // Too little daily history, or weekly data → no weekly pattern.
  assert.equal(detectWeekly(y.slice(0, 50), 'day').detected, false);
  assert.equal(detectWeekly(y, 'week').detected, false);
  const noise = series(84, i => 10 + ((i * 7919) % 13));
  assert.equal(detectWeekly(noise, 'day').detected, false);
});

test('forecast: what-if growth scenario and cumulative totals', () => {
  const y = series(30, () => 10);
  const r = forecast(y, { horizon: 30, unit: 'day', growthPctPerMonth: 10, cumulative: true });
  const last = r.projection[29];
  assert.equal(last.baseline, 10);
  assert.ok(Math.abs(last.value - 10 * 1.1 ** (30 * monthsPerBucket('day'))) < 0.01);
  assert.ok(Math.abs(r.projection[29].cumulative! - r.totals!.projected) < 0.02);
  assert.equal(r.totals!.baselineProjected, 300);
  assert.ok(r.totals!.projected > 300);
  for (let i = 1; i < 30; i++) assert.ok(r.projection[i].cumulative! >= r.projection[i - 1].cumulative!);
  assert.ok(r.assumptions.some(a => /\+10% per month/.test(a)));
  const monthly = forecast(series(24, () => 100), { horizon: 2, unit: 'month', growthPctPerMonth: 10 });
  assert.deepEqual(monthly.projection.map(p => p.value), [110, 121]);
});

test('forecast: counts never go negative', () => {
  const r = forecast(series(20, i => 40 - 2 * i), { horizon: 30, unit: 'day' });
  assert.ok(r.projection.every(p => p.value >= 0 && p.lower >= 0));
  assert.ok(r.warnings.some(w => /reaches zero/.test(w)));
});

test('forecast spec: horizon and derived limits are validated', () => {
  const base = { series: { dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'day' }] } };
  assert.ok(ForecastSpecSchema.safeParse({ ...base, horizon: 30 }).success);
  assert.ok(!ForecastSpecSchema.safeParse({ ...base, horizon: 0 }).success);
  assert.ok(!ForecastSpecSchema.safeParse({ ...base, horizon: 1000 }).success);
});

// ─── Answers & widgets ──────────────────────────────────────────────────────

function result(over: Partial<QueryResult['meta']>, columns: QueryResult['columns'], rows: Record<string, unknown>[]): QueryResult {
  return {
    columns, rows,
    meta: {
      dataset: { key: 'tickets', label: 'Tickets' }, description: 'd', kind: 'aggregate',
      range: { from: '2026-10-01', to: '2026-10-18', label: 'this month', human: '1 – 18 Oct 2026', field: 'resolvedAt', partial: true },
      bucket: null, appliedFilters: [], scope: 'ALL', totals: {}, comparison: null, rowCount: rows.length, truncated: false,
      currency: 'INR', timezone: 'Asia/Kolkata', warnings: [], spec: QuerySpecSchema.parse({ dataset: 'tickets' }), ...over,
    },
  };
}

test('answers: templates use only the returned numbers, formatted in the org currency', () => {
  const top = result({ totals: { count: 30 }, spec: QuerySpecSchema.parse({ dataset: 'tickets', limit: 5 }) },
    [{ key: 'assignee', label: 'Assignee', role: 'dimension', format: 'text' }, { key: 'count', label: 'Number of tickets', role: 'measure', format: 'number' }],
    [{ assignee: 'Dave Desk', count: 17 }, { assignee: 'IT Ops', count: 13 }]);
  const a = answerFor(top);
  assert.match(a, /^Top 2 by number of tickets this month \(1 – 18 Oct 2026\): Dave Desk 17, IT Ops 13 \(total 30\)\.$/);
  assert.ok(checkNumbers(a, [17, 13, 30]).ok);
  const kpi = result({ totals: { sum_value: 5000000 }, comparison: { label: 'previous period', human: '1 – 18 Sep 2026', range: { from: null, to: null }, totals: { sum_value: 4000000 }, change: { sum_value: { abs: 1000000, pct: 25 } } } },
    [{ key: 'sum_value', label: 'Total deal value', role: 'measure', format: 'money' }], [{ sum_value: 5000000 }]);
  assert.match(answerFor(kpi), /₹50,00,000 — up 25% from ₹40,00,000/);
  const list = result({ kind: 'list', appliedFilters: ['Status is Absent'] },
    [{ key: 'employee', label: 'Employee', role: 'field', format: 'text' }, { key: 'status', label: 'Status', role: 'field', format: 'enum' }],
    []);
  assert.match(answerFor(list), /^No tickets found \(Status is Absent, this month/);
});

test('answers: model-written numbers must exist in the data', () => {
  assert.ok(checkNumbers('Leads rose to 1,234 from 1,000 (up 23.4%) over the last 12 weeks in 2026.', [1234, 1000, 23.4]).ok);
  const bad = checkNumbers('You had 987654 leads.', [150, 125]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, ['987654']);
});

test('widgets: chart choice follows the result shape; widget spec is re-runnable', () => {
  const cols = [{ key: 'createdAt_week', label: 'Week', role: 'dimension' as const, format: 'date' as const, bucket: 'week' as const }, { key: 'count', label: 'Number of leads', role: 'measure' as const, format: 'number' as const }];
  const ser = result({ bucket: { key: 'createdAt_week', unit: 'week' }, spec: QuerySpecSchema.parse({ dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'week' }] }) }, cols, [{ createdAt_week: '2026-10-12', count: 5 }]);
  assert.equal(chooseViz(ser, 'pie'), 'line', 'a time series is never a pie');
  assert.equal(chooseViz(ser, 'bar'), 'bar');
  assert.equal(chooseViz({ ...ser, columns: [cols[1]] } as any, 'line'), 'kpi');
  const w = buildWidgetSpec({ title: 'Leads per week', result: ser, viz: 'line', question: 'q' });
  assert.deepEqual(w.viz, { type: 'line', x: 'createdAt_week', y: ['count'] });
  assert.equal(w.version, 1);
  assert.equal(w.query.dataset, 'leads');
  assert.ok(QuerySpecSchema.safeParse(w.query).success);
});

test('answers: forecast refusal is honest', () => {
  const txt = forecastAnswer({ method: 'none', totals: null, warnings: ['Not enough history to project: 5 days of data.'] } as any);
  assert.match(txt, /^I can't project this honestly: Not enough history/);
});

// ─── AI plan validation ─────────────────────────────────────────────────────

function actxFor(c: PermCtx, blocked: string[] = []): AnalyticsContext {
  const catalog = resolveCatalog(STATIC_DATASETS, { ctx: c, blockedModules: blocked });
  return { user: { id: c.userId, orgId: c.orgId, role: c.role }, ctx: c, catalog, env: ENV, currency: 'INR', blockedModules: blocked, catalogVersion: 'v' };
}

test('ai plan: valid plans pass, invented fields and datasets are rejected with reasons', () => {
  const a = actxFor(ctx('SUPER_ADMIN', ALL_READ));
  const ok = validatePlan(a, { answerable: true, title: 'Leads per week', chart: 'line', queries: [{ dataset: 'leads', measures: [{ fn: 'count' }], dimensions: [{ field: 'createdAt', bucket: 'week' }], dateRange: { field: 'createdAt', last: { n: 12, unit: 'week' } }, filters: null, sort: null }], forecast: null });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.plan!.queries[0].dataset, 'leads');
  const bad = validatePlan(a, { answerable: true, queries: [{ dataset: 'tickets', dimensions: [{ field: 'mood' }] }] });
  assert.equal(bad.plan, null);
  assert.match(bad.errors[0], /Unknown field "mood"/);
  assert.match(validatePlan(a, { answerable: true, queries: [{ dataset: 'salaries' }] }).errors[0], /Unknown dataset/);
  assert.match(validatePlan(a, 'nope').errors[0], /not a JSON object/);
  const no = validatePlan(a, { answerable: false, reason: 'Weather is not business data' });
  assert.equal(no.plan!.answerable, false);
});

test('ai plan: forecasts need a bucketed series; derived datasets must be accessible', () => {
  const a = actxFor(ctx('SUPER_ADMIN', ALL_READ));
  const good = validatePlan(a, { answerable: true, queries: [{ dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'day' }] }], forecast: { horizon: 30 } });
  assert.equal(good.errors.length, 0);
  assert.equal(good.plan!.forecast!.horizon, 30);
  const flat = validatePlan(a, { answerable: true, queries: [{ dataset: 'leads' }], forecast: { horizon: 30 } });
  assert.match(flat.errors[0], /one dimension with a bucket/);
  const sales = actxFor(ctx('SALES_REP', { 'crm.lead.read': 'ALL' }));
  const derived = validatePlan(sales, { answerable: true, queries: [{ dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'day' }] }], forecast: { horizon: 30, derived: [{ label: 'Revenue', numerator: { dataset: 'deals', measure: { fn: 'count' } }, denominator: { dataset: 'leads', measure: { fn: 'count' } } }] } });
  assert.match(derived.errors.join(' '), /deals/i);
});

test('ai prompt: only the caller\'s catalog, no redacted fields, no switched-off areas', () => {
  const hrOnly = actxFor(ctx('IT_MANAGER', ALL_READ, PAYSLIP_MASKED), ['crm', 'sales_docs', 'campaigns', 'itdesk', 'assets', 'knowledge_base']);
  const sum = catalogSummary(hrOnly.catalog);
  assert.ok(!/- leads:|- tickets:|- invoices:/.test(sum));
  assert.ok(/- attendance:/.test(sum));
  assert.ok(!/grossPay|netPay|employerCost/.test(sum), 'masked pay fields are never offered to the model');
  const prompt = buildSystemPrompt(hrOnly);
  assert.ok(!/"dataset":"leads"/.test(prompt), 'examples for unavailable datasets are left out');
  assert.match(prompt, /Today is 2026-10-18 \(Sunday\), time zone Asia\/Kolkata; money is in INR/);
  assert.equal(normaliseQuestion('  How many LEADS did we get?? '), 'how many leads did we get');
});
