import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { runWorkflows } from '../../../utils/workflow-engine';
import { sendMail, emailTemplates } from '../../../utils/mailer';
import { sseManager, SSEEvent } from '../../../utils/sse';
import { notifyOrgAdmins } from '../../notifications/notifications.controller';
import { logAction } from '../../../utils/auditLog';

const fmt = (d: Date) => d.toISOString().slice(0, 10);

// ─── Leave Types ─────────────────────────────────────────────────────────────

const LeaveTypeSchema = z.object({
  name: z.string().min(1),
  annualQuota: z.number().int().min(0).max(365).default(12),
  isPaid: z.boolean().default(true),
  color: z.string().optional(),
  isActive: z.boolean().optional(),
});

export async function listLeaveTypes(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const activeOnly = req.query.all !== '1';
    const types = await prisma.leaveType.findMany({
      where: { orgId: req.user!.orgId, ...(activeOnly ? { isActive: true } : {}) },
      orderBy: { name: 'asc' },
    });
    res.json(types);
  } catch (err) { next(err); }
}

export async function createLeaveType(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = LeaveTypeSchema.parse(req.body);
    const type = await prisma.leaveType.create({ data: { ...data, orgId: req.user!.orgId } });
    res.status(201).json(type);
  } catch (err) { next(err); }
}

export async function updateLeaveType(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = LeaveTypeSchema.partial().parse(req.body);
    const existing = await prisma.leaveType.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!existing) throw new AppError(404, 'Leave type not found');
    const type = await prisma.leaveType.update({ where: { id: req.params.id }, data });
    res.json(type);
  } catch (err) { next(err); }
}

export async function deleteLeaveType(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Soft-delete (isActive: false) rather than a hard delete — existing
    // LeaveRequests reference this row (RESTRICT on delete), and keeping
    // history intact matters more here than freeing up the name.
    const existing = await prisma.leaveType.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!existing) throw new AppError(404, 'Leave type not found');
    await prisma.leaveType.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ message: 'Leave type deactivated' });
  } catch (err) { next(err); }
}

// ─── Balance ──────────────────────────────────────────────────────────────────

/** GET /hr/leave/balance — the caller's remaining days per active leave type this calendar year */
export async function myBalance(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const userId = req.user!.id;
    const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    const yearEnd = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1));

    const [types, approved] = await Promise.all([
      prisma.leaveType.findMany({ where: { orgId, isActive: true }, orderBy: { name: 'asc' } }),
      prisma.leaveRequest.findMany({
        where: { orgId, userId, status: 'APPROVED', startDate: { gte: yearStart, lt: yearEnd } },
      }),
    ]);

    const usedByType = new Map<string, number>();
    for (const r of approved) usedByType.set(r.leaveTypeId, (usedByType.get(r.leaveTypeId) || 0) + r.days);

    const balances = types.map(t => ({
      leaveType: t,
      used: usedByType.get(t.id) || 0,
      remaining: Math.max(0, t.annualQuota - (usedByType.get(t.id) || 0)),
    }));
    res.json(balances);
  } catch (err) { next(err); }
}

// ─── Requests ────────────────────────────────────────────────────────────────

const RequestSchema = z.object({
  leaveTypeId: z.string(),
  startDate: z.string(), // YYYY-MM-DD
  endDate: z.string(),
  reason: z.string().optional(),
});

const include = {
  leaveType: true,
  user: { select: { id: true, name: true, avatarUrl: true } },
  decider: { select: { id: true, name: true } },
};

