// ─── Who manages HR (attendance, leave, payroll) ─────────────────────────────
//
// One place for the role set that may see everyone's attendance, correct days,
// approve leave and run payroll. It used to be the generic MANAGERS constant
// plus three hand-copied MANAGER_ROLES arrays in the controllers; changing who
// counts as an HR manager now means editing this list only. The values are
// exactly what those copies held, so nobody gains or loses access today.
import { R } from '../middleware/authenticate';
import { prisma } from './prisma';

export const HR_MANAGERS = [R.SUPER_ADMIN, R.IT_MANAGER, R.CRM_MANAGER] as const;

export function isHrManager(role: string | undefined | null): boolean {
  return !!role && (HR_MANAGERS as readonly string[]).includes(role);
}

/**
 * Nobody approves their own leave — unless there is no one else who could: in
 * an org whose only active HR manager is the requester, a hard block would
 * leave their leave unapprovable forever. Callers must log that it was
 * self-approved.
 */
export async function mustSomeoneElseApprove(orgId: string, userId: string): Promise<boolean> {
  const others = await prisma.user.count({ where: { orgId, isActive: true, id: { not: userId }, role: { in: [...HR_MANAGERS] as any } } });
  return others > 0;
}
