import { testConnection } from '../../utils/s3Storage';
import { Response, NextFunction, Request } from 'express';
import { z } from 'zod';
import { optionalField, optionalText, emailField } from '../../utils/zodHelpers';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { normaliseModules, getPricingConfig, savePricingOverride, DEFAULT_PRICING, PricingOverride, PricingConfig } from '../../utils/pricing';
import { AppError } from '../../middleware/errorHandler';
import { AuthRequest } from '../../middleware/authenticate';
import { getHostedStorageUsageBytes, invalidateLicenseCache, evaluateLicense, SubRow, LICENSE_STATUSES, getPlatformSendUsage } from '../../utils/licensing';
import { logAction } from '../../utils/auditLog';
import { getSendCounts, getSendCountsForOrgs } from '../../utils/usageTracking';
import { getPlatformStorageConfig, getPlatformSettingsForAdmin, upsertPlatformSettings } from '../../utils/platformSettings';
import { PLANS, isFeatureKey, stripe, isBillingEnabled } from '../../utils/stripe';
import { secretsMatch } from '../../utils/crypto';

const GB = 1024 * 1024 * 1024;

const DEFAULT_SUB_ROW = (orgId: string): SubRow => ({
  orgId, plan: 'FREE', status: 'active', seats: 5, features: [], interval: 'month',
  currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false, storageQuotaOverrideGb: null,
});

/** Effective licence evaluated from the row already loaded — the same pure
 * evaluateLicense() every gate uses (payment state, overrides, CUSTOM
 * modules), without getEffectiveLicense()'s side-effect upsert of a default
 * row per org on every admin page load (LIC-23). */
function licenseFor(orgId: string, sub: unknown, cfg: PricingConfig) {
  return evaluateLicense((sub as SubRow | null) ?? DEFAULT_SUB_ROW(orgId), new Date(), cfg);
}

