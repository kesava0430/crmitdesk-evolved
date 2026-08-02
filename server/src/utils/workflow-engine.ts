import { prisma } from './prisma';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { sendWhatsApp } from './whatsapp';
import { resolveRecipientPhone } from './notification-recipient';
import { scoreLead } from './ai';
import { sendPushToUser } from './webPush';

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
  | 'LEAD_ACTIVITY_COMPLETED'
  | 'DEAL_STAGE_CHANGED'
  | 'DEAL_WON'
  | 'DEAL_LOST'
  | 'SLA_BREACH'
  | 'DATE_FIELD_REACHED'; // date-driven follow-ups — see utils/dateAutomation.ts

// Per-stage automation ("when a deal enters Negotiation, notify the
// manager") doesn't need its own trigger type — it's just DEAL_STAGE_CHANGED
// plus a condition on the `stage` field, since ctx.entity is always the
// deal *after* the move. See pipelines UI's "add automation" shortcut,
// which prefills exactly that trigger+condition pair.

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
    | 'SCORE_LEAD'          // trigger AI lead scoring
    | 'CREATE_NOTIFICATION'; // in-app notification (bell icon), independent of email/WhatsApp
  params: Record<string, string | number>;
}

export interface WorkflowContext {
  trigger: WorkflowTrigger;
  orgId: string;
  // CONTACT / CUSTOM_MODULE_RECORD only ever arrive via DATE_FIELD_REACHED
  // (utils/dateAutomation.ts) — every other trigger still only fires for
  // TICKET/LEAD/DEAL like before.
  entityType: 'TICKET' | 'LEAD' | 'DEAL' | 'CONTACT' | 'CUSTOM_MODULE_RECORD';
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
      // Display name on the "From" header — pulled from the org's own
      // branding so recipients see "Glow Salon & Spa <bookings@...>" rather
      // than a bare address. Falls back to the org's registered name if no
      // branding record (or no companyName on it) exists yet.
      const [emailAccount, org, branding] = await Promise.all([
        prisma.emailAccount.findUnique({ where: { orgId } }),
        prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
        prisma.orgBranding.findUnique({ where: { orgId }, select: { companyName: true } }),
      ]);

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
        const fromName = (branding?.companyName || org?.name || '').replace(/"/g, '');
        await transport.sendMail({
          from: fromName ? `"${fromName}" <${emailAccount.email}>` : emailAccount.email,
          to: resolve(to),
          subject: resolve(subject || 'CRM Notification'),
          text: resolve(body || ''),
        });
        return `Email sent to ${resolve(to)}`;
      }
      return 'Email skipped — no email account connected';
    }

    case 'SEND_WHATSAPP': {
      if (entityType !== 'TICKET' && entityType !== 'DEAL' && entityType !== 'CONTACT' && entityType !== 'CUSTOM_MODULE_RECORD') {
        return `SEND_WHATSAPP skipped — not supported for ${entityType}`;
      }
      const { recipientType, message } = action.params as Record<string, string>;
      const resolve = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(entity[k] ?? k));
      // customNumber may itself be a template like "{{phone}}" — the only way
      // a CUSTOM_MODULE_RECORD (which has no dedicated recipient-lookup case
      // below) can point at a phone number stored in one of its own fields.
      const customNumber = action.params.customNumber ? resolve(String(action.params.customNumber)) : undefined;
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
      const entityTypeMap: Record<string, 'DEAL' | 'TICKET' | 'CONTACT'> = {
        TICKET: 'TICKET',
        DEAL: 'DEAL',
        CONTACT: 'CONTACT',
      };
      // Was previously `|| 'TICKET'`, which silently mis-filed a note under
      // Comment.entityType = 'TICKET' for any unmapped entity — harmless
      // while only TICKET/LEAD/DEAL existed (LEAD already fell through to
      // this same bug, unnoticed), but CUSTOM_MODULE_RECORD would now write
      // a fake ticket comment with someone else's record id. Skip cleanly instead.
      const mappedType = entityTypeMap[entityType];
      if (!mappedType) return `ADD_NOTE skipped — comments aren't supported on ${entityType}`;

      const noteBody = String(action.params.body || 'Automated workflow note');
      const systemUser = await prisma.user.findFirst({ where: { orgId, role: 'SUPER_ADMIN' } });
      if (systemUser) {
        await prisma.comment.create({
          data: {
            authorId: systemUser.id,
            entityType: mappedType,
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

    case 'CREATE_TICKET': {
      const requester = await prisma.user.findFirst({ where: { orgId, role: 'SUPER_ADMIN' } });
      if (!requester) return 'CREATE_TICKET skipped — no admin user to file it as';
      const resolve = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(entity[k] ?? k));
      const title = resolve(String(action.params.title || `Follow-up: ${entity.title || entity.name || entityId}`));
      const body = resolve(String(action.params.body || `Auto-created by workflow automation from ${entityType} ${entityId}.`));
      const priority = (String(action.params.priority || 'MEDIUM')).toUpperCase();
      const ticket = await prisma.ticket.create({
        data: { orgId, title, body, priority: priority as any, requesterId: requester.id },
      });
      return `Created ticket "${ticket.title}" (#${ticket.id.slice(-6)})`;
    }

    case 'SCORE_LEAD': {
      if (entityType !== 'LEAD') return 'SCORE_LEAD skipped — only applies to leads';
      const lead = await prisma.lead.findUnique({ where: { id: entityId }, include: { contact: true } });
      if (!lead) return 'SCORE_LEAD skipped — lead not found';
      const result = await scoreLead(lead as any);
      await prisma.lead.update({ where: { id: entityId }, data: { aiScore: result.score, aiScoreReason: result.reason } });
      return `Lead scored ${result.score}/100 — ${result.reason}`;
    }

    case 'CREATE_NOTIFICATION': {
      const { title, body, recipientType, userId: explicitUserId } = action.params as Record<string, string>;
      const resolve = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(entity[k] ?? k));
      let targetUserId: string | undefined = explicitUserId;
      if (!targetUserId && recipientType === 'ASSIGNEE') {
        // Contact has no assignedTo — its equivalent is ownerId (the CRM
        // rep who owns the relationship). CUSTOM_MODULE_RECORD has neither,
        // so ASSIGNEE simply resolves to nothing there — use an explicit
        // userId in the rule's params instead.
        targetUserId = entity.assignedTo || entity.assignee?.id || entity.ownerId;
      }
      if (!targetUserId) return 'Notification skipped — no recipient resolved';
      const notifTitle = resolve(String(title || 'Workflow automation'));
      const notifBody = resolve(String(body || ''));
      await prisma.notification.create({
        data: {
          orgId,
          userId: targetUserId,
          type: 'STATUS_CHANGE',
          title: notifTitle,
          body: notifBody,
          entityId,
          entityType,
        },
      });
      // Real browser push, on top of the in-app bell — see utils/webPush.ts.
      sendPushToUser(targetUserId, { title: notifTitle, body: notifBody }).catch(() => {});
      return `Notification created for user ${targetUserId}`;
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
