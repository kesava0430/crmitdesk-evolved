/**
 * CRM actions — contacts, accounts, leads, deals, quotes, invoices,
 * campaigns and activities. Each runs the CRM screen's own controller as the
 * confirming user (callUi); allowedRoles mirror the routes' requireRole, the
 * permission engine adds the record-scope check the CRM controllers
 * themselves don't do (a rep limited to OWN deals can't move a colleague's).
 */
import { z } from 'zod';
import { prisma } from '../../prisma';
import { AppError } from '../../../middleware/errorHandler';
import { CRM_STAFF, CRM_MANAGERS } from '../../../middleware/authenticate';
import * as contacts from '../../../modules/crm/contacts/contacts.controller';
import * as accounts from '../../../modules/crm/accounts/accounts.controller';
import * as leads from '../../../modules/crm/leads/leads.controller';
import * as deals from '../../../modules/crm/deals/deals.controller';
import * as activities from '../../../modules/crm/activities/activities.controller';
import * as quotes from '../../../modules/quotes/quotes.controller';
import * as invoices from '../../../modules/invoices/invoices.controller';
import * as campaigns from '../../../modules/campaigns/campaigns.controller';
import { ensureDefaultPipeline, normalizeStages } from '../../../modules/crm/pipelines/pipelines.service';
import { callUi, out, listPreview, diffPreview, target, show, when, zDate, zDateTime, zId, zMoney } from '../helpers';
import type { AiActionDefinition } from '../types';

const LineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.coerce.number().positive().default(1),
  unitPrice: zMoney,
  discount: z.coerce.number().min(0).max(100).default(0),
});
const linesTotal = (lines: Array<{ quantity: number; unitPrice: number; discount?: number }>) =>
  lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice) * (1 - Number(l.discount ?? 0) / 100), 0);
const linesText = (lines: Array<{ description: string; quantity: number; unitPrice: number; discount?: number }>) =>
  lines.map(l => `${l.description} — ${show(Number(l.quantity))} × ${show(Number(l.unitPrice))}${Number(l.discount) ? ` (−${l.discount}%)` : ''}`).join('; ');

