import { prisma } from './prisma';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { sendWhatsApp } from './whatsapp';
import { resolveRecipientPhone } from './notification-recipient';

// ─── Outbound webhook delivery (signed + retried) ─────────────────────────────
// Previously this action fired a single, unsigned fetch() with no retry —
// a receiver had no way to verify the payload actually came from us, and a
// transient network blip meant the automation silently never fired at all.

/** POSTs a JSON payload with an HMAC signature header, retrying transient failures. */
async function postWebhookWithRetry(url: string, payload: unknown, maxAttempts = 3): Promise<string> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const secret = process.env.WORKFLOW_WEBHOOK_SECRET;
  if (secret) {
    headers['X-Webhook-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      if (res.ok) {
        return attempt === 1 ? `Webhook sent to ${url}` : `Webhook sent to ${url} (succeeded on attempt ${attempt})`;
      }
      lastError = `HTTP ${res.status}`;
    } catch (e: any) {
      lastError = e.message;
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 500 * attempt)); // 500ms, then 1000ms
    }
  }
  return `Webhook to ${url} failed after ${maxAttempts} attempts: ${lastError}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkflowTrigger =
  | 'TICKET_CREATED'
  | 'TICKET_UPDATED'
  | 'TICKET_STATUS_CHANGED'
  | 'LEAD_CREATED'
  | 'LEAD_STATUS_CHANGED'
  | 'DEAL_STAGE_CHANGED'
  | 'DEAL_WON'
  | 'DEAL_LOST'
  | 'SLA_BREACH';

interface Condition {
  field: string;    // e.g. 'priority', 'status', 'source', 'value'
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'in';
  value: string | number | string[];
}

interface Action {
  type:
    | 'ASSIGN_TO'           // assign ticket/lead/deal to a user
    | 'SET_PRIORITY'        // change ticket priority
    | 'SET_STATUS'          // change ticket/lead status
    | 'SEND_EMAIL'          // send email notification
    | 'SEND_WHATSAPP'       // send WhatsApp notification (TICKET/DEAL only)
    | 'ADD_NOTE'            // add internal note
    | 'SEND_WEBHOOK'        // POST to external URL
    | 'CREATE_TICKET'       // auto-create a follow-up ticket
    | 'SCORE_LEAD';         // trigger AI lead scoring
  params: Record<string, string | number>;
}

export interface WorkflowContext {
  trigger: WorkflowTrigger;
  orgId: string;
  entityType: 'TICKET' | 'LEAD' | 'DEAL';
  entityId: string;
  entity: Record<string, any>;
  previousEntity?: Record<string, any>; // for update/change triggers
}

// ─── Condition evaluator ─────────────────────────────────────────────────────

function evaluateCondition(condition: Condition, entity: Record<string, any>): boolean {
  const fieldValue = entity[condition.field];
  const cv = condition.value;

  switch (condition.operator) {
    case 'eq':   return String(fieldValue) === String(cv);
    case 'neq':  return String(fieldValue) !== String(cv);
    case 'gt':   return Number(fieldValue) > Number(cv);
    case 'lt':   return Number(fieldValue) < Number(cv);
    case 'contains':
      return String(fieldValue ?? '').toLowerCase().includes(String(cv).toLowerCase());
    case 'in':
      return Array.isArray(cv) ? cv.includes(String(fieldValue)) : false;
    default:     return false;
  }
}

function evaluateConditions(conditions: Condition[], entity: Record<string, any>): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(c => evaluateCondition(c, entity));
}

// ─── Action executor ─────────────────────────────────────────────────────────

async function executeAction(action: Action, ctx: WorkflowContext): Promise<string> {
  const { entityType, entityId, orgId, entity } = ctx;

  switch (action.type) {
    case 'ASSIGN_TO': {
      const userId = String(action.params.userId);
      if (entityType === 'TICKET') {
        await prisma.ticket.updateMany({ where: { id: entityId, orgId }, data: { assignedTo: userId } });
      } else if (entityType === 'LEAD') {
        await prisma.lead.updateMany({ where: { id: entityId, orgId }, data: { assignedTo: userId } });
      } else if (entityType === 'DEAL') {
        await prisma.deal.updateMany({ where: { id: entityId, orgId }, data: { assignedTo: userId } });
      }
      return `Assigned to user ${userId}`;
    }

    case 'SET_PRIORITY': {
      if (entityType !== 'TICKET') return 'SET_PRIORITY only applies to tickets';
      const priority = String(action.params.priority);
      await prisma.ticket.updateMany({ where: { id: entityId, orgId }, data: { priority: priority as any } });
      return `Priority set to ${priority}`;
    }

    case 'SET_STATUS': {
      const status = String(action.params.status);
      if (entityType === 'TICKET') {
        await prisma.ticket.updateMany({ where: { id: entityId, orgId }, data: { status: status as any } });
      } else if (entityType === 'LEAD') {
        await prisma.lead.updateMany({ where: { id: entityId, orgId }, data: { status: status as any } });
      }
      return `Status set to ${status}`;
    }

    case 'SEND_EMAIL': {
      const { to, subject, body } = action.params as Record<string, string>;
      const emailAccount = await prisma.emailAccount.findUnique({ where: { orgId } });

      // Resolve template variables: {{title}}, {{status}}, {{priority}}, {{id}}
      const resolve = (s: string) =>
        s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(entity[k] ?? k));

      if (emailAccount) {
        const transport = nodemailer.createTransport({
          host: emailAccount.smtpHost,
          port: emailAccount.smtpPort,
          secure: emailAccount.smtpPort === 465,
          auth: { user: emailAccount.email, pass: emailAccount.password },
        });
        await transport.sendMail({
          from: emailAccount.email,
          to: resolve(to),
          subject: resolve(subject || 'CRM Notification'),
          text: resolve(body || ''),
        });
        return `Email sent to ${resolve(to)}`;
      }
      return 'Email skipped — no email account connected';
    }

    case 'SEND_WHATSAPP': {
      if (entityType !== 'TICKET' && entityType !== 'DEAL') {
        return `SEND_WHATSAPP skipped — only supported for tickets and deals, not ${entityType}`;
      }
      const { recipientType, customNumber, message } = action.params as Record<string, string>;
      const resolve = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(entity[k] ?? k));
      try {
        const phone = await resolveRecipientPhone({
          orgId, entityType, entityId,
          recipientType: (recipientType || 'ORG_DEFAULT') as any,
          customNumber,
        });
        await sendWhatsApp(orgId, phone, resolve(message || ''));
        return `WhatsApp sent to ${phone}`;
      } catch (err: any) {
        return `WhatsApp skipped — ${err?.message || err}`;
      }
    }

    case 'ADD_NOTE': {
      const noteBody = String(action.params.body || 'Automated workflow note');
      const systemUser = await prisma.user.findFirst({ where: { orgId, role: 'SUPER_ADMIN' } });
      if (systemUser) {
        const entityTypeMap: Record<string, 'DEAL' | 'TICKET' | 'CONTACT'> = {
          TICKET: 'TICKET',
          DEAL: 'DEAL',
          CONTACT: 'CONTACT',
        };
        await prisma.comment.create({
          data: {
            authorId: systemUser.id,
            entityType: entityTypeMap[entityType] || 'TICKET',
            entityId,
            body: `[Automation] ${noteBody}`,
          },
        });
      }
      return 'Note added';
    }

    case 'SEND_WEBHOOK': {
      const url = String(action.params.url);
      if (!url) return 'Webhook skipped — no URL configured';
      const payload = {
        trigger: ctx.trigger,
        entityType,
        entityId,
        entity,
        timestamp: new Date().toISOString(),
      };
      return postWebhookWithRetry(url, payload);
    }

    default:
      return `Unknown action type: ${action.type}`;
  }
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runWorkflows(ctx: WorkflowContext): Promise<void> {
  try {
    const rules = await prisma.workflowRule.findMany({
      where: { orgId: ctx.orgId, trigger: ctx.trigger, isActive: true },
    });

    for (const rule of rules) {
      const conditions = (rule.conditions as unknown as Condition[]) || [];
      const actions = (rule.actions as unknown as Action[]) || [];

      const matches = evaluateConditions(conditions, ctx.entity);

      if (!matches) {
        await prisma.workflowLog.create({
          data: { ruleId: rule.id, entityType: ctx.entityType, entityId: ctx.entityId, result: 'SKIPPED', detail: 'Conditions not met' },
        });
        continue;
      }

      const results: string[] = [];
      let hasError = false;

      for (const action of actions) {
        try {
          const detail = await executeAction(action, ctx);
          results.push(`${action.type}: ${detail}`);
        } catch (err: any) {
          results.push(`${action.type}: ERROR — ${err.message}`);
          hasError = true;
        }
      }

      await prisma.workflowLog.create({
        data: {
          ruleId: rule.id,
          entityType: ctx.entityType,
          entityId: ctx.entityId,
          result: hasError ? 'ERROR' : 'SUCCESS',
          detail: results.join(' | '),
        },
      });

      // Increment run count
      await prisma.workflowRule.update({
        where: { id: rule.id },
        data: { runCount: { increment: 1 } },
      });
    }
  } catch (err: any) {
    console.error('[workflow-engine] Error:', err.message);
  }
}
