import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { runWorkflows } from '../../../utils/workflow-engine';
import { sendMail, emailTemplates } from '../../../utils/mailer';
import { sseManager, SSEEvent } from '../../../utils/sse';
import { notifyOrgAdmins, createNotification } from '../../notifications/notifications.controller';
import { logAction } from '../../../utils/auditLog';

const fmt = (d: Date) => d.toISOString().slice(0, 10);

// ─── Leave Types ─────────────────────────────────────────────────────────────

const LeaveTypeSchema = z.object({
  name: z.string().min(1),
  annualQuota: z.number().int().min(0).max(365).default(12),
  isPaid: z.boolean().default(true),
  color: z.string().optional(),
  isActive: z.boolean().optional(),
  carryForward: z.boolean().optional(),
  carryForwardMaxDays: z.number().int().min(0).max(365).optional(),
  carryForwardExpiryMonths: z.number().int().min(0).max(12).optional(),
  allowHalfDay: z.boolean().optional(),
  isUnlimited: z.boolean().optional(),
  /** Work-from-home "type": approved days are WFH (paid), no balance consumed */
  isWfh: z.boolean().optional(),
});
import { audit, parseDateOnly as parseD, computeDays, frozenUntil } from '../../../utils/attendanceRegister';
import { computeBalances, validateLeaveRequest } from '../../../utils/leaveRules';
import { HR_MANAGERS, isHrManager, mustSomeoneElseApprove } from '../../../utils/hrAccess';
import { wfhContext } from '../../../utils/wfh';

export { computeBalances };

/** Nobody approves their own leave — whatever their role — unless they are the org's only HR manager (ATT-22). */
const SELF_APPROVAL = 'Someone else must approve your leave.';

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

/** GET /hr/leave/balance[?userId=&year=] — own balances; managers may query anyone */
export async function myBalance(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const isManager = isHrManager(req.user!.role);
    const userId = isManager && typeof req.query.userId === 'string' ? req.query.userId : req.user!.id;
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const target = await prisma.user.findFirst({ where: { id: userId, orgId: req.user!.orgId }, select: { id: true } });
    if (!target) throw new AppError(404, 'User not found');
    res.json(await computeBalances(req.user!.orgId, userId, year));
  } catch (err) { next(err); }
}

const AdjustSchema = z.object({ userId: z.string(), leaveTypeId: z.string(), year: z.number().int().min(2000).max(2100), days: z.number().min(-365).max(365), reason: z.string().min(1) });

/** POST /hr/leave/balances/adjust — managers credit/debit a balance (opening balance, comp-off, correction). Audited. */
export async function adjustBalance(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = AdjustSchema.parse(req.body);
    const [user, type] = await Promise.all([prisma.user.findFirst({ where: { id: data.userId, orgId } }), prisma.leaveType.findFirst({ where: { id: data.leaveTypeId, orgId } })]);
    if (!user || !type) throw new AppError(404, 'User or leave type not found');
    const row = await prisma.leaveBalanceAdjustment.create({ data: { orgId, userId: data.userId, leaveTypeId: data.leaveTypeId, year: data.year, days: data.days, reason: data.reason, createdBy: req.user!.id } });
    await audit(orgId, req.user!.id, { userId: data.userId, entityType: 'LEAVE_BALANCE', entityId: row.id, action: 'BALANCE_ADJUST', after: { leaveType: type.name, year: data.year, days: data.days }, reason: data.reason });
    res.status(201).json(row);
  } catch (err) { next(err); }
}

// ─── Requests ────────────────────────────────────────────────────────────────

