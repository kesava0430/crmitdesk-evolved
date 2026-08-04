import { Response, NextFunction, Request } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../utils/prisma';
import { AppError } from '../../middleware/errorHandler';
import { AuthRequest } from '../../middleware/authenticate';
import { getHostedStorageUsageBytes } from '../../utils/licensing';
import { PLANS } from '../../utils/stripe';

const GB = 1024 * 1024 * 1024;
/** Quota computed inline from the plan (same numbers licensing.ts's getStorageQuotaBytes uses) rather than
 * calling that helper directly — it upserts a default Subscription row as a side effect on every call, which
 * would fire once per org on every admin page load. Read-only here on purpose. */
function storageQuotaBytesForPlan(plan: string): number {
  return ((PLANS as Record<string, { storageQuotaGB: number }>)[plan]?.storageQuotaGB ?? 0) * GB;
}

/**
 * POST /platform/bootstrap — creates (or promotes) the first PLATFORM_ADMIN
 * account. Gated by a shared secret header rather than a login session, same
 * pattern as demo.controller.ts's resetDemo(): if PLATFORM_BOOTSTRAP_SECRET
 * isn't set, the endpoint 404s so its existence isn't observable on a
 * deployment where nobody set the secret yet.
 *
 * Idempotent by email — safe to re-run (e.g. to reset the password) without
 * creating duplicate accounts. orgId is left null: PLATFORM_ADMIN users are
 * not scoped to any Organization (see schema.prisma UserRole comment).
 */
const BootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

export async function bootstrap(req: Request, res: Response, next: NextFunction) {
  try {
    const configuredSecret = process.env.PLATFORM_BOOTSTRAP_SECRET;
    if (!configuredSecret) throw new AppError(404, 'Not found');

    const providedSecret = req.header('x-platform-bootstrap-secret');
    if (!providedSecret || providedSecret !== configuredSecret) {
      throw new AppError(404, 'Not found');
    }

    const { email, password, name } = BootstrapSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.upsert({
      where: { email },
      update: { role: 'PLATFORM_ADMIN', orgId: null, passwordHash, isActive: true },
      create: { email, name, passwordHash, role: 'PLATFORM_ADMIN', orgId: null },
    });

    res.json({ success: true, id: user.id, email: user.email });
  } catch (err) { next(err); }
}

/**
 * GET /platform/orgs — every Organization with the license/branding/sending
 * fields a platform operator needs at a glance. Deliberately omits secrets
 * (EmailAccount.password, WhatsAppConfig.authToken/accountSid) — only
 * connection status and the non-secret identifying fields are surfaced.
 */
export async function listOrgs(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgs = await prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        subscription: true,
        branding: true,
        emailAccount: { select: { email: true, smtpHost: true, lastSyncAt: true } },
        whatsAppConfig: { select: { phoneNumber: true, notifyNumber: true } },
        storageConfig: { select: { provider: true, connectedEmail: true } },
        _count: { select: { users: true, contacts: true, tickets: true } },
      },
    });

    // Attachment usage requires an aggregate query per org — read-only, run in parallel.
    const usageByOrg = await Promise.all(orgs.map(o => getHostedStorageUsageBytes(o.id)));

    res.json(orgs.map((o, i) => {
      const plan = o.subscription?.plan ?? o.plan;
      const quotaBytes = storageQuotaBytesForPlan(plan);
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan: o.plan,
        createdAt: o.createdAt,
        subscription: o.subscription
          ? {
              plan: o.subscription.plan,
              status: o.subscription.status,
              seats: o.subscription.seats,
              currentPeriodEnd: o.subscription.currentPeriodEnd,
              cancelAtPeriodEnd: o.subscription.cancelAtPeriodEnd,
              stripeCustomerId: o.subscription.stripeCustomerId,
            }
          : null,
        branding: o.branding
          ? {
              companyName: o.branding.companyName,
              logoUrl: o.branding.logoUrl,
              primaryColor: o.branding.primaryColor,
              supportEmail: o.branding.supportEmail,
            }
          : null,
        emailSending: {
          connected: !!o.emailAccount,
          email: o.emailAccount?.email ?? null,
          smtpHost: o.emailAccount?.smtpHost ?? null,
          lastSyncAt: o.emailAccount?.lastSyncAt ?? null,
        },
        whatsappSending: {
          connected: !!o.whatsAppConfig,
          phoneNumber: o.whatsAppConfig?.phoneNumber ?? null,
          notifyNumber: o.whatsAppConfig?.notifyNumber ?? null,
        },
        // "License" for attachments: which storage the org is on. `provider`
        // is null when nothing's explicitly connected — since storage.ts now
        // auto-falls-back an unconnected org straight to our hosted S3 (see
        // uploadAttachment), usedBytes is computed unconditionally: an org
        // can have real hosted usage purely from the fallback, with no
        // StorageConfig row ever created.
        storageLicense: {
          provider: o.storageConfig?.provider ?? null, // 'GOOGLE_DRIVE' | 'HOSTED_S3' | null (not connected — may still be using the platform fallback)
          connectedEmail: o.storageConfig?.connectedEmail ?? null,
          quotaBytes,
          usedBytes: usageByOrg[i],
        },
        counts: { users: o._count.users, contacts: o._count.contacts, tickets: o._count.tickets },
      };
    }));
  } catch (err) { next(err); }
}

