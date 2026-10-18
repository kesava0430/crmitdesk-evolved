import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { logAction } from '../../utils/auditLog';
import { getPermCtx, scopeFor } from '../../utils/permissions';
import { getAnalyticsContext } from '../../utils/analytics/executor';
import { QueryError } from '../../utils/analytics/compiler';
import { dashboardAccess, visibleWhere, VISIBILITIES, type DashboardViewer } from '../../utils/dashboards/access';
import { validateWidget, parseWidgetSpec, DashboardRangeSchema, type DashboardWidgetSpec, type DashboardRange } from '../../utils/dashboards/widget';
import { normaliseLayout, defaultSize, type Layout } from '../../utils/dashboards/layout';
import { renderWidgets } from '../../utils/dashboards/render';
import { proposeDashboard, modifyWidget } from '../../utils/dashboards/propose';
import { handleAIError } from '../ai/ai.controller';

// ─── Dashboards (utils/dashboards/) ────────────────────────────────────────
//
// Plain CRUD + rendering. No plan gate: dashboards work on every plan (the
// query layer underneath isn't plan-gated either); only the two AI routes
// need ai_advanced. Who may see / change a dashboard is decided by
// utils/dashboards/access.ts; what a widget shows is decided per viewer by
// the query layer at render time.

const MAX_WIDGETS_PER_DASHBOARD = 30;
const MAX_DASHBOARDS_PER_USER = 100;

async function viewerOf(req: AuthRequest): Promise<DashboardViewer> {
  const u = req.user!;
  if (!u.orgId) throw new AppError(400, 'Dashboards need an organisation account.');
  const ctx = await getPermCtx({ id: u.id, orgId: u.orgId, role: u.role });
  return { id: u.id, orgId: u.orgId, role: u.role, roleId: ctx.roleId, canManage: scopeFor(ctx, 'core.dashboard.manage') !== 'NONE' };
}

const analyticsUser = (req: AuthRequest) => ({ id: req.user!.id, orgId: req.user!.orgId, role: req.user!.role });

type DashboardWithWidgets = Prisma.DashboardGetPayload<{ include: { widgets: true; owner: { select: { id: true; name: true } } } }>;

async function loadDashboard(id: string, viewer: DashboardViewer) {
  const d = await prisma.dashboard.findFirst({
    where: { id, orgId: viewer.orgId },
    include: { widgets: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }, owner: { select: { id: true, name: true } } },
  });
  const access = d ? dashboardAccess(viewer, d) : null;
  // A dashboard you can't see answers exactly like one that doesn't exist.
  if (!d || !access?.view) throw new AppError(404, 'Dashboard not found');
  return { d, access };
}

function sizesOf(widgets: Array<{ id: string; spec: unknown }>): Record<string, { w: number; h: number }> {
  return Object.fromEntries(widgets.map(w => {
    const s = parseWidgetSpec(w.spec).spec;
    return [w.id, defaultSize(!s ? 'bar' : s.kind === 'note' ? 'note' : s.viz.type)];
  }));
}

function layoutFor(d: { layout: unknown }, widgets: Array<{ id: string; spec: unknown }>): Layout {
  return normaliseLayout(widgets.map(w => w.id), (d.layout ?? {}) as Record<string, any>, sizesOf(widgets));
}