export const RequestSchema = z.object({
  leaveTypeId: z.string(),
  startDate: z.string(), // YYYY-MM-DD
  endDate: z.string(),
  reason: z.string().optional(),
  halfDay: z.boolean().optional(),
  halfDayPeriod: z.enum(['AM', 'PM']).optional(),
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function checkDates(start: string, end?: string) {
  if (!DATE_ONLY.test(start) || (end !== undefined && !DATE_ONLY.test(end))) throw new AppError(400, 'Dates must be YYYY-MM-DD');
}

const include = {
  leaveType: true,
  user: { select: { id: true, name: true, avatarUrl: true } },
  decider: { select: { id: true, name: true } },
};

function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** "12 Oct → 14 Oct" / "12 Oct, first half" — how a request's dates read in notifications. */
export function describeDates(r: { startDate: Date; endDate: Date; halfDay?: boolean | null; halfDayPeriod?: string | null }) {
  if (r.halfDay) return `${fmt(r.startDate)} (${r.halfDayPeriod === 'PM' ? 'second' : 'first'} half)`;
  return fmt(r.startDate) === fmt(r.endDate) ? fmt(r.startDate) : `${fmt(r.startDate)} → ${fmt(r.endDate)}`;
}

/**
 * A self-service request (Leave page, or the "Request WFH" form). Work-from-home
 * types go through the policy group's WFH rules; under AUTO approval a request
 * that passes them is approved on the spot (and the days recomputed), otherwise
 * it waits for a manager like any leave. Managers are told either way —
 * in-app + push (notifyOrgAdmins) and, when a decision is needed, by email.
 */
export async function submitOwnRequest(req: AuthRequest, data: z.infer<typeof RequestSchema>) {
  const orgId = req.user!.orgId;
  const userId = req.user!.id;
  checkDates(data.startDate, data.halfDay ? undefined : data.endDate);
  const startDate = parseDateOnly(data.startDate);
  const endDate = data.halfDay ? startDate : parseDateOnly(data.endDate);
  // Working days only, type/half-day/overlap/balance checks (utils/leaveRules.ts)
  const { leaveType, days, wfh } = await validateLeaveRequest(orgId, userId, { leaveTypeId: data.leaveTypeId, startDate, endDate, halfDay: !!data.halfDay });
  const autoApproved = !!wfh?.autoApprove;

  const request = await prisma.leaveRequest.create({
    data: {
      orgId, userId, leaveTypeId: data.leaveTypeId, startDate, endDate, days, halfDay: !!data.halfDay, halfDayPeriod: data.halfDay ? (data.halfDayPeriod ?? 'AM') : null, reason: data.reason,
      // Approved by the policy, not by a person: no decider.
      ...(autoApproved ? { status: 'APPROVED', decidedAt: new Date() } : {}),
    },
    include,
  });

  logAction(userId, 'CREATE', 'LeaveRequest', request.id, { leaveType: leaveType.name, days, ...(autoApproved ? { autoApproved: true } : {}) });
  if (autoApproved) {
    await audit(orgId, userId, { userId, date: startDate, entityType: 'LEAVE_REQUEST', entityId: request.id, action: 'WFH_AUTO_APPROVE', after: { leaveType: leaveType.name, startDate: fmt(startDate), endDate: fmt(endDate), days, status: 'APPROVED' }, reason: 'Approved automatically — the policy group approves work from home within its rules' });
    computeDays(orgId, userId, startDate, endDate).catch(() => {});
  }
  sseManager.broadcastAll(orgId, SSEEvent.LEAVE_UPDATED, { id: request.id, userId, type: 'created' });
  const when = describeDates(request);
  notifyOrgAdmins({
    orgId, type: 'LEAVE_REQUESTED',
    title: leaveType.isWfh
      ? `${request.user.name} ${autoApproved ? 'will work from home (auto-approved)' : 'requested work from home'}`
      : `${request.user.name} requested ${leaveType.name}`,
    body: `${when} (${Number(days)} day${days === 1 ? '' : 's'})`,
    entityType: 'LEAVE_REQUEST', entityId: request.id,
  }).catch(() => {});

  if (!autoApproved) {
    const managers = await prisma.user.findMany({ where: { orgId, role: { in: [...HR_MANAGERS] }, isActive: true, id: { not: userId } } });
    managers.forEach(m => sendMail({
      ...(leaveType.isWfh
        ? emailTemplates.wfhRequested(m.email, m.name, request.user.name, when, days, data.reason)
        : emailTemplates.leaveRequested(m.email, m.name, request.user.name, leaveType.name, fmt(startDate), fmt(endDate), days)),
      orgId,
    }).catch(() => {}));
  }

  /* Automation hook — e.g. "when anyone requests more than 5 days,
     notify HR ops" (condition: days gt 5) or webhook a payroll system. */
  runWorkflows({
    trigger: 'LEAVE_REQUESTED', orgId, entityType: 'LEAVE', entityId: request.id,
    entity: { ...(request as any), leaveType: leaveType.name, employeeName: (request as any).user?.name },
  }).catch(() => {});
  return request;
}

export async function createRequest(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = RequestSchema.parse(req.body);
    res.status(201).json(await submitOwnRequest(req, data));
  } catch (err) { next(err); }
}

/** GET /hr/leave/requests — self sees own; managers can pass ?scope=org to see everyone's (else defaults to their own too) */
export async function listRequests(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { status, userId, scope, kind } = req.query as Record<string, string>;
    const isManager = isHrManager(req.user!.role);

    const where: any = { orgId };
    if (isManager && scope === 'org') {
      if (userId) where.userId = userId;
    } else {
      where.userId = req.user!.id;
    }
    if (status) where.status = status;
    // ?kind=wfh → work-from-home requests only; ?kind=leave → everything else
    if (kind === 'wfh') where.leaveType = { isWfh: true };
    else if (kind === 'leave') where.leaveType = { isWfh: false };

    const requests = await prisma.leaveRequest.findMany({ where, include, orderBy: { createdAt: 'desc' } });
    res.json(requests);
  } catch (err) { next(err); }
}

