/**
 * Shared and admin actions — notes, reminders, tasks, approvals, users and
 * custom-module records. Same rule as the area files: each runs the screen's
 * own handler as the confirming user.
 */
import { z } from 'zod';
import { prisma } from '../../prisma';
import { AppError } from '../../../middleware/errorHandler';
import { ALL_USERS, ALL_STAFF, MANAGERS } from '../../../middleware/authenticate';
import { sendWhatsApp } from '../../whatsapp';
import { resolveRecipientPhone } from '../../notification-recipient';
import { recordTitle } from '../../../modules/custom-modules/customModules.service';
import * as comments from '../../../modules/core/comments/comments.controller';
import * as schedules from '../../../modules/schedules/schedules.controller';
import * as tasks from '../../../modules/tasks/tasks.controller';
import * as approvals from '../../../modules/approvals/approvals.controller';
import * as usersAdmin from '../../../modules/core/users/usersAdmin.controller';
import * as customModules from '../../../modules/custom-modules/customModules.controller';
import { callUi, out, listPreview, target, show, when, zDateTime, zId } from '../helpers';
import type { AiActionDefinition, EntityKey } from '../types';

/** Record type of a polymorphic `entityType` param. */
const ENTITY_OF: Record<string, EntityKey> = {
  TICKET: 'ticket', DEAL: 'deal', CONTACT: 'contact', LEAD: 'lead', ACCOUNT: 'account', QUOTE: 'quote', INVOICE: 'invoice',
  ASSET: 'asset', CHANGE_REQUEST: 'change', CAMPAIGN: 'campaign', EMPLOYEE: 'employee', TASK: 'task',
};
const entityOf = (p: any) => (p && typeof p.entityType === 'string' ? ENTITY_OF[p.entityType] : undefined);

const RECIPIENT: Record<string, string> = { ME: 'you', ASSIGNEE: 'the assignee', CONTACT: 'the contact', CUSTOM_NUMBER: 'a custom number', ORG_DEFAULT: "the org's WhatsApp number" };

const LEGACY_ROLES = ['SUPER_ADMIN', 'CRM_MANAGER', 'SALES_REP', 'IT_MANAGER', 'IT_AGENT', 'EMPLOYEE'] as const;

