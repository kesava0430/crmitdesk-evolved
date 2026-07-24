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
import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { runWorkflows } from './workflow-engine';
import { scoreLead as aiScoreLead } from './ai';
import { sendWhatsApp } from './whatsapp';
import { resolveRecipientPhone } from './notification-recipient';
import { MANAGERS, CRM_STAFF, IT_STAFF, ALL_STAFF } from '../middleware/authenticate';

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
];

export function getAiAction(name: string): AiActionDefinition | undefined {
  return AI_ACTIONS.find(a => a.name === name);
}

/** Menu shape handed to the LLM planner — name/description/params only, no handler/roles leaked into the prompt. */
export function actionMenuForPrompt() {
  return AI_ACTIONS.map(a => ({ name: a.name, description: a.description, params: a.paramsHint }));
}