function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export async function createRequest(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = RequestSchema.parse(req.body);
    const orgId = req.user!.orgId;
    const userId = req.user!.id;

    const leaveType = await prisma.leaveType.findFirst({ where: { id: data.leaveTypeId, orgId, isActive: true } });
    if (!leaveType) throw new AppError(404, 'Leave type not found');

    const startDate = parseDateOnly(data.startDate);
    const endDate = parseDateOnly(data.endDate);
    if (endDate < startDate) throw new AppError(400, 'End date must be on or after the start date');
    const days = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;

    const request = await prisma.leaveRequest.create({
      data: { orgId, userId, leaveTypeId: data.leaveTypeId, startDate, endDate, days, reason: data.reason },
      include,
    });

    logAction(userId, 'CREATE', 'LeaveRequest', request.id, { leaveType: leaveType.name, days });
    sseManager.broadcastAll(orgId, SSEEvent.LEAVE_UPDATED, { id: request.id, userId, type: 'created' });
    notifyOrgAdmins({
      orgId, type: 'LEAVE_REQUESTED', title: `${request.user.name} requested ${leaveType.name}`,
      body: `${fmt(startDate)} → ${fmt(endDate)} (${days} day${days === 1 ? '' : 's'})`,
      entityType: 'LEAVE_REQUEST', entityId: request.id,
    }).catch(() => {});

    const managers = await prisma.user.findMany({ where: { orgId, role: { in: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] }, isActive: true } });
    managers.forEach(m => sendMail({
      ...emailTemplates.leaveRequested(m.email, m.name, request.user.name, leaveType.name, fmt(startDate), fmt(endDate), days),
      orgId,
    }).catch(() => {}));

    /* Automation hook — e.g. "when anyone requests more than 5 days,
       notify HR ops" (condition: days gt 5) or webhook a payroll system. */
    runWorkflows({
      trigger: 'LEAVE_REQUESTED', orgId, entityType: 'LEAVE', entityId: request.id,
      entity: { ...(request as any), leaveType: leaveType.name, employeeName: (request as any).user?.name },
    }).catch(() => {});

    res.status(201).json(request);
  } catch (err) { next(err); }
}

/** GET /hr/leave/requests — self sees own; managers can pass ?scope=org to see everyone's (else defaults to their own too) */
export async function listRequests(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { status, userId, scope } = req.query as Record<string, string>;
    const isManager = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'].includes(req.user!.role);

    const where: any = { orgId };
    if (isManager && scope === 'org') {
      if (userId) where.userId = userId;
    } else {
      where.userId = req.user!.id;
    }
    if (status) where.status = status;

    const requests = await prisma.leaveRequest.findMany({ where, include, orderBy: { createdAt: 'desc' } });
    res.json(requests);
  } catch (err) { next(err); }
}

export async function cancelRequest(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const request = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!request) throw new AppError(404, 'Leave request not found');
    if (request.userId !== req.user!.id) throw new AppError(403, 'You can only cancel your own request');
    if (request.status !== 'PENDING') throw new AppError(400, 'Only a pending request can be cancelled');

    const updated = await prisma.leaveRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' }, include });
    logAction(req.user!.id, 'UPDATE', 'LeaveRequest', request.id, { action: 'cancelled' });
    res.json(updated);
  } catch (err) { next(err); }
}

const RejectSchema = z.object({ reason: z.string().min(1) });

async function decide(req: AuthRequest, res: Response, next: NextFunction, approve: boolean) {
  try {
    const orgId = req.user!.orgId;
    const request = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, orgId }, include });
    if (!request) throw new AppError(404, 'Leave request not found');
    if (request.status !== 'PENDING') throw new AppError(400, `This request is already ${request.status.toLowerCase()}`);

    let rejectionReason: string | undefined;
    if (!approve) {
      rejectionReason = RejectSchema.parse(req.body).reason;
    }

    const updated = await prisma.leaveRequest.update({
      where: { id: request.id },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        decidedBy: req.user!.id,
        decidedAt: new Date(),
        rejectionReason,
      },
      include,
    });

    logAction(req.user!.id, 'UPDATE', 'LeaveRequest', request.id, { action: approve ? 'approved' : 'rejected' });
    sseManager.broadcastAll(orgId, SSEEvent.LEAVE_UPDATED, { id: request.id, userId: request.userId, type: 'decided' });

    await prisma.notification.create({
      data: {
        orgId, userId: request.userId, type: 'STATUS_CHANGE',
        title: `Your ${request.leaveType.name} request was ${approve ? 'approved' : 'rejected'}`,
        body: rejectionReason,
        entityId: request.id, entityType: 'LEAVE_REQUEST',
      },
    });
    const requester = await prisma.user.findUnique({ where: { id: request.userId } });
    if (requester) {
      sendMail({
        ...emailTemplates.leaveDecision(requester.email, requester.name, request.leaveType.name, fmt(request.startDate), fmt(request.endDate), approve, rejectionReason),
        orgId,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) { next(err); }
}

export const approveRequest = (req: AuthRequest, res: Response, next: NextFunction) => decide(req, res, next, true);
export const rejectRequest  = (req: AuthRequest, res: Response, next: NextFunction) => decide(req, res, next, false);
