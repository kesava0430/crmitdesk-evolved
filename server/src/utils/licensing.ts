import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';

// Roles that actually count against a plan's seat limit. Sales/CRM roles,
// SUPER_ADMIN, and plain EMPLOYEE logins are unrestricted — only the
// technician-facing helpdesk roles are metered, similar to how many
// helpdesk products charge per support agent rather than per total login.
const METERED_ROLES = new Set(['IT_MANAGER', 'IT_AGENT']);

export function isMeteredRole(role: string): boolean {
  return METERED_ROLES.has(role);
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
 * Throws AppError(402) if adding one more technician (IT_MANAGER/IT_AGENT)
 * would exceed the org's plan seat limit. No-op for any other role.
 *
 * Only active users count — deactivating a technician frees their seat
 * immediately, and downgrading a plan never touches existing users
 * (grandfathered in place); this check only blocks *new* technician
 * seats once the org is at or over its limit.
 */
export async function assertSeatAvailable(orgId: string, role: string): Promise<void> {
  if (!isMeteredRole(role)) return;

  const sub = await getOrCreateSubscription(orgId);
  const technicianCount = await prisma.user.count({
    where: { orgId, isActive: true, role: { in: ['IT_MANAGER', 'IT_AGENT'] } },
  });

  if (technicianCount >= sub.seats) {
    throw new AppError(
      402,
      `Your ${sub.plan} plan includes ${sub.seats} technician seat${sub.seats === 1 ? '' : 's'} (IT Manager / IT Agent). ` +
      `You're already using all ${technicianCount}. Upgrade your plan to add more technicians.`
    );
  }
}
