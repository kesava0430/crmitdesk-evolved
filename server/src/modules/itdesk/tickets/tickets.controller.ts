import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { sendMail, emailTemplates } from '../../../utils/mailer';
import { parsePagination, paginate } from '../../../utils/pagination';
import { runWorkflows } from '../../../utils/workflow-engine';
import { sseManager, SSEEvent } from '../../../utils/sse';
import { notifyOrgAdmins } from '../../notifications/notifications.controller';
import { slackNewTicket } from '../../../utils/slack';
import { logAction } from '../../../utils/auditLog';

const Schema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  categoryId: z.string().optional(),
  priority: z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).optional(),
  // "Create on behalf of" — an agent/manager can submit a ticket as if
  // filed by another User (requesterId) or link it to a CRM Contact
  // (contactId) instead of themselves. Both optional and both gated to
  // IT_STAFF in create() below — an EMPLOYEE self-service submitter can't
  // spoof who a ticket is "from".
  requesterId: z.string().optional(),
  contactId: z.string().optional().or(z.literal('')).transform(v => v || undefined),
});

const include = {
  requester: { select: { id: true, name: true, email: true } },
  contact: { select: { id: true, name: true, email: true } },
  assignee: { select: { id: true, name: true, email: true } },
  category: { select: { id: true, name: true, slaPolicy: true } },
};

function calcSlaDue(resolutionHours: number) {
  const due = new Date();
  due.setHours(due.getHours() + resolutionHours);
  return due;
}

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { status, priority, assignedTo, requesterId } = req.query as Record<string, string>;
    const where: any = { orgId };
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (assignedTo) where.assignedTo = assignedTo;
    if (requesterId) where.requesterId = requesterId;
    if (req.user!.role === 'EMPLOYEE') where.requesterId = req.user!.id;
    const pag = parsePagination(req);
    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: pag.limit, skip: pag.skip }),
      prisma.ticket.count({ where }),
    ]);
    res.json(paginate(tickets, total, pag));
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const raw = Schema.parse(req.body);
    // Coerce empty string to undefined so Prisma receives null, not a bad FK
    const { requesterId: requestedRequesterId, contactId: requestedContactId, ...rest } = raw;
    const data = { ...rest, categoryId: raw.categoryId || undefined };

    // "On behalf of" overrides are staff-only — an EMPLOYEE (self-service
    // submitter, also covered by requireRole(...ALL_USERS) on this route)
    // can't set who a ticket is filed as/for; it always defaults to
    // themselves regardless of what's in the request body.
    const isStaff = ['SUPER_ADMIN', 'IT_MANAGER', 'IT_AGENT'].includes(req.user!.role);
    let requesterId = req.user!.id;
    let contactId: string | undefined;
    if (isStaff) {
      if (requestedRequesterId) {
        const requestedUser = await prisma.user.findFirst({ where: { id: requestedRequesterId, orgId } });
        if (!requestedUser) throw new AppError(400, 'Requester not found in your organization');
        requesterId = requestedUser.id;
      }
      if (requestedContactId) {
        const contact = await prisma.contact.findFirst({ where: { id: requestedContactId, orgId } });
        if (!contact) throw new AppError(400, 'Contact not found in your organization');
        contactId = contact.id;
      }
    }

    let slaDueAt: Date | undefined;
    if (data.categoryId) {
      const cat = await prisma.category.findFirst({ where: { id: data.categoryId, orgId }, include: { slaPolicy: true } });
      if (cat?.slaPolicy) slaDueAt = calcSlaDue(cat.slaPolicy.resolutionHours);
    }
    const ticket = await prisma.ticket.create({
      data: { ...data, orgId, requesterId, contactId, slaDueAt },
      include
    });
    await prisma.ticketHistory.create({ data: { ticketId: ticket.id, toStatus: 'OPEN', changedBy: req.user!.id } });
    const managers = await prisma.user.findMany({ where: { orgId, role: { in: ['IT_MANAGER', 'SUPER_ADMIN'] }, isActive: true } });
    managers.forEach(m => sendMail({ ...emailTemplates.ticketCreated(ticket, ticket.requester.name, m.email), orgId }).catch(() => {}));
    // Fire workflows + SSE in background
    runWorkflows({ trigger: 'TICKET_CREATED', orgId, entityType: 'TICKET', entityId: ticket.id, entity: ticket as any }).catch(() => {});
    sseManager.broadcastAll(orgId, SSEEvent.TICKET_CREATED, { id: ticket.id, title: ticket.title, priority: ticket.priority, status: ticket.status });
    notifyOrgAdmins({ orgId, type: 'TICKET_CREATED', title: `New ticket: ${ticket.title}`, body: `Priority: ${ticket.priority}`, entityType: 'TICKET', entityId: ticket.id }).catch(() => {});
    slackNewTicket(orgId, { id: ticket.id, title: ticket.title, priority: ticket.priority, requester: ticket.requester }).catch(() => {});
    logAction(req.user!.id, 'CREATE', 'Ticket', ticket.id, { title: ticket.title, priority: ticket.priority });
    res.status(201).json(ticket);
  } catch (err) { next(err); }
}

