// Work from home: the employee's request form + usage, and HR's recurring WFH
// schedules. Requests are LeaveRequests of a work-from-home type, so approval,
// modification and cancellation stay on the leave endpoints (leave.controller.ts).
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { logAction } from '../../../utils/auditLog';
import { sseManager, SSEEvent } from '../../../utils/sse';
import { canManageHr } from '../../../utils/hrAccess';
import { audit, computeDays, schedulesFor } from '../../../utils/attendanceRegister';
import { dateKey, keyToDate, localDateKey, safeTimeZone, addDaysKey } from '../../../utils/attendanceEngine';
import { ensureWfhTypes, wfhContext, wfhUsage, wfhDayInfo } from '../../../utils/wfh';
import { describeWeekdays } from '../../../utils/wfhRules';
import { submitOwnRequest } from './leave.controller';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD');

const REQUEST_INCLUDE = {
  leaveType: true,
  user: { select: { id: true, name: true, avatarUrl: true } },
  decider: { select: { id: true, name: true } },
} as const;

const SCHEDULE_INCLUDE = {
  user: { select: { id: true, name: true } },
  policyGroup: { select: { id: true, name: true } },
  exceptions: { orderBy: { date: 'asc' as const }, select: { id: true, userId: true, date: true, reason: true } },
} as const;

function serializeSchedule(s: any) {
  return {
    id: s.id, userId: s.userId, policyGroupId: s.policyGroupId, weekdays: s.weekdays,
    startDate: dateKey(s.startDate), endDate: s.endDate ? dateKey(s.endDate) : null, note: s.note ?? null,
    label: describeWeekdays(s.weekdays),
    user: s.user ?? null, policyGroup: s.policyGroup ?? null,
    exceptions: (s.exceptions ?? []).map((e: any) => ({ id: e.id, userId: e.userId, date: dateKey(e.date), reason: e.reason ?? null })),
  };
}

/** Target of the summary: yourself, or (managers) ?userId= */
async function targetUser(req: AuthRequest) {
  const q = req.query.userId;
  const userId = (await canManageHr(req.user!, 'leave')) && typeof q === 'string' && q ? q : req.user!.id;
  const u = await prisma.user.findFirst({ where: { id: userId, orgId: req.user!.orgId }, select: { id: true, name: true } });
  if (!u) throw new AppError(404, 'User not found');
  return u;
}

/**
 * GET /hr/leave/wfh/me[?userId=] — everything the "Work from home" card needs:
 * whether WFH is available, the group's rules, this month's / week's usage,
 * today's WFH status, recurring WFH and recent WFH requests.
 */
export async function wfhSummary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const user = await targetUser(req);
    const [types, ctx] = await Promise.all([ensureWfhTypes(orgId), wfhContext(orgId, user.id)]);
    const horizon = addDaysKey(ctx.today, 366);
    const [usage, today, schedules, requests] = await Promise.all([
      wfhUsage(orgId, user.id, ctx),
      wfhDayInfo(orgId, user.id, ctx.today, ctx),
      schedulesFor(orgId, user.id, ctx.group, ctx.today, horizon),
      prisma.leaveRequest.findMany({ where: { orgId, userId: user.id, leaveType: { isWfh: true } }, include: REQUEST_INCLUDE, orderBy: { startDate: 'desc' }, take: 50 }),
    ]);
    res.json({
      userId: user.id,
      enabled: ctx.settings.enabled,
      groupName: ctx.group.name,
      settings: ctx.settings,
      today: ctx.today,
      types: types.map(t => ({ id: t.id, name: t.name, color: t.color })),
      defaultTypeId: types[0]?.id ?? null,
      usage,
      todayWfh: today,
      schedules: schedules.map(s => ({ ...serializeSchedule(s), scope: s.userId ? 'PERSON' : 'GROUP' })),
      requests,
    });
  } catch (err) { next(err); }
}

const WfhRequestSchema = z.object({
  startDate: DATE,
  endDate: DATE.optional(),
  halfDay: z.boolean().optional(),
  halfDayPeriod: z.enum(['AM', 'PM']).optional(),
  reason: z.string().trim().max(500).optional(),
  /** Only when the org has several work-from-home types; defaults to the first. */
  leaveTypeId: z.string().optional(),
});

/** POST /hr/leave/wfh/requests — the employee's own WFH request (rules + AUTO approval in submitOwnRequest). */
export async function requestWfh(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = WfhRequestSchema.parse(req.body);
    const types = await ensureWfhTypes(req.user!.orgId);
    const type = data.leaveTypeId ? types.find(t => t.id === data.leaveTypeId) : types[0];
    if (!type) throw new AppError(400, 'That isn\'t a work-from-home type');
    const request = await submitOwnRequest(req, {
      leaveTypeId: type.id, startDate: data.startDate, endDate: data.halfDay ? data.startDate : (data.endDate ?? data.startDate),
      halfDay: !!data.halfDay, halfDayPeriod: data.halfDayPeriod, reason: data.reason || undefined,
    });
    res.status(201).json(request);
  } catch (err) { next(err); }
}

