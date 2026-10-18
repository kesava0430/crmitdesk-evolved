/**
 * IT Desk actions — tickets, knowledge base, assets, change requests.
 * Handlers run the IT Desk screens' controllers as the confirming user, so
 * SLA due dates, ticket history, requester emails, SSE updates and workflows
 * fire exactly as when an agent clicks the button.
 */
import { z } from 'zod';
import { prisma } from '../../prisma';
import { AppError } from '../../../middleware/errorHandler';
import { ALL_USERS, IT_STAFF, IT_MANAGERS } from '../../../middleware/authenticate';
import * as tickets from '../../../modules/itdesk/tickets/tickets.controller';
import * as articles from '../../../modules/itdesk/articles/articles.controller';
import * as assets from '../../../modules/itdesk/assets/assets.controller';
import * as categories from '../../../modules/itdesk/categories/categories.controller';
import * as changes from '../../../modules/changemanagement/changeRequests.controller';
import * as comments from '../../../modules/core/comments/comments.controller';
import { callUi, out, listPreview, diffPreview, target, zDateTime, zId } from '../helpers';
import type { AiActionDefinition } from '../types';

const PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const ASSET_STATUS = ['active', 'inactive', 'retired', 'in_repair'] as const;

export const ITDESK_ACTIONS: AiActionDefinition[] = [
  // ── Tickets ─────────────────────────────────────────────────────────────
  {
    name: 'CREATE_TICKET', label: 'Create a ticket', category: 'IT Desk',
    description: 'Creates a new support/help-desk ticket (e.g. "create a high priority ticket: VPN down for the sales team"). Set categoryId only if the user names a category.',
    example: 'Create a high priority ticket: projector in the boardroom is flickering',
    paramsHint: '{ title: string, body: string, priority?: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", categoryId?: category name, contactId?: customer contact name (staff only) }',
    allowedRoles: ALL_USERS, permission: 'itdesk.ticket.create', modules: ['itdesk'], requiresConfirmation: true, risk: 'low',
    refs: { categoryId: 'category', contactId: 'contact' },
    schema: z.preprocess(
      // Older plans (and the conversation filer) send categoryName.
      (v: any) => (v && typeof v === 'object' && v.categoryName && !v.categoryId ? { ...v, categoryId: v.categoryName, categoryName: undefined } : v),
      z.object({ title: z.string().min(3).max(200), body: z.string().min(1).max(5000), priority: z.enum(PRIORITY).optional(), categoryId: zId.optional(), contactId: zId.optional() }),
    ),
    sample: { title: 'Projector flickering', body: 'Boardroom projector flickers', priority: 'HIGH' },
    preview: async (p, _ctx, info) => listPreview(`Create ${p.priority ?? 'MEDIUM'} ticket “${p.title}”`, p, info),
    handler: async (p, ctx) => {
      const t = await callUi(tickets.create, ctx, { body: p });
      return { summary: `Created ${t.priority} ticket “${t.title}”${t.category ? ` in ${t.category.name}` : ''}.`, data: t };
    },
    output: r => out('ticket', r.data),
  },
  {
    name: 'UPDATE_TICKET_STATUS', label: 'Resolve / close / reopen a ticket', category: 'IT Desk',
    description: 'Changes a ticket\'s status — resolve, close, reopen (OPEN), put on hold (PENDING) or start (IN_PROGRESS) (e.g. "mark the VPN ticket as resolved", "reopen the printer ticket").',
    example: 'Mark the VPN ticket as resolved',
    paramsHint: '{ ticketId: ticket title, status: "OPEN"|"IN_PROGRESS"|"PENDING"|"RESOLVED"|"CLOSED" }',
    allowedRoles: IT_STAFF, permission: 'itdesk.ticket.update', modules: ['itdesk'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'ticket', param: 'ticketId', permission: 'itdesk.ticket.update' },
    schema: z.object({ ticketId: zId, status: z.enum(['OPEN', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED']) }),
    sample: { ticketId: 't1', status: 'RESOLVED' },
    preview: async (p, _ctx, info) => ({
      title: `Set “${info.row?.title ?? 'ticket'}” to ${p.status}`, target: target('ticket', info.row),
      changes: [{ field: 'Status', before: info.row?.status, after: p.status }],
      notes: ['The requester is emailed about the change.'],
    }),
    handler: async (p, ctx) => {
      const t = await callUi(tickets.changeStatus, ctx, { params: { id: p.ticketId }, body: { status: p.status } });
      return { summary: `Set “${t.title}” to ${p.status}.`, data: t };
    },
    output: r => out('ticket', r.data),
  },
  {
    name: 'UPDATE_TICKET', label: 'Change ticket priority / category', category: 'IT Desk',
    description: 'Changes a ticket\'s priority, category or subject (e.g. "make the VPN ticket critical", "move the printer ticket to Hardware").',
    example: 'Raise the VPN ticket to critical priority',
    paramsHint: '{ ticketId: ticket title, priority?: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", categoryId?: category name, title?: new subject }',
    allowedRoles: IT_STAFF, permission: 'itdesk.ticket.update', modules: ['itdesk'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'ticket', param: 'ticketId', permission: 'itdesk.ticket.update' }, refs: { categoryId: 'category' },
    schema: z.object({ ticketId: zId, priority: z.enum(PRIORITY).optional(), categoryId: zId.optional(), title: z.string().min(1).max(200).optional() })
      .refine(p => Object.keys(p).length > 1, { message: 'Nothing to change' }),
    sample: { ticketId: 't1', priority: 'CRITICAL' },
    preview: async (p, _ctx, info) => ({
      title: `Update ticket “${info.row?.title ?? ''}”`, target: target('ticket', info.row),
      changes: diffPreview(info.row, p, info, [{ key: 'priority', label: 'Priority', before: r => r.priority }, { key: 'categoryId', label: 'Category', before: r => r.category?.name }, { key: 'title', label: 'Subject', before: r => r.title }]),
    }),
    handler: async (p, ctx) => {
      const { ticketId, ...data } = p;
      const t = await callUi(tickets.update, ctx, { params: { id: ticketId }, body: data });
      return { summary: `Updated ticket “${t.title}”.`, data: t };
    },
    output: r => out('ticket', r.data),
  },
  {
    name: 'ASSIGN_TICKET', label: 'Assign a ticket', category: 'IT Desk',
    description: 'Assigns a ticket to an agent and moves it to In Progress (e.g. "assign the VPN ticket to Priya").',
    example: 'Assign the VPN ticket to Priya',
    paramsHint: '{ ticketId: ticket title, assigneeId: agent\'s name }',
    // Same as the ticket screen's Assign (IT managers). The old action let IT agents assign too.
    allowedRoles: IT_MANAGERS, permission: 'itdesk.ticket.update', modules: ['itdesk'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'ticket', param: 'ticketId', permission: 'itdesk.ticket.update' }, refs: { assigneeId: 'staffUser' },
    schema: z.object({ ticketId: zId, assigneeId: zId }),
    sample: { ticketId: 't1', assigneeId: 'u1' },
    preview: async (p, _ctx, info) => ({
      title: `Assign “${info.row?.title ?? 'ticket'}” to ${info.labels.assigneeId ?? 'the agent'}`, target: target('ticket', info.row),
      changes: [{ field: 'Assignee', before: info.row?.assignee?.name ?? 'Unassigned', after: info.labels.assigneeId ?? p.assigneeId }, { field: 'Status', before: info.row?.status, after: 'IN_PROGRESS' }],
    }),
    handler: async (p, ctx) => {
      const t = await callUi(tickets.assign, ctx, { params: { id: p.ticketId }, body: { assignedTo: p.assigneeId } });
      return { summary: `Assigned “${t.title}” to ${t.assignee?.name ?? 'the agent'}.`, data: t };
    },
    output: r => out('ticket', r.data),
  },

  // ── Knowledge base ──────────────────────────────────────────────────────
  {
    name: 'CREATE_KB_ARTICLE', label: 'Draft a knowledge-base article', category: 'IT Desk',
    description: 'Creates a DRAFT knowledge-base article for review before publishing (e.g. "draft a KB article on resetting a forgotten VPN password").',
    example: 'Draft a KB article titled “Reset your VPN password” with the steps from the VPN ticket',
    paramsHint: '{ title: string, body: string (the article text), categoryId?: category name }',
    allowedRoles: IT_STAFF, permission: 'itdesk.article.create', modules: ['knowledge_base'], requiresConfirmation: true, risk: 'low',
    refs: { categoryId: 'category' },
    schema: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(20000), categoryId: zId.optional() }),
    sample: { title: 'Reset your VPN password', body: '1. Open …' },
    preview: async (p, _ctx, info) => { const pv = listPreview(`Draft KB article “${p.title}”`, p, info); pv.changes.push({ field: 'Status', after: 'DRAFT (not visible to customers until published)' }); return pv; },
    handler: async (p, ctx) => {
      const a = await callUi(articles.create, ctx, { body: { ...p, status: 'DRAFT' } });
      return { summary: `Drafted KB article “${a.title}”. Publish it from Knowledge Base when it's reviewed.`, data: a };
    },
    output: r => out('article', r.data),
  },
  {
    name: 'LINK_KB_ARTICLE', label: 'Link a KB article to a ticket', category: 'IT Desk',
    description: 'Adds a note on a ticket pointing to a knowledge-base article (e.g. "link the VPN reset article to the Ravi VPN ticket"). Tickets have no separate article link, so it is recorded as an internal note.',
    example: 'Link the “Reset your VPN password” article to the VPN ticket',
    paramsHint: '{ ticketId: ticket title, articleId: article title }',
    allowedRoles: IT_STAFF, permission: 'itdesk.ticket.update', modules: ['itdesk', 'knowledge_base'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'ticket', param: 'ticketId', permission: 'itdesk.ticket.update' }, refs: { articleId: 'article' },
    schema: z.object({ ticketId: zId, articleId: zId }),
    sample: { ticketId: 't1', articleId: 'a1' },
    preview: async (_p, _ctx, info) => ({
      title: `Link “${info.labels.articleId ?? 'article'}” to “${info.row?.title ?? 'ticket'}”`, target: target('ticket', info.row),
      changes: [{ field: 'Internal note', after: `Related knowledge-base article: ${info.labels.articleId ?? ''}` }],
    }),
    handler: async (p, ctx) => {
      const a = await prisma.knowledgeArticle.findFirst({ where: { id: p.articleId, orgId: ctx.orgId }, select: { id: true, title: true } });
      if (!a) throw new AppError(404, 'Knowledge-base article not found');
      const c = await callUi(comments.create, ctx, { params: { entityType: 'TICKET', entityId: p.ticketId }, body: { body: `<p>Related knowledge-base article: <a href="/itdesk/articles?article=${a.id}">${a.title.replace(/[<>&]/g, '')}</a></p>` } });
      return { summary: `Linked “${a.title}” to the ticket (internal note).`, data: { id: p.ticketId, commentId: c.id } };
    },
    output: (_r, p) => ({ id: p.ticketId, type: 'ticket', label: 'Ticket', link: '/itdesk/tickets' }),
  },

  // ── Assets ──────────────────────────────────────────────────────────────
  {
    name: 'CREATE_ASSET', label: 'Create an asset', category: 'IT Desk',
    description: 'Adds a new IT asset to the registry (e.g. "add a Dell XPS 15 laptop asset, serial 7H2K9").',
    example: 'Add a Dell XPS 15 laptop asset with serial 7H2K9',
    paramsHint: '{ name: string, type: string (e.g. Laptop), serialNumber?: string, assignedTo?: person\'s name, status?: "active"|"inactive"|"retired"|"in_repair" }',
    allowedRoles: IT_MANAGERS, permission: 'itdesk.asset.create', modules: ['assets'], requiresConfirmation: true, risk: 'low',
    refs: { assignedTo: 'user' },
    schema: z.object({ name: z.string().min(1).max(120), type: z.string().min(1).max(60), serialNumber: z.string().max(120).optional(), assignedTo: zId.optional(), status: z.enum(ASSET_STATUS).default('active') }),
    sample: { name: 'Dell XPS 15', type: 'Laptop' },
    preview: async (p, _ctx, info) => listPreview(`Add asset “${p.name}”`, p, info),
    handler: async (p, ctx) => {
      const a = await callUi(assets.create, ctx, { body: p });
      return { summary: `Added the “${a.name}” asset${a.assignee ? `, assigned to ${a.assignee.name}` : ''}.`, data: a };
    },
    output: r => out('asset', r.data),
  },
  {
    name: 'CHECK_OUT_ASSET', label: 'Check out / assign an asset', category: 'IT Desk',
    description: 'Assigns (checks out) an asset to a person (e.g. "give the Dell XPS 15 to Ravi", "check out laptop 7H2K9 to Priya").',
    example: 'Check out the Dell XPS 15 to Ravi Kumar',
    paramsHint: '{ assetId: asset name or serial, assignedTo: person\'s name }',
    allowedRoles: IT_MANAGERS, permission: 'itdesk.asset.update', modules: ['assets'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'asset', param: 'assetId', permission: 'itdesk.asset.update' }, refs: { assignedTo: 'user' },
    schema: z.object({ assetId: zId, assignedTo: zId }),
    sample: { assetId: 'as1', assignedTo: 'u1' },
    preview: async (p, _ctx, info) => ({
      title: `Check out “${info.row?.name ?? 'asset'}” to ${info.labels.assignedTo ?? 'the person'}`, target: target('asset', info.row),
      changes: [{ field: 'Assigned to', before: info.row?.assignee?.name ?? 'In stock', after: info.labels.assignedTo ?? p.assignedTo }, ...(info.row && info.row.status !== 'active' ? [{ field: 'Status', before: info.row.status, after: 'active' }] : [])],
    }),
    handler: async (p, ctx) => {
      const a = await callUi(assets.update, ctx, { params: { id: p.assetId }, body: { assignedTo: p.assignedTo, status: 'active' } });
      return { summary: `Checked out “${a.name}” to ${a.assignee?.name ?? 'the person'}.`, data: a };
    },
    output: r => out('asset', r.data),
  },
  {
    name: 'CHECK_IN_ASSET', label: 'Check in an asset', category: 'IT Desk',
    description: 'Returns (checks in) an asset so it is unassigned and back in stock, optionally setting a status like in_repair (e.g. "Ravi returned his laptop", "check in the XPS 15 for repair").',
    example: 'Check in the Dell XPS 15 — Ravi returned it',
    paramsHint: '{ assetId: asset name or serial, status?: "active"|"inactive"|"retired"|"in_repair" }',
    allowedRoles: IT_MANAGERS, permission: 'itdesk.asset.update', modules: ['assets'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'asset', param: 'assetId', permission: 'itdesk.asset.update' },
    schema: z.object({ assetId: zId, status: z.enum(ASSET_STATUS).optional() }),
    sample: { assetId: 'as1' },
    preview: async (p, _ctx, info) => ({
      title: `Check in “${info.row?.name ?? 'asset'}”`, target: target('asset', info.row),
      changes: [{ field: 'Assigned to', before: info.row?.assignee?.name ?? 'In stock', after: 'In stock (unassigned)' }, ...(p.status ? [{ field: 'Status', before: info.row?.status, after: p.status }] : [])],
    }),
    handler: async (p, ctx) => {
      const a = await callUi(assets.update, ctx, { params: { id: p.assetId }, body: { assignedTo: null, ...(p.status ? { status: p.status } : {}) } });
      return { summary: `Checked in “${a.name}”${p.status ? ` (${p.status})` : ''}.`, data: a };
    },
    output: r => out('asset', r.data),
  },
  {
    name: 'UPDATE_ASSET_STATUS', label: "Update an asset's status", category: 'IT Desk',
    description: 'Changes an asset\'s status (e.g. "mark the Dell XPS 15 as retired").',
    example: 'Mark the Dell XPS 15 asset as retired',
    paramsHint: '{ assetId: asset name or serial, status: "active"|"inactive"|"retired"|"in_repair" }',
    allowedRoles: IT_MANAGERS, permission: 'itdesk.asset.update', modules: ['assets'], requiresConfirmation: true, risk: 'low',
    record: { entity: 'asset', param: 'assetId', permission: 'itdesk.asset.update' },
    schema: z.object({ assetId: zId, status: z.enum(ASSET_STATUS) }),
    sample: { assetId: 'as1', status: 'retired' },
    preview: async (p, _ctx, info) => ({ title: `Set “${info.row?.name ?? 'asset'}” to ${p.status}`, target: target('asset', info.row), changes: [{ field: 'Status', before: info.row?.status, after: p.status }] }),
    handler: async (p, ctx) => {
      const a = await callUi(assets.update, ctx, { params: { id: p.assetId }, body: { status: p.status } });
      return { summary: `Set “${a.name}” to ${p.status}.`, data: a };
    },
    output: r => out('asset', r.data),
  },

  // ── Categories & change requests ────────────────────────────────────────
  {
    name: 'CREATE_TICKET_CATEGORY', label: 'Create a ticket category', category: 'IT Desk',
    description: 'Creates a new IT Desk ticket category (e.g. "create a Network category for tickets").',
    example: 'Create a Network ticket category',
    paramsHint: '{ name: string }',
    allowedRoles: IT_MANAGERS, permission: 'itdesk.category.create', modules: ['itdesk'], requiresConfirmation: true, risk: 'low',
    schema: z.object({ name: z.string().min(1).max(80) }),
    sample: { name: 'Network' },
    preview: async (p, _ctx, info) => listPreview(`Create ticket category “${p.name}”`, p, info),
    handler: async (p, ctx) => {
      const c = await callUi(categories.create, ctx, { body: { name: p.name } });
      return { summary: `Created the “${c.name}” category.`, data: c };
    },
    output: r => out('category', r.data),
  },
  {
    name: 'CREATE_CHANGE_REQUEST', label: 'Create a change request', category: 'IT Desk',
    description: 'Raises an IT change request for approval (e.g. "raise a normal change to upgrade the firewall firmware Saturday 10pm to midnight").',
    example: 'Raise a change request to upgrade the firewall firmware this Saturday 10pm to 11:59pm',
    paramsHint: '{ title: string, description: string, type?: "NORMAL"|"EMERGENCY"|"STANDARD", priority?: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", assignedTo?: person\'s name, plannedStart?: date-time words or ISO, plannedEnd?: date-time }',
    allowedRoles: IT_STAFF, permission: 'itdesk.change.create', modules: ['itdesk'], requiresConfirmation: true, risk: 'low',
    refs: { assignedTo: 'staffUser' }, dates: { plannedStart: 'datetime', plannedEnd: 'datetime' },
    schema: z.object({ title: z.string().min(1).max(200), description: z.string().min(1).max(5000), type: z.enum(['NORMAL', 'EMERGENCY', 'STANDARD']).default('NORMAL'), priority: z.enum(PRIORITY).default('MEDIUM'), assignedTo: zId.optional(), plannedStart: zDateTime.optional(), plannedEnd: zDateTime.optional() })
      .refine(p => !p.plannedStart || !p.plannedEnd || p.plannedStart <= p.plannedEnd, { message: 'The planned end must be after the start', path: ['plannedEnd'] }),
    sample: { title: 'Firewall firmware upgrade', description: 'Upgrade to 7.2' },
    preview: async (p, _ctx, info) => listPreview(`Raise change request “${p.title}”`, p, info),
    handler: async (p, ctx) => {
      const c = await callUi(changes.create, ctx, { body: p });
      return { summary: `Raised change request “${c.title}” (${c.status ?? 'pending approval'}).`, data: c };
    },
    output: r => out('change', r.data),
  },
];