/** Billable seats in use per org, one grouped query (same rule as getBillableSeatCount). */
async function billableSeatsByOrg(orgIds: string[]): Promise<Record<string, number>> {
  if (!orgIds.length) return {};
  const rows = await prisma.user.groupBy({
    by: ['orgId'],
    where: { orgId: { in: orgIds }, isActive: true, role: { notIn: ['EMPLOYEE', 'PLATFORM_ADMIN'] } },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) if (r.orgId) out[r.orgId] = r._count._all;
  return out;
}

/** The licence fields shown in the console (and diffed into the audit log). */
const LICENSE_FIELDS = [
  'plan', 'status', 'seats', 'features', 'interval', 'cancelAtPeriodEnd', 'currentPeriodEnd', 'graceUntil',
  'storageQuotaOverrideGb', 'aiTokenLimitMonthly', 'seatsOverride', 'extraFeatures', 'manualNote', 'manualExpiresAt',
  'platformEmailQuotaMonthly', 'platformWhatsAppQuotaMonthly',
] as const;

function licenseDiff(before: Record<string, any> | null, after: Record<string, any>) {
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : Array.isArray(v) ? [...v].sort().join(',') : v ?? null);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of LICENSE_FIELDS) {
    const a = norm(before?.[k]); const b = norm(after[k]);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = { from: before?.[k] ?? null, to: after[k] ?? null };
  }
  return changes;
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
    const [usageByOrg, sendCountsByOrg, seatsByOrg, cfg] = await Promise.all([
      Promise.all(orgs.map(o => getHostedStorageUsageBytes(o.id))),
      getSendCountsForOrgs(orgs.map(o => o.id)),
      billableSeatsByOrg(orgs.map(o => o.id)),
      getPricingConfig(),
    ]);

    res.json(orgs.map((o, i) => {
      const plan = o.subscription?.plan ?? 'FREE';
      const lic = licenseFor(o.id, o.subscription, cfg);
      const quotaBytes = lic.storageQuotaGB * GB;
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan,
        createdAt: o.createdAt,
        subscription: o.subscription
          ? {
              plan: o.subscription.plan,
              status: o.subscription.status,
              seats: o.subscription.seats,
              currentPeriodEnd: o.subscription.currentPeriodEnd,
              cancelAtPeriodEnd: o.subscription.cancelAtPeriodEnd,
              stripeCustomerId: o.subscription.stripeCustomerId,
              storageQuotaOverrideGb: (o.subscription as any).storageQuotaOverrideGb ?? null,
              aiTokenLimitMonthly: (o.subscription as any).aiTokenLimitMonthly ?? null,
              stripeSubscriptionId: o.subscription.stripeSubscriptionId,
            }
          : null,
        // What the org can actually do right now (payment state + overrides applied).
        license: { effectivePlan: lic.effectivePlan, access: lic.access, seats: lic.seats, reason: lic.reason, stripeManaged: lic.stripeManaged },
        seatsUsed: seatsByOrg[o.id] ?? 0,
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

    const cfg = await getPricingConfig();
    const lic = licenseFor(org.id, org.subscription, cfg);
    const quotaBytes = lic.storageQuotaGB * GB;
    // Current-month AI token usage, shown next to the license's token
    // allowance in the org detail panel.
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [usedBytes, sendCounts, tokenAgg, platformSends, history] = await Promise.all([
      getHostedStorageUsageBytes(org.id), // real even without an explicit StorageConfig row — see the fallback in storage.ts
      getSendCounts(org.id),
      prisma.aiInteractionLog.aggregate({
        where: { orgId: org.id, createdAt: { gte: monthStart } },
        _sum: { totalTokens: true },
        _count: { _all: true },
      }),
      getPlatformSendUsage(org.id),
      // Licence history = the audit entries this console writes on every save.
      prisma.auditLog.findMany({
        where: { entityType: 'Subscription', entityId: org.id },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, createdAt: true, changes: true, user: { select: { name: true, email: true } } },
      }),
    ]);
    const seatsUsed = org.users.filter(u => u.isActive && u.role !== 'EMPLOYEE' && u.role !== 'PLATFORM_ADMIN').length;

    res.json({
      ...org,
      plan: org.subscription?.plan ?? 'FREE',
      license: lic,
      seatsUsed,
      licenceHistory: history,
      storageLicense: { quotaBytes, usedBytes },
      sendCounts,
      platformSendsThisMonth: {
        email: platformSends.email, emailLimit: lic.platformEmailMonthly,
        whatsapp: platformSends.whatsapp, whatsappLimit: lic.platformWhatsAppMonthly,
      },
      aiUsage: {
        tokensUsedThisMonth: tokenAgg._sum.totalTokens ?? 0,
        callsThisMonth: tokenAgg._count._all,
        tokenLimitMonthly: lic.aiTokensMonthly,
        tokenLimitOverride: (org.subscription as any)?.aiTokenLimitMonthly ?? null,
      },
    });
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

const dateInput = z.union([z.string().min(1), z.null()]).optional()
  .transform(v => (v === undefined ? undefined : v === null ? null : new Date(v)))
  .refine(v => v === undefined || v === null || !Number.isNaN(v.getTime()), 'Invalid date');

const UpdateSubscriptionSchema = z.object({
  plan: z.enum(['FREE', 'PRO', 'ENTERPRISE', 'CUSTOM']).optional(),
  seats: z.number().int().positive().optional(),
  /** Feature keys for a CUSTOM licence (utils/pricing.ts MODULES; ignored for fixed plans). */
  features: z.array(z.string()).optional(),
  interval: z.enum(['month', 'year']).optional(),
  /** A fixed list — a typo here used to silently lapse the org (LIC-17). */
  status: z.enum(LICENSE_STATUSES).optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
  /** Hosted-storage quota override in GB. null clears the override (plan
   *  default applies again); 0 is meaningful — it removes hosted storage
   *  from this org entirely. */
  storageQuotaOverrideGb: z.number().int().min(0).max(10000).nullable().optional(),
  /** Monthly AI token allowance. null = the plan's default allowance;
   *  0 = explicitly unlimited. Enforced as a hard cap by the AI gateway. */
  aiTokenLimitMonthly: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  /** Operator overrides the Stripe webhook never touches (LIC-7). */
  seatsOverride: z.number().int().min(1).max(100_000).nullable().optional(),
  extraFeatures: z.array(z.string()).max(30).optional(),
  manualNote: z.string().max(2000).nullable().optional(),
  /** Manual licences only: expiry date (null = never expires) (LIC-20). */
  manualExpiresAt: dateInput,
  graceUntil: dateInput,
  platformEmailQuotaMonthly: z.number().int().min(0).max(10_000_000).nullable().optional(),
  platformWhatsAppQuotaMonthly: z.number().int().min(0).max(10_000_000).nullable().optional(),
});

/** Fields Stripe owns on a Stripe-billed licence — editing them here would
 *  only change our DB while Stripe keeps charging the old plan. */
const STRIPE_OWNED_FIELDS = ['plan', 'seats', 'features', 'interval', 'status', 'graceUntil', 'manualExpiresAt'] as const;

/**
 * PATCH /platform/orgs/:id/subscription — lets the platform operator override
 * an org's licence (comping an account, correcting a manual sales deal)
 * without the org's own admin going through Billing. Upserts because not
 * every org has a Subscription row yet.
 *
 * Stripe-billed licences (stripeSubscriptionId set): plan / seats / modules /
 * interval / status belong to Stripe — changing them returns 409 (use the
 * override fields, or change the subscription in Stripe). Cancel-at-period-end
 * is sent to Stripe itself so the customer actually stops being billed.
 * The override fields (seatsOverride, extraFeatures, storage / AI / send
 * quotas, note) work on every licence and survive every webhook.
 *
 * Every change is written to the audit log as a field diff (LIC-17).
 */
export async function updateSubscription(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.params.id;
    const data = UpdateSubscriptionSchema.parse(req.body);
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) throw new AppError(404, 'Organization not found');
    const before = await prisma.subscription.findUnique({ where: { orgId } });

    const payload: Record<string, unknown> = { ...data };
    if (data.features) payload.features = normaliseModules(data.features);
    if (data.extraFeatures) payload.extraFeatures = [...new Set(data.extraFeatures.filter(isFeatureKey))];
    if (data.manualNote !== undefined) payload.manualNote = data.manualNote?.trim() || null;
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

    const stripeSubId = before?.stripeSubscriptionId ?? null;
    if (stripeSubId) {
      // The console posts the whole form, so only a field whose value actually
      // differs counts as an attempted change.
      const changes = (k: string) => k in licenseDiff(before as any, { ...before, [k]: payload[k] });
      const blocked = STRIPE_OWNED_FIELDS.filter(k => k in payload && changes(k));
      if (blocked.length) {
        throw new AppError(409, `This licence is billed through Stripe, so ${blocked.join(', ')} can't be changed here — Stripe would keep charging the old plan. ` +
          'Use the seat / module overrides to comp extras, ask the customer to change plan under Billing, or change the subscription in the Stripe dashboard.');
      }
      for (const k of STRIPE_OWNED_FIELDS) delete payload[k];

      if (payload.cancelAtPeriodEnd !== undefined && payload.cancelAtPeriodEnd !== before!.cancelAtPeriodEnd) {
        if (!isBillingEnabled()) throw new AppError(503, 'Stripe is not configured on this server, so the subscription cannot be changed from here.');
        await stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: !!payload.cancelAtPeriodEnd });
        // lastStripeEventAt is left to Stripe's own event timestamps (our
        // clock may be skewed); the resulting subscription.updated confirms it.
      } else {
        delete payload.cancelAtPeriodEnd;
      }
    }

    // Switching a manual licence to a fixed plan takes that plan's seat count
    // (comps go through seatsOverride); only CUSTOM takes the seats typed in.
    // Unchanged plans keep their row as-is, so an older comp isn't reset.
    if (!stripeSubId && typeof payload.plan === 'string' && payload.plan !== 'CUSTOM' && payload.plan !== (before?.plan ?? 'FREE')) {
      payload.seats = PLANS[payload.plan as 'FREE' | 'PRO' | 'ENTERPRISE'].seats;
      payload.features = [];
    }

    const sub = await prisma.subscription.upsert({
      where: { orgId },
      create: { orgId, plan: 'FREE', status: 'active', seats: 5, ...(payload as any) },
      update: payload as any,
    });
    invalidateLicenseCache(orgId);

    const changes = licenseDiff(before as any, sub as any);
    if (Object.keys(changes).length) logAction(req.user!.id, 'UPDATE', 'Subscription', orgId, { changes, stripeManaged: !!stripeSubId });

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