// ─── Recurring WFH (managers) ────────────────────────────────────────────────

const ScheduleSchema = z.object({
  userId: z.string().optional(),
  policyGroupId: z.string().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one weekday').max(7),
  startDate: DATE,
  endDate: DATE.nullable().optional(),
  note: z.string().trim().max(200).optional(),
});

async function orgToday(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  return localDateKey(new Date(), safeTimeZone(org?.timezone));
}

/** Person schedules: bring that person's register up to date now (group ones recompute when viewed). */
function recomputePerson(orgId: string, userId: string | null, fromKey: string, toKey: string | null, today: string) {
  if (!userId) return;
  const end = toKey && toKey < today ? toKey : today;
  const start = fromKey > addDaysKey(end, -62) ? fromKey : addDaysKey(end, -62);
  if (start > end) return;
  computeDays(orgId, userId, keyToDate(start), keyToDate(end)).catch(() => {});
}

/** GET /hr/leave/wfh/schedules?userId=|policyGroupId= — recurring WFH, active and ended. */
export async function listSchedules(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, policyGroupId } = req.query as Record<string, string>;
    const rows = await prisma.wfhSchedule.findMany({
      where: { orgId: req.user!.orgId, ...(userId ? { userId } : {}), ...(policyGroupId ? { policyGroupId } : {}) },
      include: SCHEDULE_INCLUDE, orderBy: [{ startDate: 'desc' }],
    });
    res.json(rows.map(serializeSchedule));
  } catch (err) { next(err); }
}

async function checkOwner(orgId: string, userId?: string | null, policyGroupId?: string | null) {
  if (!!userId === !!policyGroupId) throw new AppError(400, 'A recurring WFH schedule is for one person or one policy group — pick exactly one.');
  if (userId && !(await prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true } }))) throw new AppError(404, 'Employee not found');
  if (policyGroupId && !(await prisma.attendancePolicyGroup.findFirst({ where: { id: policyGroupId, orgId }, select: { id: true } }))) throw new AppError(404, 'Policy group not found');
}

const scheduleAudit = async (orgId: string, actor: string, s: any, action: string, reason: string, before?: any) => {
  logAction(actor, action === 'WFH_SCHEDULE_CREATE' ? 'CREATE' : action === 'WFH_SCHEDULE_DELETE' ? 'DELETE' : 'UPDATE', 'WfhSchedule', s.id, { userId: s.userId, policyGroupId: s.policyGroupId, weekdays: s.weekdays });
  // Person schedules also land in that person's attendance change history.
  if (s.userId) await audit(orgId, actor, { userId: s.userId, date: s.startDate, entityType: 'WFH_SCHEDULE', entityId: s.id, action, before: before ?? null, after: { weekdays: s.weekdays, startDate: dateKey(s.startDate), endDate: s.endDate ? dateKey(s.endDate) : null }, reason });
};

/** POST /hr/leave/wfh/schedules — e.g. "every Friday from 1 Nov" for a person or a whole policy group. */
export async function createSchedule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = ScheduleSchema.parse(req.body);
    await checkOwner(orgId, data.userId, data.policyGroupId);
    if (data.endDate && data.endDate < data.startDate) throw new AppError(400, 'The end date is before the start date');
    const s = await prisma.wfhSchedule.create({
      data: { orgId, userId: data.userId ?? null, policyGroupId: data.policyGroupId ?? null, weekdays: [...new Set(data.weekdays)].sort(), startDate: keyToDate(data.startDate), endDate: data.endDate ? keyToDate(data.endDate) : null, note: data.note || null, createdBy: req.user!.id },
      include: SCHEDULE_INCLUDE,
    });
    await scheduleAudit(orgId, req.user!.id, s, 'WFH_SCHEDULE_CREATE', data.note || `Recurring work from home: ${describeWeekdays(s.weekdays)}`);
    recomputePerson(orgId, s.userId, data.startDate, data.endDate ?? null, await orgToday(orgId));
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: s.userId, type: 'wfh_schedule' });
    res.status(201).json(serializeSchedule(s));
  } catch (err) { next(err); }
}