/**
 * POST /hr/leave/requests/:id/cancel — the employee withdraws their own
 * request: a pending one, or an approved work-from-home request that hasn't
 * started yet (nothing has been worked or paid on it; the days are recomputed).
 */
export async function cancelRequest(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const request = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, orgId }, include: { leaveType: true } });
    if (!request) throw new AppError(404, 'Leave request not found');
    if (request.userId !== req.user!.id) throw new AppError(403, 'You can only cancel your own request');
    let futureWfh = false;
    if (request.status === 'APPROVED' && request.leaveType.isWfh) {
      const { today } = await wfhContext(orgId, request.userId);
      futureWfh = fmt(request.startDate) > today;
      if (!futureWfh) throw new AppError(400, 'This work from home has already started — ask HR to change it.');
    } else if (request.status !== 'PENDING') {
      throw new AppError(400, 'Only a pending request can be cancelled');
    }

    const updated = await prisma.leaveRequest.update({
      where: { id: request.id },
      data: { status: 'CANCELLED', ...(futureWfh ? { cancelledBy: req.user!.id, cancelledAt: new Date(), cancelReason: 'Withdrawn by the employee' } : {}) },
      include,
    });
    logAction(req.user!.id, 'UPDATE', 'LeaveRequest', request.id, { action: 'cancelled', ...(futureWfh ? { wasApproved: true } : {}) });
    if (futureWfh) {
      await audit(orgId, req.user!.id, { userId: request.userId, date: request.startDate, entityType: 'LEAVE_REQUEST', entityId: request.id, action: 'LEAVE_CANCEL', before: { status: 'APPROVED' }, after: { status: 'CANCELLED' }, reason: 'Approved work from home withdrawn by the employee before it started' });
      computeDays(orgId, request.userId, request.startDate, request.endDate).catch(() => {});
    }
    sseManager.broadcastAll(orgId, SSEEvent.LEAVE_UPDATED, { id: request.id, userId: request.userId, type: 'cancelled' });
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
    const selfApproved = approve && request.userId === req.user!.id;
    if (selfApproved && await mustSomeoneElseApprove(orgId, req.user!.id)) throw new AppError(403, SELF_APPROVAL);

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

    logAction(req.user!.id, 'UPDATE', 'LeaveRequest', request.id, { action: approve ? 'approved' : 'rejected', ...(selfApproved ? { selfApproved: true } : {}) });
    if (selfApproved) await audit(orgId, req.user!.id, { userId: request.userId, date: request.startDate, entityType: 'LEAVE_REQUEST', entityId: request.id, action: 'LEAVE_SELF_APPROVE', after: { status: 'APPROVED' }, reason: 'Self-approved — no other active HR manager in the organisation' });
    sseManager.broadcastAll(orgId, SSEEvent.LEAVE_UPDATED, { id: request.id, userId: request.userId, type: 'decided' });
    if (approve) computeDays(orgId, request.userId, request.startDate, request.endDate).catch(() => {});

    // In-app bell + push (createNotification), then email
    const isWfh = request.leaveType.isWfh;
    await createNotification({
      orgId, userId: request.userId, type: 'STATUS_CHANGE',
      title: isWfh
        ? `Your work-from-home request (${describeDates(request)}) was ${approve ? 'approved' : 'rejected'}`
        : `Your ${request.leaveType.name} request was ${approve ? 'approved' : 'rejected'}`,
      body: rejectionReason,
      entityId: request.id, entityType: 'LEAVE_REQUEST',
    });
    const requester = await prisma.user.findUnique({ where: { id: request.userId } });
    if (requester) {
      sendMail({
        ...(isWfh
          ? emailTemplates.wfhDecision(requester.email, requester.name, describeDates(request), approve, rejectionReason)
          : emailTemplates.leaveDecision(requester.email, requester.name, request.leaveType.name, fmt(request.startDate), fmt(request.endDate), approve, rejectionReason)),
        orgId,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) { next(err); }
}

export const approveRequest = (req: AuthRequest, res: Response, next: NextFunction) => decide(req, res, next, true);
export const rejectRequest  = (req: AuthRequest, res: Response, next: NextFunction) => decide(req, res, next, false);


// ─── Admin leave control ─────────────────────────────────────────────────────

const OnBehalfSchema = RequestSchema.extend({
  userId: z.string(),
  autoApprove: z.boolean().optional(),
  /** Explicit manager override: allow going below zero balance (e.g. advance leave). */
  allowNegative: z.boolean().optional(),
  /** Explicit manager override of the work-from-home rules (limits, disabled group, half day). Audited. */
  overrideWfhLimits: z.boolean().optional(),
});

/** POST /hr/leave/requests/on-behalf — a manager applies for an employee; optionally approved immediately. Audited. */
export async function applyOnBehalf(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = OnBehalfSchema.parse(req.body);
    const target = await prisma.user.findFirst({ where: { id: data.userId, orgId } });
    if (!target) throw new AppError(404, 'Employee not found');
    const approve = data.autoApprove !== false;
    const selfApproved = approve && data.userId === req.user!.id;
    if (selfApproved && await mustSomeoneElseApprove(orgId, req.user!.id)) throw new AppError(403, `${SELF_APPROVAL} Apply for it as a normal request instead.`);
    checkDates(data.startDate, data.halfDay ? undefined : data.endDate);
    const startDate = parseD(data.startDate); const endDate = data.halfDay ? startDate : parseD(data.endDate);
    const { leaveType, days, wfh } = await validateLeaveRequest(orgId, data.userId, { leaveTypeId: data.leaveTypeId, startDate, endDate, halfDay: !!data.halfDay }, { allowNegative: !!data.allowNegative, subject: 'employee', wfhActor: 'manager', overrideWfhLimits: !!data.overrideWfhLimits });
    const request = await prisma.leaveRequest.create({
      data: {
        orgId, userId: data.userId, leaveTypeId: data.leaveTypeId, startDate, endDate, days, halfDay: !!data.halfDay, halfDayPeriod: data.halfDay ? (data.halfDayPeriod ?? 'AM') : null,
        reason: data.reason, appliedBy: req.user!.id,
        ...(approve ? { status: 'APPROVED', decidedBy: req.user!.id, decidedAt: new Date() } : {}),
      }, include,
    });
    await audit(orgId, req.user!.id, { userId: data.userId, date: startDate, entityType: 'LEAVE_REQUEST', entityId: request.id, action: selfApproved ? 'LEAVE_SELF_APPROVE' : 'LEAVE_APPLY_ON_BEHALF', after: { leaveType: leaveType.name, startDate: fmt(startDate), endDate: fmt(endDate), days, status: request.status, ...(selfApproved ? { selfApproved: true } : {}) }, reason: data.reason ?? (selfApproved ? 'Self-approved — no other active HR manager in the organisation' : null) });
    if (wfh?.overridden) await audit(orgId, req.user!.id, { userId: data.userId, date: startDate, entityType: 'LEAVE_REQUEST', entityId: request.id, action: 'WFH_LIMIT_OVERRIDE', after: { startDate: fmt(startDate), endDate: fmt(endDate), days }, reason: `Manager overrode the work-from-home rules: ${wfh.overridden}` });
    if (approve) computeDays(orgId, data.userId, startDate, endDate).catch(() => {});
    sseManager.broadcastAll(orgId, SSEEvent.LEAVE_UPDATED, { id: request.id, userId: data.userId, type: 'created' });
    res.status(201).json(request);
  } catch (err) { next(err); }
}