export async function getOne(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ticket = await prisma.ticket.findFirst({
      where: { id: req.params.id, orgId: req.user!.orgId },
      include: { ...include, history: { orderBy: { changedAt: 'desc' } } }
    });
    if (!ticket) throw new AppError(404, 'Ticket not found');
    res.json(ticket);
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.partial().parse(req.body);
    await prisma.ticket.updateMany({ where: { id: req.params.id, orgId: req.user!.orgId }, data });
    const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id }, include });
    logAction(req.user!.id, 'UPDATE', 'Ticket', req.params.id, data as Record<string, unknown>);
    res.json(ticket);
  } catch (err) { next(err); }
}

export async function changeStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { status } = z.object({ status: z.enum(['OPEN','IN_PROGRESS','PENDING','RESOLVED','CLOSED']) }).parse(req.body);
    const existing = await prisma.ticket.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!existing) throw new AppError(404, 'Ticket not found');
    const data: any = { status };
    if (status === 'RESOLVED') data.resolvedAt = new Date();
    if (status === 'CLOSED') data.closedAt = new Date();
    const ticket = await prisma.ticket.update({ where: { id: req.params.id }, data, include });
    await prisma.ticketHistory.create({ data: { ticketId: ticket.id, fromStatus: existing.status, toStatus: status, changedBy: req.user!.id } });
    runWorkflows({ trigger: 'TICKET_STATUS_CHANGED', orgId: req.user!.orgId, entityType: 'TICKET', entityId: ticket.id, entity: ticket as any, previousEntity: existing as any }).catch(() => {});
    sseManager.broadcastAll(req.user!.orgId, SSEEvent.TICKET_STATUS, { id: ticket.id, title: ticket.title, status, previousStatus: existing.status });
    notifyOrgAdmins({ orgId: req.user!.orgId, type: 'TICKET_STATUS', title: `Ticket "${ticket.title}" → ${status}`, entityType: 'TICKET', entityId: ticket.id }).catch(() => {});
    if (status === 'RESOLVED' && ticket.requester?.email) {
      sendMail({ ...emailTemplates.ticketResolved(ticket, ticket.requester.name, ticket.requester.email), orgId: req.user!.orgId }).catch(() => {});
      // Feedback survey is no longer hardcoded here — it's a SEND_CSAT_SURVEY
      // workflow action (see workflow-engine.ts), fired via the
      // TICKET_STATUS_CHANGED runWorkflows() call above. Configurable per
      // org: condition it on status/category, or turn it off entirely, from
      // the Workflows UI rather than a code change.
    } else if (ticket.requester?.email) {
      sendMail({ ...emailTemplates.ticketStatusChanged(ticket, status, ticket.requester.name, ticket.requester.email), orgId: req.user!.orgId }).catch(() => {});
    }
    res.json(ticket);
  } catch (err) { next(err); }
}

export async function assign(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { assignedTo } = z.object({ assignedTo: z.string() }).parse(req.body);
    const ticket = await prisma.ticket.update({
      where: { id: req.params.id },
      data: { assignedTo, status: 'IN_PROGRESS' },
      include
    });
    if (ticket.assignee?.email) {
      sendMail({ ...emailTemplates.ticketAssigned(ticket, ticket.assignee.name, ticket.assignee.email), orgId: req.user!.orgId }).catch(() => {});
    }
    res.json(ticket);
  } catch (err) { next(err); }
}

export async function reports(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const [open, inProgress, resolved, closed] = await Promise.all([
      prisma.ticket.count({ where: { orgId, status: 'OPEN' } }),
      prisma.ticket.count({ where: { orgId, status: 'IN_PROGRESS' } }),
      prisma.ticket.count({ where: { orgId, status: 'RESOLVED' } }),
      prisma.ticket.count({ where: { orgId, status: 'CLOSED' } }),
    ]);
    const byPriority = await prisma.ticket.groupBy({ by: ['priority'], _count: true, where: { orgId, status: { in: ['OPEN','IN_PROGRESS'] } } });
    const slaBreached = await prisma.ticket.count({ where: { orgId, slaDueAt: { lt: new Date() }, status: { notIn: ['RESOLVED','CLOSED'] } } });
    res.json({ open, inProgress, resolved, closed, byPriority, slaBreached });
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.ticket.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    logAction(req.user!.id, 'DELETE', 'Ticket', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
}
