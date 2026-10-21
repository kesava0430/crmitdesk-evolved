// ─── Work from home: database side ───────────────────────────────────────────
//
// A WFH request is a LeaveRequest whose type has isWfh (ATT-27), so approvals,
// modification, cancellation and the register keep working exactly as before
// for existing types and requests. This module adds what the approved spec
// asks on top (see utils/wfhRules.ts for the pure rules):
//   - a default "Work from home" type per org, created lazily;
//   - per-policy-group rules enforced whenever a WFH request is created or
//     changed (validateWfh, called from validateLeaveRequest);
//   - "is this an approved WFH day?" for check-in, the team view and the live map;
//   - usage figures for the employee's "2 of 4 used this month" line.

import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { policyForUser, holidayKeysForUser, schedulesFor } from './attendanceRegister';
import { dateKey, keyToDate, todayKeyFor, type Policy } from './attendanceEngine';
import {
  wfhSettingsOf, approvalOutcome, requestDays, scheduleDays, scheduleFor, mergeDays, usageWindow, usageFor, checkLimits, checkNotice, limitEntries,
  type WfhSettings, type DayWeight,
} from './wfhRules';

export const DEFAULT_WFH_TYPE_NAME = 'Work from home';

/**
 * The org's work-from-home types, making sure one exists (like
 * ensureDefaultGroup). Existing isWfh types are used as they are; with several,
 * all of them count as WFH and the oldest is the default the request form
 * picks. With none active, an inactive one is reactivated rather than
 * duplicated, else "Work from home" is created.
 */
export async function ensureWfhTypes(orgId: string) {
  let types = await prisma.leaveType.findMany({ where: { orgId, isWfh: true, isActive: true }, orderBy: { createdAt: 'asc' } });
  if (types.length) return types;
  const inactive = await prisma.leaveType.findFirst({ where: { orgId, isWfh: true }, orderBy: { createdAt: 'asc' } });
  if (inactive) {
    await prisma.leaveType.update({ where: { id: inactive.id }, data: { isActive: true } });
  } else {
    // The name is unique per org; a non-WFH type could already use it.
    const taken = await prisma.leaveType.findFirst({ where: { orgId, name: DEFAULT_WFH_TYPE_NAME } });
    try {
      await prisma.leaveType.create({ data: { orgId, name: taken ? `${DEFAULT_WFH_TYPE_NAME} (WFH)` : DEFAULT_WFH_TYPE_NAME, isWfh: true, isPaid: true, annualQuota: 0, allowHalfDay: true, color: '#0d9488' } });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err; // created concurrently — fine
    }
  }
  types = await prisma.leaveType.findMany({ where: { orgId, isWfh: true, isActive: true }, orderBy: { createdAt: 'asc' } });
  return types;
}

/** Rules, policy and calendar for one user — the context every WFH decision needs. */
export async function wfhContext(orgId: string, userId: string) {
  const { policy, group, locationId } = await policyForUser(orgId, userId);
  return { policy, group, locationId, settings: wfhSettingsOf(group), today: todayKeyFor(policy) };
}

type Ctx = Awaited<ReturnType<typeof wfhContext>>;

/**
 * Every WFH working day of [fromKey, toKey] that counts towards the limits:
 * approved and pending WFH requests (half day = 0.5). Recurring days don't
 * count (wfhRules.limitEntries).
 */
export async function wfhUsageDays(orgId: string, userId: string, ctx: Ctx, fromKey: string, toKey: string, excludeRequestId?: string): Promise<DayWeight[]> {
  const from = keyToDate(fromKey), to = keyToDate(toKey);
  const [requests, holidays] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { orgId, userId, status: { in: ['PENDING', 'APPROVED'] }, leaveType: { isWfh: true }, startDate: { lte: to }, endDate: { gte: from }, ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}) },
      select: { startDate: true, endDate: true, halfDay: true },
    }),
    holidayKeysForUser(orgId, userId, ctx.locationId, from, to),
  ]);
  const offs = ctx.policy.weeklyOffs;
  const fromReqs = requests.flatMap(r => requestDays(dateKey(r.startDate), dateKey(r.endDate), r.halfDay, offs, holidays)).filter(d => d.day >= fromKey && d.day <= toKey);
  return limitEntries(fromReqs);
}