const ModifySchema = z.object({
  leaveTypeId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  halfDay: z.boolean().optional(),
  halfDayPeriod: z.enum(['AM', 'PM']).optional(),
  reason: z.string().optional(),
  changeReason: z.string().min(1),
  allowNegative: z.boolean().optional(),
  overrideWfhLimits: z.boolean().optional(),
});

/** PATCH /hr/leave/requests/:id — a manager modifies a pending or approved request (dates, type, half day). Audited. */
export async function modifyRequest(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = ModifySchema.parse(req.body);
    const request = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, orgId }, include });
    if (!request) throw new AppError(404, 'Leave request not found');
    if (!['PENDING', 'APPROVED'].includes(request.status)) throw new AppError(400, 'Only pending or approved requests can be modified');
    if (request.userId === req.user!.id && await mustSomeoneElseApprove(orgId, req.user!.id)) throw new AppError(403, 'Someone else must change your leave.');
    if (data.startDate) checkDates(data.startDate);
    if (data.endDate) checkDates(data.endDate);
    const startDate = data.startDate ? parseD(data.startDate) : request.startDate;
    const halfDay = data.halfDay ?? request.halfDay;
    const endDate = halfDay ? startDate : data.endDate ? parseD(data.endDate) : request.endDate;
    // Same rules as a new request — type in this org, half-day allowed,
    // working days, no overlap with the person's OTHER requests, balance (ATT-23)
    const { days, wfh } = await validateLeaveRequest(orgId, request.userId, { leaveTypeId: data.leaveTypeId ?? request.leaveTypeId, startDate, endDate, halfDay }, { excludeRequestId: request.id, allowNegative: !!data.allowNegative, subject: 'employee', wfhActor: 'manager', overrideWfhLimits: !!data.overrideWfhLimits });
    const before = { leaveTypeId: request.leaveTypeId, startDate: fmt(request.startDate), endDate: fmt(request.endDate), days: Number(request.days), halfDay: request.halfDay };
    const updated = await prisma.leaveRequest.update({
      where: { id: request.id },
      data: { leaveTypeId: data.leaveTypeId ?? request.leaveTypeId, startDate, endDate, days, halfDay, halfDayPeriod: halfDay ? (data.halfDayPeriod ?? request.halfDayPeriod ?? 'AM') : null, reason: data.reason ?? request.reason },
      include,
    });
    await audit(orgId, req.user!.id, { userId: request.userId, date: startDate, entityType: 'LEAVE_REQUEST', entityId: request.id, action: 'LEAVE_MODIFY', before, after: { leaveTypeId: updated.leaveTypeId, startDate: fmt(startDate), endDate: fmt(endDate), days, halfDay }, reason: data.changeReason });
    if (wfh?.overridden) await audit(orgId, req.user!.id, { userId: request.userId, date: startDate, entityType: 'LEAVE_REQUEST', entityId: request.id, action: 'WFH_LIMIT_OVERRIDE', after: { startDate: fmt(startDate), endDate: fmt(endDate), days }, reason: `Manager overrode the work-from-home rules: ${wfh.overridden}` });
    // Recompute both the old and the new range so stale LEAVE days are cleared
    const lo = new Date(Math.min(request.startDate.getTime(), startDate.getTime())), hi = new Date(Math.max(request.endDate.getTime(), endDate.getTime()));
    if (updated.status === 'APPROVED') computeDays(orgId, request.userId, lo, hi).catch(() => {});
    sseManager.broadcastAll(orgId, SSEEvent.LEAVE_UPDATED, { id: request.id, userId: request.userId, type: 'modified' });
    res.json(updated);
  } catch (err) { next(err); }
}