// ─── Licence pricing (Platform Admin → Pricing) ──────────────────────────────
//
// The platform operator — not a customer org's SUPER_ADMIN — decides what
// every plan and custom-licence module costs. Stored as one JSON override on
// PlatformSettings and layered over the code defaults (utils/pricing.ts).

/** Per-plan monthly allowance; null = unlimited. */
const limitsSchema = () => z.object({
  FREE: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  PRO: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  ENTERPRISE: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  CUSTOM: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
}).optional();

const PricingSchema = z.object({
  baseSeatPriceCents: z.number().int().min(0).max(1_000_000).optional(),
  planPrices: z.object({
    PRO: z.number().min(0).max(1_000_000).optional(),
    ENTERPRISE: z.number().min(0).max(1_000_000).optional(),
  }).optional(),
  customStorageGb: z.number().int().min(0).max(100_000).optional(),
  yearlyMonthsCharged: z.number().min(1).max(12).optional(),
  gracePeriodDays: z.number().int().min(0).max(365).optional(),
  minSeats: z.number().int().min(1).max(100_000).optional(),
  maxSeats: z.number().int().min(1).max(100_000).optional(),
  volumeTiers: z.array(z.object({ minSeats: z.number().int().min(1).max(100_000), discountPct: z.number().min(0).max(90) })).max(10).optional(),
  modules: z.array(z.object({
    key: z.string().min(1),
    name: z.string().min(1).max(60).optional(),
    description: z.string().max(200).optional(),
    pricePerSeatCents: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
  })).max(50).optional(),
  currency: z.string().regex(/^[a-zA-Z]{3}$/).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  contactEmail: z.union([z.string().email(), z.literal('')]).optional(),
  planFeatures: z.object({
    FREE: z.array(z.string()).optional(), PRO: z.array(z.string()).optional(),
    ENTERPRISE: z.array(z.string()).optional(), CUSTOM: z.array(z.string()).optional(),
  }).optional(),
  platformEmailMonthly: limitsSchema(),
  platformWhatsAppMonthly: limitsSchema(),
  aiTokensMonthly: limitsSchema(),
});

