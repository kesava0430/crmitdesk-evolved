// ─── Product areas & module catalogue ────────────────────────────────────────
//
// The product is sold as three AREAS — HR, CRM and IT Desk — that the PLATFORM
// operator switches on or off per customer org (Platform Admin → org →
// Areas). Each area is a group of sub-modules, and each sub-module is one
// licence feature key (utils/stripe.ts FEATURE_KEYS), so enforcement stays
// key-based everywhere (requireFeature / requireModuleAtMount / the client's
// entitlements):
//
//   HR      → hr_core (people, directory, org structure, leave, HR settings),
//             attendance (incl. WFH, face verification), payroll (incl. loans, payslips)
//   CRM     → crm (contacts, companies, leads, deals, activities),
//             sales_docs (quotes & invoices), campaigns
//   IT Desk → itdesk (tickets, categories, SLA, change requests),
//             assets, knowledge_base, customer_portal
//
// Each area has a ROOT key (hr_core / crm / itdesk). Switching an area off
// means the root is in Subscription.disabledFeatures, and every sub-module of
// that area is off with it, whatever the plan says. Switching it on clears
// every key of the area from disabledFeatures, so all its sub-modules come
// back (subject to the plan, e.g. the customer portal still needs a plan that
// includes it — areas are ANDed with plan features, never a way around them).
// Platform Admin → Advanced may also switch off a single sub-module inside an
// enabled area (HR without Payroll) by listing just that key.
//
// Shared capabilities (dashboard, inbox, chat, approvals, workflows, AI,
// custom modules, analytics, API keys, branding, SSO, storage) are NOT area
// switched: they stay plan-gated as before and only show data of enabled areas.
//
// This file is the single source of truth for what a module covers:
//  - `apiPrefixes`: routers mounted behind requireModuleAtMount() in index.ts
//    (the whole router answers 402 while the module is off);
//  - `routes`: client paths the web/Android app hides from the sidebar and
//    replaces with a "not enabled" page. The client never hard-codes this —
//    it reads the catalogue from GET /billing/entitlements (`modules`, `areas`).
//
// Pure (no Prisma) so it can be unit-tested and imported anywhere.

import type { FeatureKey } from './stripe';

export type AreaKey = 'hr' | 'crm' | 'itdesk';

export interface ModuleDef {
  key: FeatureKey;
  area: AreaKey;
  label: string;
  description: string;
  /** Client route prefixes (exact path or path + '/…'). */
  routes: string[];
  /** API mount points gated as a whole while the module is off. */
  apiPrefixes: string[];
}

export interface AreaDef {
  key: AreaKey;
  /** Feature key that stands for the whole area in disabledFeatures. */
  root: FeatureKey;
  label: string;
  description: string;
  /** Staff roles whose day-to-day work is this area (role picker hints, landing page). */
  roles: string[];
}

export const AREAS: AreaDef[] = [
  { key: 'hr', root: 'hr_core', label: 'HR', roles: ['HR_MANAGER'],
    description: 'People, org structure, leave, attendance (WFH, face check-in) and payroll' },
  { key: 'crm', root: 'crm', label: 'CRM', roles: ['CRM_MANAGER', 'SALES_REP'],
    description: 'Contacts, companies, leads, deals, quotes & invoices, campaigns' },
  { key: 'itdesk', root: 'itdesk', label: 'IT Desk', roles: ['IT_MANAGER', 'IT_AGENT'],
    description: 'Tickets, SLAs, change requests, assets, knowledge base and the customer portal' },
];

