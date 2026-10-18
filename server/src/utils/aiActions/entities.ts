/**
 * Record types an AI action can point at: how to find one by name (within
 * what the user may see), load it for a before → after preview, check the
 * permission engine's record scope on it, and link to it from the result card.
 */
import { prisma } from '../prisma';
import { scopedWhere, canAccessRecord, type PermCtx } from '../permissions';
import { pendingForUser } from '../approvals';
import type { Candidate } from './resolve';
import { searchTerms } from './resolve';
import type { EntityKey } from './types';

export interface EntityDef {
  /** Singular noun for messages ("deal", "leave request"). */
  noun: string;
  /** Licence module the record type belongs to (utils/modules.ts), if any. */
  module?: string;
  /** Permission-engine resource + read key, so name lookups only see what this user may see. */
  scope?: { resource: string; read: string };
  /** Up to ~40 candidates named like `text` (or the newest ones when text is empty). */
  search: (orgId: string, perm: PermCtx | undefined, text: string) => Promise<Candidate[]>;
  /** The full row, org-scoped; null when it doesn't exist in this org. */
  load: (orgId: string, id: string) => Promise<Record<string, any> | null>;
  title: (row: Record<string, any>) => string;
  link?: (id: string, row?: Record<string, any> | null) => string;
}

const TAKE = 40;

/** OR of case-insensitive contains on `field` for each distinctive word. */
function nameFilter(field: string, text: string, path?: (cond: any) => any): any {
  const terms = searchTerms(text);
  if (!terms.length) return {};
  const wrap = path ?? ((c: any) => ({ [field]: c }));
  return { OR: terms.map(t => wrap({ contains: t, mode: 'insensitive' })) };
}

function scoped(perm: PermCtx | undefined, def: { resource: string; read: string } | undefined) {
  return perm && def ? scopedWhere(perm, def.resource, def.read) : {};
}