/** GET /platform/orgs/:id — fuller detail for a single org, including its staff user list (no password hashes). */
export async function getOrg(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.params.id },
      include: {
        subscription: true,
        branding: true,
        emailAccount: { select: { email: true, imapHost: true, smtpHost: true, smtpPort: true, lastSyncAt: true } },
        whatsAppConfig: { select: { phoneNumber: true, notifyNumber: true, createdAt: true } },
        storageConfig: { select: { provider: true, connectedEmail: true, rootFolderId: true, updatedAt: true } },
        users: {
          select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { contacts: true, tickets: true, deals: true } },
      },
    });
    if (!org) throw new AppError(404, 'Organization not found');

    const quotaBytes = storageQuotaBytesForPlan(org.subscription?.plan ?? org.plan);
    const usedBytes = await getHostedStorageUsageBytes(org.id); // real even without an explicit StorageConfig row — see the fallback in storage.ts

    res.json({ ...org, storageLicense: { quotaBytes, usedBytes } });
  } catch (err) { next(err); }
}

const UpdateOrgSchema = z.object({
  name: z.string().min(1).optional(),
});

/** PATCH /platform/orgs/:id — org identity fields only; plan/branding have their own endpoints below. */
export async function updateOrg(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = UpdateOrgSchema.parse(req.body);
    const org = await prisma.organization.update({ where: { id: req.params.id }, data });
    res.json(org);
  } catch (err) { next(err); }
}

const UpdateSubscriptionSchema = z.object({
  plan: z.enum(['FREE', 'PRO', 'ENTERPRISE']).optional(),
  seats: z.number().int().positive().optional(),
  status: z.string().min(1).optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
});

/**
 * PATCH /platform/orgs/:id/subscription — lets the platform operator override
 * an org's plan/seats/status directly (comping an account, fixing a stuck
 * Stripe webhook, correcting a manual sales deal) without needing the org's
 * own admin to go through Billing themselves. Upserts because not every org
 * has a Subscription row yet (see licensing.ts's getOrCreateSubscription —
 * same default-row pattern). Also mirrors the plan onto Organization.plan so
 * the two never drift apart (some older code paths still read that field).
 */
export async function updateSubscription(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.params.id;
    const data = UpdateSubscriptionSchema.parse(req.body);

    const sub = await prisma.subscription.upsert({
      where: { orgId },
      create: { orgId, plan: 'FREE', status: 'active', seats: 5, ...data },
      update: data,
    });

    if (data.plan) {
      await prisma.organization.update({ where: { id: orgId }, data: { plan: data.plan } });
    }

    res.json(sub);
  } catch (err) { next(err); }
}

const UpdateBrandingSchema = z.object({
  companyName: z.string().min(1).optional(),
  logoUrl: z.string().url().nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  supportEmail: z.string().email().nullable().optional(),
});

/** PATCH /platform/orgs/:id/branding — same fields the org's own Settings → Branding page edits, editable centrally. */
export async function updateBranding(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.params.id;
    const data = UpdateBrandingSchema.parse(req.body);

    const branding = await prisma.orgBranding.upsert({
      where: { orgId },
      create: { orgId, companyName: data.companyName ?? '', ...data },
      update: data,
    });

    res.json(branding);
  } catch (err) { next(err); }
}