function present(d: DashboardWithWidgets, access: ReturnType<typeof dashboardAccess>) {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    visibility: d.visibility,
    roleIds: d.roleIds,
    legacyRoles: d.legacyRoles,
    owner: d.owner,
    dateRange: d.dateRange,
    refreshMinutes: d.refreshMinutes,
    layout: layoutFor(d, d.widgets),
    widgets: d.widgets.map(w => ({ id: w.id, position: w.position, spec: w.spec })),
    access,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

async function saveLayout(dashboardId: string, layout: Layout) {
  await prisma.dashboard.update({ where: { id: dashboardId }, data: { layout: layout as unknown as Prisma.InputJsonValue } });
}

/** Validates widget specs against the EDITOR's catalog: you can only add what you can see. */
async function validateSpecs(req: AuthRequest, specs: unknown[]): Promise<DashboardWidgetSpec[]> {
  const actx = await getAnalyticsContext(analyticsUser(req));
  return specs.map((s, i) => {
    const v = validateWidget({ catalog: actx.catalog, env: actx.env }, s);
    if (!v.spec) throw new AppError(400, `Widget ${specs.length > 1 ? `${i + 1} ` : ''}isn't valid: ${v.errors.slice(0, 3).join('; ')}`);
    return v.spec;
  });
}

const rangeOrNull = z.union([DashboardRangeSchema, z.null()]);

// ─── List / read ────────────────────────────────────────────────────────────

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const [rows, home] = await Promise.all([
      prisma.dashboard.findMany({
        where: visibleWhere(viewer) as Prisma.DashboardWhereInput,
        include: { owner: { select: { id: true, name: true } }, _count: { select: { widgets: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 300,
      }),
      prisma.dashboardHome.findUnique({ where: { userId: viewer.id } }),
    ]);
    const items = rows.map(d => ({
      id: d.id, title: d.title, description: d.description, visibility: d.visibility,
      owner: d.owner, widgetCount: d._count.widgets, updatedAt: d.updatedAt, access: dashboardAccess(viewer, d),
    })).filter(d => d.access.view);
    res.json({
      mine: items.filter(d => d.access.isOwner),
      shared: items.filter(d => !d.access.isOwner),
      home: home && items.some(d => d.id === home.dashboardId) ? { dashboardId: home.dashboardId, replaceBuiltIn: home.replaceBuiltIn } : null,
      canManage: viewer.canManage || viewer.role === 'SUPER_ADMIN',
    });
  } catch (err) { next(err); }
}

export async function get(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d, access } = await loadDashboard(req.params.id, viewer);
    res.json(present(d, access));
  } catch (err) { next(err); }
}

/** Roles a dashboard can be shared with (the share dialog). */
export async function shareOptions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const roles = await prisma.role.findMany({
      where: { isActive: true, OR: [{ orgId: viewer.orgId }, { orgId: null }] },
      select: { id: true, key: true, name: true, legacyRole: true, orgId: true },
      orderBy: [{ rank: 'asc' }, { name: 'asc' }],
    });
    // An org-specific copy of a system role shadows the global template.
    const orgKeys = new Set(roles.filter(r => r.orgId).map(r => r.key));
    res.json({ roles: roles.filter(r => r.orgId || !orgKeys.has(r.key)).map(({ orgId: _o, ...r }) => r) });
  } catch (err) { next(err); }
}

// ─── Create / update / delete ───────────────────────────────────────────────

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullish(),
  widgets: z.array(z.unknown()).max(MAX_WIDGETS_PER_DASHBOARD).default([]),
  /** Desktop layout keyed by widget index ("0", "1", …) — from an AI proposal / a builder preview. */
  layout: z.record(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).nullish(),
  dateRange: rangeOrNull.nullish(),
  refreshMinutes: z.number().int().min(0).max(1440).default(0),
});

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const body = CreateSchema.parse(req.body);
    const count = await prisma.dashboard.count({ where: { orgId: viewer.orgId, ownerId: viewer.id } });
    if (count >= MAX_DASHBOARDS_PER_USER) throw new AppError(400, `You already have ${MAX_DASHBOARDS_PER_USER} dashboards — delete one first.`);
    const specs = body.widgets.length ? await validateSpecs(req, body.widgets) : [];
    const created = await prisma.$transaction(async tx => {
      const d = await tx.dashboard.create({
        data: {
          orgId: viewer.orgId, ownerId: viewer.id, title: body.title, description: body.description ?? null,
          dateRange: body.dateRange ? (body.dateRange as Prisma.InputJsonValue) : Prisma.DbNull, refreshMinutes: body.refreshMinutes,
        },
      });
      const ws = [];
      for (const [i, spec] of specs.entries()) {
        ws.push(await tx.dashboardWidget.create({ data: { dashboardId: d.id, spec: spec as unknown as Prisma.InputJsonValue, position: i } }));
      }
      const byIndex = Object.fromEntries(ws.map((w, i) => [w.id, body.layout?.[String(i)]]));
      const layout = normaliseLayout(ws.map(w => w.id), byIndex, sizesOf(ws));
      await tx.dashboard.update({ where: { id: d.id }, data: { layout: layout as unknown as Prisma.InputJsonValue } });
      return d;
    });
    logAction(viewer.id, 'CREATE', 'Dashboard', created.id, { title: body.title, widgets: specs.length, source: specs[0]?.source?.kind ?? 'manual' });
    const { d, access } = await loadDashboard(created.id, viewer);
    res.status(201).json(present(d, access));
  } catch (err) { next(err); }
}

const UpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).nullish(),
  layout: z.record(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).optional(),
  /** Phone order: widget ids top to bottom. */
  order: z.array(z.string()).max(MAX_WIDGETS_PER_DASHBOARD).optional(),
  dateRange: rangeOrNull.optional(),
  refreshMinutes: z.number().int().min(0).max(1440).optional(),
});

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d, access } = await loadDashboard(req.params.id, viewer);
    if (!access.edit) throw new AppError(403, 'Only the owner (or someone who manages shared dashboards) can change this dashboard.');
    const body = UpdateSchema.parse(req.body);
    let widgets = d.widgets;
    if (body.order) {
      const known = new Set(widgets.map(w => w.id));
      const order = [...body.order.filter(id => known.has(id)), ...widgets.map(w => w.id).filter(id => !body.order!.includes(id))];
      await prisma.$transaction(order.map((id, i) => prisma.dashboardWidget.update({ where: { id }, data: { position: i } })));
      widgets = order.map(id => widgets.find(w => w.id === id)!);
    }
    const layout = body.layout ? normaliseLayout(widgets.map(w => w.id), body.layout, sizesOf(widgets)) : undefined;
    await prisma.dashboard.update({
      where: { id: d.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        ...(layout ? { layout: layout as unknown as Prisma.InputJsonValue } : {}),
        ...(body.dateRange !== undefined ? { dateRange: body.dateRange ? (body.dateRange as Prisma.InputJsonValue) : Prisma.DbNull } : {}),
        ...(body.refreshMinutes !== undefined ? { refreshMinutes: body.refreshMinutes } : {}),
      },
    });
    // Layout-only saves happen on every drag; audit the meaningful changes.
    const changed = Object.keys(body).filter(k => k !== 'layout' && k !== 'order');
    if (changed.length) logAction(viewer.id, 'UPDATE', 'Dashboard', d.id, { fields: changed });
    const fresh = await loadDashboard(d.id, viewer);
    res.json(present(fresh.d, fresh.access));
  } catch (err) { next(err); }
}

const ShareSchema = z.object({
  visibility: z.enum(VISIBILITIES),
  roleIds: z.array(z.string().max(60)).max(50).default([]),
  legacyRoles: z.array(z.enum(['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER', 'IT_AGENT', 'SALES_REP', 'EMPLOYEE'])).max(10).default([]),
});