const fmtDate = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const money = (v: unknown) => (v === null || v === undefined ? '' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

export const ENTITIES: Record<EntityKey, EntityDef> = {
  deal: {
    noun: 'deal', module: 'crm', scope: { resource: 'deal', read: 'crm.deal.read' },
    search: async (orgId, perm, text) => (await prisma.deal.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.deal.scope), ...nameFilter('title', text) },
      select: { id: true, title: true, stage: true, value: true }, orderBy: { updatedAt: 'desc' }, take: TAKE,
    })).map(d => ({ id: d.id, label: d.title, hint: `${d.stage} · ${money(d.value)}` })),
    load: (orgId, id) => prisma.deal.findFirst({ where: { id, orgId }, include: { assignee: { select: { name: true } }, contact: { select: { name: true } } } }),
    title: r => r.title, link: () => '/crm/deals',
  },
  lead: {
    noun: 'lead', module: 'crm', scope: { resource: 'lead', read: 'crm.lead.read' },
    search: async (orgId, perm, text) => (await prisma.lead.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.lead.scope), ...nameFilter('name', text, c => ({ contact: { name: c } })) },
      select: { id: true, status: true, source: true, contact: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(l => ({ id: l.id, label: l.contact?.name || 'Unnamed lead', hint: [l.status, l.contact?.email].filter(Boolean).join(' · '), aliases: l.contact?.email ? [l.contact.email] : [] })),
    load: (orgId, id) => prisma.lead.findFirst({ where: { id, orgId }, include: { contact: { select: { name: true, email: true } }, assignee: { select: { name: true } } } }),
    title: r => r.contact?.name || 'lead', link: () => '/crm/leads',
  },
  contact: {
    noun: 'contact', module: 'crm', scope: { resource: 'contact', read: 'crm.contact.read' },
    search: async (orgId, perm, text) => (await prisma.contact.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.contact.scope), ...nameFilter('name', text) },
      select: { id: true, name: true, email: true, account: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(c => ({ id: c.id, label: c.name, hint: [c.account?.name, c.email].filter(Boolean).join(' · '), aliases: c.email ? [c.email] : [] })),
    load: (orgId, id) => prisma.contact.findFirst({ where: { id, orgId }, include: { account: { select: { name: true } } } }),
    title: r => r.name, link: id => `/crm/contacts/${id}`,
  },
  account: {
    noun: 'account', module: 'crm', scope: { resource: 'account', read: 'crm.account.read' },
    search: async (orgId, perm, text) => (await prisma.account.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.account.scope), ...nameFilter('name', text) },
      select: { id: true, name: true, industry: true }, orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(a => ({ id: a.id, label: a.name, hint: a.industry ?? undefined })),
    load: (orgId, id) => prisma.account.findFirst({ where: { id, orgId } }),
    title: r => r.name, link: () => '/crm/contacts',
  },
  ticket: {
    noun: 'ticket', module: 'itdesk', scope: { resource: 'ticket', read: 'itdesk.ticket.read' },
    search: async (orgId, perm, text) => (await prisma.ticket.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.ticket.scope), ...nameFilter('title', text) },
      select: { id: true, title: true, status: true, priority: true }, orderBy: { updatedAt: 'desc' }, take: TAKE,
    })).map(t => ({ id: t.id, label: t.title, hint: `${t.status} · ${t.priority}` })),
    load: (orgId, id) => prisma.ticket.findFirst({ where: { id, orgId }, include: { assignee: { select: { name: true } }, category: { select: { name: true } } } }),
    title: r => r.title, link: () => '/itdesk/tickets',
  },
  quote: {
    noun: 'quote', module: 'sales_docs', scope: { resource: 'quote', read: 'crm.quote.read' },
    search: async (orgId, perm, text) => (await prisma.quote.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.quote.scope), ...nameFilter('title', text) },
      select: { id: true, title: true, status: true }, orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(q => ({ id: q.id, label: q.title, hint: q.status })),
    load: (orgId, id) => prisma.quote.findFirst({ where: { id, orgId }, include: { lines: true } }),
    title: r => r.title, link: () => '/quotes',
  },
  invoice: {
    noun: 'invoice', module: 'sales_docs',
    search: async (orgId, _perm, text) => {
      const num = text.match(/\b(?:inv[-\s]?)?(\d{1,6})\b/i);
      const where: any = { orgId };
      const nf = nameFilter('title', text);
      if (nf.OR || num) where.OR = [...(nf.OR ?? []), ...(num ? [{ invoiceNumber: { contains: num[1] } }] : [])];
      return (await prisma.invoice.findMany({ where, select: { id: true, invoiceNumber: true, title: true, status: true }, orderBy: { createdAt: 'desc' }, take: TAKE }))
        .map(i => ({ id: i.id, label: `${i.invoiceNumber} ${i.title}`, hint: i.status, aliases: [i.invoiceNumber, i.title, i.invoiceNumber.replace(/^INV-0*/, '')] }));
    },
    load: (orgId, id) => prisma.invoice.findFirst({ where: { id, orgId }, include: { lines: true } }),
    title: r => `${r.invoiceNumber} ${r.title}`, link: () => '/invoices',
  },
  campaign: {
    noun: 'campaign', module: 'campaigns',
    search: async (orgId, _perm, text) => (await prisma.campaign.findMany({
      where: { orgId, ...nameFilter('name', text) }, select: { id: true, name: true, status: true }, orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(c => ({ id: c.id, label: c.name, hint: c.status })),
    load: (orgId, id) => prisma.campaign.findFirst({ where: { id, orgId } }),
    title: r => r.name, link: () => '/campaigns',
  },
  asset: {
    noun: 'asset', module: 'assets', scope: { resource: 'asset', read: 'itdesk.asset.read' },
    search: async (orgId, perm, text) => (await prisma.asset.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.asset.scope), ...(searchTerms(text).length ? { OR: [...(nameFilter('name', text).OR ?? []), ...(nameFilter('serialNumber', text).OR ?? [])] } : {}) },
      select: { id: true, name: true, type: true, serialNumber: true, assignee: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(a => ({ id: a.id, label: a.name, hint: [a.type, a.serialNumber, a.assignee?.name && `with ${a.assignee.name}`].filter(Boolean).join(' · '), aliases: a.serialNumber ? [a.serialNumber] : [] })),
    load: (orgId, id) => prisma.asset.findFirst({ where: { id, orgId }, include: { assignee: { select: { name: true } } } }),
    title: r => r.name, link: () => '/itdesk/assets',
  },
  article: {
    noun: 'knowledge article', module: 'knowledge_base',
    search: async (orgId, _perm, text) => (await prisma.knowledgeArticle.findMany({
      where: { orgId, ...nameFilter('title', text) }, select: { id: true, title: true, status: true }, orderBy: { updatedAt: 'desc' }, take: TAKE,
    })).map(a => ({ id: a.id, label: a.title, hint: a.status })),
    load: (orgId, id) => prisma.knowledgeArticle.findFirst({ where: { id, orgId } }),
    title: r => r.title, link: () => '/itdesk/articles',
  },
  change: {
    noun: 'change request', module: 'itdesk',
    search: async (orgId, _perm, text) => (await prisma.changeRequest.findMany({
      where: { orgId, ...nameFilter('title', text) }, select: { id: true, title: true, status: true }, orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(c => ({ id: c.id, label: c.title, hint: c.status })),
    load: (orgId, id) => prisma.changeRequest.findFirst({ where: { id, orgId } }),
    title: r => r.title, link: () => '/change-requests',
  },
  category: {
    noun: 'ticket category', module: 'itdesk',
    search: async (orgId, _perm, text) => (await prisma.category.findMany({ where: { orgId, ...nameFilter('name', text) }, select: { id: true, name: true }, take: TAKE }))
      .map(c => ({ id: c.id, label: c.name })),
    load: (orgId, id) => prisma.category.findFirst({ where: { id, orgId } }),
    title: r => r.name, link: () => '/itdesk/categories',
  },
  // Anyone in the org with an active login (task assignees, invite targets, owners…)
  user: {
    noun: 'person',
    search: async (orgId, _perm, text) => (await prisma.user.findMany({
      where: { orgId, isActive: true, role: { not: 'PLATFORM_ADMIN' }, ...(searchTerms(text).length ? { OR: [...(nameFilter('name', text).OR ?? []), ...(nameFilter('email', text).OR ?? [])] } : {}) },
      select: { id: true, name: true, email: true, role: true }, orderBy: { name: 'asc' }, take: TAKE,
    })).map(u => ({ id: u.id, label: u.name, hint: `${u.email} · ${u.role.replace(/_/g, ' ').toLowerCase()}`, aliases: [u.email, u.email.split('@')[0]] })),
    load: (orgId, id) => prisma.user.findFirst({ where: { id, orgId }, select: { id: true, name: true, email: true, role: true, isActive: true, phone: true } }),
    title: r => r.name, link: () => '/admin/users',
  },
  // IT staff only — who tickets are assigned to (same set the ticket screen offers)
  staffUser: {
    noun: 'agent',
    search: async (orgId, _perm, text) => (await prisma.user.findMany({
      where: { orgId, isActive: true, role: { in: ['SUPER_ADMIN', 'IT_MANAGER', 'IT_AGENT'] }, ...nameFilter('name', text) },
      select: { id: true, name: true, email: true }, orderBy: { name: 'asc' }, take: TAKE,
    })).map(u => ({ id: u.id, label: u.name, hint: u.email, aliases: [u.email] })),
    load: (orgId, id) => prisma.user.findFirst({ where: { id, orgId }, select: { id: true, name: true, email: true, role: true, isActive: true } }),
    title: r => r.name,
  },
  employee: {
    noun: 'person', module: 'hr_core', scope: { resource: 'employee', read: 'hr.employee.read' },
    search: async (orgId, perm, text) => (await prisma.employee.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.employee.scope), ...(searchTerms(text).length ? { OR: [...(nameFilter('displayName', text).OR ?? []), ...(nameFilter('employeeCode', text).OR ?? [])] } : {}) },
      select: { id: true, displayName: true, employeeCode: true, designation: true, userId: true }, orderBy: { displayName: 'asc' }, take: TAKE,
    })).map(e => ({ id: e.id, label: e.displayName, hint: [e.employeeCode, e.designation].filter(Boolean).join(' · '), aliases: [e.employeeCode] })),
    load: (orgId, id) => prisma.employee.findFirst({
      where: { id, orgId },
      include: { department: { select: { name: true } }, manager: { select: { displayName: true } }, location: { select: { name: true } } },
    }),
    title: r => r.displayName, link: () => '/people',
  },
  department: {
    noun: 'department', module: 'hr_core',
    search: async (orgId, _perm, text) => (await prisma.department.findMany({ where: { orgId, isActive: true, ...nameFilter('name', text) }, select: { id: true, name: true }, take: TAKE }))
      .map(d => ({ id: d.id, label: d.name })),
    load: (orgId, id) => prisma.department.findFirst({ where: { id, orgId } }),
    title: r => r.name,
  },
  leaveType: {
    noun: 'leave type', module: 'hr_core',
    search: async (orgId, _perm, text) => (await prisma.leaveType.findMany({ where: { orgId, isActive: true, ...nameFilter('name', text) }, select: { id: true, name: true, isWfh: true }, take: TAKE }))
      .map(t => ({ id: t.id, label: t.name, hint: t.isWfh ? 'work from home' : undefined })),
    load: (orgId, id) => prisma.leaveType.findFirst({ where: { id, orgId } }),
    title: r => r.name,
  },
  // Pending requests only — approve/reject can't act on anything else.
  leaveRequest: {
    noun: 'pending leave or WFH request', module: 'hr_core',
    search: async (orgId, _perm, text) => (await prisma.leaveRequest.findMany({
      where: { orgId, status: 'PENDING', ...nameFilter('name', text, c => ({ user: { name: c } })) },
      select: { id: true, startDate: true, endDate: true, days: true, user: { select: { name: true } }, leaveType: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(r => ({
      id: r.id, label: `${r.user.name} — ${r.leaveType.name}`, aliases: [r.user.name],
      hint: `${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} (${Number(r.days)} day${Number(r.days) === 1 ? '' : 's'})`,
    })),
    load: (orgId, id) => prisma.leaveRequest.findFirst({ where: { id, orgId }, include: { user: { select: { name: true } }, leaveType: { select: { name: true, isWfh: true } } } }),
    title: r => `${r.user?.name ?? ''} — ${r.leaveType?.name ?? 'leave'} ${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}`, link: () => '/hr/leave',
  },
  // Approvals waiting on THIS user (the only ones they can decide).
  approval: {
    noun: 'pending approval',
    search: async (orgId, perm, _text) => {
      if (!perm) return [];
      const rows: any[] = await pendingForUser(orgId, perm.userId);
      return rows.slice(0, TAKE).map(r => ({ id: r.id, label: r.title, hint: [r.requester?.name, r.entityType].filter(Boolean).join(' · '), aliases: r.requester?.name ? [r.requester.name] : [] }));
    },
    load: (orgId, id) => prisma.approvalRequest.findFirst({ where: { id, orgId }, include: { requester: { select: { name: true } } } }),
    title: r => r.title, link: () => '/approvals',
  },
  loan: {
    noun: 'loan / advance', module: 'payroll',
    search: async (orgId, _perm, text) => (await prisma.employeeLoan.findMany({
      where: { orgId, status: 'ACTIVE', ...(searchTerms(text).length ? { OR: [...(nameFilter('name', text).OR ?? []), ...(nameFilter('name', text, c => ({ user: { name: c } })).OR ?? [])] } : {}) },
      select: { id: true, name: true, type: true, principal: true, user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: TAKE,
    })).map(l => ({ id: l.id, label: `${l.user.name} — ${l.name}`, hint: `${l.type.toLowerCase()} · ${money(l.principal)}`, aliases: [l.user.name, l.name] })),
    load: (orgId, id) => prisma.employeeLoan.findFirst({ where: { id, orgId }, include: { user: { select: { name: true } } } }),
    title: r => `${r.user?.name ?? ''} — ${r.name}`, link: () => '/hr/payroll',
  },
  rule: {
    noun: 'workflow rule',
    search: async (orgId, _perm, text) => (await prisma.workflowRule.findMany({ where: { orgId, ...nameFilter('name', text) }, select: { id: true, name: true, isActive: true }, take: TAKE }))
      .map(r => ({ id: r.id, label: r.name, hint: r.isActive ? 'on' : 'off' })),
    load: (orgId, id) => prisma.workflowRule.findFirst({ where: { id, orgId } }),
    title: r => r.name, link: () => '/workflows',
  },
  module: {
    noun: 'custom module',
    search: async (orgId, _perm, text) => (await prisma.customModule.findMany({ where: { orgId, isActive: true, ...nameFilter('name', text) }, select: { id: true, name: true, slug: true }, take: TAKE }))
      .map(m => ({ id: m.id, label: m.name, aliases: [m.slug] })),
    load: (orgId, id) => prisma.customModule.findFirst({ where: { id, orgId } }),
    title: r => r.name, link: (_id, r) => (r?.slug ? `/modules/${r.slug}` : '/custom-modules'),
  },
  task: {
    noun: 'task', scope: { resource: 'task', read: 'core.task.read' },
    search: async (orgId, perm, text) => (await prisma.task.findMany({
      where: { orgId, ...scoped(perm, ENTITIES.task.scope), status: { notIn: ['DONE', 'CANCELLED'] }, ...nameFilter('title', text) },
      select: { id: true, title: true, status: true }, orderBy: { updatedAt: 'desc' }, take: TAKE,
    })).map(t => ({ id: t.id, label: t.title, hint: t.status })),
    load: (orgId, id) => prisma.task.findFirst({ where: { id, orgId } }),
    title: r => r.title, link: () => '/my-work',
  },
  payrollCycle: {
    noun: 'payroll cycle', module: 'payroll',
    search: async (orgId, _perm, text) => (await prisma.payrollCycle.findMany({ where: { orgId, ...nameFilter('name', text) }, select: { id: true, name: true }, take: TAKE }))
      .map(c => ({ id: c.id, label: c.name })),
    load: (orgId, id) => prisma.payrollCycle.findFirst({ where: { id, orgId } }),
    title: r => r.name,
  },
};

/** Record-level permission check through the engine (scope OWN/TEAM/DEPARTMENT/ALL). */
export function recordAllowed(perm: PermCtx | undefined, entity: EntityKey, permissionKey: string | undefined, row: Record<string, any>): boolean {
  const def = ENTITIES[entity];
  if (!perm || !permissionKey || !def.scope) return true;
  return canAccessRecord(perm, def.scope.resource, permissionKey, row);
}
