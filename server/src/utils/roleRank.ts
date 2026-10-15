import { AppError } from '../middleware/errorHandler';

/**
 * Role rank rules shared by every endpoint that hands out or changes a login's
 * role — Administration → Users, People → Add person, and People → Edit.
 *
 * They used to live only in usersAdmin.controller.ts, which meant the People
 * endpoints (which also create logins and change roles) never applied them:
 * an IT_MANAGER could add a person with the Super Admin role, or change an
 * existing person's role to Super Admin from the People list. One copy, used
 * by all of them, closes that side door.
 *
 *   - you can only ASSIGN a role of your own rank or lower (a manager can add
 *     another manager, but never mint a SUPER_ADMIN), and
 *   - you can only MANAGE (edit/deactivate/reset/re-role) users of your rank
 *     or lower (a manager can never touch the SUPER_ADMIN's account).
 *
 * Custom roles are ranked by their resolved legacyRole, so they can't be used
 * as a side door either.
 */

export type LegacyRole = 'SUPER_ADMIN' | 'CRM_MANAGER' | 'SALES_REP' | 'IT_MANAGER' | 'IT_AGENT' | 'EMPLOYEE';
export const LEGACY_ROLES: LegacyRole[] = ['SUPER_ADMIN', 'CRM_MANAGER', 'SALES_REP', 'IT_MANAGER', 'IT_AGENT', 'EMPLOYEE'];

export const ROLE_RANK: Record<LegacyRole, number> = {
  SUPER_ADMIN: 3,
  CRM_MANAGER: 2,
  IT_MANAGER: 2,
  SALES_REP: 1,
  IT_AGENT: 1,
  EMPLOYEE: 0,
};

/** Unknown roles (API, a custom legacy value) rank lowest — the safe direction to be wrong in. */
export function rankOf(role: string | null | undefined): number {
  return ROLE_RANK[role as LegacyRole] ?? 0;
}

/** Maps any Role.legacyRole onto the enum; anything unrecognised is EMPLOYEE. */
export function toLegacyRole(role: string | null | undefined): LegacyRole {
  return LEGACY_ROLES.includes(role as LegacyRole) ? (role as LegacyRole) : 'EMPLOYEE';
}

/** Caller may not act on a user who outranks them. */
export function assertCanManage(callerRole: string, targetRole: string) {
  if (rankOf(targetRole) > rankOf(callerRole)) {
    throw new AppError(403, 'You cannot manage a user with a higher role than your own');
  }
}

/** Caller may not hand out a role above their own rank. */
export function assertCanAssign(callerRole: string, newRole: string) {
  if (rankOf(newRole) > rankOf(callerRole)) {
    throw new AppError(403, 'You cannot assign a role higher than your own');
  }
}