export const SHARED_ACTIONS: AiActionDefinition[] = [
  // ── Internal note on a record (Comments) ────────────────────────────────
  {
    name: 'ADD_NOTE', label: 'Add a note / internal comment', category: 'Shared',
    description: 'Adds an internal note (comment) to a ticket, deal, contact, lead or account (e.g. "add a note on the Acme deal saying we followed up", "comment on the VPN ticket: waiting for the vendor"). Notes are visible to staff only — there is no public reply to requesters.',
    example: 'Add a note on the VPN ticket: waiting for the vendor to replace the router',
    paramsHint: '{ entityType: "TICKET"|"DEAL"|"CONTACT"|"LEAD"|"ACCOUNT", entityId: the record\'s name, body: string }',
    allowedRoles: ALL_STAFF, requiresConfirmation: true, risk: 'low', modules: ['itdesk', 'crm'],
    refs: { entityId: entityOf },
    schema: z.object({ entityType: z.enum(['TICKET', 'DEAL', 'CONTACT', 'LEAD', 'ACCOUNT']), entityId: zId, body: z.string().min(1).max(5000) }),
    sample: { entityType: 'DEAL', entityId: 'd1', body: 'Followed up by phone' },
    preview: async (p, _ctx, info) => ({ title: `Add an internal note on ${info.labels.entityId ? `${p.entityType.toLowerCase()} “${info.labels.entityId}”` : info.refLabels.entityId ?? `the ${p.entityType.toLowerCase()}`}`, changes: [{ field: 'Note', after: p.body }] }),
    handler: async (p, ctx) => {
      const c = await callUi(comments.create, ctx, { params: { entityType: p.entityType, entityId: p.entityId }, body: { body: p.body } });
      return { summary: `Added a note on the ${p.entityType.toLowerCase()}.`, data: { id: p.entityId, commentId: c.id } };
    },
    output: (_r, p) => ({ ...out(ENTITY_OF[p.entityType], { id: p.entityId }), label: 'Note added' }),
  },

  // ── WhatsApp reminder (Schedules — the record's Reminders tab) ──────────
  {
    name: 'SCHEDULE_WHATSAPP_REMINDER', label: 'Schedule a WhatsApp reminder', category: 'Shared',
    description: 'Schedules a WhatsApp reminder about a ticket, deal, lead or contact (e.g. "remind me on WhatsApp about the Acme deal tomorrow at 9am" → recipientType ME; "remind the assignee…" → ASSIGNEE).',
    example: 'Remind me on WhatsApp about the Acme deal tomorrow at 9am',
    paramsHint: '{ entityType: "TICKET"|"DEAL"|"LEAD"|"CONTACT", entityId: the record\'s name, dueAt: date-time words or ISO, message: string, recipientType?: "ME"|"ASSIGNEE"|"CONTACT"|"CUSTOM_NUMBER"|"ORG_DEFAULT" (default ASSIGNEE), customNumber?: string, recurrence?: "NONE"|"DAILY"|"WEEKLY" }',
    allowedRoles: ALL_STAFF, requiresConfirmation: true, risk: 'low', modules: ['itdesk', 'crm'],
    refs: { entityId: entityOf }, dates: { dueAt: 'datetime' },
    schema: z.object({
      entityType: z.enum(['TICKET', 'DEAL', 'LEAD', 'CONTACT']), entityId: zId, dueAt: zDateTime, message: z.string().min(1).max(1000),
      recipientType: z.enum(['ME', 'CONTACT', 'ASSIGNEE', 'CUSTOM_NUMBER', 'ORG_DEFAULT']).default('ASSIGNEE'),
      customNumber: z.preprocess(v => (v === '' ? undefined : v), z.string().max(30).optional()), recurrence: z.enum(['NONE', 'DAILY', 'WEEKLY']).default('NONE'),
    }),
    sample: { entityType: 'DEAL', entityId: 'd1', dueAt: '2026-10-19T03:30:00.000Z', message: 'Call Acme', recipientType: 'ME' },
    preview: async (p, ctx, info) => {
      const pv = listPreview(`WhatsApp reminder about ${info.labels.entityId ? `“${info.labels.entityId}”` : info.refLabels.entityId ?? `the ${p.entityType.toLowerCase()}`}`, p, info, ['entityType', 'entityId', 'recipientType', 'recurrence']);
      pv.changes.push({ field: 'Send to', after: RECIPIENT[p.recipientType] ?? p.recipientType });
      if (p.recurrence && p.recurrence !== 'NONE') pv.changes.push({ field: 'Repeats', after: p.recurrence.toLowerCase() });
      if (p.recipientType === 'ME') {
        const me = await prisma.user.findFirst({ where: { id: ctx.userId, orgId: ctx.orgId }, select: { phone: true } });
        pv.notes = [me?.phone ? `Sent to your number on file (${me.phone}).` : 'Your profile has no phone number yet — add one under Profile or the reminder will fail.'];
      }
      return pv;
    },
    handler: async (p, ctx) => {
      const s = await callUi(schedules.create, ctx, { body: p });
      return { summary: `Scheduled a WhatsApp reminder for ${when(s.dueAt, ctx)} (to ${RECIPIENT[p.recipientType] ?? p.recipientType}).`, data: s };
    },
    output: (r, p) => ({ id: (r.data as any)?.id, type: 'reminder', label: 'WhatsApp reminder', link: out(ENTITY_OF[p.entityType], { id: p.entityId }).link }),
  },
  {
    name: 'SEND_WHATSAPP_NOW', label: 'Send a WhatsApp message now', category: 'Shared',
    description: 'Sends a WhatsApp message immediately to the contact/assignee of a ticket, deal or lead (e.g. "WhatsApp the Acme deal contact that the proposal is on its way").',
    example: 'Send a WhatsApp message to the Acme deal contact saying the proposal is on its way',
    paramsHint: '{ entityType: "TICKET"|"DEAL"|"LEAD", entityId: the record\'s name, message: string, recipientType?: "CONTACT"|"ASSIGNEE"|"CUSTOM_NUMBER"|"ORG_DEFAULT"|"ME" (default ASSIGNEE), customNumber?: string }',
    allowedRoles: ALL_STAFF, requiresConfirmation: true, risk: 'high', modules: ['itdesk', 'crm'],
    refs: { entityId: entityOf },
    schema: z.object({
      entityType: z.enum(['TICKET', 'DEAL', 'LEAD']), entityId: zId, message: z.string().min(1).max(1000),
      recipientType: z.enum(['CONTACT', 'ASSIGNEE', 'CUSTOM_NUMBER', 'ORG_DEFAULT', 'ME']).default('ASSIGNEE'),
      customNumber: z.preprocess(v => (v === '' ? undefined : v), z.string().max(30).optional()),
    }),
    sample: { entityType: 'DEAL', entityId: 'd1', message: 'Proposal on its way', recipientType: 'CONTACT' },
    preview: async (p, ctx, info) => {
      let to: string;
      try { to = await resolveRecipientPhone({ orgId: ctx.orgId, entityType: p.entityType, entityId: p.entityId, recipientType: p.recipientType, customNumber: p.customNumber, meUserId: ctx.userId }); }
      catch (e: any) { to = `can't send: ${e?.message ?? e}`; }
      return { title: `Send a WhatsApp message now (${p.recipientType.toLowerCase()} of “${info.labels.entityId ?? ''}”)`, changes: [{ field: 'To', after: to }, { field: 'Message', after: p.message }], notes: ['Sent immediately; it cannot be recalled.'] };
    },
    handler: async (p, ctx) => {
      if (p.recipientType === 'CUSTOM_NUMBER' && !p.customNumber) throw new AppError(400, 'A phone number is required when the recipient is "Custom number"');
      const phone = await resolveRecipientPhone({ orgId: ctx.orgId, entityType: p.entityType, entityId: p.entityId, recipientType: p.recipientType, customNumber: p.customNumber, meUserId: ctx.userId });
      await sendWhatsApp(ctx.orgId, phone, p.message);
      return { summary: `Sent a WhatsApp message to ${phone}.`, data: { id: p.entityId } };
    },
    output: (_r, p) => ({ ...out(ENTITY_OF[p.entityType], { id: p.entityId }), label: 'Message sent' }),
  },

  // ── Tasks (My Work) ─────────────────────────────────────────────────────
  {
    name: 'CREATE_TASK', label: 'Create a task or reminder', category: 'Shared',
    description: 'Creates a task in My Work for yourself or a colleague, optionally due at a time and linked to a record (e.g. "remind me to send the contract Monday 10am", "ask Priya to update the price list by Friday").',
    example: 'Create a task for me to send the Acme contract on Monday at 10am',
    paramsHint: '{ title: string, description?: string, dueAt?: date-time words or ISO, priority?: "LOW"|"MEDIUM"|"HIGH"|"URGENT", assigneeUserId?: person\'s name (default you), entityType?: "TICKET"|"DEAL"|"CONTACT"|"LEAD"|"ACCOUNT", entityId?: that record\'s name }',
    allowedRoles: ALL_USERS, permission: 'core.task.create', requiresConfirmation: true, risk: 'low',
    refs: { assigneeUserId: 'user', entityId: entityOf }, dates: { dueAt: 'datetime' },
    schema: z.object({
      title: z.string().min(1).max(300), description: z.string().max(5000).optional(), dueAt: zDateTime.optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
      assigneeUserId: zId.optional(), entityType: z.enum(['TICKET', 'DEAL', 'CONTACT', 'LEAD', 'ACCOUNT']).optional(), entityId: zId.optional(),
    }).refine(p => !p.entityType === !p.entityId, { message: 'A linked record needs both its type and the record', path: ['entityId'] }),
    sample: { title: 'Send the Acme contract', dueAt: '2026-10-19T04:30:00.000Z' },
    preview: async (p, _ctx, info) => {
      const pv = listPreview(`Create task “${p.title}”`, p, info, ['entityType', 'assigneeUserId']);
      pv.changes.push({ field: 'Assignee', after: p.assigneeUserId ? (info.labels.assigneeUserId ?? p.assigneeUserId) : 'You' });
      return pv;
    },
    handler: async (p, ctx) => {
      const t = await callUi(tasks.create, ctx, { body: { ...p, assigneeUserId: p.assigneeUserId ?? ctx.userId } });
      return { summary: `Created task “${t.title}”${t.assigneeUser && t.assigneeUser.id !== ctx.userId ? ` for ${t.assigneeUser.name}` : ''}${t.dueAt ? ` due ${when(t.dueAt, ctx)}` : ''}.`, data: t };
    },
    output: r => out('task', r.data),
  },

  // ── Approvals waiting on me ─────────────────────────────────────────────
  {
    name: 'DECIDE_APPROVAL', label: 'Approve / reject an approval request', category: 'Shared',
    description: 'Approves or rejects an approval request that is waiting on you (expenses, purchases, discounts… from the Approvals inbox) (e.g. "approve Arjun\'s laptop purchase request"). Leave/WFH requests use APPROVE_LEAVE / REJECT_LEAVE.',
    example: "Approve Arjun's laptop purchase approval",
    paramsHint: '{ approvalId: request title or requester\'s name, decision: "APPROVED"|"REJECTED", comment?: string }',
    allowedRoles: ALL_USERS, requiresConfirmation: true, risk: 'medium',
    record: { entity: 'approval', param: 'approvalId' },
    schema: z.object({ approvalId: zId, decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().max(2000).optional() })
      .refine(p => p.decision !== 'REJECTED' || !!p.comment, { message: 'Give a reason when rejecting', path: ['comment'] }),
    sample: { approvalId: 'ap1', decision: 'APPROVED' },
    preview: async (p, _ctx, info) => ({
      title: `${p.decision === 'APPROVED' ? 'Approve' : 'Reject'} “${info.row?.title ?? 'approval'}”`, target: target('approval', info.row),
      changes: [{ field: 'Your decision', after: p.decision }, ...(info.row?.amount ? [{ field: 'Amount', after: `${show(info.row.amount)} ${info.row.currency ?? ''}` }] : []), ...(p.comment ? [{ field: 'Comment', after: p.comment }] : [])],
      notes: info.row?.requester?.name ? [`Requested by ${info.row.requester.name}.`] : undefined,
    }),
    handler: async (p, ctx) => {
      const r = await callUi(approvals.decideRequest, ctx, { params: { id: p.approvalId }, body: { decision: p.decision, comment: p.comment } });
      return { summary: `${p.decision === 'APPROVED' ? 'Approved' : 'Rejected'} the request${r.finalized ? '' : ' — it moves to the next approver'}.`, data: { id: p.approvalId, ...r } };
    },
    output: (_r, p) => ({ id: p.approvalId, type: 'approval', label: 'Approval', link: '/approvals' }),
  },

  // ── Users ───────────────────────────────────────────────────────────────
  {
    name: 'INVITE_USER', label: 'Invite a user', category: 'Admin',
    description: 'Emails a sign-in invitation with a role (e.g. "invite meera@acme.com as a sales rep"). You can only give roles up to your own, and only roles of areas the organisation has.',
    example: 'Invite meera@example.com as a Sales Rep',
    paramsHint: `{ email: string, role: ${LEGACY_ROLES.map(r => `"${r}"`).join('|')} or a custom role name such as "HR Manager" }`,
    allowedRoles: MANAGERS, permission: 'core.user.create', requiresConfirmation: true, risk: 'high',
    schema: z.object({ email: z.string().email(), role: z.string().min(2).max(60).default('EMPLOYEE') }),
    sample: { email: 'meera@example.com', role: 'SALES_REP' },
    preview: async p => ({ title: `Invite ${p.email}`, changes: [{ field: 'Email', after: p.email }, { field: 'Role', after: p.role }], notes: ['An invitation email is sent; accepting it uses a paid seat unless the role is Employee.'] }),
    handler: async (p, ctx) => {
      const key = p.role.trim().toUpperCase().replace(/[\s-]+/g, '_');
      let body: Record<string, unknown>;
      if ((LEGACY_ROLES as readonly string[]).includes(key)) body = { email: p.email, role: key };
      else {
        const role = await prisma.role.findFirst({ where: { OR: [{ orgId: ctx.orgId }, { orgId: null }], AND: [{ OR: [{ key }, { name: { equals: p.role.trim(), mode: 'insensitive' } }] }] }, select: { id: true }, orderBy: { orgId: 'desc' } });
        if (!role) throw new AppError(400, `There's no "${p.role}" role — pick one from Administration → Roles.`);
        body = { email: p.email, roleId: role.id };
      }
      const r = await callUi(usersAdmin.invite, ctx, { body });
      return { summary: `Invited ${p.email} as ${r.invite?.role?.replace(/_/g, ' ').toLowerCase() ?? p.role}. The link expires in 7 days.`, data: { id: r.invite?.id } };
    },
    output: () => ({ type: 'invite', label: 'Invitation', link: '/admin/users' }),
  },
  {
    name: 'DEACTIVATE_USER', label: 'Deactivate a user', category: 'Admin',
    description: 'Turns off a person\'s sign-in (they have left) — their HR record is marked as exited (e.g. "deactivate Rahul\'s account"). You can\'t deactivate yourself or someone with a higher role.',
    example: "Deactivate Rahul Verma's account — he has left",
    paramsHint: '{ userId: person\'s name or email }',
    allowedRoles: MANAGERS, permission: 'core.user.update', requiresConfirmation: true, risk: 'high',
    record: { entity: 'user', param: 'userId' },
    schema: z.object({ userId: zId }),
    sample: { userId: 'u9' },
    preview: async (_p, _ctx, info) => ({
      title: `Deactivate ${info.row?.name ?? 'this user'}'s account`, target: target('user', info.row),
      changes: [{ field: 'Sign-in', before: info.row?.isActive === false ? 'Already inactive' : 'Active', after: 'Deactivated' }, { field: 'Role', after: show(info.row?.role) }],
      notes: ['They are signed out and can no longer log in; the employee record is marked as exited. Reactivating is a manual step on the Users page.'],
    }),
    handler: async (p, ctx) => {
      const u = await prisma.user.findFirst({ where: { id: p.userId, orgId: ctx.orgId }, select: { name: true } });
      await callUi(usersAdmin.deactivate, ctx, { params: { id: p.userId } });
      return { summary: `Deactivated ${u?.name ?? 'the user'}'s account.`, data: { id: p.userId, name: u?.name } };
    },
    output: r => out('user', r.data),
  },

  // ── Custom module record update ─────────────────────────────────────────
  {
    name: 'UPDATE_CUSTOM_MODULE_RECORD', label: 'Update a custom module record', category: 'Shared',
    description: 'Changes field values of an existing custom-module record (e.g. "set the 2025 Kia EV6 price to 39,500"). Use only fieldKeys listed for that module; recordTitle is matched against the module\'s records.',
    example: 'Set the price of the 2025 Kia EV6 to 39500 in Vehicle Inventory',
    paramsHint: '{ moduleId: module name, recordId?: string, recordTitle?: the record\'s title, data: { [fieldKey]: value } }',
    allowedRoles: ALL_STAFF, requiresConfirmation: true, risk: 'medium',
    refs: { moduleId: 'module' },
    schema: z.object({ moduleId: zId, recordId: z.string().optional(), recordTitle: z.string().max(200).optional(), data: z.record(z.union([z.string(), z.number(), z.boolean()])) })
      .refine(p => p.recordId || p.recordTitle, { message: 'recordId or recordTitle is required' })
      .refine(p => Object.keys(p.data ?? {}).length > 0, { message: 'Nothing to change', path: ['data'] }),
    sample: { moduleId: 'm1', recordTitle: '2025 Kia EV6', data: { price: 39500 } },
    preview: async (p, ctx, info) => {
      const { record, fields } = await findCustomRecord(ctx.orgId, p);
      const before = (record?.data ?? {}) as Record<string, unknown>;
      return {
        title: `Update “${record ? recordTitle(fields, before, record.id) : p.recordTitle}” in ${info.labels.moduleId ?? 'the module'}`,
        changes: Object.entries(p.data).map(([k, v]) => ({ field: fields.find(f => f.fieldKey === k)?.label ?? k, before: show(before[k]), after: show(v) })),
      };
    },
    handler: async (p, ctx) => {
      const { record, module_ } = await findCustomRecord(ctx.orgId, p);
      if (!record) throw new AppError(404, 'Record not found');
      const r = await callUi(customModules.updateRecord, ctx, { params: { id: module_.id, recordId: record.id }, body: { data: p.data } });
      return { summary: `Updated the record in ${module_.name}.`, data: r };
    },
    output: (r, p) => ({ id: (r.data as any)?.id, type: 'customRecord', label: 'Record', link: `/custom-modules` , moduleId: p.moduleId }),
  },
];

async function findCustomRecord(orgId: string, p: { moduleId: string; recordId?: string; recordTitle?: string }) {
  const module_ = await prisma.customModule.findFirst({ where: { id: p.moduleId, orgId } });
  if (!module_) throw new AppError(404, 'Custom module not found');
  const fields = await prisma.customModuleField.findMany({ where: { moduleId: module_.id }, orderBy: { position: 'asc' } });
  let record = p.recordId ? await prisma.customModuleRecord.findFirst({ where: { id: p.recordId, moduleId: module_.id } }) : null;
  if (!record && p.recordTitle) {
    const rows = await prisma.customModuleRecord.findMany({ where: { moduleId: module_.id, orgId }, orderBy: { updatedAt: 'desc' }, take: 200 });
    const needle = p.recordTitle.toLowerCase();
    const matches = rows.filter(r => recordTitle(fields, r.data as Record<string, unknown>, r.id).toLowerCase().includes(needle));
    if (matches.length > 1) throw new AppError(400, `"${p.recordTitle}" matches ${matches.length} ${module_.name} records — be more specific`);
    record = matches[0] ?? null;
  }
  return { module_, fields, record };
}