/** PATCH /hr/leave/wfh/schedules/:id — change weekdays / dates / note. */
export async function updateSchedule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = ScheduleSchema.pick({ weekdays: true, startDate: true, endDate: true, note: true }).partial().parse(req.body);
    const existing = await prisma.wfhSchedule.findFirst({ where: { id: req.params.id, orgId } });
    if (!existing) throw new AppError(404, 'Schedule not found');
    const startKey = data.startDate ?? dateKey(existing.startDate);
    const endKey = data.endDate === undefined ? (existing.endDate ? dateKey(existing.endDate) : null) : data.endDate;
    if (endKey && endKey < startKey) throw new AppError(400, 'The end date is before the start date');
    const s = await prisma.wfhSchedule.update({
      where: { id: existing.id },
      data: {
        ...(data.weekdays ? { weekdays: [...new Set(data.weekdays)].sort() } : {}),
        startDate: keyToDate(startKey), endDate: endKey ? keyToDate(endKey) : null,
        ...(data.note !== undefined ? { note: data.note || null } : {}),
      },
      include: SCHEDULE_INCLUDE,
    });
    const before = { weekdays: existing.weekdays, startDate: dateKey(existing.startDate), endDate: existing.endDate ? dateKey(existing.endDate) : null };
    await scheduleAudit(orgId, req.user!.id, s, 'WFH_SCHEDULE_UPDATE', 'Recurring work from home changed', before);
    const lo = before.startDate < startKey ? before.startDate : startKey;
    recomputePerson(orgId, s.userId, lo, null, await orgToday(orgId));
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: s.userId, type: 'wfh_schedule' });
    res.json(serializeSchedule(s));
  } catch (err) { next(err); }
}

/**
 * DELETE /hr/leave/wfh/schedules/:id — stop recurring WFH. A schedule that
 * already applied to past days is ENDED yesterday rather than deleted, so
 * those days stay WFH in the register; one that hasn't started is removed.
 */
export async function deleteSchedule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const s = await prisma.wfhSchedule.findFirst({ where: { id: req.params.id, orgId }, include: SCHEDULE_INCLUDE });
    if (!s) throw new AppError(404, 'Schedule not found');
    const today = await orgToday(orgId);
    const yesterday = addDaysKey(today, -1);
    if (dateKey(s.startDate) <= yesterday) {
      const endKey = s.endDate && dateKey(s.endDate) < yesterday ? dateKey(s.endDate) : yesterday;
      const ended = await prisma.wfhSchedule.update({ where: { id: s.id }, data: { endDate: keyToDate(endKey) }, include: SCHEDULE_INCLUDE });
      await scheduleAudit(orgId, req.user!.id, ended, 'WFH_SCHEDULE_END', `Recurring work from home ended on ${endKey}`);
      recomputePerson(orgId, s.userId, today, null, today);
      res.json({ ended: true, schedule: serializeSchedule(ended) });
    } else {
      await prisma.wfhSchedule.delete({ where: { id: s.id } });
      await scheduleAudit(orgId, req.user!.id, s, 'WFH_SCHEDULE_DELETE', 'Recurring work from home removed before it started');
      res.json({ ended: false, deleted: true });
    }
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId: s.userId, type: 'wfh_schedule' });
  } catch (err) { next(err); }
}

const ExceptionSchema = z.object({ date: DATE, userId: z.string().nullable().optional(), reason: z.string().trim().max(200).optional() });

/** POST /hr/leave/wfh/schedules/:id/exceptions — skip one date (for one person, or everyone on the schedule). */
export async function addException(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = ExceptionSchema.parse(req.body);
    const s = await prisma.wfhSchedule.findFirst({ where: { id: req.params.id, orgId } });
    if (!s) throw new AppError(404, 'Schedule not found');
    // On a person's schedule the exception is theirs.
    const userId = s.userId ?? data.userId ?? null;
    if (userId && !(await prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true } }))) throw new AppError(404, 'Employee not found');
    const date = keyToDate(data.date);
    const dup = await prisma.wfhScheduleException.findFirst({ where: { scheduleId: s.id, date, userId } });
    const ex = dup ?? await prisma.wfhScheduleException.create({ data: { orgId, scheduleId: s.id, userId, date, reason: data.reason || null, createdBy: req.user!.id } });
    logAction(req.user!.id, 'UPDATE', 'WfhSchedule', s.id, { skipDate: data.date, userId });
    if (userId) {
      await audit(orgId, req.user!.id, { userId, date, entityType: 'WFH_SCHEDULE', entityId: s.id, action: 'WFH_SCHEDULE_SKIP', after: { date: data.date }, reason: data.reason || 'Recurring work from home skipped for this date' });
      computeDays(orgId, userId, date, date).catch(() => {});
    }
    sseManager.broadcastAll(orgId, SSEEvent.ATTENDANCE_UPDATED, { userId, type: 'wfh_schedule' });
    res.status(201).json({ id: ex.id, userId: ex.userId, date: dateKey(ex.date), reason: ex.reason });
  } catch (err) { next(err); }
}

/** DELETE /hr/leave/wfh/schedules/:id/exceptions/:exceptionId — undo a skipped date. */
export async function removeException(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ex = await prisma.wfhScheduleException.findFirst({ where: { id: req.params.exceptionId, scheduleId: req.params.id, orgId } });
    if (!ex) throw new AppError(404, 'Exception not found');
    await prisma.wfhScheduleException.delete({ where: { id: ex.id } });
    logAction(req.user!.id, 'UPDATE', 'WfhSchedule', ex.scheduleId, { unskipDate: dateKey(ex.date), userId: ex.userId });
    if (ex.userId) computeDays(orgId, ex.userId, ex.date, ex.date).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
}