export const CRM_ACTIONS: AiActionDefinition[] = [
  // ── Contacts ────────────────────────────────────────────────────────────
  {
    name: 'CREATE_CONTACT', label: 'Create a contact', category: 'CRM',
    description: 'Adds a CRM contact (a person at a customer), optionally linked to an existing account/company (e.g. "add Jane Smith, CTO at Acme, jane@acme.com").',
    example: 'Add a contact Jane Smith, CTO at Acme Industries, jane@acme.com',
    paramsHint: '{ name: string, email?: string, phone?: string, jobTitle?: string, accountId?: company/account name, source?: string }',
    allowedRoles: CRM_STAFF, permission: 'crm.contact.create', modules: ['crm'], requiresConfirmation: true, risk: 'low',
    refs: { accountId: 'account' },
    schema: z.object({ name: z.string().trim().min(1).max(120), email: z.string().email().optional(), phone: z.string().max(40).optional(), jobTitle: z.string().max(120).optional(), accountId: zId.optional(), source: z.string().max(60).optional() }),
    sample: { name: 'Jane Smith', email: 'jane@acme.com', jobTitle: 'CTO' },
    preview: async (p, _ctx, info) => listPreview(`Create contact “${p.name}”`, p, info),
    handler: async (p, ctx) => {
      const c = await callUi(contacts.create, ctx, { body: { ...p, source: p.source ?? 'AI assistant' } });
      return { summary: `Created contact “${c.name}”${c.account ? ` at ${c.account.name}` : ''}.`, data: c };
    },
    output: r => out('contact', r.data),
  },
  {
    name: 'UPDATE_CONTACT', label: 'Update a contact', category: 'CRM',
    description: 'Changes a contact\'s name, email, phone, job title or account (e.g. "update Jane Smith\'s phone to +91 98765 43210").',
    example: "Update Jane Smith's phone number to +91 98765 43210",
    paramsHint: '{ contactId: contact name, name?: string, email?: string, phone?: string, jobTitle?: string, accountId?: account name }',
    allowedRoles: CRM_STAFF, permission: 'crm.contact.update', modules: ['crm'], requiresConfirmation: true, risk: 'medium',
    record: { entity: 'contact', param: 'contactId', permission: 'crm.contact.update' }, refs: { accountId: 'account' },
    schema: z.object({ contactId: zId, name: z.string().trim().min(1).max(120).optional(), email: z.string().email().optional(), phone: z.string().max(40).optional(), jobTitle: z.string().max(120).optional(), accountId: zId.optional() })
      .refine(p => Object.keys(p).length > 1, { message: 'Nothing to change' }),
    sample: { contactId: 'c1', phone: '+91 98765 43210' },
    preview: async (p, _ctx, info) => ({
      title: `Update contact “${info.row?.name ?? ''}”`, target: target('contact', info.row),
      changes: diffPreview(info.row, p, info, [
        { key: 'name', label: 'Name', before: r => r.name }, { key: 'email', label: 'Email', before: r => r.email }, { key: 'phone', label: 'Phone', before: r => r.phone },
        { key: 'jobTitle', label: 'Job title', before: r => r.jobTitle }, { key: 'accountId', label: 'Account', before: r => r.account?.name },
      ]),
    }),
    handler: async (p, ctx) => {
      const { contactId, ...data } = p;
      const c = await callUi(contacts.update, ctx, { params: { id: contactId }, body: data });
      return { summary: `Updated contact “${c.name}”.`, data: c };
    },
    output: r => out('contact', r.data),
  },

  // ── Accounts ────────────────────────────────────────────────────────────
  {
    name: 'CREATE_ACCOUNT', label: 'Create an account', category: 'CRM',
    description: 'Creates a new company/account record (e.g. "create an account called Acme Industries").',
    example: 'Create an account called Acme Industries',
    paramsHint: '{ name: string, industry?: string, website?: string, phone?: string, address?: string }',
    allowedRoles: CRM_STAFF, permission: 'crm.account.create', modules: ['crm'], requiresConfirmation: true, risk: 'low',
    schema: z.object({ name: z.string().min(1).max(120), industry: z.string().max(80).optional(), website: z.string().max(200).optional(), phone: z.string().max(40).optional(), address: z.string().max(300).optional() }),
    sample: { name: 'Acme Industries' },
    preview: async (p, _ctx, info) => listPreview(`Create account “${p.name}”`, p, info),
    handler: async (p, ctx) => {
      const a = await callUi(accounts.create, ctx, { body: p });
      return { summary: `Created the “${a.name}” account.`, data: a };
    },
    output: r => out('account', r.data),
  },
  {
    name: 'UPDATE_ACCOUNT', label: 'Update an account', category: 'CRM',
    description: 'Changes an account\'s name, industry, website, phone or address (e.g. "set Acme\'s website to acme.com").',
    example: "Set Acme Industries' industry to Manufacturing",
    paramsHint: '{ accountId: account name, name?: string, industry?: string, website?: string, phone?: string, address?: string }',
    allowedRoles: CRM_STAFF, permission: 'crm.account.update', modules: ['crm'], requiresConfirmation: true, risk: 'medium',
    record: { entity: 'account', param: 'accountId', permission: 'crm.account.update' },
    schema: z.object({ accountId: zId, name: z.string().min(1).max(120).optional(), industry: z.string().max(80).optional(), website: z.string().max(200).optional(), phone: z.string().max(40).optional(), address: z.string().max(300).optional() })
      .refine(p => Object.keys(p).length > 1, { message: 'Nothing to change' }),
    sample: { accountId: 'a1', industry: 'Manufacturing' },
    preview: async (p, _ctx, info) => ({
      title: `Update account “${info.row?.name ?? ''}”`, target: target('account', info.row),
      changes: diffPreview(info.row, p, info, ['name', 'industry', 'website', 'phone', 'address'].map(k => ({ key: k, label: k[0].toUpperCase() + k.slice(1), before: (r: any) => r[k] }))),
    }),
    handler: async (p, ctx) => {
      const { accountId, ...data } = p;
      const a = await callUi(accounts.update, ctx, { params: { id: accountId }, body: data });
      return { summary: `Updated the “${a?.name}” account.`, data: a };
    },
    output: r => out('account', r.data),
  },

  // ── Leads ───────────────────────────────────────────────────────────────
  // Matches an existing contact by email, then exact name; creates one when
  // the person is new (linked to the named account if it exists). Then the
  // Leads screen's own create — LEAD_CREATED workflows, Slack, audit.
  {
    name: 'CREATE_LEAD', label: 'Create a lead', category: 'CRM',
    description: 'Creates a sales lead for a person (e.g. "add a lead for Maria Gomez at Initech, met her at the expo"). Reuses the contact if the email or exact name already exists.',
    example: 'Add a lead for Maria Gomez from Initech — met at the expo, wants a demo',
    paramsHint: '{ contactName: string, contactEmail?: string, company?: string, notes?: string, source?: string, assignedTo?: owner\'s name (default you) }',
    allowedRoles: CRM_STAFF, permission: 'crm.lead.create', modules: ['crm'], requiresConfirmation: true, risk: 'low',
    refs: { assignedTo: 'user' },
    schema: z.object({ contactName: z.string().trim().min(2).max(120), contactEmail: z.string().email().optional(), company: z.string().max(120).optional(), notes: z.string().max(2000).optional(), source: z.string().max(60).optional(), assignedTo: zId.optional() }),
    sample: { contactName: 'Maria Gomez', company: 'Initech', source: 'Expo' },
    preview: async (p, ctx, info) => {
      const existing = await findContact(ctx.orgId, p.contactName, p.contactEmail);
      const account = !existing && p.company ? await prisma.account.findFirst({ where: { orgId: ctx.orgId, name: { contains: p.company, mode: 'insensitive' } }, select: { name: true } }) : null;
      const pv = listPreview(`Create a lead for ${p.contactName}`, p, info);
      pv.changes.push({ field: 'Contact', after: existing ? `Existing contact “${existing.name}”` : `New contact${account ? ` at ${account.name}` : ''}` });
      return pv;
    },
    handler: async (p, ctx) => {
      let contact = await findContact(ctx.orgId, p.contactName, p.contactEmail);
      let created = false;
      if (!contact && p.company) {
        const account = await prisma.account.findFirst({ where: { orgId: ctx.orgId, name: { contains: p.company, mode: 'insensitive' } }, select: { id: true } });
        if (account) {
          contact = await callUi(contacts.create, ctx, { body: { name: p.contactName, email: p.contactEmail, accountId: account.id, source: p.source ?? 'AI assistant' } });
          created = true;
        }
      }
      const lead = await callUi(leads.create, ctx, { body: {
        ...(contact ? { contactId: contact.id } : { name: p.contactName, email: p.contactEmail }),
        source: p.source ?? 'AI assistant', notes: [p.company && !contact ? `Company: ${p.company}` : null, p.notes].filter(Boolean).join('\n') || undefined,
        assignedTo: p.assignedTo,
      } });
      if (!contact) created = true;
      return { summary: `Created a lead for ${lead.contact?.name ?? p.contactName}${created ? ' (new contact)' : ' (existing contact)'}.`, data: lead };
    },
    output: r => out('lead', r.data),
  },
  {
    name: 'UPDATE_LEAD_STATUS', label: 'Change lead status', category: 'CRM',
    description: 'Changes a lead\'s status (e.g. "mark the John Doe lead as qualified"). Converting into a deal is CONVERT_LEAD.',
    example: 'Mark the John Doe lead as qualified',
    paramsHint: '{ leadId: lead\'s name, status: "NEW"|"CONTACTED"|"QUALIFIED"|"UNQUALIFIED" }',
    allowedRoles: CRM_STAFF, permission: 'crm.lead.update', modules: ['crm'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'lead', param: 'leadId', permission: 'crm.lead.update' },
    schema: z.object({ leadId: zId, status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED']) }),
    sample: { leadId: 'l1', status: 'QUALIFIED' },
    preview: async (p, _ctx, info) => ({ title: `Set ${info.row?.contact?.name ?? 'the lead'} to ${p.status}`, target: target('lead', info.row), changes: [{ field: 'Status', before: info.row?.status, after: p.status }] }),
    handler: async (p, ctx) => {
      const existing = await prisma.lead.findFirst({ where: { id: p.leadId, orgId: ctx.orgId }, select: { status: true } });
      if (existing?.status === 'CONVERTED') throw new AppError(400, 'This lead has already been converted — change the deal instead');
      const lead = await callUi(leads.update, ctx, { params: { id: p.leadId }, body: { status: p.status } });
      return { summary: `Set “${lead.contact?.name ?? 'lead'}” to ${p.status}.`, data: lead };
    },
    output: r => out('lead', r.data),
  },
  {
    name: 'UPDATE_LEAD', label: 'Update a lead', category: 'CRM',
    description: 'Changes a lead\'s owner, source or notes (e.g. "assign the Maria Gomez lead to Arjun").',
    example: 'Assign the Maria Gomez lead to Arjun',
    paramsHint: '{ leadId: lead\'s name, assignedTo?: owner\'s name, source?: string, notes?: string }',
    allowedRoles: CRM_STAFF, permission: 'crm.lead.update', modules: ['crm'], requiresConfirmation: true, risk: 'medium',
    record: { entity: 'lead', param: 'leadId', permission: 'crm.lead.update' }, refs: { assignedTo: 'user' },
    schema: z.object({ leadId: zId, assignedTo: zId.optional(), source: z.string().max(60).optional(), notes: z.string().max(2000).optional() })
      .refine(p => Object.keys(p).length > 1, { message: 'Nothing to change' }),
    sample: { leadId: 'l1', assignedTo: 'u2' },
    preview: async (p, _ctx, info) => ({
      title: `Update the lead for ${info.row?.contact?.name ?? ''}`, target: target('lead', info.row),
      changes: diffPreview(info.row, p, info, [{ key: 'assignedTo', label: 'Owner', before: r => r.assignee?.name }, { key: 'source', label: 'Source', before: r => r.source }, { key: 'notes', label: 'Notes', before: r => r.notes }]),
    }),
    handler: async (p, ctx) => {
      const { leadId, ...data } = p;
      const lead = await callUi(leads.update, ctx, { params: { id: leadId }, body: data });
      return { summary: `Updated the lead for ${lead.contact?.name ?? 'the contact'}.`, data: lead };
    },
    output: r => out('lead', r.data),
  },
  {
    name: 'CONVERT_LEAD', label: 'Convert a lead to a deal', category: 'CRM',
    description: 'Converts a lead into a deal on the pipeline (e.g. "convert the Maria Gomez lead into a 2 lakh deal").',
    example: 'Convert the Maria Gomez lead into a deal worth 200000',
    paramsHint: '{ leadId: lead\'s name, dealTitle?: string, dealValue?: number, dealStage?: pipeline stage name }',
    allowedRoles: CRM_STAFF, permission: 'crm.lead.update', modules: ['crm'], requiresConfirmation: true, risk: 'medium',
    record: { entity: 'lead', param: 'leadId', permission: 'crm.lead.update' },
    schema: z.object({ leadId: zId, dealTitle: z.string().max(200).optional(), dealValue: zMoney.optional(), dealStage: z.string().max(60).optional() }),
    sample: { leadId: 'l1', dealValue: 200000 },
    preview: async (p, ctx, info) => {
      const stages = normalizeStages((await ensureDefaultPipeline(ctx.orgId)).stages);
      if (p.dealStage && !stages.some(s => s.label === p.dealStage)) throw new AppError(400, `"${p.dealStage}" isn't a pipeline stage (stages: ${stages.map(s => s.label).join(', ')})`);
      return {
        title: `Convert ${info.row?.contact?.name ?? 'the lead'} into a deal`, target: target('lead', info.row),
        changes: [
          { field: 'Lead status', before: info.row?.status, after: 'CONVERTED' },
          { field: 'New deal', after: p.dealTitle ?? `Deal - ${info.row?.contact?.name ?? 'New Deal'}` },
          { field: 'Value', after: show(p.dealValue ?? 0) }, { field: 'Stage', after: p.dealStage ?? stages[0]?.label ?? '—' },
        ],
      };
    },
    handler: async (p, ctx) => {
      const r = await callUi(leads.convert, ctx, { params: { id: p.leadId }, body: { dealTitle: p.dealTitle, dealValue: p.dealValue, dealStage: p.dealStage } });
      return { summary: `Converted the lead into deal “${r.deal.title}”.`, data: r.deal };
    },
    output: r => out('deal', r.data),
  },

  // ── Deals ───────────────────────────────────────────────────────────────
  {
    name: 'CREATE_DEAL', label: 'Create a deal', category: 'CRM',
    description: 'Creates a deal on the pipeline (e.g. "create a 5 lakh deal for Acme closing end of month, owner Arjun").',
    example: 'Create a deal “Acme renewal” worth 500000 closing end of month',
    paramsHint: '{ title: string, value?: number, stage?: pipeline stage name, closeDate?: date, contactId?: contact name, accountId?: account name, assignedTo?: owner\'s name (default you), probability?: 0-100 }',
    allowedRoles: CRM_STAFF, permission: 'crm.deal.create', modules: ['crm'], requiresConfirmation: true, risk: 'low',
    refs: { contactId: 'contact', accountId: 'account', assignedTo: 'user' }, dates: { closeDate: 'date' },
    schema: z.object({ title: z.string().trim().min(1).max(200), value: zMoney.optional(), stage: z.string().max(60).optional(), closeDate: zDate.optional(), contactId: zId.optional(), accountId: zId.optional(), assignedTo: zId.optional(), probability: z.coerce.number().min(0).max(100).optional() }),
    sample: { title: 'Acme renewal', value: 500000 },
    preview: async (p, ctx, info) => {
      const stages = normalizeStages((await ensureDefaultPipeline(ctx.orgId)).stages);
      if (p.stage && !stages.some(s => s.label === p.stage)) throw new AppError(400, `"${p.stage}" isn't a pipeline stage (stages: ${stages.map(s => s.label).join(', ')})`);
      const pv = listPreview(`Create deal “${p.title}”`, p, info);
      if (!p.stage) pv.changes.push({ field: 'Stage', after: stages[0]?.label ?? '—' });
      return pv;
    },
    handler: async (p, ctx) => {
      const d = await callUi(deals.create, ctx, { body: p });
      return { summary: `Created deal “${d.title}” (${d.stage}, ${show(Number(d.value))}).`, data: d };
    },
    output: r => out('deal', r.data),
  },
  {
    name: 'MOVE_DEAL_STAGE', label: 'Move deal stage', category: 'CRM',
    description: 'Moves a deal to a different pipeline stage (e.g. "move the Acme deal to Proposal").',
    example: 'Move the Acme deal to Proposal',
    paramsHint: '{ dealId: deal name, stage: pipeline stage name }',
    allowedRoles: CRM_STAFF, permission: 'crm.deal.update', modules: ['crm'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'deal', param: 'dealId', permission: 'crm.deal.update' },
    schema: z.object({ dealId: zId, stage: z.string().min(1).max(60) }),
    sample: { dealId: 'd1', stage: 'Proposal' },
    preview: async (p, _ctx, info) => ({ title: `Move “${info.row?.title ?? 'deal'}” to ${p.stage}`, target: target('deal', info.row), changes: [{ field: 'Stage', before: info.row?.stage, after: p.stage }] }),
    handler: async (p, ctx) => {
      const before = await prisma.deal.findFirst({ where: { id: p.dealId, orgId: ctx.orgId }, select: { stage: true } });
      const d = await callUi(deals.moveStage, ctx, { params: { id: p.dealId }, body: { stage: p.stage } });
      return { summary: `Moved “${d.title}” from ${before?.stage ?? '—'} to ${p.stage}.`, data: d };
    },
    output: r => out('deal', r.data),
  },
  {
    name: 'UPDATE_DEAL', label: 'Update a deal', category: 'CRM',
    description: 'Changes a deal\'s value, stage, owner, close date, probability or marks it won/lost (e.g. "set the Acme deal to 6 lakh and assign it to Arjun", "mark the Acme deal won").',
    example: 'Update the Acme deal value to 600000 and assign it to Arjun',
    paramsHint: '{ dealId: deal name, value?: number, stage?: pipeline stage name, assignedTo?: owner\'s name, closeDate?: date, probability?: 0-100, status?: "OPEN"|"WON"|"LOST", title?: string }',
    allowedRoles: CRM_STAFF, permission: 'crm.deal.update', modules: ['crm'], requiresConfirmation: true, risk: 'medium',
    record: { entity: 'deal', param: 'dealId', permission: 'crm.deal.update' }, refs: { assignedTo: 'user' }, dates: { closeDate: 'date' },
    schema: z.object({ dealId: zId, value: zMoney.optional(), stage: z.string().max(60).optional(), assignedTo: zId.optional(), closeDate: zDate.optional(), probability: z.coerce.number().min(0).max(100).optional(), status: z.enum(['OPEN', 'WON', 'LOST']).optional(), title: z.string().min(1).max(200).optional() })
      .refine(p => Object.keys(p).length > 1, { message: 'Nothing to change' }),
    sample: { dealId: 'd1', value: 600000 },
    preview: async (p, _ctx, info) => ({
      title: `Update deal “${info.row?.title ?? ''}”`, target: target('deal', info.row),
      changes: diffPreview(info.row, p, info, [
        { key: 'title', label: 'Title', before: r => r.title }, { key: 'value', label: 'Value', before: r => r.value }, { key: 'stage', label: 'Stage', before: r => r.stage },
        { key: 'assignedTo', label: 'Owner', before: r => r.assignee?.name }, { key: 'closeDate', label: 'Close date', before: r => r.closeDate },
        { key: 'probability', label: 'Probability %', before: r => r.probability }, { key: 'status', label: 'Status', before: r => r.status },
      ]),
    }),
    handler: async (p, ctx) => {
      const { dealId, stage, ...rest } = p;
      let d: any;
      const current = await prisma.deal.findFirst({ where: { id: dealId, orgId: ctx.orgId }, select: { stage: true } });
      // A stage change goes through the board's move (stage validation, history, owner email).
      if (stage && stage !== current?.stage) d = await callUi(deals.moveStage, ctx, { params: { id: dealId }, body: { stage } });
      if (Object.keys(rest).length) d = await callUi(deals.update, ctx, { params: { id: dealId }, body: rest });
      return { summary: `Updated deal “${d?.title ?? ''}”.`, data: d };
    },
    output: r => out('deal', r.data),
  },

  // ── Activities / follow-ups ─────────────────────────────────────────────
  {
    name: 'LOG_ACTIVITY', label: 'Log an activity or follow-up', category: 'CRM',
    description: 'Logs or schedules a call, email, meeting or task on a deal, contact or lead (e.g. "log a call with the Acme deal about pricing", "schedule a follow-up call with Ravi Friday 11am"). A future dueAt makes it a scheduled follow-up.',
    example: 'Schedule a follow-up call with the Acme deal on Friday at 11am',
    paramsHint: '{ type: "CALL"|"EMAIL"|"MEETING"|"TASK", title: string, body?: string, dealId?: deal name, contactId?: contact name, leadId?: lead\'s name, dueAt?: date-time words or ISO, done?: boolean }',
    allowedRoles: CRM_STAFF, permission: 'crm.activity.create', modules: ['crm'], requiresConfirmation: true, risk: 'low',
    refs: { dealId: 'deal', contactId: 'contact', leadId: 'lead' }, dates: { dueAt: 'datetime' },
    schema: z.object({ type: z.enum(['CALL', 'EMAIL', 'MEETING', 'TASK']), title: z.string().min(1).max(200), body: z.string().max(2000).optional(), dealId: zId.optional(), contactId: zId.optional(), leadId: zId.optional(), dueAt: zDateTime.optional(), done: z.boolean().optional() }),
    sample: { type: 'CALL', title: 'Follow-up call', dueAt: '2026-10-23T05:30:00.000Z' },
    preview: async (p, _ctx, info) => listPreview(`${p.dueAt && !p.done ? 'Schedule' : 'Log'} a ${p.type.toLowerCase()}: “${p.title}”`, p, info),
    handler: async (p, ctx) => {
      const a = await callUi(activities.create, ctx, { body: { ...p, done: p.done ?? false } });
      return { summary: `${a.dueAt && !a.done ? 'Scheduled' : 'Logged'} a ${a.type.toLowerCase()}: “${a.title}”${a.dueAt ? ` for ${when(a.dueAt, ctx)}` : ''}.`, data: a };
    },
    output: (r, p) => ({ id: (r.data as any)?.id, type: 'activity', label: (r.data as any)?.title, link: p.dealId ? '/crm/deals' : p.leadId ? '/crm/leads' : p.contactId ? `/crm/contacts/${p.contactId}` : '/crm/deals' }),
  },

  // ── Quotes ──────────────────────────────────────────────────────────────
  {
    name: 'CREATE_QUOTE', label: 'Create a quote', category: 'CRM',
    description: 'Creates a DRAFT quote with line items (there is no product catalogue — give each line a description, quantity and unit price), optionally on a deal (e.g. "quote Acme 10 CRM seats at 1,200 each and onboarding at 25,000").',
    example: 'Create a quote for the Acme deal: 10 CRM seats at 1200 each and onboarding at 25000',
    paramsHint: '{ title: string, dealId?: deal name, validUntil?: date, notes?: string, lines: [{ description: string, quantity?: number, unitPrice: number, discount?: percent }] }',
    allowedRoles: CRM_STAFF, permission: 'crm.quote.create', modules: ['sales_docs'], requiresConfirmation: true, risk: 'low',
    refs: { dealId: 'deal' }, dates: { validUntil: 'date' },
    schema: z.object({ title: z.string().min(1).max(200), dealId: zId.optional(), validUntil: zDate.optional(), notes: z.string().max(2000).optional(), lines: z.array(LineSchema).min(1).max(50) }),
    sample: { title: 'Acme — CRM seats', lines: [{ description: 'CRM seat', quantity: 10, unitPrice: 1200 }] },
    preview: async (p, _ctx, info) => {
      const pv = listPreview(`Create a draft quote “${p.title}”`, p, info, ['lines']);
      pv.changes.push({ field: 'Lines', after: linesText(p.lines) }, { field: 'Subtotal', after: show(linesTotal(p.lines)) });
      return pv;
    },
    handler: async (p, ctx) => {
      const q = await callUi(quotes.create, ctx, { body: p });
      return { summary: `Created draft quote “${q.title}” (${q.lines.length} line${q.lines.length === 1 ? '' : 's'}, subtotal ${show(linesTotal(q.lines))}).`, data: q };
    },
    output: r => out('quote', r.data),
  },
  {
    name: 'CHANGE_QUOTE_STATUS', label: 'Send / mark a quote', category: 'CRM',
    description: 'Sets a quote to Draft, Sent, or Rejected (e.g. "mark the Acme quote as sent"). Accepted isn\'t settable here — only the customer\'s signed acceptance link marks a quote Accepted.',
    example: 'Mark the Acme quote as sent',
    paramsHint: '{ quoteId: quote title, status: "DRAFT"|"SENT"|"REJECTED" }',
    allowedRoles: CRM_STAFF, permission: 'crm.quote.update', modules: ['sales_docs'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'quote', param: 'quoteId', permission: 'crm.quote.update' },
    schema: z.object({ quoteId: zId, status: z.enum(['DRAFT', 'SENT', 'REJECTED']) }),
    sample: { quoteId: 'q1', status: 'SENT' },
    preview: async (p, _ctx, info) => ({ title: `Set quote “${info.row?.title ?? ''}” to ${p.status}`, target: target('quote', info.row), changes: [{ field: 'Status', before: info.row?.status, after: p.status }] }),
    handler: async (p, ctx) => {
      const q = await callUi(quotes.changeStatus, ctx, { params: { id: p.quoteId }, body: { status: p.status } });
      return { summary: `Set quote “${q.title}” to ${p.status}.`, data: q };
    },
    output: r => out('quote', r.data),
  },

  // ── Invoices ────────────────────────────────────────────────────────────
  {
    name: 'CREATE_INVOICE', label: 'Create an invoice', category: 'CRM',
    description: 'Creates a DRAFT invoice — from an existing quote (copies its lines) or with its own line items (e.g. "invoice the Acme quote, due in 14 days").',
    example: 'Create an invoice from the Acme quote due in 14 days',
    paramsHint: '{ quoteId?: quote title (copies its lines, title and deal), title?: string, dealId?: deal name, dueDate?: date, taxRate?: percent, notes?: string, lines?: [{ description, quantity?, unitPrice, discount? }] (required without a quote) }',
    allowedRoles: CRM_STAFF, permission: 'crm.invoice.create', modules: ['sales_docs'], requiresConfirmation: true, risk: 'medium',
    refs: { quoteId: 'quote', dealId: 'deal' }, dates: { dueDate: 'date' },
    schema: z.object({ quoteId: zId.optional(), title: z.string().min(1).max(200).optional(), dealId: zId.optional(), dueDate: zDate.optional(), taxRate: z.coerce.number().min(0).max(100).optional(), notes: z.string().max(2000).optional(), lines: z.array(LineSchema).min(1).max(50).optional() })
      .refine(p => p.quoteId || (p.lines && p.title), { message: 'Name a quote to invoice, or give a title and line items' }),
    sample: { title: 'Onboarding', lines: [{ description: 'Onboarding', quantity: 1, unitPrice: 25000 }] },
    preview: async (p, ctx, info) => {
      const q = p.quoteId && !/^\$/.test(p.quoteId) ? await prisma.quote.findFirst({ where: { id: p.quoteId, orgId: ctx.orgId }, include: { lines: true } }) : null;
      const lines = (p.lines ?? q?.lines ?? []).map((l: any) => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discount: Number(l.discount ?? 0) }));
      const name = p.title ?? q?.title;
      const pv = listPreview(name ? `Create a draft invoice “${name}”` : `Create a draft invoice from ${info.refLabels.quoteId ?? 'the quote'}`, p, info, ['lines']);
      if (lines.length) pv.changes.push({ field: 'Lines', after: linesText(lines) }, { field: 'Subtotal', after: show(linesTotal(lines)) });
      pv.notes = ['The invoice number is assigned when it is created (INV-…).'];
      return pv;
    },
    handler: async (p, ctx) => {
      let body: any = { title: p.title, dealId: p.dealId, dueDate: p.dueDate, taxRate: p.taxRate ?? 0, notes: p.notes, lines: p.lines };
      if (p.quoteId) {
        const q = await prisma.quote.findFirst({ where: { id: p.quoteId, orgId: ctx.orgId }, include: { lines: true } });
        if (!q) throw new AppError(404, 'Quote not found');
        body = {
          ...body, quoteId: q.id, title: p.title ?? q.title, dealId: p.dealId ?? q.dealId ?? undefined,
          lines: p.lines ?? q.lines.map(l => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discount: Number(l.discount ?? 0) })),
        };
      }
      const inv = await callUi(invoices.create, ctx, { body });
      return { summary: `Created draft invoice ${inv.invoiceNumber} “${inv.title}”.`, data: inv };
    },
    output: r => out('invoice', r.data),
  },
  {
    name: 'CHANGE_INVOICE_STATUS', label: 'Send / mark an invoice paid', category: 'CRM',
    description: 'Sets an invoice\'s status — sent, paid (records full payment; partial payments aren\'t tracked), overdue, void or back to draft (e.g. "mark invoice INV-0007 as paid").',
    example: 'Mark invoice INV-0007 as paid',
    paramsHint: '{ invoiceId: invoice number or title, status: "DRAFT"|"SENT"|"PAID"|"OVERDUE"|"VOID" }',
    allowedRoles: CRM_STAFF, permission: 'crm.invoice.update', modules: ['sales_docs'], requiresConfirmation: true,
    risk: p => (p.status === 'PAID' || p.status === 'VOID' ? 'high' : 'medium'),
    record: { entity: 'invoice', param: 'invoiceId', permission: 'crm.invoice.update' },
    schema: z.object({ invoiceId: zId, status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'VOID']) }),
    sample: { invoiceId: 'i1', status: 'PAID' },
    preview: async (p, _ctx, info) => {
      const total = info.row?.lines ? linesTotal(info.row.lines) * (1 + Number(info.row.taxRate ?? 0) / 100) : null;
      return {
        title: `Set invoice ${info.row?.invoiceNumber ?? ''} to ${p.status}`, target: target('invoice', info.row),
        changes: [{ field: 'Status', before: info.row?.status, after: p.status }, ...(total !== null ? [{ field: 'Invoice total', after: show(Math.round(total * 100) / 100) }] : []), ...(p.status === 'PAID' ? [{ field: 'Paid on', after: 'today' }] : [])],
        notes: p.status === 'PAID' ? ['Marks the whole invoice as paid — there is no partial-payment ledger.'] : undefined,
      };
    },
    handler: async (p, ctx) => {
      const inv = await callUi(invoices.changeStatus, ctx, { params: { id: p.invoiceId }, body: { status: p.status } });
      return { summary: `Set invoice ${inv.invoiceNumber} to ${p.status}.`, data: inv };
    },
    output: r => out('invoice', r.data),
  },

  // ── Campaigns ───────────────────────────────────────────────────────────
  {
    name: 'CREATE_CAMPAIGN', label: 'Create an email campaign (draft)', category: 'CRM',
    description: 'Creates a DRAFT email campaign to all leads or all contacts (e.g. "draft a Diwali offer campaign to all contacts"). Sending is a separate step (SEND_CAMPAIGN); scheduled sending isn\'t supported.',
    example: 'Draft a campaign “Diwali offer” to all contacts with subject “20% off this week”',
    paramsHint: '{ name: string, subject: string, body: string (the email text), targetType?: "LEADS"|"CONTACTS" }',
    allowedRoles: CRM_MANAGERS, permission: 'crm.campaign.create', modules: ['campaigns'], requiresConfirmation: true, risk: 'low',
    schema: z.object({ name: z.string().min(1).max(120), subject: z.string().min(1).max(200), body: z.string().min(1).max(10000), targetType: z.enum(['LEADS', 'CONTACTS']).default('LEADS') }),
    sample: { name: 'Diwali offer', subject: '20% off this week', body: 'Hello!', targetType: 'CONTACTS' },
    preview: async (p, _ctx, info) => listPreview(`Create draft campaign “${p.name}”`, p, info),
    handler: async (p, ctx) => {
      const c = await callUi(campaigns.create, ctx, { body: p });
      return { summary: `Created draft campaign “${c.name}” (to all ${c.targetType.toLowerCase()}). Nothing has been sent.`, data: c };
    },
    output: r => out('campaign', r.data),
  },
  {
    name: 'SEND_CAMPAIGN', label: 'Send a campaign', category: 'CRM',
    description: 'Sends an existing email campaign to its whole audience right now (e.g. "send the Spring Promo campaign"). Irreversible.',
    example: 'Send the Spring Promo campaign',
    paramsHint: '{ campaignId: campaign name }',
    allowedRoles: CRM_MANAGERS, permission: 'crm.campaign.update', modules: ['campaigns'], requiresConfirmation: true, risk: 'high',
    record: { entity: 'campaign', param: 'campaignId' },
    schema: z.object({ campaignId: zId }),
    sample: { campaignId: 'cmp1' },
    preview: async (_p, ctx, info) => {
      const row = info.row;
      let audience: number | null = null;
      if (row) {
        audience = row.targetType === 'CONTACTS'
          ? await prisma.contact.count({ where: { orgId: ctx.orgId, email: { not: null } } })
          : await prisma.lead.count({ where: { orgId: ctx.orgId, status: { not: 'CONVERTED' }, contact: { email: { not: null } } } });
      }
      return {
        title: `Send campaign “${row?.name ?? ''}” now`, target: target('campaign', row),
        changes: [{ field: 'Status', before: row?.status, after: 'SENDING' }, { field: 'Audience', after: audience === null ? '—' : `about ${audience} ${String(row?.targetType ?? '').toLowerCase()} with an email` }, { field: 'Subject', after: row?.subject ?? null }],
        notes: ['Emails go out immediately and cannot be recalled.'],
      };
    },
    handler: async (p, ctx) => {
      const r = await callUi(campaigns.send, ctx, { params: { id: p.campaignId } });
      return { summary: r.message ?? `Sending to ${r.recipients} recipients…`, data: { id: p.campaignId, recipients: r.recipients } };
    },
    output: (r, p) => ({ id: p.campaignId, type: 'campaign', label: 'Campaign', link: '/campaigns' }),
  },
];

async function findContact(orgId: string, name: string, email?: string) {
  const byEmail = email ? await prisma.contact.findFirst({ where: { orgId, email: { equals: email, mode: 'insensitive' } } }) : null;
  return byEmail ?? prisma.contact.findFirst({ where: { orgId, name: { equals: name, mode: 'insensitive' } } });
}
