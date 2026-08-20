import { testConnection } from '../../utils/s3Storage';
import { Response, NextFunction, Request } from 'express';
import { z } from 'zod';
import { optionalField, optionalText, emailField } from '../../utils/zodHelpers';
import bcrypt from 'bcryptjs';
import { prisma } from '../../utils/prisma';
import { AppError } from '../../middleware/errorHandler';
import { AuthRequest } from '../../middleware/authenticate';
import { getHostedStorageUsageBytes } from '../../utils/licensing';
import { getSendCounts, getSendCountsForOrgs } from '../../utils/usageTracking';
import { getPlatformStorageConfig, getPlatformSettingsForAdmin, upsertPlatformSettings } from '../../utils/platformSettings';
import { PLANS } from '../../utils/stripe';
import { secretsMatch } from '../../utils/crypto';

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
  email: emailField(),
  password: z.string().min(8),
  name: z.string().min(1),
});

export async function bootstrap(req: Request, res: Response, next: NextFunction) {
  try {
    const configuredSecret = process.env.PLATFORM_BOOTSTRAP_SECRET;
    if (!configuredSecret) throw new AppError(404, 'Not found');

    const providedSecret = req.header('x-platform-bootstrap-secret');
    // Constant-time — this header mints a PLATFORM_ADMIN, the most valuable
    // secret comparison in the codebase. See secretsMatch() in utils/crypto.ts.
    if (!secretsMatch(providedSecret, configuredSecret)) {
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
    // Send counts are a single batched groupBy across every org (see getSendCountsForOrgs).
    const [usageByOrg, sendCountsByOrg] = await Promise.all([
      Promise.all(orgs.map(o => getHostedStorageUsageBytes(o.id))),
      getSendCountsForOrgs(orgs.map(o => o.id)),
    ]);

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
        // All-time email/WhatsApp sends, split by whether the org's own
        // connected account was used vs. the platform fallback — see
        // utils/usageTracking.ts's getSendCountsForOrgs.
        sendCounts: sendCountsByOrg[o.id],
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
    const [usedBytes, sendCounts] = await Promise.all([
      getHostedStorageUsageBytes(org.id), // real even without an explicit StorageConfig row — see the fallback in storage.ts
      getSendCounts(org.id),
    ]);

    res.json({ ...org, storageLicense: { quotaBytes, usedBytes }, sendCounts });
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
  companyName: optionalField(z.string().min(1)),
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

/**
 * GET /platform/settings — the platform-wide email/WhatsApp fallback config
 * (see utils/platformSettings.ts). Secrets are reduced to a configured/source
 * flag, never sent back in the clear.
 */
export async function getSettings(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getPlatformSettingsForAdmin());
  } catch (err) { next(err); }
}

// Every field here is String? on PlatformSettings — the console reads the
// current values, so unset ones come back as null and are posted back as null.
const UpdateSettingsSchema = z.object({
  resendApiKey: optionalText(),
  resendFrom: optionalText(),
  smtpHost: optionalText(),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpUser: optionalText(),
  smtpPass: optionalText(),
  smtpFrom: optionalText(),
  twilioAccountSid: optionalText(),
  twilioAuthToken: optionalText(),
  twilioFromNumber: optionalText(),
  // The shared bucket behind provider HOSTED_S3 — every paying org that did
  // not connect storage of their own lands here. Same per-field semantics as
  // everything above: omitted = untouched, "" = back to the env var.
  s3Bucket: optionalText(),
  s3Region: optionalText(),
  s3Endpoint: optionalText(),
  s3AccessKeyId: optionalText(),
  s3SecretAccessKey: optionalText(),
});

/**
 * PATCH /platform/settings — updates any subset of the platform email/
 * WhatsApp fallback fields. Per-field: omitted = untouched, empty string =
 * cleared back to the env var, anything else = stored (encrypted for the
 * three secret fields). See upsertPlatformSettings for the exact semantics.
 */
export async function updateSettings(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = UpdateSettingsSchema.parse(req.body);
    await upsertPlatformSettings(data);
    res.json(await getPlatformSettingsForAdmin());
  } catch (err) { next(err); }
}


/**
 * POST /platform/settings/storage/test — round-trips a probe object against
 * the bucket HOSTED_S3 would use right now.
 *
 * Deliberately tests the RESOLVED config (database layered over environment)
 * rather than whatever is in the form. The question a platform admin actually
 * has is "does hosted storage work", and with two possible sources for every
 * field, reading that off the form is guesswork.
 *
 * Optionally accepts a candidate config, so the console can test credentials
 * before saving them — the same pattern the per-org S3 connect uses.
 */
const TestStorageSchema = z.object({
  bucket: z.string().trim().optional(),
  region: z.string().trim().optional(),
  endpoint: z.string().trim().optional(),
  accessKeyId: z.string().trim().optional(),
  secretAccessKey: z.string().trim().optional(),
}).optional();

export async function testStorage(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const candidate = TestStorageSchema.parse(req.body ?? {});
    const live = await getPlatformStorageConfig();

    // Per field: use what was typed, else what is live. This makes "I only
    // changed the bucket" testable without re-entering the secret key.
    const target = {
      bucket: candidate?.bucket || live.bucket || '',
      region: candidate?.region || live.region || 'auto',
      endpoint: candidate?.endpoint || live.endpoint || null,
      accessKeyId: candidate?.accessKeyId || live.accessKeyId || '',
      secretAccessKey: candidate?.secretAccessKey || live.secretAccessKey || '',
    };

    if (!target.bucket || !target.accessKeyId || !target.secretAccessKey) {
      return res.json({
        ok: false,
        error: 'Hosted storage is not configured — set a bucket, access key ID and secret, here or as S3_* environment variables.',
      });
    }

    const result = await testConnection(target);
    res.json({ ...result, bucket: target.bucket, endpoint: target.endpoint });
  } catch (err) { next(err); }
}
