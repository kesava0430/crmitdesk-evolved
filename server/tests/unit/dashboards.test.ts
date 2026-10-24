/**
 * Dashboards (utils/dashboards/): sharing rules, widget-spec validation,
 * layout normalisation, viewer-scoped availability, the dashboard date range,
 * and AI proposal validation + repair. All pure — no database.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import type { PermCtx, Scope, Access } from '../../src/utils/permissions';
import { PERMISSION_CATALOG } from '../../src/utils/permissions';
import { STATIC_DATASETS } from '../../src/utils/analytics/catalog';
import { resolveCatalog, type CompileEnv } from '../../src/utils/analytics/compiler';
import { derivedExplanation } from '../../src/utils/analytics/executor';
import { dashboardAccess, visibleWhere, type DashboardViewer, type DashboardShareInfo } from '../../src/utils/dashboards/access';
import {
  parseWidgetSpec, validateWidget, vizProblem, widgetAvailability, applyDashboardRange, usesRelativeRange,
  normaliseWidgetSpec, isAccessError, DashboardRangeSchema, type DataWidgetSpec,
} from '../../src/utils/dashboards/widget';
import { normaliseLayout, overlaps, readingOrder, defaultSize, GRID_COLS } from '../../src/utils/dashboards/layout';
import { checkProposal, salvage, convertModelWidget, parseKpi, widgetToModel, buildProposalPrompt, MAX_WIDGETS } from '../../src/utils/dashboards/propose';
import type { AnalyticsContext } from '../../src/utils/analytics/executor';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function ctx(role: string, grants: Record<string, Scope>, fieldRules: Record<string, Access> = {}): PermCtx {
  return {
    userId: 'u_me', orgId: 'org_1', role, roleKey: role, roleId: null, employeeId: 'e_me', departmentId: 'd_it',
    reportEmployeeIds: [], reportUserIds: [], teamEmployeeIds: [],
    grants: new Map(Object.entries(grants)), fieldRules: new Map(Object.entries(fieldRules)),
  };
}
const ALL_READ: Record<string, Scope> = Object.fromEntries([
  'crm.lead.read', 'crm.contact.read', 'crm.account.read', 'crm.deal.read', 'crm.quote.read', 'crm.invoice.read', 'crm.campaign.read', 'crm.activity.read',
  'itdesk.ticket.read', 'itdesk.asset.read', 'itdesk.article.read', 'itdesk.change.read',
  'hr.employee.read', 'hr.attendance.read', 'hr.leave.read', 'hr.payslip.read', 'core.task.read', 'core.approval.read',
].map(k => [k, 'ALL' as Scope]));
const BASELINE: Record<string, Scope> = {
  'hr.attendance.read': 'OWN', 'hr.leave.read': 'OWN', 'hr.payslip.read': 'OWN', 'hr.employee.read': 'OWN',
  'core.task.read': 'OWN', 'core.approval.read': 'OWN', 'itdesk.ticket.read': 'OWN', 'itdesk.article.read': 'ALL',
};
const PAYSLIP_MASKED: Record<string, Access> = Object.fromEntries(
  ['basic', 'grossPay', 'netPay', 'pf', 'totalDeductions'].map(f => [`payslip.${f}`, 'MASKED' as Access]));
const ENV: CompileEnv = { orgId: 'org_1', userId: 'u_me', timezone: 'Asia/Kolkata', today: '2026-10-18', currency: 'INR' };

const adminCat = () => resolveCatalog(STATIC_DATASETS, { ctx: ctx('SUPER_ADMIN', ALL_READ), blockedModules: [] });
const employeeCat = () => resolveCatalog(STATIC_DATASETS, { ctx: ctx('EMPLOYEE', BASELINE, PAYSLIP_MASKED), blockedModules: [] });
const itAgentCat = () => resolveCatalog(STATIC_DATASETS, {
  ctx: ctx('IT_AGENT', { ...BASELINE, 'itdesk.ticket.read': 'ALL', 'itdesk.asset.read': 'ALL', 'itdesk.change.read': 'ALL' }, PAYSLIP_MASKED), blockedModules: [],
});
const HR_ONLY_BLOCKED = ['crm', 'sales_docs', 'campaigns', 'itdesk', 'assets', 'knowledge_base', 'customer_portal'];
const hrOnlyAdminCat = () => resolveCatalog(STATIC_DATASETS, { ctx: ctx('SUPER_ADMIN', ALL_READ), blockedModules: HR_ONLY_BLOCKED });

const leadsKpi = {
  title: 'Leads — last 30 days', viz: { type: 'kpi', y: ['count'] },
  query: { dataset: 'leads', measures: [{ fn: 'count' }], dateRange: { field: 'createdAt', preset: 'last_30_days' }, compare: 'previous_period' },
  description: 'Number of leads — last 30 days', source: { kind: 'ai_answer', question: 'leads last 30 days?' },
};
const LEAD_SERIES = { dataset: 'leads', measures: [{ fn: 'count' }], dimensions: [{ field: 'createdAt', bucket: 'day' }] };
const LEAD_FORECAST = {
  horizon: 30, cumulative: true,
  derived: [
    { label: 'Projected conversions', numerator: { dataset: 'leads', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'CONVERTED' }] }, denominator: { dataset: 'leads', measure: { fn: 'count' } } },
    { label: 'Projected revenue', numerator: { dataset: 'deals', measure: { fn: 'sum', field: 'value' }, filters: [{ field: 'status', op: 'eq', value: 'WON' }] }, denominator: { dataset: 'deals', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'WON' }] }, of: 0, format: 'money' },
  ],
};

// ─── Sharing rules ──────────────────────────────────────────────────────────

const viewer = (o: Partial<DashboardViewer> = {}): DashboardViewer => ({ id: 'u_me', orgId: 'org_1', role: 'SALES_REP', roleId: 'role_sales', canManage: false, ...o });
const dash = (o: Partial<DashboardShareInfo> = {}): DashboardShareInfo => ({ orgId: 'org_1', ownerId: 'u_owner', visibility: 'PRIVATE', roleIds: [], legacyRoles: [], ...o });

test('access: the owner can do everything with their dashboard', () => {
  const a = dashboardAccess(viewer(), dash({ ownerId: 'u_me' }));
  assert.deepEqual(a, { view: true, edit: true, share: true, delete: true, duplicate: true, isOwner: true });
});

test('access: a private dashboard is invisible to everyone else — admins included', () => {
  assert.equal(dashboardAccess(viewer(), dash()).view, false);
  assert.equal(dashboardAccess(viewer({ role: 'SUPER_ADMIN', canManage: true }), dash()).view, false);
});

test('access: ORG dashboards are read-only for others unless they manage dashboards', () => {
  const a = dashboardAccess(viewer(), dash({ visibility: 'ORG' }));
  assert.equal(a.view, true); assert.equal(a.edit, false); assert.equal(a.delete, false); assert.equal(a.share, false); assert.equal(a.duplicate, true);
  const m = dashboardAccess(viewer({ role: 'CRM_MANAGER', canManage: true }), dash({ visibility: 'ORG' }));
  assert.equal(m.edit, true); assert.equal(m.delete, true); assert.equal(m.isOwner, false);
});

test('access: ROLES dashboards match the Role row or the legacy role', () => {
  const d = dash({ visibility: 'ROLES', roleIds: ['role_sales'], legacyRoles: ['IT_AGENT'] });
  assert.equal(dashboardAccess(viewer(), d).view, true, 'by Role id');
  assert.equal(dashboardAccess(viewer({ role: 'IT_AGENT', roleId: null }), d).view, true, 'by legacy role');
  assert.equal(dashboardAccess(viewer({ role: 'EMPLOYEE', roleId: 'role_emp' }), d).view, false);
  // Super Admins see (and manage) every shared dashboard.
  const admin = dashboardAccess(viewer({ role: 'SUPER_ADMIN', roleId: null, canManage: false }), d);
  assert.equal(admin.view, true); assert.equal(admin.edit, true);
});

test('access: never across organisations', () => {
  assert.equal(dashboardAccess(viewer({ orgId: 'org_2' }), dash({ visibility: 'ORG' })).view, false);
  assert.equal(dashboardAccess(viewer({ orgId: 'org_2', id: 'u_owner' }), dash({ visibility: 'ORG' })).view, false);
});

test('access: the list query mirrors the rules', () => {
  const w = visibleWhere(viewer()) as any;
  assert.equal(w.orgId, 'org_1');
  assert.deepEqual(w.OR, [{ ownerId: 'u_me' }, { visibility: 'ORG' }, { visibility: 'ROLES', legacyRoles: { has: 'SALES_REP' } }, { visibility: 'ROLES', roleIds: { has: 'role_sales' } }]);
  const a = visibleWhere(viewer({ role: 'SUPER_ADMIN', roleId: null })) as any;
  assert.deepEqual(a.OR, [{ ownerId: 'u_me' }, { visibility: 'ORG' }, { visibility: 'ROLES' }]);
  assert.ok(!JSON.stringify(a).includes('PRIVATE'));
});

test('access: core.dashboard.manage is in the permission catalog', () => {
  assert.ok(PERMISSION_CATALOG.some(p => p.key === 'core.dashboard.manage' && p.module === 'core'));
});

// ─── Widget specs ───────────────────────────────────────────────────────────

test('widget: a pinned AI answer (no kind) parses as a data widget and viz keys follow the query', () => {
  const { spec, errors } = parseWidgetSpec({
    version: 1, title: 'Leads per week', viz: { type: 'line', x: 'wrong', y: ['nope'] },
    query: { dataset: 'leads', measures: [{ fn: 'count' }], dimensions: [{ field: 'createdAt', bucket: 'week' }] }, description: '', source: { kind: 'ai_answer' },
  });
  assert.deepEqual(errors, []);
  assert.equal(spec!.kind, 'data');
  assert.equal((spec as DataWidgetSpec).viz.x, 'createdAt_week');
  assert.deepEqual((spec as DataWidgetSpec).viz.y, ['count']);
});

test('widget: schema rejects junk (unknown viz, SQL-ish keys, missing title)', () => {
  assert.ok(parseWidgetSpec({ title: 'x', viz: { type: 'radar' }, query: { dataset: 'leads' } }).errors.length);
  assert.ok(parseWidgetSpec({ viz: { type: 'kpi' }, query: { dataset: 'leads' } }).errors.length);
  assert.ok(parseWidgetSpec({ kind: 'note', title: 'n', text: 'x'.repeat(5000) }).errors.length);
  assert.ok(parseWidgetSpec('DROP TABLE users').errors.length);
});

test('widget: viz must fit the query', () => {
  const mk = (type: string, query: object, extra: object = {}) => parseWidgetSpec({ title: 't', viz: { type }, query, ...extra }).spec as DataWidgetSpec;
  assert.match(vizProblem(mk('line', { dataset: 'leads', dimensions: [{ field: 'status' }] }))!, /bucket/);
  assert.match(vizProblem(mk('kpi', { dataset: 'leads', dimensions: [{ field: 'status' }] }))!, /group-by/);
  assert.match(vizProblem(mk('pie', { dataset: 'leads' }))!, /group-by/);
  assert.match(vizProblem(mk('bar', { dataset: 'leads', mode: 'list' }))!, /table/);
  assert.match(vizProblem(mk('forecast', LEAD_SERIES))!, /forecast/);
  assert.equal(vizProblem(mk('forecast', LEAD_SERIES, { forecast: LEAD_FORECAST })), null);
  assert.equal(vizProblem(mk('kpi', LEAD_SERIES, { forecast: LEAD_FORECAST, options: { kpi: { value: 'derived', derived: 1 } } })), null);
  assert.match(vizProblem(mk('kpi', LEAD_SERIES, { options: { kpi: { value: 'projected' } } }))!, /needs a forecast/);
  assert.equal(vizProblem(mk('funnel', { dataset: 'leads', dimensions: [{ field: 'status' }] })), null);
  assert.equal(vizProblem(mk('stacked_bar', { dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'week' }, { field: 'status' }] })), null);
});

test('widget: validated against the viewer catalog (dry-run compile)', () => {
  const c = { catalog: adminCat(), env: ENV };
  assert.ok(validateWidget(c, leadsKpi).spec);
  const bad = validateWidget(c, { ...leadsKpi, query: { ...leadsKpi.query, filters: [{ field: 'status', op: 'eq', value: 'WONDERFUL' }] } });
  assert.equal(bad.spec, null); assert.match(bad.errors.join(), /valid Status/);
  const unknown = validateWidget(c, { ...leadsKpi, query: { dataset: 'unicorns' } });
  assert.match(unknown.errors.join(), /not available/);
  // An employee can't save a payroll widget using masked pay fields.
  const pay = { title: 'Gross pay', viz: { type: 'kpi' }, query: { dataset: 'payslips', measures: [{ fn: 'sum', field: 'grossPay' }] } };
  assert.ok(validateWidget(c, pay).spec, 'admin may');
  assert.match(validateWidget({ catalog: employeeCat(), env: ENV }, pay).errors.join(), /isn't available to your role/);
  // Forecast derived index must exist.
  const k = { title: 'x', viz: { type: 'kpi' }, query: LEAD_SERIES, forecast: LEAD_FORECAST, options: { kpi: { value: 'derived', derived: 3 } } };
  assert.match(validateWidget(c, k).errors.join(), /derived must be the index/);
});

test('widget: notes need text or a forecast to explain', () => {
  const c = { catalog: adminCat(), env: ENV };
  assert.match(validateWidget(c, { kind: 'note', title: 'Empty' }).errors.join(), /needs text/);
  assert.ok(validateWidget(c, { kind: 'note', title: 'Hi', text: 'Weekly review board' }).spec);
  assert.ok(validateWidget(c, { kind: 'note', title: 'How', methodOf: { query: LEAD_SERIES, forecast: LEAD_FORECAST } }).spec);
});

// ─── Viewer-scoped availability ─────────────────────────────────────────────

test('availability: an employee sees CRM widgets as "not available", never an error', () => {
  const s = parseWidgetSpec(leadsKpi).spec!;
  assert.deepEqual(widgetAvailability(adminCat(), s, STATIC_DATASETS, []), { ok: true });
  const r = widgetAvailability(employeeCat(), s, STATIC_DATASETS, []);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /leads, which your role doesn't have access to/);
});

test('availability: an IT agent sees tickets but not leads or payroll cost', () => {
  const cat = itAgentCat();
  const tickets = parseWidgetSpec({ title: 'Open tickets', viz: { type: 'kpi' }, query: { dataset: 'tickets', filters: [{ field: 'isOpen', op: 'eq', value: true }] } }).spec!;
  assert.equal(widgetAvailability(cat, tickets, STATIC_DATASETS, []).ok, true);
  assert.equal(widgetAvailability(cat, parseWidgetSpec(leadsKpi).spec!, STATIC_DATASETS, []).ok, false);
  const cost = parseWidgetSpec({ title: 'Cost', viz: { type: 'hbar' }, query: { dataset: 'payslips', measures: [{ fn: 'sum', field: 'employerCost' }], dimensions: [{ field: 'department' }] } }).spec!;
  const r = widgetAvailability(cat, cost, STATIC_DATASETS, []);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /can't see/);
});

test('availability: an HR-only org gets "switched-off product area" for CRM widgets, without naming the dataset', () => {
  const r = widgetAvailability(hrOnlyAdminCat(), parseWidgetSpec(leadsKpi).spec!, STATIC_DATASETS, HR_ONLY_BLOCKED);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /product area that is switched off/);
  assert.doesNotMatch((r as any).reason, /lead/i);
  assert.ok(isAccessError((r as any).reason));
  // …including a forecast whose derived revenue uses deals.
  const f = parseWidgetSpec({ title: 'p', viz: { type: 'kpi' }, query: LEAD_SERIES, forecast: LEAD_FORECAST, options: { kpi: { value: 'projected' } } }).spec!;
  assert.equal(widgetAvailability(hrOnlyAdminCat(), f, STATIC_DATASETS, HR_ONLY_BLOCKED).ok, false);
  // HR widgets work there.
  const hc = parseWidgetSpec({ title: 'Headcount', viz: { type: 'hbar' }, query: { dataset: 'employees', dimensions: [{ field: 'department' }] } }).spec!;
  assert.equal(widgetAvailability(hrOnlyAdminCat(), hc, STATIC_DATASETS, HR_ONLY_BLOCKED).ok, true);
});

test('availability: a note explaining a forecast follows its datasets; access errors are recognised', () => {
  const n = parseWidgetSpec({ kind: 'note', title: 'How', methodOf: { query: LEAD_SERIES, forecast: LEAD_FORECAST } }).spec!;
  assert.equal(widgetAvailability(employeeCat(), n, STATIC_DATASETS, []).ok, false);
  const text = parseWidgetSpec({ kind: 'note', title: 'Hello', text: 'Team board' }).spec!;
  assert.equal(widgetAvailability(employeeCat(), text, STATIC_DATASETS, []).ok, true);
  assert.equal(isAccessError("\"grossPay\" on Payslips isn't available to your role, so it can't be used for measuring."), true);
  assert.equal(isAccessError("Leads aren't available: that part of the product is switched off for your organisation."), true);
  assert.equal(isAccessError('That query took too long.'), false);
});

// ─── Dashboard date range ───────────────────────────────────────────────────

test('date range: replaces relative ranges only, keeping the widget\'s date field', () => {
  const range = DashboardRangeSchema.parse({ preset: 'last_7_days' });
  const kpi = parseWidgetSpec(leadsKpi).spec!;
  const r = applyDashboardRange(kpi, range);
  assert.equal(r.applied, true);
  assert.deepEqual({ field: r.query!.dateRange!.field, preset: r.query!.dateRange!.preset }, { field: 'createdAt', preset: 'last_7_days' });
  assert.equal(r.query!.compare, 'previous_period', 'comparison kept');

  const resolved = parseWidgetSpec({ title: 'Resolved', viz: { type: 'kpi' }, query: { dataset: 'tickets', dateRange: { field: 'resolvedAt', last: { n: 3, unit: 'month' } } } }).spec!;
  assert.equal(applyDashboardRange(resolved, range).query!.dateRange!.field, 'resolvedAt');

  const fixed = parseWidgetSpec({ ...leadsKpi, query: { ...leadsKpi.query, dateRange: { field: 'createdAt', from: '2026-01-01', to: '2026-03-31' } } }).spec!;
  assert.equal(applyDashboardRange(fixed, range).applied, false, 'fixed from/to kept');
  const allTime = parseWidgetSpec({ title: 'All leads', viz: { type: 'kpi' }, query: { dataset: 'leads' } }).spec!;
  assert.equal(usesRelativeRange((allTime as DataWidgetSpec).query), false);
  assert.equal(applyDashboardRange(allTime, range).applied, false, 'an all-time total stays all-time');
  const series = parseWidgetSpec({ title: 'Per week', viz: { type: 'line' }, query: { dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'week' }] } }).spec!;
  const s = applyDashboardRange(series, DashboardRangeSchema.parse({ preset: 'this_quarter' }));
  assert.equal(s.applied, true, 'an unranged series uses an implicit relative default');
  assert.equal(s.query!.dateRange!.field, 'createdAt');
  const f = parseWidgetSpec({ title: 'Projection', viz: { type: 'forecast' }, query: LEAD_SERIES, forecast: LEAD_FORECAST }).spec!;
  assert.equal(applyDashboardRange(f, range).applied, false, 'forecasts keep their history window');
  const optOut = parseWidgetSpec({ ...leadsKpi, options: { ignoreDashboardRange: true } }).spec!;
  assert.equal(applyDashboardRange(optOut, range).applied, false);
  assert.equal(applyDashboardRange(kpi, null).applied, false);
});

test('date range: schema needs something to apply', () => {
  assert.equal(DashboardRangeSchema.safeParse({}).success, false);
  assert.equal(DashboardRangeSchema.safeParse({ from: '2026-10-01', to: '2026-10-18' }).success, true);
  assert.equal(DashboardRangeSchema.safeParse({ preset: 'last_decade' }).success, false);
});

// ─── Layout ─────────────────────────────────────────────────────────────────

test('layout: overlapping and out-of-grid cells are fixed, deterministically', () => {
  const sizes = { a: { w: 6, h: 4 }, b: { w: 6, h: 4 }, c: { w: 3, h: 2 } };
  const raw = { a: { x: 0, y: 0, w: 6, h: 4 }, b: { x: 2, y: 1, w: 6, h: 4 }, c: { x: 11, y: 0, w: 40, h: 1 } };
  const l = normaliseLayout(['a', 'b', 'c'], raw, sizes);
  const cells = Object.values(l);
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) assert.equal(overlaps(cells[i], cells[j]), false);
  for (const c of cells) { assert.ok(c.x >= 0 && c.x + c.w <= GRID_COLS); assert.ok(c.h >= 2); }
  assert.deepEqual(l.c, { x: 0, y: 4, w: 12, h: 2 }, 'clamped to 12 wide, min height 2, pushed below');
  assert.deepEqual(l.b, { x: 2, y: 6, w: 6, h: 4 });
  assert.deepEqual(normaliseLayout(['a', 'b', 'c'], raw, sizes), l, 'same input, same layout');
});

test('layout: gaps compact upwards and widgets without a cell fill the first free spot', () => {
  const l = normaliseLayout(['a', 'n1', 'n2'], { a: { x: 0, y: 7, w: 4, h: 2 } }, { a: { w: 4, h: 2 }, n1: defaultSize('kpi'), n2: defaultSize('table') });
  assert.deepEqual(l.a, { x: 0, y: 0, w: 4, h: 2 });
  assert.deepEqual(l.n1, { x: 4, y: 0, w: 3, h: 2 });
  assert.deepEqual(l.n2, { x: 0, y: 2, w: 12, h: 5 });
  assert.deepEqual(readingOrder(l), ['a', 'n1', 'n2']);
  // Junk input never throws.
  assert.deepEqual(Object.keys(normaliseLayout(['x'], { x: { x: NaN as any, y: 'a' as any } }, {})), ['x']);
  assert.deepEqual(normaliseLayout([], null, {}), {});
});

test('layout: the client copy of the layout core is identical to the server one', () => {
  const core = (f: string) => {
    const s = fs.readFileSync(f, 'utf8');
    const m = /\/\/ <layout-core>([\s\S]*?)\/\/ <\/layout-core>/.exec(s);
    assert.ok(m, `layout-core markers missing in ${f}`);
    return m![1].trim();
  };
  const root = path.resolve(__dirname, '../../..');
  assert.equal(core(path.join(root, 'client/src/shared/components/dashboards/layout.ts')), core(path.join(root, 'server/src/utils/dashboards/layout.ts')));
});

// ─── AI proposals ───────────────────────────────────────────────────────────

const ownerExample = () => ({
  title: 'Lead projection', description: 'If things continue',
  widgets: [
    { title: 'Leads — last 30 days', viz: 'kpi', kpi: 'total', query: leadsKpi.query },
    { title: 'Projected leads', viz: 'kpi', kpi: 'projected', query: LEAD_SERIES, forecast: { ...LEAD_FORECAST, growthPctPerMonth: null } },
    { title: 'Projected conversions', viz: 'kpi', kpi: 'derived:0', query: LEAD_SERIES, forecast: LEAD_FORECAST },
    { title: 'Projected revenue', viz: 'kpi', kpi: 'derived:1', query: LEAD_SERIES, forecast: LEAD_FORECAST },
    { title: 'Leads and projection', viz: 'forecast', query: LEAD_SERIES, forecast: LEAD_FORECAST },
    { title: 'Leads by source', viz: 'hbar', query: { dataset: 'leads', dimensions: [{ field: 'source' }], dateRange: { field: 'createdAt', preset: 'last_90_days' }, sort: { by: 'count', dir: 'desc' }, limit: 8 } },
    { title: 'Lead funnel', viz: 'funnel', query: { dataset: 'leads', dimensions: [{ field: 'status' }] } },
    { title: 'How it works', viz: 'note', noteFor: 4, text: 'Leads will double next month!' },
  ],
});

test('proposal: the owner\'s lead-projection example validates into 8 widgets with a data-generated note', () => {
  const chk = checkProposal({ catalog: adminCat(), env: ENV }, ownerExample(), 'Create a dashboard projecting our leads');
  assert.deepEqual(chk.errors, []);
  const p = chk.proposal!;
  assert.equal(p.widgets.length, 8);
  const kinds = p.widgets.map(w => (w.kind === 'note' ? 'note' : `${w.viz.type}${w.kind === 'data' && w.options.kpi ? ':' + w.options.kpi.value : ''}`));
  assert.deepEqual(kinds, ['kpi:total', 'kpi:projected', 'kpi:derived', 'kpi:derived', 'forecast', 'hbar', 'funnel', 'note']);
  const note = p.widgets[7];
  assert.equal(note.kind, 'note');
  assert.equal((note as any).text, '', 'the model\'s free text is never stored');
  assert.equal((note as any).methodOf.forecast.horizon, 30);
  assert.ok(p.widgets.every(w => w.source.kind === 'ai_dashboard'));
  assert.match((p.widgets[0] as DataWidgetSpec).description, /Number of leads/);
  // Layout: KPIs share the first row; nothing overlaps.
  assert.deepEqual([0, 1, 2, 3].map(i => p.layout[String(i)].y), [0, 0, 0, 0]);
});

test('proposal: a forecast without a note gets the method note added; text-only notes are dropped', () => {
  const raw = { title: 'P', widgets: [{ title: 'F', viz: 'forecast', query: LEAD_SERIES, forecast: { horizon: 14 } }, { title: 'Hi', viz: 'note', text: 'Our best quarter ever' }] };
  const chk = checkProposal({ catalog: adminCat(), env: ENV }, raw, 'q');
  assert.equal(chk.proposal!.widgets.length, 2);
  assert.equal(chk.proposal!.widgets[1].kind, 'note');
  assert.ok((chk.proposal!.widgets[1] as any).methodOf);
  assert.match(chk.warnings.join(), /Left out a text note/);
});

test('proposal: invalid widgets produce repair errors; after repair the valid ones are kept and the rest named', () => {
  const c = { catalog: adminCat(), env: ENV };
  const first = { title: 'Mood', widgets: [
    { title: 'Open', viz: 'kpi', query: { dataset: 'tickets', filters: [{ field: 'isOpen', op: 'eq', value: true }] } },
    { title: 'By mood', viz: 'pie', query: { dataset: 'tickets', dimensions: [{ field: 'mood' }] } },
  ] };
  const chk = checkProposal(c, first, 'q');
  assert.equal(chk.proposal, null);
  assert.match(chk.errors.join(), /widgets\.1: query: Unknown field "mood"/);
  // Repaired reply → valid.
  const repaired = JSON.parse(JSON.stringify(first));
  repaired.widgets[1].query.dimensions[0].field = 'sentiment';
  assert.ok(checkProposal(c, repaired, 'q').proposal);
  // Still broken after repair → salvage keeps the valid widget and says so.
  const s = salvage(chk, first)!;
  assert.equal(s.proposal.widgets.length, 1);
  assert.match(s.warnings.join(), /1 proposed widget couldn't be built/);
  // Nothing valid → no proposal.
  assert.equal(salvage(checkProposal(c, { widgets: [{ viz: 'pie', query: { dataset: 'nope' } }] }, 'q'), {}), null);
});

test('proposal: the viewer\'s catalog decides — an HR-only org can\'t get CRM widgets, an employee can\'t get pay', () => {
  const hr = checkProposal({ catalog: hrOnlyAdminCat(), env: ENV }, ownerExample(), 'q');
  assert.equal(hr.proposal, null);
  assert.match(hr.errors.join(), /dataset "leads" is not available/);
  const pay = { title: 'Pay', widgets: [{ title: 'Cost', viz: 'hbar', query: { dataset: 'payslips', measures: [{ fn: 'sum', field: 'employerCost' }], dimensions: [{ field: 'department' }] } }] };
  assert.ok(checkProposal({ catalog: hrOnlyAdminCat(), env: ENV }, pay, 'q').proposal);
  assert.match(checkProposal({ catalog: employeeCat(), env: ENV }, pay, 'q').errors.join(), /isn't available to your role/);
});

test('proposal: caps at 8 widgets without losing the method note; tolerant viz aliases and kpi parsing', () => {
  const many = { title: 'Big', widgets: [
    { title: 'F', viz: 'projection', query: LEAD_SERIES, forecast: { horizon: 30 } },
    ...Array.from({ length: 9 }, (_, i) => ({ title: `K${i}`, viz: 'metric', query: { dataset: 'leads' } })),
  ] };
  const chk = checkProposal({ catalog: adminCat(), env: ENV }, many, 'q');
  assert.equal(chk.proposal!.widgets.length, MAX_WIDGETS);
  assert.equal(chk.proposal!.widgets.at(-1)!.kind, 'note');
  assert.match(chk.warnings.join(), /Kept the first 8/);
  assert.deepEqual(parseKpi('derived:1'), { value: 'derived', derived: 1 });
  assert.deepEqual(parseKpi('rate'), { value: 'rate', derived: 0 });
  assert.deepEqual(parseKpi('weird'), { value: 'total' });
  assert.equal(checkProposal({ catalog: adminCat(), env: ENV }, 'nope', 'q').errors[0], 'The reply was not a JSON object.');
});

test('proposal: model widget round trip for "change this widget"', () => {
  const s = parseWidgetSpec({ title: 'p', viz: { type: 'kpi' }, query: LEAD_SERIES, forecast: LEAD_FORECAST, options: { kpi: { value: 'derived', derived: 1 } } }).spec!;
  const m = widgetToModel(s);
  assert.equal(m.kpi, 'derived:1');
  const back = convertModelWidget(m, [m], { catalog: adminCat(), env: ENV }, 'q');
  const v = validateWidget({ catalog: adminCat(), env: ENV }, back.spec);
  assert.ok(v.spec);
  assert.deepEqual((v.spec as DataWidgetSpec).options.kpi, { value: 'derived', derived: 1 });
});

test('proposal: the prompt carries the caller\'s catalog only (no CRM examples for an HR-only org)', () => {
  const actx = { catalog: hrOnlyAdminCat(), env: ENV, currency: 'INR' } as unknown as AnalyticsContext;
  const p = buildProposalPrompt(actx);
  assert.ok(!/\n- leads:/.test(p) && !/"dataset":"leads"/.test(p));
  assert.match(p, /\n- employees:/);
  assert.match(p, /Headcount by department/);
  const full = buildProposalPrompt({ catalog: adminCat(), env: ENV, currency: 'INR' } as unknown as AnalyticsContext);
  assert.match(full, /Projected revenue/);
});

test('normalise: list queries take their fields as y', () => {
  const s = normaliseWidgetSpec(parseWidgetSpec({ title: 't', viz: { type: 'table' }, query: { dataset: 'leads', mode: 'list', fields: ['status', 'source'] } }).spec as DataWidgetSpec);
  assert.deepEqual(s.viz.y, ['status', 'source']);
  assert.equal(s.viz.x, null);
});

// ─── Forecast explanation formatting ────────────────────────────────────────

test('derived explanation: amounts in org currency, counts as ratio + %', () => {
  const money = derivedExplanation('Projected revenue', 'projected conversions', 158500,
    { value: 3170000, format: 'money', description: 'Total deal value where Status is Won' },
    { value: 20, format: 'number', description: 'Number of deals where Status is Won' }, 'previous 90 full days', 'INR');
  assert.match(money, /× ₹1,58,500 — /);
  assert.match(money, /₹31,70,000 ÷ 20\.$/);
  assert.ok(!/158500/.test(money));
  const rate = derivedExplanation('Projected conversions', 'projected number of leads', 0.17474,
    { value: 101, format: 'number', description: 'Leads converted' }, { value: 578, format: 'number', description: 'Leads' }, 'previous 90 full days', 'INR');
  assert.match(rate, /× 0\.1747 \(17\.5%\) — Leads converted ÷ Leads/);
  const usd = derivedExplanation('R', 's', 1234.5, { value: 12345, format: 'money', description: 'a' }, { value: 10, format: 'number', description: 'b' }, 'w', 'USD');
  assert.match(usd, /× \$1,235 — /);
});

test('normalise: a time series drops a leftover top-N sort/limit', () => {
  const s = parseWidgetSpec({ title: 't', viz: { type: 'line' }, query: { dataset: 'leads', dimensions: [{ field: 'createdAt', bucket: 'week' }], sort: { by: 'count', dir: 'desc' }, limit: 8 } }).spec as DataWidgetSpec;
  assert.equal(s.query.sort, null);
  assert.equal(s.query.limit, null);
  const bar = parseWidgetSpec({ title: 't', viz: { type: 'hbar' }, query: { dataset: 'leads', dimensions: [{ field: 'source' }], sort: { by: 'count', dir: 'desc' }, limit: 8 } }).spec as DataWidgetSpec;
  assert.equal(bar.query.limit, 8, 'top N on groups is kept');
});

// ─── Request budgets (Groq free tier: 8,000 tokens/minute, prompt + max_tokens counted up front) ──

import {
  buildRepairPrompt, buildWidgetEditPrompt, dashboardCatalog, compactErrors, previousReply,
  BUILD_MAX_TOKENS, EDIT_MAX_TOKENS,
} from '../../src/utils/dashboards/propose';
import { estimateTokens } from '../../src/utils/aiRateLimit';

const fullActx = () => ({ catalog: adminCat(), env: ENV, currency: 'INR' } as unknown as AnalyticsContext);
const OWNER_REQUEST = 'Create a dashboard projecting our leads for the upcoming days — if the business continues the same way, where will we be?';
const catalogPart = (p: string) => p.slice(p.indexOf('\nCATALOG\n'), p.indexOf('\nEXAMPLES\n') > 0 ? p.indexOf('\nEXAMPLES\n') : undefined);

test('budget: the owner\'s lead projection reads only leads + deals and stays well under 4k tokens per request', () => {
  const p = buildProposalPrompt(fullActx(), OWNER_REQUEST);
  const cat = catalogPart(p);
  assert.match(cat, /\n- leads:/); assert.match(cat, /\n- deals:/);
  assert.ok(!/\n- (tickets|employees|payslips|attendance):/.test(cat), 'unrelated datasets are named only');
  assert.match(cat, /Also available[^\n]*tickets/);
  assert.match(p, /"forecastOf":4/, 'the example uses the compact KPI format');
  const total = estimateTokens(p.length + OWNER_REQUEST.length) + BUILD_MAX_TOKENS;
  assert.ok(total <= 3500, `lead projection request ≈ ${total} tokens`);
});

test('budget: a request that names nothing still fits (most-used datasets within budget, the rest by name)', () => {
  for (const q of ['Give me an executive overview of the whole business', 'HR overview with attendance and leave', 'Help desk performance this month', '']) {
    const p = buildProposalPrompt(fullActx(), q);
    const total = estimateTokens(p.length + q.length) + BUILD_MAX_TOKENS;
    assert.ok(total <= 4100, `"${q}" ≈ ${total} tokens`);
  }
  const shown = dashboardCatalog(adminCat(), 'Give me an executive overview').shown.map(d => d.def.key);
  assert.deepEqual(shown.slice(0, 3), ['leads', 'deals', 'tickets']);
  assert.deepEqual(dashboardCatalog(adminCat(), 'HR overview with attendance and leave').shown.map(d => d.def.key).sort(), ['attendance', 'employees', 'leave_requests']);
});

test('budget: widget edit reads the widget\'s own dataset; repair is a small prompt with the datasets the reply used', () => {
  const s = parseWidgetSpec({ title: 'Tickets by priority', viz: { type: 'bar' }, query: { dataset: 'tickets', dimensions: [{ field: 'priority' }] } }).spec!;
  const edit = buildWidgetEditPrompt(fullActx(), s, 'make it a pie chart');
  assert.match(catalogPart(edit), /\n- tickets:/);
  assert.ok(!/\n- leads:/.test(catalogPart(edit)));
  assert.ok(estimateTokens(edit.length + 400) + EDIT_MAX_TOKENS <= 2200, 'widget edit request');
  const reply = { title: 'Mood', widgets: [{ title: 'By mood', viz: 'pie', query: { dataset: 'tickets', dimensions: [{ field: 'mood' }] } }] };
  const repair = buildRepairPrompt(fullActx(), 'Ticket mood dashboard', reply);
  assert.match(catalogPart(repair), /\n- tickets:/);
  assert.ok(!/EXAMPLES/.test(repair), 'no worked examples in the repair prompt');
  const user = `Request: Ticket mood dashboard\n\nYour previous reply:\n${previousReply(reply, null)}\n\nIt was rejected because:\n- ${compactErrors(['widgets.0: query: Unknown field "mood" on Tickets (for grouping).']).join('\n- ')}`;
  assert.ok(estimateTokens(repair.length + user.length) + BUILD_MAX_TOKENS <= 3200, 'repair request');
  // A reply using a dataset the request didn't mention gets that dataset's fields in the repair.
  assert.match(catalogPart(buildRepairPrompt(fullActx(), 'Ticket mood dashboard', { widgets: [{ query: { dataset: 'assets' } }] })), /\n- assets:/);
});

test('repair input: dataset lists are stripped from errors and the previous reply is re-serialised compactly', () => {
  assert.deepEqual(compactErrors(['widgets.1: query: dataset "foo" is not available (datasets: leads, deals, tickets).', 'x (Datasets: a, b)']),
    ['widgets.1: query: dataset "foo" is not available.', 'x']);
  assert.equal(compactErrors(Array(20).fill('e')).length, 8);
  assert.equal(previousReply({ a: [1, 2] }, '{\n  "a": [1, 2]\n}'), '{"a":[1,2]}');
  assert.equal(previousReply(null, 'not json'), 'not json');
});

test('compact format: KPI tiles with "forecastOf" validate exactly like the full format', () => {
  const full = ownerExample();
  const compact = JSON.parse(JSON.stringify(full));
  for (const w of compact.widgets) if (w.viz === 'kpi' && w.kpi !== 'total') { delete w.query; delete w.forecast; w.forecastOf = 4; }
  const a = checkProposal({ catalog: adminCat(), env: ENV }, full, 'q');
  const b = checkProposal({ catalog: adminCat(), env: ENV }, compact, 'q');
  assert.deepEqual(b.errors, []);
  assert.equal(b.proposal!.widgets.length, 8);
  // Same query + forecast on every projection tile as the forecast widget itself.
  const fc = b.proposal!.widgets[4] as DataWidgetSpec;
  for (const i of [1, 2, 3]) {
    const w = b.proposal!.widgets[i] as DataWidgetSpec;
    assert.deepEqual(w.query, fc.query); assert.deepEqual(w.forecast, fc.forecast);
  }
  assert.deepEqual(b.proposal!.widgets.map(w => w.kind === 'data' ? w.options.kpi?.value ?? w.viz.type : 'note'), a.proposal!.widgets.map(w => w.kind === 'data' ? w.options.kpi?.value ?? w.viz.type : 'note'));
  // forecastOf must point at a forecast.
  const bad = { widgets: [{ title: 'K', viz: 'kpi', kpi: 'projected', forecastOf: 1 }, { title: 'B', viz: 'bar', query: { dataset: 'leads', dimensions: [{ field: 'source' }] } }] };
  assert.match(checkProposal({ catalog: adminCat(), env: ENV }, bad, 'q').errors.join(), /forecastOf 1 must point at a widget with a query and a forecast/);
});

test('output caps: an 8-widget compact proposal fits BUILD_MAX_TOKENS with room for reasoning', () => {
  const compact = JSON.parse(JSON.stringify(ownerExample()));
  for (const w of compact.widgets) if (w.viz === 'kpi' && w.kpi !== 'total') { delete w.query; delete w.forecast; w.forecastOf = 4; }
  const compactTokens = estimateTokens(JSON.stringify(compact).length);
  const fullTokens = estimateTokens(JSON.stringify(ownerExample()).length);
  assert.ok(compactTokens * 2 <= BUILD_MAX_TOKENS, `compact ≈ ${compactTokens}`);
  assert.ok(fullTokens * 1.25 <= BUILD_MAX_TOKENS, `even the repeated (old) format ≈ ${fullTokens} fits`);
});