/** POST /hr/leave/requests/:id/admin-cancel — a manager cancels a pending OR approved request (balance is restored; attendance recomputed). Audited. */
export async function adminCancel(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    const request = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, orgId }, include });
    if (!request) throw new AppError(404, 'Leave request not found');
    if (!['PENDING', 'APPROVED'].includes(request.status)) throw new AppError(400, `This request is already ${request.status.toLowerCase()}`);
    const updated = await prisma.leaveRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED', cancelledBy: req.user!.id, cancelledAt: new Date(), cancelReason: reason }, include });
    await audit(orgId, req.user!.id, { userId: request.userId, date: request.startDate, entityType: 'LEAVE_REQUEST', entityId: request.id, action: 'LEAVE_CANCEL', before: { status: request.status }, after: { status: 'CANCELLED' }, reason });
    computeDays(orgId, request.userId, request.startDate, request.endDate).catch(() => {});
    await createNotification({ orgId, userId: request.userId, type: 'STATUS_CHANGE', title: `Your ${request.leaveType.name} (${describeDates(request)}) was cancelled by ${req.user!.email}`, body: reason, entityId: request.id, entityType: 'LEAVE_REQUEST' });
    sseManager.broadcastAll(orgId, SSEEvent.LEAVE_UPDATED, { id: request.id, userId: request.userId, type: 'cancelled' });
    res.json(updated);
  } catch (err) { next(err); }
}

