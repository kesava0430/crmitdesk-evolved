/**
 * AI Action Registry — the whitelist of everything an AI-driven command can
 * actually DO to the database.
 *
 * This is the safety boundary for the "run day-to-day work by typing" claim:
 * the LLM never runs its own query or invents behaviour. It can only pick
 * `name`s from this list and fill their params; the server then
 *   1. validates the params with the action's zod schema,
 *   2. checks the user's legacy role (allowedRoles — mirrors the UI route's
 *      requireRole), the permission engine key and, for actions on an
 *      existing record, the record scope (canAccessRecord),
 *   3. checks the org's areas/modules (utils/modules.ts),
 *   4. shows a before → after card with a risk level (high → a second
 *      explicit confirmation), and only then
 *   5. runs the handler — which, for every action, calls the SAME controller
 *      function the screen calls (utils/aiActions/invoke.ts), so the UI and
 *      the assistant can never disagree about a business rule.
 *
 * Definitions live per area in utils/aiActions/actions/*.ts; the few
 * cross-cutting ones (workflow rules, custom modules, lead scoring, manual
 * attendance sessions) are below.
 */
import { z } from 'zod';
import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { scoreLead as aiScoreLead } from './ai';
import { MANAGERS, CRM_STAFF, ALL_STAFF, CRM_MANAGERS } from '../middleware/authenticate';
import { HR_MANAGERS, hrAccessFor } from './hrAccess';
import { FIELD_TYPES, recordTitle } from '../modules/custom-modules/customModules.service';
import * as customModules from '../modules/custom-modules/customModules.controller';
import * as workflows from '../modules/workflows/workflows.controller';
import * as attendance from '../modules/hr/attendance/attendance.controller';
import { ENTITY_TYPE_MODULE } from './modules';
import { can, type PermCtx } from './permissions';
import { HR_ACTIONS } from './aiActions/actions/hr';
import { CRM_ACTIONS } from './aiActions/actions/crm';
import { ITDESK_ACTIONS } from './aiActions/actions/itdesk';
import { SHARED_ACTIONS } from './aiActions/actions/shared';
import { callUi, listPreview, out, zDateTime, zId } from './aiActions/helpers';
import type { AiActionDefinition, Risk } from './aiActions/types';

export type { AiActionDefinition, AiActionContext, AiActionResult, Risk, ActionPreview, StepOutput } from './aiActions/types';

