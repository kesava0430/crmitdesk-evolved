import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';

// Every internal role counts against a plan's seat limit EXCEPT plain
// EMPLOYEE — those are staff who just submit requests internally (not
// technicians, sales reps, managers, or admins actually working the
// platform), so they're free and unlimited. Everyone else — SUPER_ADMIN,
// CRM_MANAGER, SALES_REP, IT_MANAGER, IT_AGENT — is a billable seat.
const UNMETERED_ROLES = new Set(['EMPLOYEE']);

export function isMeteredRole(role: string): boolean {
  return !UNMETERED_ROLES.has(role);
}

/** Same default-row pattern billing.controller.ts uses — never assume a
 * Subscription row already exists for an org. */
async function getOrCreateSubscription(orgId: string) {
  return prisma.subscription.upsert({
    where: { orgId },
    create: { orgId, plan: 'FREE', status: 'active', seats: 5 },
    update: {},
  });
}

/**
 * Throws AppError(402) if adding one more billable-role user (anything
 * other than EMPLOYEE) would exceed the org's plan seat limit. No-op for
 * EMPLOYEE.
 *
 * Only active users count — deactivating someone frees their seat
 * immediately, and downgrading a plan never touches existing users
 * (grandfathered in place); this check only blocks *new* billable seats
 * once the org is at or over its limit.
 */
/** Active users whose role counts against the seat limit (everything but EMPLOYEE). */
export async function getBillableSeatCount(orgId: string): Promise<number> {
  return prisma.user.count({
    where: { orgId, isActive: true, role: { not: 'EMPLOYEE' } },
  });
}

export async function assertSeatAvailable(orgId: string, role: string): Promise<void> {
  if (!isMeteredRole(role)) return;

  const sub = await getOrCreateSubscription(orgId);
  const billableCount = await getBillableSeatCount(orgId);

  if (billableCount >= sub.seats) {
    throw new AppError(
      402,
      `Your ${sub.plan} plan includes ${sub.seats} seat${sub.seats === 1 ? '' : 's'}. ` +
      `You're already using all ${billableCount} (every role except Employee counts toward this). ` +
      `Upgrade your plan to add more people.`
    );
  }
}
