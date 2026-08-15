/**
 * AI Action Registry — the whitelist of everything an AI-driven command can
 * actually DO to the database.
 *
 * This is the safety boundary for the "AI Command" feature: the LLM never
 * gets to run its own query or invent behavior. It can only ever pick a
 * `name` from this list, and every handler here re-checks org scope and
 * role permission itself — the model's opinion of what's allowed is never
 * trusted, only its choice of *which* registered action to propose.
 *
 * Each action's `handler` deliberately mirrors the logic in the equivalent
 * hand-written controller (deals.controller.ts, tickets.controller.ts, etc.)
 * rather than importing it directly, since those controllers are shaped
 * around (req, res, next) and this registry needs a plain
 * (params, ctx) => result function that both the "execute" endpoint and
 * (later, if ever wanted) a background runner can call the same way.
 */
import { z, ZodSchema } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { runWorkflows } from './workflow-engine';
import { scoreLead as aiScoreLead } from './ai';
import { sendWhatsApp } from './whatsapp';
import { resolveRecipientPhone } from './notification-recipient';
import { MANAGERS, CRM_STAFF, IT_STAFF, ALL_STAFF, CRM_MANAGERS } from '../middleware/authenticate';
import { FIELD_TYPES, slugify, validateRecordData } from '../modules/custom-modules/customModules.service';

export interface AiActionContext {
  orgId: string;
  userId: string;
}

export interface AiActionResult {
  summary: string;
  data?: unknown;
}

export interface AiActionDefinition<TParams = any> {
  name: string;
  label: string;
  /** Shown to the LLM as part of its menu of choices — keep this precise. */
  description: string;
  /** Shown to the LLM so it knows what shape to fill `params` with. */
  paramsHint: string;
  /** Role names allowed to invoke this action — checked server-side, always. */
  allowedRoles: readonly string[];
  /** Destructive/irreversible/outbound actions should always require confirmation. */
  requiresConfirmation: boolean;
  schema: ZodSchema<TParams>;
  handler: (params: TParams, ctx: AiActionContext) => Promise<AiActionResult>;
}

async function assertOwnedByOrg(entityType: 'TICKET' | 'DEAL' | 'CONTACT', entityId: string, orgId: string) {
  const found = entityType === 'TICKET'
    ? await prisma.ticket.findFirst({ where: { id: entityId, orgId }, select: { id: true, title: true } })
    : entityType === 'DEAL'
      ? await prisma.deal.findFirst({ where: { id: entityId, orgId }, select: { id: true, title: true } })
      : await prisma.contact.findFirst({ where: { id: entityId, orgId }, select: { id: true, name: true } });
  if (!found) throw new AppError(404, `${entityType.toLowerCase()} not found`);
  return found;
}