const CORE_ACTIONS: AiActionDefinition[] = [
  // ── Score a lead (AI) ────────────────────────────────────────────────────
  {
    name: 'SCORE_LEAD', label: 'Score a lead', category: 'CRM',
    description: 'Runs AI lead scoring on a lead and saves the score (e.g. "score the John Doe lead").',
    example: 'Score the John Doe lead',
    paramsHint: '{ leadId: lead\'s name }',
    allowedRoles: CRM_STAFF, permission: 'crm.lead.update', modules: ['crm'], requiresConfirmation: false, risk: 'low',
    record: { entity: 'lead', param: 'leadId', permission: 'crm.lead.update' },
    schema: z.object({ leadId: zId }),
    sample: { leadId: 'l1' },
    handler: async (params, ctx) => {
      const lead = await prisma.lead.findFirst({ where: { id: params.leadId, orgId: ctx.orgId }, include: { contact: { select: { name: true, email: true, jobTitle: true } } } });
      if (!lead) throw new AppError(404, 'Lead not found');
      const result = await aiScoreLead(lead as any);
      // Same rule as the Score button: only a genuine assessment is saved — a
      // placeholder 50 (AI unavailable / unparseable reply) never is.
      if (!result.scored) throw new AppError(503, 'The AI could not score this lead right now — nothing was saved.');
      await prisma.lead.updateMany({ where: { id: params.leadId, orgId: ctx.orgId }, data: { aiScore: result.score, aiScoreReason: result.reason } });
      return { summary: `Scored “${lead.contact?.name || 'lead'}”: ${result.score}/100 — ${result.reason}`, data: { id: lead.id, ...result } };
    },
    output: r => out('lead', r.data),
  },

  // ── Workflow rule on/off (Workflows → toggle) ────────────────────────────
  {
    name: 'TOGGLE_WORKFLOW_RULE', label: 'Turn a workflow rule on/off', category: 'Admin',
    description: 'Turns an automation/workflow rule on or off by name (e.g. "disable the auto-assign rule").',
    example: 'Disable the auto-assign rule',
    paramsHint: '{ ruleId: rule name, isActive?: boolean (omit to flip) }',
    allowedRoles: MANAGERS, permission: 'core.workflow.update', requiresConfirmation: true, risk: 'medium',
    record: { entity: 'rule', param: 'ruleId' },
    schema: z.object({ ruleId: zId, isActive: z.boolean().optional() }),
    sample: { ruleId: 'r1', isActive: false },
    preview: async (p, _ctx, info) => {
      const next = p.isActive ?? !info.row?.isActive;
      return { title: `${next ? 'Turn on' : 'Turn off'} “${info.row?.name ?? 'rule'}”`, changes: [{ field: 'Active', before: info.row ? (info.row.isActive ? 'On' : 'Off') : null, after: next ? 'On' : 'Off' }] };
    },
    handler: async (p, ctx) => {
      const rule = await prisma.workflowRule.findFirst({ where: { id: p.ruleId, orgId: ctx.orgId } });
      if (!rule) throw new AppError(404, 'Workflow rule not found');
      const want = p.isActive ?? !rule.isActive;
      if (want === rule.isActive) return { summary: `“${rule.name}” is already ${want ? 'on' : 'off'} — nothing changed.`, data: rule };
      const updated = await callUi(workflows.toggleActive, ctx, { params: { id: rule.id } });
      return { summary: `${updated.isActive ? 'Enabled' : 'Disabled'} the “${rule.name}” workflow rule.`, data: updated };
    },
    output: r => out('rule', r.data),
  },

  // ── Custom modules (no-code builder) ─────────────────────────────────────
  {
    name: 'CREATE_CUSTOM_MODULE', label: 'Create a custom module', category: 'Admin',
    description: 'Creates a new custom module — a brand-new record type (e.g. "create a Vendor Contracts module under Admin"). Fields are added with ADD_CUSTOM_MODULE_FIELD. Default navSection is CRM.',
    example: 'Create a Vendor Contracts module under Admin',
    paramsHint: '{ name: string, description?: string, navSection?: "CRM"|"IT_DESK"|"HR"|"ADMIN" }',
    allowedRoles: CRM_MANAGERS, requiresConfirmation: true, risk: 'medium',
    schema: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional(), navSection: z.enum(['CRM', 'IT_DESK', 'HR', 'ADMIN']).default('CRM') }),
    sample: { name: 'Vendor Contracts', navSection: 'ADMIN' },
    preview: async (p, _ctx, info) => listPreview(`Create the “${p.name}” module`, p, info),
    handler: async (p, ctx) => {
      const m = await callUi(customModules.createModule, ctx, { body: p });
      return { summary: `Created the “${m.name}” module under ${m.navSection ?? p.navSection}. Add fields to it next — it won't show for others until it has one.`, data: m };
    },
    output: r => out('module', r.data),
  },
  {
    name: 'ADD_CUSTOM_MODULE_FIELD', label: 'Add a field to a custom module', category: 'Admin',
    description: 'Adds a field to an existing custom module (e.g. "add a Claim Amount currency field to Warranty Claims").',
    example: 'Add a Claim Amount currency field to Warranty Claims',
    paramsHint: `{ moduleId: module name, label: string, fieldType: ${FIELD_TYPES.map(t => `"${t}"`).join('|')}, options?: string[] (DROPDOWN only), required?: boolean, isPrimary?: boolean }`,
    allowedRoles: CRM_MANAGERS, requiresConfirmation: true, risk: 'medium',
    refs: { moduleId: 'module' },
    schema: z.object({ moduleId: zId, label: z.string().min(1).max(80), fieldType: z.enum(FIELD_TYPES), options: z.array(z.string()).optional(), required: z.boolean().default(false), isPrimary: z.boolean().default(false) }),
    sample: { moduleId: 'm1', label: 'Claim Amount', fieldType: 'CURRENCY' },
    preview: async (p, _ctx, info) => listPreview(`Add field “${p.label}” to ${info.labels.moduleId ?? 'the module'}`, p, info),
    handler: async (p, ctx) => {
      const { moduleId, ...body } = p;
      const f = await callUi(customModules.addField, ctx, { params: { id: moduleId }, body });
      return { summary: `Added “${f.label}” (${f.fieldType}).`, data: f };
    },
    output: (r, p) => ({ id: (r.data as any)?.id, type: 'field', label: (r.data as any)?.label, link: '/custom-modules', moduleId: p.moduleId }),
  },
  {
    name: 'CREATE_CUSTOM_MODULE_RECORD', label: 'Create a custom module record', category: 'Shared',
    description: 'Creates a record in an existing custom module (e.g. "add a Vehicle Inventory record for the 2025 Kia EV6 at $41,000"). Use only fieldKeys listed for that module; stage must be one of its stage keys.',
    example: 'Add a Vehicle Inventory record for the 2025 Kia EV6 at $41,000',
    paramsHint: '{ moduleId: module name, data: { [fieldKey]: value }, stage?: stage key }',
    allowedRoles: ALL_STAFF, requiresConfirmation: true, risk: 'low',
    refs: { moduleId: 'module' },
    schema: z.object({ moduleId: zId, data: z.record(z.union([z.string(), z.number(), z.boolean()])), stage: z.string().max(40).optional() }),
    sample: { moduleId: 'm1', data: { model: 'Kia EV6', price: 41000 } },
    preview: async (p, ctx, info) => {
      const fields = /^\$/.test(p.moduleId) ? [] : await prisma.customModuleField.findMany({ where: { moduleId: p.moduleId, module: { orgId: ctx.orgId } }, select: { fieldKey: true, label: true } });
      return {
        title: `Create a record in ${info.labels.moduleId ?? 'the module'}`,
        changes: [...Object.entries(p.data).map(([k, v]) => ({ field: fields.find(f => f.fieldKey === k)?.label ?? k, after: String(v) })), ...(p.stage ? [{ field: 'Stage', after: p.stage }] : [])],
      };
    },
    handler: async (p, ctx) => {
      const rec = await callUi(customModules.createRecord, ctx, { params: { id: p.moduleId }, body: { data: p.data, ...(p.stage ? { stage: p.stage } : {}) } });
      const fields = await prisma.customModuleField.findMany({ where: { moduleId: p.moduleId } });
      return { summary: `Created “${recordTitle(fields, rec.data, rec.id)}”${rec.stage ? ` (${rec.stage})` : ''}.`, data: rec };
    },
    output: (r, p) => ({ id: (r.data as any)?.id, type: 'customRecord', label: 'Record', link: '/custom-modules', moduleId: p.moduleId }),
  },
  {
    name: 'MOVE_CUSTOM_RECORD_STAGE', label: 'Move a record to another stage', category: 'Shared',
    description: 'Moves a custom-module record to another pipeline stage (e.g. "move the 2025 Kia EV6 to reserved"). stage must be one of the module\'s stage keys; give the record\'s title as recordTitle.',
    example: 'Move the 2025 Kia EV6 to reserved',
    paramsHint: '{ moduleId: module name, recordId?: string, recordTitle?: string, stage: stage key }',
    allowedRoles: ALL_STAFF, requiresConfirmation: true, risk: 'low',
    refs: { moduleId: 'module' },
    schema: z.object({ moduleId: zId, recordId: z.string().optional(), recordTitle: z.string().max(200).optional(), stage: z.string().min(1).max(40) })
      .refine(p => p.recordId || p.recordTitle, { message: 'recordId or recordTitle is required' }),
    sample: { moduleId: 'm1', recordTitle: 'Kia EV6', stage: 'reserved' },
    preview: async (p, ctx, info) => {
      const r = /^\$/.test(p.moduleId) ? null : await findRecordByTitle(ctx.orgId, p);
      return { title: `Move “${r?.title ?? p.recordTitle ?? 'record'}” to ${p.stage} in ${info.labels.moduleId ?? 'the module'}`, changes: [{ field: 'Stage', before: r?.record.stage ?? null, after: p.stage }] };
    },
    handler: async (p, ctx) => {
      const found = await findRecordByTitle(ctx.orgId, p);
      const rec = await callUi(customModules.setRecordStage, ctx, { params: { id: p.moduleId, recordId: found.record.id }, body: { stage: p.stage } });
      return { summary: `Moved “${found.title}” to ${p.stage}.`, data: rec };
    },
    output: (r, p) => ({ id: (r.data as any)?.id, type: 'customRecord', label: 'Record', link: '/custom-modules', moduleId: p.moduleId }),
  },

  // ── Manual attendance session (Attendance → Manual entry) ────────────────
  {
    name: 'MANUAL_ATTENDANCE_ENTRY', label: 'Add a manual attendance session', category: 'HR',
    description: 'Adds a manual check-in/check-out session for an employee, bypassing location checks (e.g. "log John as present today from 9 to 5"). Self check-in isn\'t an AI action — it needs the employee\'s own device. To just set a day\'s status use MARK_ATTENDANCE.',
    example: 'Log John as present today from 9am to 5pm',
    paramsHint: '{ userId: employee\'s name, checkInAt: date-time words or ISO, checkOutAt?: date-time (required for past days), reason: string, notes?: string }',
    allowedRoles: HR_MANAGERS, hrArea: 'attendance', modules: ['attendance'], requiresConfirmation: true, risk: 'medium',
    refs: { userId: 'user' }, dates: { checkInAt: 'datetime', checkOutAt: 'datetime' },
    schema: z.object({ userId: zId, date: z.string().optional(), checkInAt: zDateTime, checkOutAt: zDateTime.optional(), reason: z.string().min(1).max(300), notes: z.string().max(300).optional() })
      .refine(p => !p.checkOutAt || p.checkOutAt > p.checkInAt, { message: 'Check-out must be after check-in', path: ['checkOutAt'] }),
    sample: { userId: 'u1', checkInAt: '2026-10-16T03:30:00.000Z', checkOutAt: '2026-10-16T11:30:00.000Z', reason: 'Forgot to check in' },
    preview: async (p, _ctx, info) => listPreview(`Add a manual session for ${info.labels.userId ?? 'the employee'}`, p, info, ['date']),
    handler: async (p, ctx) => {
      const r = await callUi(attendance.manualEntry, ctx, { body: { userId: p.userId, checkInAt: new Date(p.checkInAt).toISOString(), checkOutAt: p.checkOutAt ? new Date(p.checkOutAt).toISOString() : null, notes: p.notes, reason: `${p.reason} (via AI assistant)` } });
      const u = await prisma.user.findFirst({ where: { id: p.userId, orgId: ctx.orgId }, select: { name: true } });
      return { summary: `Added a manual attendance session for ${u?.name ?? 'the employee'}.`, data: r };
    },
    output: () => ({ type: 'attendance', label: 'Attendance register', link: '/hr/attendance' }),
  },
];