export async function share(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d, access } = await loadDashboard(req.params.id, viewer);
    if (!access.share) throw new AppError(403, 'Only the owner (or someone who manages shared dashboards) can change who sees this dashboard.');
    const body = ShareSchema.parse(req.body);
    let roleIds: string[] = [];
    if (body.visibility === 'ROLES') {
      // Only roles of this org (or the global system templates) can be named.
      const found = await prisma.role.findMany({ where: { id: { in: body.roleIds }, OR: [{ orgId: viewer.orgId }, { orgId: null }] }, select: { id: true } });
      roleIds = found.map(r => r.id);
      if (!roleIds.length && !body.legacyRoles.length) throw new AppError(400, 'Pick at least one role to share with.');
    }
    await prisma.dashboard.update({
      where: { id: d.id },
      data: { visibility: body.visibility, roleIds, legacyRoles: body.visibility === 'ROLES' ? body.legacyRoles : [] },
    });
    logAction(viewer.id, 'UPDATE', 'Dashboard', d.id, { visibility: body.visibility, roleIds, legacyRoles: body.visibility === 'ROLES' ? body.legacyRoles : [] });
    const fresh = await loadDashboard(d.id, viewer);
    res.json(present(fresh.d, fresh.access));
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d, access } = await loadDashboard(req.params.id, viewer);
    if (!access.delete) throw new AppError(403, 'Only the owner (or someone who manages shared dashboards) can delete this dashboard.');
    await prisma.dashboard.delete({ where: { id: d.id } });
    logAction(viewer.id, 'DELETE', 'Dashboard', d.id, { title: d.title, owner: d.ownerId, widgets: d.widgets.length });
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function duplicate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d } = await loadDashboard(req.params.id, viewer);
    const title = z.object({ title: z.string().trim().min(1).max(120).optional() }).parse(req.body ?? {}).title ?? `${d.title} (copy)`.slice(0, 120);
    const layout = layoutFor(d, d.widgets);
    const copy = await prisma.$transaction(async tx => {
      const c = await tx.dashboard.create({
        data: {
          orgId: viewer.orgId, ownerId: viewer.id, title, description: d.description,
          dateRange: d.dateRange ? (d.dateRange as Prisma.InputJsonValue) : Prisma.DbNull, refreshMinutes: d.refreshMinutes,
        },
      });
      const map: Layout = {};
      for (const w of d.widgets) {
        const nw = await tx.dashboardWidget.create({ data: { dashboardId: c.id, spec: w.spec as Prisma.InputJsonValue, position: w.position } });
        if (layout[w.id]) map[nw.id] = layout[w.id];
      }
      await tx.dashboard.update({ where: { id: c.id }, data: { layout: map as unknown as Prisma.InputJsonValue } });
      return c;
    });
    logAction(viewer.id, 'CREATE', 'Dashboard', copy.id, { duplicatedFrom: d.id, title });
    const fresh = await loadDashboard(copy.id, viewer);
    res.status(201).json(present(fresh.d, fresh.access));
  } catch (err) { next(err); }
}

// ─── Widgets ────────────────────────────────────────────────────────────────

export async function addWidget(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d, access } = await loadDashboard(req.params.id, viewer);
    if (!access.edit) throw new AppError(403, 'You can’t add widgets to this dashboard.');
    if (d.widgets.length >= MAX_WIDGETS_PER_DASHBOARD) throw new AppError(400, `A dashboard holds up to ${MAX_WIDGETS_PER_DASHBOARD} widgets.`);
    const { spec } = z.object({ spec: z.unknown() }).parse(req.body);
    const [valid] = await validateSpecs(req, [spec]);
    const w = await prisma.dashboardWidget.create({
      data: { dashboardId: d.id, spec: valid as unknown as Prisma.InputJsonValue, position: (d.widgets.at(-1)?.position ?? -1) + 1 },
    });
    // The new widget has no cell yet: normalisation puts it in the first free spot.
    await saveLayout(d.id, layoutFor(d, [...d.widgets, w]));
    logAction(viewer.id, 'UPDATE', 'Dashboard', d.id, { widgetAdded: w.id, title: valid.title, source: valid.source?.kind });
    const fresh = await loadDashboard(d.id, viewer);
    res.status(201).json({ widgetId: w.id, dashboard: present(fresh.d, fresh.access) });
  } catch (err) { next(err); }
}