export const AI_ACTIONS: AiActionDefinition[] = [
  // ── Move a deal to a different pipeline stage ──────────────────────────
  {
    name: 'MOVE_DEAL_STAGE',
    label: 'Move deal stage',
    description: 'Moves a deal to a different pipeline stage (e.g. "move the Acme deal to Proposal").',
    paramsHint: '{ dealId: string, stage: string }',
    allowedRoles: CRM_STAFF,
    requiresConfirmation: true,
    schema: z.object({ dealId: z.string().min(1), stage: z.string().min(1) }),
    handler: async (params, ctx) => {
      const existing = await prisma.deal.findFirst({ where: { id: params.dealId, orgId: ctx.orgId } });
      if (!existing) throw new AppError(404, 'Deal not found');
      const deal = await prisma.deal.update({ where: { id: params.dealId }, data: { stage: params.stage } });
      await prisma.dealHistory.create({
        data: { dealId: deal.id, fromStage: existing.stage, toStage: params.stage, changedBy: ctx.userId },
      });
      runWorkflows({
        trigger: 'DEAL_STAGE_CHANGED', orgId: ctx.orgId, entityType: 'DEAL',
        entityId: deal.id, entity: deal as any, previousEntity: existing as any,
      }).catch(() => {});
      return { summary: `Moved "${deal.title}" from ${existing.stage} to ${params.stage}.`, data: deal };
    },
  },

  // ── Change a ticket's status ────────────────────────────────────────────
  {
    name: 'UPDATE_TICKET_STATUS',
    label: 'Change ticket status',
    description: 'Changes a ticket\'s status (e.g. "mark the VPN ticket as resolved").',
    paramsHint: '{ ticketId: string, status: "OPEN"|"IN_PROGRESS"|"PENDING"|"RESOLVED"|"CLOSED" }',
    allowedRoles: IT_STAFF,
    requiresConfirmation: true,
    schema: z.object({
      ticketId: z.string().min(1),
      status: z.enum(['OPEN', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED']),
    }),
    handler: async (params, ctx) => {
      const existing = await prisma.ticket.findFirst({ where: { id: params.ticketId, orgId: ctx.orgId } });
      if (!existing) throw new AppError(404, 'Ticket not found');
      const data: any = { status: params.status };
      if (params.status === 'RESOLVED') data.resolvedAt = new Date();
      if (params.status === 'CLOSED') data.closedAt = new Date();
      const ticket = await prisma.ticket.update({ where: { id: params.ticketId }, data });
      await prisma.ticketHistory.create({
        data: { ticketId: ticket.id, fromStatus: existing.status, toStatus: params.status, changedBy: ctx.userId },
      });
      runWorkflows({
        trigger: 'TICKET_STATUS_CHANGED', orgId: ctx.orgId, entityType: 'TICKET',
        entityId: ticket.id, entity: ticket as any, previousEntity: existing as any,
      }).catch(() => {});
      return { summary: `Set "${ticket.title}" to ${params.status}.`, data: ticket };
    },
  },

  // ── Schedule a WhatsApp reminder ────────────────────────────────────────
  {
    name: 'SCHEDULE_WHATSAPP_REMINDER',
    label: 'Schedule a WhatsApp reminder',
    description: 'Schedules a future WhatsApp reminder on a ticket or deal (e.g. "remind the assignee about the Acme deal tomorrow at 9am").',
    paramsHint: '{ entityType: "TICKET"|"DEAL", entityId: string, dueAt: ISO datetime string, message: string, recipientType?: "CONTACT"|"ASSIGNEE"|"CUSTOM_NUMBER"|"ORG_DEFAULT" (default ASSIGNEE), customNumber?: string, recurrence?: "NONE"|"DAILY"|"WEEKLY" (default NONE) }',
    allowedRoles: ALL_STAFF,
    requiresConfirmation: true,
    schema: z.object({
      entityType: z.enum(['TICKET', 'DEAL']),
      entityId: z.string().min(1),
      dueAt: z.string().min(1),
      message: z.string().min(1).max(1000),
      recipientType: z.enum(['CONTACT', 'ASSIGNEE', 'CUSTOM_NUMBER', 'ORG_DEFAULT']).default('ASSIGNEE'),
      customNumber: z.preprocess(v => (v === '' ? undefined : v), z.string().optional()),
      recurrence: z.enum(['NONE', 'DAILY', 'WEEKLY']).default('NONE'),
    }),
    handler: async (params, ctx) => {
      if (params.recipientType === 'CUSTOM_NUMBER' && !params.customNumber) {
        throw new AppError(400, 'A phone number is required when the recipient is "Custom number"');
      }
      if (params.recipientType === 'CONTACT' && params.entityType !== 'DEAL') {
        throw new AppError(400, 'Only deals have a linked contact — choose a different recipient for tickets');
      }
      const exists = params.entityType === 'TICKET'
        ? await prisma.ticket.findFirst({ where: { id: params.entityId, orgId: ctx.orgId }, select: { id: true, title: true } })
        : await prisma.deal.findFirst({ where: { id: params.entityId, orgId: ctx.orgId }, select: { id: true, title: true } });
      if (!exists) throw new AppError(404, `${params.entityType === 'TICKET' ? 'Ticket' : 'Deal'} not found`);

      const schedule = await prisma.schedule.create({
        data: {
          orgId: ctx.orgId,
          entityType: params.entityType,
          entityId: params.entityId,
          dueAt: new Date(params.dueAt),
          recurrence: params.recurrence,
          message: params.message,
          recipientType: params.recipientType,
          customNumber: params.customNumber || null,
          createdBy: ctx.userId,
        },
      });
      return { summary: `Scheduled a reminder on "${exists.title}" for ${new Date(params.dueAt).toLocaleString()}.`, data: schedule };
    },
  },

  // ── Send a WhatsApp message right now (not scheduled) ───────────────────
  {
    name: 'SEND_WHATSAPP_NOW',
    label: 'Send a WhatsApp message now',
    description: 'Sends a WhatsApp message immediately (not scheduled) to the resolved recipient of a ticket or deal.',
    paramsHint: '{ entityType: "TICKET"|"DEAL", entityId: string, message: string, recipientType?: "CONTACT"|"ASSIGNEE"|"CUSTOM_NUMBER"|"ORG_DEFAULT" (default ASSIGNEE), customNumber?: string }',
    allowedRoles: ALL_STAFF,
    requiresConfirmation: true,
    schema: z.object({
      entityType: z.enum(['TICKET', 'DEAL']),
      entityId: z.string().min(1),
      message: z.string().min(1).max(1000),
      recipientType: z.enum(['CONTACT', 'ASSIGNEE', 'CUSTOM_NUMBER', 'ORG_DEFAULT']).default('ASSIGNEE'),
      customNumber: z.preprocess(v => (v === '' ? undefined : v), z.string().optional()),
    }),
    handler: async (params, ctx) => {
      if (params.recipientType === 'CUSTOM_NUMBER' && !params.customNumber) {
        throw new AppError(400, 'A phone number is required when the recipient is "Custom number"');
      }
      const phone = await resolveRecipientPhone({
        orgId: ctx.orgId,
        entityType: params.entityType,
        entityId: params.entityId,
        recipientType: params.recipientType,
        customNumber: params.customNumber,
      });
      await sendWhatsApp(ctx.orgId, phone, params.message);
      return { summary: `Sent a WhatsApp message to ${phone}.` };
    },
  },

  // ── Add a note/comment ───────────────────────────────────────────────────
  {
    name: 'ADD_NOTE',
    label: 'Add a note',
    description: 'Adds a note/comment to a ticket, deal, or contact (e.g. "add a note on the Acme deal saying we followed up").',
    paramsHint: '{ entityType: "TICKET"|"DEAL"|"CONTACT", entityId: string, body: string }',
    allowedRoles: ALL_STAFF,
    requiresConfirmation: true,
    schema: z.object({
      entityType: z.enum(['TICKET', 'DEAL', 'CONTACT']),
      entityId: z.string().min(1),
      body: z.string().min(1).max(2000),
    }),
    handler: async (params, ctx) => {
      const entity = await assertOwnedByOrg(params.entityType, params.entityId, ctx.orgId);
      const comment = await prisma.comment.create({
        data: { entityType: params.entityType as any, entityId: params.entityId, body: params.body, authorId: ctx.userId },
      });
      const label = (entity as any).title || (entity as any).name || params.entityId;
      return { summary: `Added a note on "${label}".`, data: comment };
    },
  },

  // ── Score a lead ─────────────────────────────────────────────────────────
  {
    name: 'SCORE_LEAD',
    label: 'Score a lead',
    description: 'Runs AI lead scoring on a lead and saves the score (e.g. "score the John Doe lead").',
    paramsHint: '{ leadId: string }',
    allowedRoles: CRM_STAFF,
    requiresConfirmation: false,
    schema: z.object({ leadId: z.string().min(1) }),
    handler: async (params, ctx) => {
      const lead = await prisma.lead.findFirst({
        where: { id: params.leadId, orgId: ctx.orgId },
        include: { contact: { select: { name: true, email: true, jobTitle: true } } },
      });
      if (!lead) throw new AppError(404, 'Lead not found');
      const result = await aiScoreLead(lead as any);
      await prisma.lead.updateMany({
        where: { id: params.leadId, orgId: ctx.orgId },
        data: { aiScore: result.score, aiScoreReason: result.reason },
      });
      return { summary: `Scored "${lead.contact?.name || 'lead'}": ${result.score}/100 — ${result.reason}`, data: result };
    },
  },

  // ── Toggle a workflow rule on/off ────────────────────────────────────────
  {
    name: 'TOGGLE_WORKFLOW_RULE',
    label: 'Toggle a workflow rule',
    description: 'Turns an automation/workflow rule on or off by name (e.g. "disable the auto-assign rule").',
    paramsHint: '{ ruleId: string, isActive?: boolean (omit to just flip the current state) }',
    allowedRoles: MANAGERS,
    requiresConfirmation: true,
    schema: z.object({ ruleId: z.string().min(1), isActive: z.boolean().optional() }),
    handler: async (params, ctx) => {
      const rule = await prisma.workflowRule.findFirst({ where: { id: params.ruleId, orgId: ctx.orgId } });
      if (!rule) throw new AppError(404, 'Workflow rule not found');
      const nextActive = params.isActive ?? !rule.isActive;
      const updated = await prisma.workflowRule.update({ where: { id: params.ruleId }, data: { isActive: nextActive } });
      return { summary: `${nextActive ? 'Enabled' : 'Disabled'} the "${rule.name}" workflow rule.`, data: updated };
    },
  },

  // ── Assign a ticket to a user ────────────────────────────────────────────
  {
    name: 'ASSIGN_TICKET',
    label: 'Assign a ticket',
    description: 'Assigns a ticket to a specific agent and moves it to In Progress (e.g. "assign the VPN ticket to Priya"). Match the assignee by name from the assignableUsers context list.',
    paramsHint: '{ ticketId: string, assigneeId: string }',
    allowedRoles: IT_STAFF,
    requiresConfirmation: true,
    schema: z.object({ ticketId: z.string().min(1), assigneeId: z.string().min(1) }),
    handler: async (params, ctx) => {
      const ticket = await prisma.ticket.findFirst({ where: { id: params.ticketId, orgId: ctx.orgId } });
      if (!ticket) throw new AppError(404, 'Ticket not found');
      const assignee = await prisma.user.findFirst({ where: { id: params.assigneeId, orgId: ctx.orgId, isActive: true } });
      if (!assignee) throw new AppError(404, 'That user was not found in your organization');

      const updated = await prisma.ticket.update({
        where: { id: ticket.id },
        data: { assignedTo: assignee.id, status: 'IN_PROGRESS' },
      });
      return { summary: `Assigned "${ticket.title}" to ${assignee.name}.`, data: updated };
    },
  },

  // ── Change a lead's status ───────────────────────────────────────────────
  {
    name: 'UPDATE_LEAD_STATUS',
    label: 'Change lead status',
    description: 'Changes a lead\'s status (e.g. "mark the John Doe lead as qualified").',
    paramsHint: '{ leadId: string, status: "NEW"|"CONTACTED"|"QUALIFIED"|"UNQUALIFIED"|"CONVERTED" }',
    allowedRoles: CRM_STAFF,
    requiresConfirmation: true,
    schema: z.object({
      leadId: z.string().min(1),
      status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED']),
    }),
    handler: async (params, ctx) => {
      const existing = await prisma.lead.findFirst({ where: { id: params.leadId, orgId: ctx.orgId }, include: { contact: { select: { name: true } } } });
      if (!existing) throw new AppError(404, 'Lead not found');
      if (existing.status === 'CONVERTED') throw new AppError(400, 'This lead has already been converted — use the Convert flow to make further changes');
      // CONVERTED is a one-way, higher-stakes transition (creates a Deal
      // behind the scenes via the dedicated /leads/:id/convert endpoint) —
      // deliberately not something this quick status-change action performs,
      // to avoid a natural-language misfire accidentally converting a lead.
      if (params.status === 'CONVERTED') throw new AppError(400, 'Converting a lead creates a deal and can\'t be done from a quick status change — use the Convert action on the lead itself');

      const updated = await prisma.lead.update({ where: { id: existing.id }, data: { status: params.status } });
      runWorkflows({
        trigger: 'LEAD_STATUS_CHANGED', orgId: ctx.orgId, entityType: 'LEAD',
        entityId: updated.id, entity: updated as any, previousEntity: existing as any,
      }).catch(() => {});
      return { summary: `Set "${existing.contact?.name || 'lead'}" to ${params.status}.`, data: updated };
    },
  },

  // ── Create a new custom module (no-code object builder) ─────────────────
  {
    name: 'CREATE_CUSTOM_MODULE',
    label: 'Create a custom module',
    description: 'Creates a new custom module — a brand-new record type for data that doesn\'t fit CRM/IT Desk out of the box (e.g. "create a Vendor Contracts module under Admin"). Fields are added separately with ADD_CUSTOM_MODULE_FIELD — a module with no fields yet is invisible to everyone but managers. If the request doesn\'t say which part of the app it belongs to, default navSection to CRM.',
    paramsHint: '{ name: string, description?: string, navSection?: "CRM"|"IT_DESK"|"HR"|"ADMIN" (which sidebar section the module\'s link appears under once it has fields — default CRM) }',
    allowedRoles: CRM_MANAGERS,
    requiresConfirmation: true,
    schema: z.object({
      name: z.string().min(1).max(80),
      description: z.string().max(500).optional(),
      navSection: z.enum(['CRM', 'IT_DESK', 'HR', 'ADMIN']).default('CRM'),
    }),
    handler: async (params, ctx) => {
      let slug = slugify(params.name);
      let suffix = 0;
      while (await prisma.customModule.findFirst({ where: { orgId: ctx.orgId, slug: suffix ? `${slug}-${suffix}` : slug } })) {
        suffix += 1;
      }
      if (suffix) slug = `${slug}-${suffix}`;
      const module_ = await prisma.customModule.create({
        data: { orgId: ctx.orgId, name: params.name, slug, icon: 'Layers', description: params.description, navSection: params.navSection, createdBy: ctx.userId },
      });
      return { summary: `Created the "${module_.name}" module under ${params.navSection}. Add fields to it next — it won't show up for other users until it has at least one.`, data: module_ };
    },
  },

  // ── Add a field to an existing custom module ─────────────────────────────
  {
    name: 'ADD_CUSTOM_MODULE_FIELD',
    label: 'Add a field to a custom module',
    description: 'Adds a field to an existing custom module\'s schema (e.g. "add a Claim Amount currency field to Warranty Claims"). Match the module by name from the modules context list.',
    paramsHint: `{ moduleId: string, label: string, fieldType: ${FIELD_TYPES.map(t => `"${t}"`).join('|')}, options?: string[] (DROPDOWN only, the choices), required?: boolean, isPrimary?: boolean (use this field as the record's title in list views) }`,
    allowedRoles: CRM_MANAGERS,
    requiresConfirmation: true,
    schema: z.object({
      moduleId: z.string().min(1),
      label: z.string().min(1).max(80),
      fieldType: z.enum(FIELD_TYPES),
      options: z.array(z.string()).optional(),
      required: z.boolean().default(false),
      isPrimary: z.boolean().default(false),
    }),
    handler: async (params, ctx) => {
      const module_ = await prisma.customModule.findFirst({ where: { id: params.moduleId, orgId: ctx.orgId } });
      if (!module_) throw new AppError(404, 'Custom module not found');

      const fieldKey = slugify(params.label).replace(/-/g, '_');
      const existing = await prisma.customModuleField.findUnique({ where: { moduleId_fieldKey: { moduleId: module_.id, fieldKey } } });
      if (existing) throw new AppError(400, `A field with key "${fieldKey}" already exists on "${module_.name}"`);

      if (params.isPrimary) {
        await prisma.customModuleField.updateMany({ where: { moduleId: module_.id, isPrimary: true }, data: { isPrimary: false } });
      }

      const field = await prisma.customModuleField.create({
        data: {
          moduleId: module_.id, label: params.label, fieldKey, fieldType: params.fieldType,
          options: params.options, required: params.required, isPrimary: params.isPrimary,
        },
      });
      return { summary: `Added "${field.label}" (${field.fieldType}) to "${module_.name}".`, data: field };
    },
  },

  // ── Create a record in a custom module ───────────────────────────────────
  {
    name: 'CREATE_CUSTOM_MODULE_RECORD',
    label: 'Create a custom module record',
    description: 'Creates a record in an existing custom module (e.g. "add a Vendor Contracts record for Acme Supplies worth $5,000"). Match the module by name and its fields by fieldKey from the modules context list — never invent a fieldKey that isn\'t listed for that module.',
    paramsHint: '{ moduleId: string, data: { [fieldKey]: value } }',
    allowedRoles: ALL_STAFF,
    requiresConfirmation: true,
    schema: z.object({ moduleId: z.string().min(1), data: z.record(z.union([z.string(), z.number(), z.boolean()])) }),
    handler: async (params, ctx) => {
      const module_ = await prisma.customModule.findFirst({ where: { id: params.moduleId, orgId: ctx.orgId } });
      if (!module_) throw new AppError(404, 'Custom module not found');
      const fields = await prisma.customModuleField.findMany({ where: { moduleId: module_.id } });
      if (!fields.length) throw new AppError(400, `"${module_.name}" has no fields defined yet`);

      const data = validateRecordData(fields, params.data);
      const record = await prisma.customModuleRecord.create({
        data: { moduleId: module_.id, orgId: ctx.orgId, data: data as Prisma.InputJsonValue, source: 'MANUAL', createdBy: ctx.userId },
      });
      return { summary: `Created a new "${module_.name}" record.`, data: record };
    },
  },
];

export function getAiAction(name: string): AiActionDefinition | undefined {
  return AI_ACTIONS.find(a => a.name === name);
}

/** Menu shape handed to the LLM planner — name/description/params only, no handler/roles leaked into the prompt. */
export function actionMenuForPrompt() {
  return AI_ACTIONS.map(a => ({ name: a.name, description: a.description, params: a.paramsHint }));
}