async function findRecordByTitle(orgId: string, p: { moduleId: string; recordId?: string; recordTitle?: string }) {
  const module_ = await prisma.customModule.findFirst({ where: { id: p.moduleId, orgId } });
  if (!module_) throw new AppError(404, 'Custom module not found');
  const fields = await prisma.customModuleField.findMany({ where: { moduleId: module_.id }, orderBy: { position: 'asc' } });
  let record = p.recordId ? await prisma.customModuleRecord.findFirst({ where: { id: p.recordId, moduleId: module_.id } }) : null;
  if (!record && p.recordTitle) {
    /* Title match in JS rather than a JSON-path query: modules are small
       (bounded fetch), and this gets case-insensitive matching for free. */
    const candidates = await prisma.customModuleRecord.findMany({ where: { moduleId: module_.id, orgId }, orderBy: { updatedAt: 'desc' }, take: 200 });
    const needle = p.recordTitle.toLowerCase();
    const matches = candidates.filter(r => recordTitle(fields, r.data as Record<string, unknown>, r.id).toLowerCase().includes(needle));
    if (matches.length === 0) throw new AppError(404, `No ${module_.name} record matches "${p.recordTitle}"`);
    if (matches.length > 1) throw new AppError(400, `"${p.recordTitle}" matches ${matches.length} ${module_.name} records — be more specific`);
    record = matches[0];
  }
  if (!record) throw new AppError(404, 'Record not found');
  return { record, title: recordTitle(fields, record.data as Record<string, unknown>, record.id) };
}