export const MODULE_CATALOGUE: ModuleDef[] = [
  // ── HR ──
  {
    key: 'hr_core', area: 'hr', label: 'People & leave',
    description: 'People, employee directory, org structure, leave, HR settings',
    routes: ['/people', '/hr/employees', '/hr/directory', '/hr/org', '/hr/leave', '/hr/settings'],
    apiPrefixes: ['/api/hr/employees', '/api/people', '/api/hr/org', '/api/hr/leave'],
  },
  {
    key: 'attendance', area: 'hr', label: 'Attendance',
    description: 'Check-in / check-out, face verification, registers, work from home',
    routes: ['/hr/attendance'],
    apiPrefixes: ['/api/hr/attendance'],
  },
  {
    key: 'payroll', area: 'hr', label: 'Payroll',
    description: 'Salary structures, payroll runs, payslips, loans & advances',
    routes: ['/hr/payroll'],
    apiPrefixes: ['/api/hr/payroll'],
  },
  // ── CRM ──
  {
    key: 'crm', area: 'crm', label: 'Contacts & pipeline',
    description: 'Contacts, companies, leads, deals & pipelines, activities',
    routes: ['/crm'],
    apiPrefixes: ['/api/crm'],
  },
  {
    key: 'sales_docs', area: 'crm', label: 'Quotes & invoices',
    description: 'Quotes with e-signature, invoices and quote templates',
    routes: ['/quotes', '/invoices'],
    apiPrefixes: ['/api/quotes', '/api/invoices', '/api/templates/quotes'],
  },
  {
    key: 'campaigns', area: 'crm', label: 'Campaigns',
    description: 'Email campaigns to contacts and leads',
    routes: ['/campaigns'],
    apiPrefixes: ['/api/campaigns'],
  },
  // ── IT Desk ──
  {
    key: 'itdesk', area: 'itdesk', label: 'Tickets',
    description: 'Tickets, categories, SLA policies, change requests, time tracking, CSAT',
    routes: ['/itdesk/tickets', '/itdesk/categories', '/change-requests'],
    apiPrefixes: ['/api/itdesk/tickets', '/api/itdesk/categories', '/api/itdesk/sla-policies', '/api/itdesk/time-tracking', '/api/change-requests', '/api/csat'],
  },
  {
    key: 'assets', area: 'itdesk', label: 'Assets',
    description: 'IT asset inventory and assignments',
    routes: ['/itdesk/assets'],
    apiPrefixes: ['/api/itdesk/assets'],
  },
  {
    key: 'knowledge_base', area: 'itdesk', label: 'Knowledge base',
    description: 'Help articles for staff and the customer portal',
    routes: ['/itdesk/articles'],
    apiPrefixes: ['/api/itdesk/articles'],
  },
  {
    key: 'customer_portal', area: 'itdesk', label: 'Customer portal',
    description: 'Self-service portal where customers raise and track tickets (plan feature)',
    routes: ['/portal-users'],
    apiPrefixes: ['/api/portal-users', '/api/portal'],
  },
];

export const MODULE_KEYS: FeatureKey[] = MODULE_CATALOGUE.map(m => m.key);
export const AREA_ROOTS: FeatureKey[] = AREAS.map(a => a.root);

/** Feature keys introduced with the catalogue. Unlike the older keys (where a
 *  key missing from the PLAN only locks creating new things and keeps
 *  existing data readable), these switch their whole module off whenever the
 *  licence lacks them. Every plan includes them by default. */
export const AREA_MODULE_KEYS: FeatureKey[] = ['crm', 'itdesk', 'sales_docs', 'assets', 'knowledge_base'];

export function moduleDef(key: string): ModuleDef | undefined {
  return MODULE_CATALOGUE.find(m => m.key === key);
}

export function areaDef(key: string): AreaDef | undefined {
  return AREAS.find(a => a.key === key);
}

export function areaOf(key: string): AreaDef | undefined {
  const m = moduleDef(key);
  return m ? areaDef(m.area) : undefined;
}

export function areaModuleKeys(area: AreaKey): FeatureKey[] {
  return MODULE_CATALOGUE.filter(m => m.area === area).map(m => m.key);
}

/** Module whose client routes cover `path` (longest prefix wins), if any. */
export function moduleForRoute(path: string): ModuleDef | undefined {
  let best: { m: ModuleDef; len: number } | undefined;
  for (const m of MODULE_CATALOGUE) {
    for (const r of m.routes) {
      if ((path === r || path.startsWith(r + '/')) && (!best || r.length > best.len)) best = { m, len: r.length };
    }
  }
  return best?.m;
}

