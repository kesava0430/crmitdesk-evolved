// ─── Leave rules shared by every way a leave request is created or changed ───
//
// Self-service requests, manager on-behalf requests, manager modifications and
// the AI REQUEST_LEAVE action all go through validateLeaveRequest(), so they
// agree on:
//   - length = WORKING days (the employee's policy-group weekly offs and the
//     holidays that apply to their location don't consume leave) — ATT-9;
//   - the leave type belongs to the org, is active and allows half days;
//   - no overlap with another pending/approved request;
//   - enough balance, counting pending requests too, unless the type is
//     unlimited, unpaid, or work-from-home (or a manager overrides) — ATT-23;
//   - for a work-from-home type, the policy group's WFH rules instead
//     (enabled, half day, notice, monthly/weekly limits — utils/wfh.ts).
import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { policyForUser, holidayKeysForUser } from './attendanceRegister';
import { countWorkingDays, dateKey } from './attendanceEngine';
import { validateWfh, type WfhValidation } from './wfh';

/**
 * Balance per leave type for a user in a year:
 *   opening (carry-forward from last year, capped, lapsing after N months) + quota + adjustments − used (approved, incl. half days)
 * `remaining` is no longer clamped at 0 — an overdrawn balance shows as negative
 * instead of hiding the overdraw. Work-from-home types have no balance and are
 * left out.
 */
export async function computeBalances(orgId: string, userId: string, year: number, asOf = new Date()) {
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
  const prevStart = new Date(Date.UTC(year - 1, 0, 1));
  const [types, approved, adjustments, prevAdjustments] = await Promise.all([
    prisma.leaveType.findMany({ where: { orgId, isActive: true, isWfh: false }, orderBy: { name: 'asc' } }),
    prisma.leaveRequest.findMany({ where: { orgId, userId, status: 'APPROVED', startDate: { gte: prevStart, lt: yearEnd } } }),
    prisma.leaveBalanceAdjustment.findMany({ where: { orgId, userId, year } }),
    prisma.leaveBalanceAdjustment.findMany({ where: { orgId, userId, year: year - 1 } }),
  ]);
  const usedIn = (typeId: string, y: number) => approved.filter(r => r.leaveTypeId === typeId && r.startDate.getUTCFullYear() === y).reduce((s, r) => s + Number(r.days), 0);
  const adj = (list: typeof adjustments, typeId: string) => list.filter(a => a.leaveTypeId === typeId).reduce((s, a) => s + Number(a.days), 0);
  return types.map(t => {
    let carried = 0;
    if (t.carryForward) {
      const prevRemaining = Math.max(0, t.annualQuota + adj(prevAdjustments, t.id) - usedIn(t.id, year - 1));
      carried = Math.min(prevRemaining, t.carryForwardMaxDays || prevRemaining);
      if (t.carryForwardExpiryMonths > 0 && asOf >= new Date(Date.UTC(year, t.carryForwardExpiryMonths, 1))) {
        // Expired: only the part already consumed this year counts (consumed first-in-first-out)
        carried = Math.min(carried, usedIn(t.id, year));
      }
    }
    const used = usedIn(t.id, year);
    const adjustments_ = adj(adjustments, t.id);
    const entitlement = t.annualQuota + carried + adjustments_;
    return { leaveType: t, quota: t.annualQuota, carriedForward: carried, adjustments: adjustments_, used, remaining: t.isUnlimited ? null : Math.round((entitlement - used) * 10) / 10, entitlement };
  });
}

/** Working-day length of a leave for one user (0.5 for a half day on a working day). */
export async function leaveLength(orgId: string, userId: string, startDate: Date, endDate: Date, halfDay: boolean): Promise<number> {
  const { policy, locationId } = await policyForUser(orgId, userId);
  const holidays = await holidayKeysForUser(orgId, userId, locationId, startDate, endDate);
  return countWorkingDays(dateKey(startDate), dateKey(endDate), policy.weeklyOffs, holidays, halfDay);
}

export interface LeaveInput { leaveTypeId: string; startDate: Date; endDate: Date; halfDay: boolean }

export async function validateLeaveRequest(orgId: string, userId: string, input: LeaveInput, opts: {
  excludeRequestId?: string; allowNegative?: boolean; subject?: 'you' | 'employee';
  /** Who is acting for WFH rules: self-service (default) or a manager (no notice rules; may override limits) */
  wfhActor?: 'self' | 'manager'; overrideWfhLimits?: boolean;
} = {}): Promise<{ leaveType: any; days: number; wfh: WfhValidation | null }> {
  const who = opts.subject === 'employee' ? 'The employee' : 'You';
  const leaveType = await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, orgId, isActive: true } });
  if (!leaveType) throw new AppError(404, 'Leave type not found');
  if (input.endDate < input.startDate) throw new AppError(400, 'End date must be on or after the start date');
  if (input.endDate.getTime() - input.startDate.getTime() > 366 * 86_400_000) throw new AppError(400, 'A single request can cover at most a year');
  if (input.halfDay && !leaveType.allowHalfDay) throw new AppError(400, `${leaveType.name} cannot be taken as a half day`);

  const days = await leaveLength(orgId, userId, input.startDate, input.endDate, input.halfDay);
  if (days === 0) throw new AppError(400, 'Those dates are all weekly offs or holidays — there is nothing to apply for.');

  const overlap = await prisma.leaveRequest.findFirst({
    where: { orgId, userId, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: input.endDate }, endDate: { gte: input.startDate }, ...(opts.excludeRequestId ? { id: { not: opts.excludeRequestId } } : {}) },
  });
  if (overlap) throw new AppError(400, `${who} already ${who === 'You' ? 'have' : 'has'} leave or work from home on those dates`);

  const wfh = leaveType.isWfh
    ? await validateWfh(orgId, userId, input, { actor: opts.wfhActor ?? 'self', overrideLimits: opts.overrideWfhLimits, excludeRequestId: opts.excludeRequestId, subject: opts.subject })
    : null;

  if (!leaveType.isUnlimited && leaveType.isPaid && !leaveType.isWfh && !opts.allowNegative) {
    const year = input.startDate.getUTCFullYear();
    const balances = await computeBalances(orgId, userId, year);
    const b = balances.find(x => x.leaveType.id === leaveType.id);
    const pending = await prisma.leaveRequest.findMany({
      where: { orgId, userId, leaveTypeId: leaveType.id, status: 'PENDING', startDate: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) }, ...(opts.excludeRequestId ? { id: { not: opts.excludeRequestId } } : {}) },
      select: { days: true },
    });
    let ownApproved = 0;
    if (opts.excludeRequestId) {
      const self = await prisma.leaveRequest.findFirst({ where: { id: opts.excludeRequestId, orgId, status: 'APPROVED', leaveTypeId: leaveType.id }, select: { days: true, startDate: true } });
      if (self && self.startDate.getUTCFullYear() === year) ownApproved = Number(self.days);
    }
    const available = Math.round(((b?.entitlement ?? 0) - (b?.used ?? 0) + ownApproved - pending.reduce((s, p) => s + Number(p.days), 0)) * 10) / 10;
    if (days > available) {
      throw new AppError(400, `Not enough ${leaveType.name} balance: ${Math.max(0, available)} day${available === 1 ? '' : 's'} available (after pending requests), ${days} requested.`);
    }
  }
  return { leaveType, days, wfh };
}