const ConvertSchema = z.object({ userId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), leaveTypeId: z.string(), halfDay: z.boolean().optional(), halfDayPeriod: z.enum(['AM', 'PM']).optional(), reason: z.string().min(1) });

/** POST /hr/leave/convert — turn an absent/LOP/half day into approved leave (e.g. employee forgot to apply). Audited. */
export async function convertAttendanceToLeave(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = ConvertSchema.parse(req.body);
    const [target, leaveType] = await Promise.all([prisma.user.findFirst({ where: { id: data.userId, orgId } }), prisma.leaveType.findFirst({ where: { id: data.leaveTypeId, orgId, isActive: true } })]);
    if (!target || !leaveType) throw new AppError(404, 'Employee or leave type not found');
    if (data.userId === req.user!.id && await mustSomeoneElseApprove(orgId, req.user!.id)) throw new AppError(403, SELF_APPROVAL);
    if (data.halfDay && !leaveType.allowHalfDay) throw new AppError(400, `${leaveType.name} cannot be taken as a half day`);
    const date = parseD(data.date);
    const frozen = await frozenUntil(orgId, data.userId);
    if (frozen && data.date <= frozen) throw new AppError(409, `${data.date} is in a payroll period that has already been finalised, so it can no longer be changed.`);
    const existing = await prisma.leaveRequest.findFirst({ where: { orgId, userId: data.userId, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: date }, endDate: { gte: date } } });
    if (existing) throw new AppError(400, 'There is already leave on that date');
    const dayBefore = await prisma.attendanceDay.findUnique({ where: { userId_date: { userId: data.userId, date } } });
    const request = await prisma.leaveRequest.create({
      data: { orgId, userId: data.userId, leaveTypeId: data.leaveTypeId, startDate: date, endDate: date, days: data.halfDay ? 0.5 : 1, halfDay: !!data.halfDay, halfDayPeriod: data.halfDay ? (data.halfDayPeriod ?? 'AM') : null, reason: data.reason, appliedBy: req.user!.id, status: 'APPROVED', decidedBy: req.user!.id, decidedAt: new Date() },
      include,
    });
    // Drop any manual override so the engine reflects the leave
    await prisma.attendanceDay.deleteMany({ where: { userId: data.userId, date, source: 'MANUAL' } });
    const { days } = await computeDays(orgId, data.userId, date, date);
    await audit(orgId, req.user!.id, { userId: data.userId, date, entityType: 'ATTENDANCE_DAY', entityId: days[0]?.id, action: 'CONVERT_TO_LEAVE', before: dayBefore ? { status: dayBefore.status } : null, after: { status: days[0]?.status, leaveType: leaveType.name, requestId: request.id }, reason: data.reason });
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: data.userId, type: 'corrected' });
    res.status(201).json({ request, day: days[0] });
  } catch (err) { next(err); }
}