export async function updateWidget(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d, access } = await loadDashboard(req.params.id, viewer);
    if (!access.edit) throw new AppError(403, 'You can’t change widgets on this dashboard.');
    const w = d.widgets.find(x => x.id === req.params.widgetId);
    if (!w) throw new AppError(404, 'Widget not found');
    const { spec } = z.object({ spec: z.unknown() }).parse(req.body);
    const [valid] = await validateSpecs(req, [spec]);
    await prisma.dashboardWidget.update({ where: { id: w.id }, data: { spec: valid as unknown as Prisma.InputJsonValue } });
    logAction(viewer.id, 'UPDATE', 'Dashboard', d.id, { widgetChanged: w.id, title: valid.title });
    const fresh = await loadDashboard(d.id, viewer);
    res.json(present(fresh.d, fresh.access));
  } catch (err) { next(err); }
}

export async function removeWidget(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d, access } = await loadDashboard(req.params.id, viewer);
    if (!access.edit) throw new AppError(403, 'You can’t remove widgets from this dashboard.');
    const w = d.widgets.find(x => x.id === req.params.widgetId);
    if (!w) throw new AppError(404, 'Widget not found');
    await prisma.dashboardWidget.delete({ where: { id: w.id } });
    const rest = d.widgets.filter(x => x.id !== w.id);
    const layout = { ...(d.layout as Record<string, any>) };
    delete layout[w.id];
    await saveLayout(d.id, normaliseLayout(rest.map(x => x.id), layout, sizesOf(rest)));
    logAction(viewer.id, 'UPDATE', 'Dashboard', d.id, { widgetRemoved: w.id, title: (w.spec as any)?.title });
    const fresh = await loadDashboard(d.id, viewer);
    res.json(present(fresh.d, fresh.access));
  } catch (err) { next(err); }
}

export async function duplicateWidget(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d, access } = await loadDashboard(req.params.id, viewer);
    if (!access.edit) throw new AppError(403, 'You can’t add widgets to this dashboard.');
    if (d.widgets.length >= MAX_WIDGETS_PER_DASHBOARD) throw new AppError(400, `A dashboard holds up to ${MAX_WIDGETS_PER_DASHBOARD} widgets.`);
    const w = d.widgets.find(x => x.id === req.params.widgetId);
    if (!w) throw new AppError(404, 'Widget not found');
    const spec = { ...(w.spec as Record<string, unknown>), title: `${String((w.spec as any)?.title ?? 'Widget')} (copy)`.slice(0, 120) };
    const nw = await prisma.dashboardWidget.create({ data: { dashboardId: d.id, spec: spec as Prisma.InputJsonValue, position: (d.widgets.at(-1)?.position ?? -1) + 1 } });
    const cur = layoutFor(d, d.widgets);
    const src = cur[w.id];
    // Same size as the original, placed in the first free spot.
    await saveLayout(d.id, normaliseLayout([...d.widgets.map(x => x.id), nw.id], cur, { ...sizesOf(d.widgets), [nw.id]: src ? { w: src.w, h: src.h } : sizesOf([nw])[nw.id] }));
    logAction(viewer.id, 'UPDATE', 'Dashboard', d.id, { widgetDuplicated: w.id, newWidget: nw.id });
    const fresh = await loadDashboard(d.id, viewer);
    res.status(201).json({ widgetId: nw.id, dashboard: present(fresh.d, fresh.access) });
  } catch (err) { next(err); }
}

// ─── Rendering (always as the viewer) ───────────────────────────────────────

function sendQueryError(err: unknown, res: Response): boolean {
  if (err instanceof QueryError) { res.status(400).json({ error: err.message, details: err.hints, code: 'ANALYTICS_QUERY_INVALID' }); return true; }
  return false;
}

