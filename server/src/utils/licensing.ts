import { Response, NextFunction } from 'express';
import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/authenticate';
import { PLANS, FeatureKey } from './stripe';

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

/** Active users whose role counts against the seat limit (everything but EMPLOYEE). */
export async function getBillableSeatCount(orgId: string): Promise<number> {
  return prisma.user.count({
    where: { orgId, isActive: true, role: { not: 'EMPLOYEE' } },
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

// ─── Feature gating ──────────────────────────────────────────────────────────
//
// Coarse-grained on purpose — see the FeatureKey comment in utils/stripe.ts.
// A plan value that isn't a known key in PLANS (e.g. a future CUSTOM tier,
// before it has real feature config) fails safe to "no gated features"
// rather than throwing, so an unrecognized plan blocks access to Pro+
// features instead of accidentally granting them.

function planFeatures(plan: string): FeatureKey[] {
  return (PLANS as Record<string, { features: readonly FeatureKey[] }>)[plan]?.features as FeatureKey[] || [];
}

export async function hasFeature(orgId: string, feature: FeatureKey): Promise<boolean> {
  const sub = await getOrCreateSubscription(orgId);
  return planFeatures(sub.plan).includes(feature);
}

/** Express middleware factory — 402s with an upgrade message if the org's
 * plan doesn't include `feature`. Mirrors requireRole()'s call shape
 * (middleware/authenticate.ts) so route tables read consistently. */
export function requireFeature(feature: FeatureKey) {
  return async (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      const sub = await getOrCreateSubscription(req.user!.orgId);
      if (!planFeatures(sub.plan).includes(feature)) {
        throw new AppError(
          402,
          `This feature isn't included in your ${sub.plan} plan. Upgrade your plan to unlock it.`
        );
      }
      next();
    } catch (err) { next(err); }
  };
}

// ─── Hosted storage quota ─────────────────────────────────────────────────
//
// Separate from the seat/feature checks above: this gates the "use our
// hosted storage" option in Settings → Storage (utils/s3Storage.ts), an
// alternative to bring-your-own Google Drive. Same fail-safe-to-0 pattern
// as planFeatures() for an unrecognized plan value.

function planStorageQuotaGB(plan: string): number {
  return (PLANS as Record<string, { storageQuotaGB: number }>)[plan]?.storageQuotaGB ?? 0;
}

export async function getStorageQuotaBytes(orgId: string): Promise<number> {
  const sub = await getOrCreateSubscription(orgId);
  // A per-org override set by the platform operator in the license editor
  // beats the plan default — this is how a specific customer gets more (or
  // less) hosted storage than their tier normally includes, without moving
  // them to a different plan. Null/undefined = plan default applies.
  const overrideGb = (sub as any).storageQuotaOverrideGb;
  if (overrideGb !== null && overrideGb !== undefined) {
    return overrideGb * 1024 * 1024 * 1024;
  }
  return planStorageQuotaGB(sub.plan) * 1024 * 1024 * 1024;
}

/** Sums fileSize across every attachment this org has stored in OUR bucket
 * (provider === 'HOSTED_S3'). Computed on the fly rather than a running
 * counter, so it can never drift out of sync with what's actually stored —
 * a delete always reflects immediately. Google Drive attachments don't
 * count here at all; that storage is the customer's own, not ours. */
// Attachment has no direct orgId column (it's polymorphic — see
// utils/entityAccess.ts) — but every attachment stored under HOSTED_S3 was
// necessarily uploaded by this org (storage.ts only ever uploads to the
// caller's own StorageConfig), so filtering by uploader.orgId is equivalent
// and avoids a join through nine different entity tables.
export async function getHostedStorageUsageBytes(orgId: string): Promise<number> {
  const result = await prisma.attachment.aggregate({
    where: { provider: 'HOSTED_S3', uploader: { orgId } },
    _sum: { fileSize: true },
  });
  return result._sum.fileSize ?? 0;
}

/**
 * Throws AppError(402) before an upload would push the org over its plan's
 * hosted-storage quota (or if the plan doesn't include hosted storage at
 * all, i.e. quota is 0 — FREE orgs must use their own Google Drive).
 * `additionalBytes` is the size of the file about to be uploaded.
 */
export async function assertHostedStorageAvailable(orgId: string, additionalBytes: number): Promise<void> {
  const sub = await getOrCreateSubscription(orgId);
  const quotaBytes = await getStorageQuotaBytes(orgId);

  if (quotaBytes === 0) {
    throw new AppError(
      402,
      `Hosted storage isn't included in your ${sub.plan} plan — connect your own Google Drive or your own S3-compatible bucket in Settings → Storage instead, or upgrade to Pro for 5GB of hosted storage.`
    );
  }

  const usedBytes = await getHostedStorageUsageBytes(orgId);
  if (usedBytes + additionalBytes > quotaBytes) {
    const usedGB = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
    const quotaGB = (quotaBytes / (1024 * 1024 * 1024)).toFixed(0);
    throw new AppError(
      402,
      `This upload would exceed your ${sub.plan} plan's ${quotaGB}GB hosted storage quota (${usedGB}GB used). Delete some files, switch to your own Google Drive, or upgrade your plan.`
    );
  }
}