/** "used / limit" for the month and ISO week of `refDay` (default today). */
export async function wfhUsage(orgId: string, userId: string, ctx?: Ctx, refDay?: string) {
  const c = ctx ?? await wfhContext(orgId, userId);
  const day = refDay ?? c.today;
  const win = usageWindow([day]);
  const used = usageFor(await wfhUsageDays(orgId, userId, c, win.from, win.to), day);
  return { refDay: day, month: { used: used.month, limit: c.settings.maxPerMonth }, week: { used: used.week, limit: c.settings.maxPerWeek } };
}

export interface WfhValidation {
  settings: WfhSettings;
  /** AUTO approval mode and the request passed every rule */
  autoApprove: boolean;
  /** Set when a manager's override let a request through that broke a rule (for the audit) */
  overridden: string | null;
}

/**
 * The WFH rules for a request being created or changed. Self-service requests
 * get every rule; a manager applying or modifying on someone's behalf isn't
 * held to the notice rules (they often record past days) and can override the
 * limits / disabled group / half-day rule with an explicit, audited flag.
 */
export async function validateWfh(orgId: string, userId: string, input: { startDate: Date; endDate: Date; halfDay: boolean }, opts: { actor: 'self' | 'manager'; overrideLimits?: boolean; excludeRequestId?: string; subject?: 'you' | 'employee' } = { actor: 'self' }): Promise<WfhValidation> {
  const ctx = await wfhContext(orgId, userId);
  const { settings } = ctx;
  const startKey = dateKey(input.startDate), endKey = dateKey(input.endDate);
  const override = opts.actor === 'manager' && !!opts.overrideLimits;
  const broken: string[] = [];
  const fail = (status: number, msg: string) => { if (override) broken.push(msg); else throw new AppError(status, msg); };
  const whose = opts.subject === 'employee' ? 'this employee\'s' : 'your';

  if (!settings.enabled) fail(403, `Work from home isn't enabled for ${whose} attendance policy (${ctx.group.name}). Ask HR if you think this is wrong.`);
  if (input.halfDay && !settings.allowHalfDay) fail(400, `Half-day work from home isn't allowed under ${whose} attendance policy.`);
  if (opts.actor === 'self') {
    const why = checkNotice(settings, startKey, ctx.today);
    if (why) throw new AppError(400, why);
  }

  const holidays = await holidayKeysForUser(orgId, userId, ctx.locationId, input.startDate, input.endDate);
  const requested = requestDays(startKey, endKey, input.halfDay, ctx.policy.weeklyOffs, holidays);

  // A recurring WFH day needs no request (and must not be counted twice).
  const schedules = await schedulesFor(orgId, userId, ctx.group, startKey, endKey);
  const clash = requested.find(d => scheduleFor(schedules, userId, d.day));
  if (clash) throw new AppError(400, `${clash.day} is already a recurring work-from-home day — no request is needed.`);

  if (requested.length && (settings.maxPerMonth != null || settings.maxPerWeek != null)) {
    const win = usageWindow(requested.map(r => r.day));
    const existing = await wfhUsageDays(orgId, userId, ctx, win.from, win.to, opts.excludeRequestId);
    const why = checkLimits(settings, existing, requested);
    if (why) fail(400, why);
  }
  return { settings, autoApprove: approvalOutcome(settings, opts.actor, broken.length > 0) === 'AUTO_APPROVED', overridden: broken.length ? broken.join(' ') : null };
}

export interface WfhDayInfo { source: 'REQUEST' | 'SCHEDULE'; requestId: string | null; name: string; halfDay: boolean }