/** Areas switched off by the operator, read from a disabledFeatures list. */
export function disabledAreas(disabled: readonly string[]): AreaKey[] {
  return AREAS.filter(a => disabled.includes(a.root)).map(a => a.key);
}

/**
 * Pure: the new disabledFeatures list after switching areas / sub-modules.
 *  - area ON  → every key of the area leaves the list (all sub-modules back);
 *  - area OFF → the area root joins the list (sub-module keys are left as
 *    they were, so nothing else is lost; they're off with the area anyway);
 *  - module ON/OFF → just that key (a sub-module can only be switched while
 *    its area is on — switching it ON also switches its area on).
 * Keys outside the catalogue already in the list are kept untouched.
 * Throws when the result would leave the org with no area at all.
 */
export function applyAreaChanges(
  current: readonly string[],
  changes: { areas?: Partial<Record<AreaKey, boolean>>; modules?: Partial<Record<string, boolean>> },
): string[] {
  const out = new Set(current);
  for (const [k, on] of Object.entries(changes.modules ?? {})) {
    const m = moduleDef(k);
    if (!m || on === undefined) continue;
    if (on) { out.delete(m.key); out.delete(areaDef(m.area)!.root); } else out.add(m.key);
  }
  for (const [k, on] of Object.entries(changes.areas ?? {})) {
    const a = areaDef(k);
    if (!a || on === undefined) continue;
    if (on) for (const key of areaModuleKeys(a.key)) out.delete(key);
    else out.add(a.root);
  }
  if (AREAS.every(a => out.has(a.root))) throw new Error('An organisation needs at least one area (HR, CRM or IT Desk) enabled.');
  return [...out];
}

/**
 * Shared screens that only make sense next to certain areas. Not licence
 * features (nothing to switch per org) — each is shown while at least ONE of
 * its `areas` is on, and hidden (page + API mount) otherwise, so an HR-only
 * org looks like an HR product. Decided per screen:
 *  - Inbox: customer email / WhatsApp conversations that become tickets or leads.
 *  - AI Builder: AI rules on ticket / lead / deal / contact events only.
 *  - Solution Builder: generates a CRM / help-desk style workspace.
 *  - Templates: record templates (ticket/contact/deal/lead), ticket replies,
 *    campaign emails, quotes.
 *  - Import: contacts and leads only.
 *  - Custom fields: on tickets, contacts, deals, leads only.
 *  - Web forms: create leads or tickets.
 *  - Analytics / Reports: ticket and CRM reports only (HR has its own
 *    registers inside Attendance / Payroll).
 *  - Slack / Microsoft Teams: ticket, SLA, deal and lead notifications.
 * Deliberately NOT listed (shown for every area): dashboard, My Work,
 * approvals, chat, workflows (HR has Leave-requested / Approval-decided /
 * custom-record triggers), AI Studio (business context + custom AI functions
 * and scripts work on any data), custom modules, users, roles, audit log,
 * API keys, branding, SSO, storage, billing, org settings.
 */
export interface SharedSurface { key: string; label: string; areas: AreaKey[]; routes: string[]; apiPrefixes: string[] }

export const SHARED_SURFACES: SharedSurface[] = [
  { key: 'inbox', label: 'Inbox', areas: ['crm', 'itdesk'], routes: ['/inbox'], apiPrefixes: ['/api/inbox'] },
  { key: 'ai_builder', label: 'AI Builder', areas: ['crm', 'itdesk'], routes: ['/ai-builder'], apiPrefixes: [] },
  { key: 'solution_builder', label: 'Solution Builder', areas: ['crm', 'itdesk'], routes: ['/solution-builder'], apiPrefixes: [] },
  { key: 'templates', label: 'Templates', areas: ['crm', 'itdesk'], routes: ['/templates'], apiPrefixes: ['/api/templates/records', '/api/templates/replies', '/api/templates/emails'] },
  { key: 'import', label: 'Import CSV', areas: ['crm'], routes: ['/import'], apiPrefixes: ['/api/import'] },
  { key: 'custom_fields', label: 'Custom fields', areas: ['crm', 'itdesk'], routes: ['/custom-fields'], apiPrefixes: [] },
  { key: 'web_forms', label: 'Web forms', areas: ['crm', 'itdesk'], routes: ['/web-forms'], apiPrefixes: ['/api/web-forms'] },
  // Only the prebuilt ticket/CRM report endpoints: the query layer under
  // /api/analytics (catalog, query, forecast — utils/analytics/) serves every
  // area, HR included, and gates each dataset by its own module.
  { key: 'analytics', label: 'Analytics & reports', areas: ['crm', 'itdesk'], routes: ['/analytics', '/reports'], apiPrefixes: ['/api/analytics/overview', '/api/analytics/tickets', '/api/analytics/crm', '/api/reports'] },
  { key: 'chat_integrations', label: 'Slack & Microsoft Teams', areas: ['crm', 'itdesk'], routes: ['/slack', '/teams'], apiPrefixes: ['/api/slack', '/api/teams'] },
];