export const AI_ACTIONS: AiActionDefinition[] = [...HR_ACTIONS, ...CRM_ACTIONS, ...ITDESK_ACTIONS, ...SHARED_ACTIONS, ...CORE_ACTIONS];

// Registry integrity — a duplicate name would make one definition unreachable.
{
  const seen = new Set<string>();
  for (const a of AI_ACTIONS) {
    if (seen.has(a.name)) throw new Error(`Duplicate AI action ${a.name}`);
    seen.add(a.name);
  }
}

// ─── Access checks (pure — unit-tested) ──────────────────────────────────────

export function getAiAction(name: string): AiActionDefinition | undefined {
  return AI_ACTIONS.find(a => a.name === name);
}

export function riskOf(def: AiActionDefinition, params: any): Risk {
  const r = typeof def.risk === 'function' ? safe(() => (def.risk as (p: any) => Risk)(params ?? {}), 'medium') : def.risk;
  return r ?? 'medium';
}
function safe<T>(f: () => T, fallback: T): T { try { return f(); } catch { return fallback; } }

/** Pure: may `name` be offered while `blockedModules` are off? Offered while ANY of its modules is on. */
export function isActionAvailable(name: string, blockedModules: readonly string[] = []): boolean {
  const mods = getAiAction(name)?.modules;
  return !mods || !mods.length || mods.some(m => !blockedModules.includes(m));
}