/** Is `dayKey` an approved WFH day for the user (approved request or recurring schedule)? */
export async function wfhDayInfo(orgId: string, userId: string, dayKey: string, pre?: { policy: Policy; group: any; locationId: string | null }): Promise<WfhDayInfo | null> {
  const date = keyToDate(dayKey);
  const req = await prisma.leaveRequest.findFirst({
    where: { orgId, userId, status: 'APPROVED', leaveType: { isWfh: true }, startDate: { lte: date }, endDate: { gte: date } },
    select: { id: true, halfDay: true, leaveType: { select: { name: true } } },
  });
  if (req) return { source: 'REQUEST', requestId: req.id, name: req.leaveType.name, halfDay: req.halfDay };
  const { policy, group, locationId } = pre ?? await policyForUser(orgId, userId);
  const schedules = await schedulesFor(orgId, userId, group, dayKey, dayKey);
  if (!scheduleFor(schedules, userId, dayKey)) return null;
  // A weekly off or holiday isn't a WFH day even when the weekday matches.
  const holidays = await holidayKeysForUser(orgId, userId, locationId, date, date);
  if (!scheduleDays(schedules, userId, dayKey, dayKey, policy.weeklyOffs, holidays).length) return null;
  return { source: 'SCHEDULE', requestId: null, name: 'Recurring work from home', halfDay: false };
}

/**
 * WFH status "today" (each person's policy day) for many users — the team
 * view's chip and badges and the live map. A few queries for the whole org.
 * Weekly offs and holidays are not WFH days, so recurring weekdays falling on
 * one are skipped.
 */
export async function wfhTodayForUsers(orgId: string, userIds: string[], policies: Map<string, Policy>, now = new Date()): Promise<Map<string, WfhDayInfo>> {
  const out = new Map<string, WfhDayInfo>();
  if (!userIds.length) return out;
  const todays = new Map(userIds.map(id => [id, policies.get(id) ? todayKeyFor(policies.get(id)!, now) : dateKey(now)]));
  const keys = [...new Set(todays.values())].sort();
  const lo = keyToDate(keys[0]), hi = keyToDate(keys[keys.length - 1]);
  const [requests, groups, schedules, holidays] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { orgId, userId: { in: userIds }, status: 'APPROVED', leaveType: { isWfh: true }, startDate: { lte: hi }, endDate: { gte: lo } },
      select: { id: true, userId: true, startDate: true, endDate: true, halfDay: true, leaveType: { select: { name: true } } },
    }),
    prisma.attendancePolicyGroup.findMany({ where: { orgId }, select: { id: true, wfhEnabled: true } }),
    prisma.wfhSchedule.findMany({
      where: { orgId, startDate: { lte: hi }, OR: [{ endDate: null }, { endDate: { gte: lo } }] },
      include: { exceptions: { where: { date: { gte: lo, lte: hi } }, select: { userId: true, date: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.holiday.findMany({ where: { orgId, isOptional: false, date: { gte: lo, lte: hi } }, select: { date: true, locationIds: true } }),
  ]);
  const enabled = new Map(groups.map(g => [g.id, g.wfhEnabled]));
  for (const id of userIds) {
    const day = todays.get(id)!;
    const t = keyToDate(day).getTime();
    const req = requests.find(r => r.userId === id && r.startDate.getTime() <= t && r.endDate.getTime() >= t);
    if (req) { out.set(id, { source: 'REQUEST', requestId: req.id, name: req.leaveType.name, halfDay: req.halfDay }); continue; }
    const policy = policies.get(id);
    if (!policy) continue;
    if (policy.weeklyOffs.includes(keyToDate(day).getUTCDay())) continue;
    // Location-scoped holidays would need each person's location; an org-wide one is enough to skip here.
    if (holidays.some(h => dateKey(h.date) === day && h.locationIds.length === 0)) continue;
    const mine = schedules.filter(s => s.userId === id || (s.policyGroupId && s.policyGroupId === policy.id && enabled.get(s.policyGroupId) !== false));
    if (scheduleFor(mine, id, day)) out.set(id, { source: 'SCHEDULE', requestId: null, name: 'Recurring work from home', halfDay: false });
  }
  return out;
}