/** Pure: areas whose root module is not blocked. */
export function enabledAreasFrom(blockedModules: readonly string[]): AreaKey[] {
  return AREAS.filter(a => !blockedModules.includes(a.root)).map(a => a.key);
}

/** Pure: is a shared surface relevant while only `enabled` areas are on? */
export function isSurfaceOn(surface: SharedSurface, enabled: readonly AreaKey[]): boolean {
  return surface.areas.some(a => enabled.includes(a));
}

/** Client-safe catalogue (what GET /billing/entitlements and the platform console send). */
export function publicCatalogue() {
  return {
    areas: AREAS.map(({ key, root, label, description, roles }) => ({ key, root, label, description, roles, modules: areaModuleKeys(key) })),
    modules: MODULE_CATALOGUE.map(({ key, area, label, description, routes }) => ({ key, area, label, description, routes })),
    surfaces: SHARED_SURFACES.map(({ key, label, areas, routes }) => ({ key, label, areas, routes })),
  };
}

/** Workflow triggers that belong to a module: not offered, refused on save and
 *  never fired while the module is off. Unlisted triggers (custom modules,
 *  approvals, date reached) aren't area switched. Mirrored by entity in the
 *  client's trigger picker (WorkflowsPage.tsx ENTITY_MODULE). */
export const WORKFLOW_TRIGGER_MODULE: Record<string, FeatureKey> = {
  TICKET_CREATED: 'itdesk', TICKET_UPDATED: 'itdesk', TICKET_STATUS_CHANGED: 'itdesk', SLA_BREACH: 'itdesk', CSAT_RECEIVED: 'itdesk',
  LEAD_CREATED: 'crm', LEAD_STATUS_CHANGED: 'crm', LEAD_ACTIVITY_COMPLETED: 'crm', DEAL_STAGE_CHANGED: 'crm', DEAL_WON: 'crm', DEAL_LOST: 'crm',
  INVOICE_STATUS_CHANGED: 'sales_docs', QUOTE_STATUS_CHANGED: 'sales_docs',
  LEAVE_REQUESTED: 'hr_core',
};
/** Workflow actions that create / act on a module's records. */
export const WORKFLOW_ACTION_MODULE: Record<string, FeatureKey> = {
  CREATE_TICKET: 'itdesk', SEND_CSAT_SURVEY: 'itdesk', SCORE_LEAD: 'crm',
};

// ─── Roles & permissions per area ────────────────────────────────────────────
//
// Roles & Permissions only shows what the org has: permissions of switched-off
// modules aren't listed or grantable, and built-in roles of a switched-off
// area aren't offered (users who already hold one keep it — the console shows
// it as "area off").