export async function render(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const { d } = await loadDashboard(req.params.id, viewer);
    const body = z.object({ dateRange: rangeOrNull.optional(), widgetIds: z.array(z.string()).max(MAX_WIDGETS_PER_DASHBOARD).optional() }).parse(req.body ?? {});
    // undefined = the dashboard's saved range; null = each widget's own.
    const saved = d.dateRange ? DashboardRangeSchema.safeParse(d.dateRange) : null;
    const range: DashboardRange | null = body.dateRange !== undefined ? body.dateRange : saved?.success ? saved.data : null;
    const widgets = d.widgets.filter(w => !body.widgetIds || body.widgetIds.includes(w.id));
    const actx = await getAnalyticsContext(analyticsUser(req));
    const out = await renderWidgets(actx, widgets.map(w => ({ id: w.id, spec: w.spec })), range);
    res.json({ widgets: out, range, timezone: actx.env.timezone, currency: actx.currency, today: actx.env.today, renderedAt: new Date().toISOString() });
  } catch (err) { if (!sendQueryError(err, res)) next(err); }
}

/** Unsaved specs (builder live preview, AI proposal preview) rendered as the caller. */
export async function renderSpecs(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = z.object({ specs: z.array(z.unknown()).min(1).max(MAX_WIDGETS_PER_DASHBOARD), dateRange: rangeOrNull.optional() }).parse(req.body);
    const actx = await getAnalyticsContext(analyticsUser(req));
    const out = await renderWidgets(actx, body.specs.map((spec, i) => ({ id: String(i), spec })), body.dateRange ?? null);
    res.json({ widgets: out, range: body.dateRange ?? null, timezone: actx.env.timezone, currency: actx.currency, today: actx.env.today, renderedAt: new Date().toISOString() });
  } catch (err) { if (!sendQueryError(err, res)) next(err); }
}

// ─── Home dashboard ─────────────────────────────────────────────────────────

export async function getHome(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const home = await prisma.dashboardHome.findUnique({ where: { userId: viewer.id } });
    if (!home) return res.json({ home: null });
    try {
      const { d } = await loadDashboard(home.dashboardId, viewer);
      res.json({ home: { dashboardId: d.id, title: d.title, replaceBuiltIn: home.replaceBuiltIn } });
    } catch {
      // Unshared since it was picked — quietly fall back to the built-in dashboard.
      res.json({ home: null });
    }
  } catch (err) { next(err); }
}

export async function setHome(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const viewer = await viewerOf(req);
    const body = z.object({ dashboardId: z.string().nullable(), replaceBuiltIn: z.boolean().default(false) }).parse(req.body);
    if (!body.dashboardId) {
      await prisma.dashboardHome.deleteMany({ where: { userId: viewer.id } });
      return res.json({ home: null });
    }
    const { d } = await loadDashboard(body.dashboardId, viewer);
    await prisma.dashboardHome.upsert({
      where: { userId: viewer.id },
      update: { dashboardId: d.id, replaceBuiltIn: body.replaceBuiltIn },
      create: { userId: viewer.id, dashboardId: d.id, replaceBuiltIn: body.replaceBuiltIn },
    });
    res.json({ home: { dashboardId: d.id, title: d.title, replaceBuiltIn: body.replaceBuiltIn } });
  } catch (err) { next(err); }
}

// ─── AI (ai_advanced) ───────────────────────────────────────────────────────

export async function aiPropose(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { prompt } = z.object({ prompt: z.string().trim().min(3).max(800) }).parse(req.body);
    const r = await proposeDashboard(analyticsUser(req), prompt);
    res.json(r);
  } catch (err) {
    if (sendQueryError(err, res)) return;
    if (!handleAIError(err, res)) next(err);
  }
}

export async function aiModifyWidget(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = z.object({ spec: z.unknown(), instruction: z.string().trim().min(2).max(500) }).parse(req.body);
    const parsed = parseWidgetSpec(body.spec);
    if (!parsed.spec) throw new AppError(400, `Widget isn't valid: ${parsed.errors.join('; ')}`);
    const r = await modifyWidget(analyticsUser(req), parsed.spec, body.instruction);
    res.json(r);
  } catch (err) {
    if (sendQueryError(err, res)) return;
    if (!handleAIError(err, res)) next(err);
  }
}