/** Pure: why this specific call can't run because of the org's areas (null = fine). */
export function actionBlockedReason(name: string, params: any, blockedModules: readonly string[] = []): string | null {
  if (!isActionAvailable(name, blockedModules)) return 'That action works on an area that isn’t enabled for your organisation.';
  const t = params && typeof params.entityType === 'string' ? ENTITY_TYPE_MODULE[params.entityType] : undefined;
  if (t && blockedModules.includes(t)) return 'That record type belongs to an area that isn’t enabled for your organisation.';
  return null;
}

/** Pure: why this user can't run the action at all (null = allowed). Role first (mirrors the route), then the permission engine. */
export function roleBlockedReason(def: AiActionDefinition, role: string, perm?: PermCtx): string | null {
  // HR actions also admit whoever manages that HR area (HR Manager role, or a
  // custom role with the matching permission) — same rule as the HR routes.
  const hrOk = !!def.hrArea && !!perm && hrAccessFor({ role: perm.role, roleKey: perm.roleKey, grants: perm.grants })[def.hrArea];
  if (!hrOk && !def.allowedRoles.includes(role as any)) return `Your role isn't permitted to ${def.label.charAt(0).toLowerCase()}${def.label.slice(1)}.`;
  if (perm && def.permission && !can(perm, def.permission)) return `You don't have the “${def.permission}” permission needed to ${def.label.charAt(0).toLowerCase()}${def.label.slice(1)}.`;
  return null;
}

function offered(a: AiActionDefinition, role: string | undefined, blockedModules: readonly string[], perm?: PermCtx) {
  return (!role || !roleBlockedReason(a, role, perm)) && isActionAvailable(a.name, blockedModules);
}

/** Menu shape handed to the LLM planner — name/description/params only, no handler/roles leaked into the prompt. */
export function actionMenuForPrompt(role?: string, blockedModules: readonly string[] = [], perm?: PermCtx) {
  /* With a role, only the actions that role may run. Every action costs the
     planner ~80 prompt tokens on every request, and offering an action the
     execute step would reject only produces a "you're not allowed" card. The
     list is the same for everyone with that role, so the provider's prompt
     cache still applies. */
  return AI_ACTIONS
    .filter(a => offered(a, role, blockedModules, perm))
    .map(a => ({ name: a.name, description: a.description, params: a.paramsHint }));
}

/**
 * The "what can I say" help panel (GET /api/ai/actions), generated from the
 * registry and filtered exactly like execution: role, permission engine, and
 * the org's areas — so it can never show an action this user couldn't run.
 */
/* Shared actions that work on IT Desk or CRM records carry one example; when
   that example's area is switched off for the org, the help panel shows the
   other area's wording instead (an IT-only org isn't shown "the Acme deal"). */
const AREA_EXAMPLES: Record<string, { itdesk: string; crm: string }> = {
  ADD_NOTE: { itdesk: 'Add a note on the VPN ticket: waiting for the vendor to replace the router', crm: 'Add a note on the Acme deal: they want the revised proposal by Friday' },
  SCHEDULE_WHATSAPP_REMINDER: { itdesk: 'Remind me on WhatsApp about the VPN ticket tomorrow at 9am', crm: 'Remind me on WhatsApp about the Acme deal tomorrow at 9am' },
  SEND_WHATSAPP_NOW: { itdesk: 'Send a WhatsApp message to the VPN ticket requester saying the fix is in progress', crm: 'Send a WhatsApp message to the Acme deal contact saying the proposal is on its way' },
};

export function exampleFor(a: Pick<AiActionDefinition, 'name' | 'example'>, blockedModules: readonly string[] = []): string {
  const alt = AREA_EXAMPLES[a.name];
  if (!alt) return a.example;
  if (blockedModules.includes('itdesk')) return alt.crm;
  if (blockedModules.includes('crm')) return alt.itdesk;
  return a.example;
}

export function listActionsForRole(role: string, blockedModules: readonly string[] = [], perm?: PermCtx) {
  return AI_ACTIONS
    .filter(a => offered(a, role, blockedModules, perm))
    .map(a => ({
      name: a.name, label: a.label, description: a.description, example: exampleFor(a, blockedModules),
      category: a.category ?? 'Shared', risk: typeof a.risk === 'string' ? a.risk : 'varies',
    }));
}