/** Permission `module.resource` → licence module. Unlisted (core.*, ai.*) are shared. */
export const PERMISSION_RESOURCE_MODULE: Record<string, FeatureKey> = {
  'crm.lead': 'crm', 'crm.contact': 'crm', 'crm.account': 'crm', 'crm.deal': 'crm', 'crm.activity': 'crm',
  'crm.quote': 'sales_docs', 'crm.invoice': 'sales_docs', 'crm.campaign': 'campaigns',
  'itdesk.ticket': 'itdesk', 'itdesk.change': 'itdesk', 'itdesk.category': 'itdesk', 'itdesk.sla': 'itdesk',
  'itdesk.asset': 'assets', 'itdesk.article': 'knowledge_base',
  'hr.employee': 'hr_core', 'hr.department': 'hr_core', 'hr.team': 'hr_core', 'hr.location': 'hr_core',
  'hr.leave': 'hr_core', 'hr.document': 'hr_core',
  'hr.attendance': 'attendance', 'hr.payslip': 'payroll', 'hr.salary': 'payroll',
};

/** Licence module of a permission key ("crm.deal.read" → 'crm'), or undefined when shared. */
export function permissionModule(key: string): FeatureKey | undefined {
  const [m, r] = key.split('.');
  return PERMISSION_RESOURCE_MODULE[`${m}.${r}`];
}

/** Field-rule resources ("employee", "payslip", "deal" …) → licence module. */
export function fieldResourceModule(resource: string): FeatureKey | undefined {
  const hit = Object.entries(PERMISSION_RESOURCE_MODULE).find(([k]) => k.split('.')[1] === resource);
  return hit?.[1];
}

/** Modules a built-in role is FOR — off when none of them is on. Unlisted roles are shared. */
export const ROLE_MODULES: Record<string, FeatureKey[]> = {
  CRM_MANAGER: ['crm'], SALES_REP: ['crm'],
  IT_MANAGER: ['itdesk'], IT_AGENT: ['itdesk'],
  HR_MANAGER: ['hr_core'],
  FINANCE: ['sales_docs', 'payroll'],
};

/** Pure: is a role (by key or legacy role) for an area that's off? */
export function isRoleAreaOff(role: { key?: string | null; legacyRole?: string | null }, blockedModules: readonly string[]): boolean {
  const mods = ROLE_MODULES[role.key ?? ''] ?? ROLE_MODULES[role.legacyRole ?? ''];
  return !!mods && mods.every(m => blockedModules.includes(m));
}

/** Built-in role descriptions that name areas, rewritten to the areas the org has. */
export function roleDescriptionFor(role: { key?: string | null; isSystem?: boolean | null; description?: string | null }, blockedModules: readonly string[]): string | null {
  if (!role.isSystem) return role.description ?? null;
  const on = (m: string) => !blockedModules.includes(m);
  if (role.key === 'FINANCE') {
    const parts = [on('sales_docs') && 'quotes, invoices', on('payroll') && 'payroll cost', 'expense approvals'].filter(Boolean);
    return `${String(parts.join(', ')).replace(/^./, c => c.toUpperCase())}.`;
  }
  if (role.key === 'EMPLOYEE') {
    const parts = [on('attendance') && 'attendance', on('hr_core') && 'leave', on('payroll') && 'payslips', 'requests'].filter(Boolean);
    return `Self-service only: own ${parts.join(', ')}.`;
  }
  return role.description ?? null;
}

/** Record entity types (as stored on notifications, tasks, custom fields,
 *  comments …) → licence module. Unlisted types are shared. */
export const ENTITY_TYPE_MODULE: Record<string, FeatureKey> = {
  TICKET: 'itdesk', CHANGE_REQUEST: 'itdesk', SLA: 'itdesk', ASSET: 'assets', ARTICLE: 'knowledge_base',
  CONTACT: 'crm', LEAD: 'crm', DEAL: 'crm', ACCOUNT: 'crm', ACTIVITY: 'crm', QUOTE: 'sales_docs', INVOICE: 'sales_docs', CAMPAIGN: 'campaigns',
  EMPLOYEE: 'hr_core', LEAVE_REQUEST: 'hr_core', LEAVE: 'hr_core', ATTENDANCE: 'attendance', PAYSLIP: 'payroll', PAYROLL_RUN: 'payroll',
};

/** Licence module of an entity type ("Ticket", "TICKET", "LeaveRequest" → …), if any. */
export function entityTypeModule(type: string | null | undefined): FeatureKey | undefined {
  if (!type) return undefined;
  const norm = type.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  return ENTITY_TYPE_MODULE[norm];
}
