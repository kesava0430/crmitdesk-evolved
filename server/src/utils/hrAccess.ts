// ─── Who manages HR (people, org structure, leave, attendance, payroll) ──────
//
// ONE place decides whether a signed-in user may manage HR for the whole org.
// Every HR route guard (requireHrManager) and every in-controller "may this
// person see / change other people's HR records" check (canManageHr) goes
// through here, and GET /permissions/me exposes the same answer to the client
// so the sidebar, tabs and buttons agree with the server.
//
// Who passes:
//  - the manager-level legacy roles that always ran HR (Super Admin, IT
//    Manager, Sales Manager) — nobody loses access they had;
//  - the built-in HR Manager role (Role.key HR_MANAGER). Its users carry the
//    legacy UserRole EMPLOYEE (the enum has no HR value), which is why the old
//    role-list checks locked them out of everything HR;
//  - a custom role that holds the matching HR permission at ALL scope (e.g.
//    hr.leave.update = ALL lets a "Leave approver" role approve the org's leave).
// HR Manager gets no CRM / IT Desk rights from this — those checks don't use it.
// Product areas are enforced separately (requireFeatureAtMount on the HR mounts).
import type { Response, NextFunction } from 'express';
import { R, type AuthRequest } from '../middleware/authenticate';
import { AppError } from '../middleware/errorHandler';
import { prisma } from './prisma';
import { getPermCtx } from './permissions';

export type HrArea = 'people' | 'org' | 'leave' | 'attendance' | 'payroll';
export const HR_AREAS: HrArea[] = ['people', 'org', 'leave', 'attendance', 'payroll'];

/** Legacy UserRole values that have always managed HR. */
export const LEGACY_HR_MANAGER_ROLES = [R.SUPER_ADMIN, R.IT_MANAGER, R.CRM_MANAGER] as const;
/**
 * @deprecated use requireHrManager / canManageHr. Kept for the AI action
 * registry's allowedRoles lists, which canManageHr extends via `hrArea`.
 */
export const HR_MANAGERS = LEGACY_HR_MANAGER_ROLES;
export const HR_MANAGER_ROLE_KEY = 'HR_MANAGER';

/** The permission a custom role must hold at ALL scope to manage each area. */
export const HR_AREA_PERMISSION: Record<HrArea, string> = {
  people: 'hr.employee.update',
  org: 'hr.department.update',
  leave: 'hr.leave.update',
  attendance: 'hr.attendance.update',
  payroll: 'hr.salary.update',
};

export interface HrAccessInput {
  role: string;
  roleKey?: string | null;
  grants?: Map<string, string> | Record<string, string> | null;
}

const grantOf = (g: HrAccessInput['grants'], key: string) =>
  !g ? undefined : g instanceof Map ? g.get(key) : (g as Record<string, string>)[key];

/** Pure: which HR areas this user manages org-wide. */
export function hrAccessFor(input: HrAccessInput): Record<HrArea, boolean> {
  const all = (LEGACY_HR_MANAGER_ROLES as readonly string[]).includes(input.role) || input.roleKey === HR_MANAGER_ROLE_KEY;
  const out = {} as Record<HrArea, boolean>;
  for (const a of HR_AREAS) out[a] = all || grantOf(input.grants, HR_AREA_PERMISSION[a]) === 'ALL';
  return out;
}

/** Pure: manages at least one HR area (sees the HR admin screens at all). */
export function managesAnyHr(input: HrAccessInput): boolean {
  return Object.values(hrAccessFor(input)).some(Boolean);
}

type UserLike = { id: string; orgId: string; role: string };

/** Does this user manage `area` for the whole org? (legacy role, HR Manager role, or matching custom-role grant) */
export async function canManageHr(user: UserLike, area: HrArea): Promise<boolean> {
  if ((LEGACY_HR_MANAGER_ROLES as readonly string[]).includes(user.role)) return true; // no DB round trip
  if (!user.id || user.role === 'API') return false;
  const ctx = await getPermCtx(user);
  return hrAccessFor({ role: ctx.role, roleKey: ctx.roleKey, grants: ctx.grants })[area];
}

/** All five areas for this user (GET /permissions/me, client gating). */
export async function hrAccessOf(user: UserLike): Promise<Record<HrArea, boolean>> {
  if (!user.id || user.role === 'API') return hrAccessFor({ role: user.role });
  const ctx = await getPermCtx(user);
  return hrAccessFor({ role: ctx.role, roleKey: ctx.roleKey, grants: ctx.grants });
}

/**
 * Route guard replacing requireRole(...HR_MANAGERS). API keys stay out, exactly
 * as before (manager-gated routes never admitted them).
 */
export function requireHrManager(area: HrArea) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(403, 'Insufficient permissions'));
    if (req.user.role === 'API') return next(new AppError(403, 'API keys cannot access admin-gated endpoints'));
    canManageHr(req.user, area)
      .then(ok => next(ok ? undefined : new AppError(403, 'Insufficient permissions')))
      .catch(next);
  };
}

/** Prisma where for active users (other than `excludeUserId`) who manage `area`. */
export function hrManagersWhere(orgId: string, area: HrArea, excludeUserId?: string) {
  return {
    orgId, isActive: true,
    ...(excludeUserId && { id: { not: excludeUserId } }),
    OR: [
      { role: { in: [...LEGACY_HR_MANAGER_ROLES] as any } },
      { roleRef: { is: { key: HR_MANAGER_ROLE_KEY } } },
      { roleRef: { is: { permissions: { some: { permissionKey: HR_AREA_PERMISSION[area], scope: 'ALL' } } } } },
    ],
  } as any;
}

/**
 * Nobody approves their own leave — unless there is no one else who could: in
 * an org whose only active HR manager is the requester, a hard block would
 * leave their leave unapprovable forever. Callers must log that it was
 * self-approved.
 */
export async function mustSomeoneElseApprove(orgId: string, userId: string): Promise<boolean> {
  const others = await prisma.user.count({ where: hrManagersWhere(orgId, 'leave', userId) });
  return others > 0;
}