/** GET /platform/pricing — effective pricing plus the code defaults (so the UI can show "default: …"). */
export async function getPricing(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const [effective, row] = await Promise.all([
      getPricingConfig(),
      prisma.platformSettings.findUnique({ where: { id: 'platform' }, select: { pricing: true, updatedAt: true } }),
    ]);
    res.json({ effective, defaults: DEFAULT_PRICING, hasOverride: !!row?.pricing, updatedAt: row?.updatedAt ?? null });
  } catch (err) { next(err); }
}

/** PUT /platform/pricing — replace the operator override (send the full desired config). Every org sees it on its next request. */
export async function updatePricing(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const override = PricingSchema.parse(req.body) as PricingOverride;
    const previous = await getPricingConfig();
    const effective = await savePricingOverride(override);
    invalidateLicenseCache(); // grace days / custom storage / plan features feed entitlements
    // Audit trail of every price / entitlement change (LIC-17): top-level keys that changed.
    const changed = (Object.keys(effective) as (keyof typeof effective)[])
      .filter(k => JSON.stringify(previous[k]) !== JSON.stringify(effective[k]));
    if (changed.length) {
      logAction(req.user!.id, 'UPDATE', 'PricingConfig', 'platform', {
        changes: Object.fromEntries(changed.map(k => [k, { from: previous[k], to: effective[k] }])),
      });
    }
    res.json({ effective, defaults: DEFAULT_PRICING, hasOverride: true, updatedAt: new Date() });
  } catch (err) { next(err); }
}

/** DELETE /platform/pricing — drop the override and go back to code/env defaults. */
export async function resetPricing(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.platformSettings.upsert({ where: { id: 'platform' }, create: { id: 'platform' }, update: { pricing: Prisma.DbNull } });
    logAction(_req.user!.id, 'UPDATE', 'PricingConfig', 'platform', { reset: true });
    const { invalidatePricingCache } = await import('../../utils/pricing');
    invalidatePricingCache();
    invalidateLicenseCache();
    res.json({ effective: DEFAULT_PRICING, defaults: DEFAULT_PRICING, hasOverride: false, updatedAt: null });
  } catch (err) { next(err); }
}
