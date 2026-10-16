import { Response, NextFunction } from 'express';
import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/authenticate';
import jwt from 'jsonwebtoken';
import { PLANS, FeatureKey, PlanKey, isPlanKey, isFeatureKey } from './stripe';
import { normaliseModules, getPricingConfig, DEFAULT_PRICING, PricingConfig } from './pricing';
import { MODULE_CATALOGUE, AREA_MODULE_KEYS, areaOf } from './modules';

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

// ─── Effective licence (plan × payment state) ────────────────────────────────
//
// Everything below (seats, features, storage) must read the org's licence
// through getEffectiveLicense() rather than Subscription.plan directly, so
// that Stripe's payment state is honoured everywhere in one place:
//
//   active / trialing            → full paid entitlements
//   past_due / incomplete        → paid entitlements continue during the grace
//                                  window (graceUntil, set by the webhook the
//                                  moment payment fails), then FREE
//   canceled / unpaid / paused   → FREE immediately
//   Stripe-managed, active, but currentPeriodEnd stale past grace → FREE
//   manual licence (no Stripe subscription) past manualExpiresAt  → FREE
//
// "FREE" here means FREE entitlements (seats/features/storage). Existing users,
// rules and files are never touched — the grandfathering rules in the licensing
// spec still apply; the org simply can't add beyond FREE limits until it pays.
//
// Operator overrides (seatsOverride, extraFeatures, storage / AI / send-quota
// overrides) are applied on top in every state — they are deliberate comps.
// disabledFeatures (modules the operator switched OFF for this org) is applied
// last, also in every state:
//
//   features = (plan features for the effective plan ∪ extraFeatures) − disabledFeatures
//
// then any catalogue module whose prerequisite is missing (utils/modules.ts
// `requires`, e.g. Campaigns needs CRM) is dropped too.

export type LicenseAccess = 'full' | 'grace' | 'lapsed';

export interface EffectiveLicense {
  orgId: string;
  /** Plan on the row */
  plan: PlanKey;
  /** Plan whose entitlements actually apply right now */
  effectivePlan: PlanKey;
  status: string;
  seats: number;
  features: FeatureKey[];
  storageQuotaGB: number;
  interval: string;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  /** True when Stripe bills this licence (changes must go through Stripe). */
  stripeManaged: boolean;
  /** Expiry of a manual licence (null = none / Stripe-managed). */
  manualExpiresAt: Date | null;
  /** Monthly allowances — null = unlimited. */
  aiTokensMonthly: number | null;
  platformEmailMonthly: number | null;
  platformWhatsAppMonthly: number | null;
  access: LicenseAccess;
  /** Human-readable explanation when access !== 'full' */
  reason: string | null;
  /** Keys the platform operator switched off for this org (valid keys only). */
  disabledFeatures: FeatureKey[];
  /** Catalogue modules that are OFF as a whole right now: switched off by the
   *  operator, an area module (crm, itdesk, …) the licence lacks, or a module
   *  whose prerequisite is off. Their routers answer 402 and the app hides
   *  them (see requireModuleAtMount and GET /billing/entitlements). Older
   *  feature keys missing only from the PLAN are not listed — their existing
   *  data stays readable, as before. */
  blockedModules: FeatureKey[];
}

const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const LAPSED_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);
const GRACE_STATUSES = new Set(['past_due', 'incomplete']);
/** Statuses Platform Admin may set on a manual licence. */
export const LICENSE_STATUSES = ['active', 'trialing', 'past_due', 'incomplete', 'canceled', 'unpaid', 'paused'] as const;

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

export type SubRow = {
  orgId: string; plan: string; status: string; seats: number; features: string[]; interval: string;
  currentPeriodEnd: Date | null; graceUntil: Date | null; cancelAtPeriodEnd: boolean;
  storageQuotaOverrideGb: number | null;
  stripeSubscriptionId?: string | null;
  lastPaymentFailedAt?: Date | null;
  updatedAt?: Date | null;
  seatsOverride?: number | null;
  extraFeatures?: string[] | null;
  disabledFeatures?: string[] | null;
  manualExpiresAt?: Date | null;
  trialEndsAt?: Date | null;
  aiTokenLimitMonthly?: number | null;
  platformEmailQuotaMonthly?: number | null;
  platformWhatsAppQuotaMonthly?: number | null;
};

/** Effective feature list of a plan under the live pricing config. */
export function planFeaturesFor(plan: PlanKey, cfg: PricingConfig = DEFAULT_PRICING): FeatureKey[] {
  return [...(cfg.planFeatures?.[plan] ?? PLANS[plan].features)];
}

/** AI tokens: per-org override wins (0 = explicitly unlimited); else the plan default. */
export function resolveAiTokenLimit(override: number | null | undefined, plan: PlanKey, cfg: PricingConfig = DEFAULT_PRICING): number | null {
  if (override !== null && override !== undefined) return override > 0 ? override : null;
  return cfg.aiTokensMonthly?.[plan] ?? null;
}

/** Send quota: per-org override wins (0 = none allowed via the platform); else plan default. */
export function resolveSendQuota(override: number | null | undefined, defaults: Record<string, number | null> | undefined, plan: PlanKey): number | null {
  if (override !== null && override !== undefined) return Math.max(0, override);
  return defaults?.[plan] ?? null;
}

/**
 * Pure: apply the operator's area / module switch-offs to a granted feature
 * set (utils/modules.ts). Returns the effective features and the catalogue
 * modules that are off as a whole (EffectiveLicense.blockedModules):
 *  - any key in `disabled` is off (an area root there = the whole area off);
 *  - an area whose root is blocked takes every sub-module down with it;
 *  - the catalogue's new area keys (crm, itdesk, …) are blocked whenever the
 *    licence lacks them. Older keys merely missing from the plan (hr_core,
 *    payroll, campaigns, …) are NOT blocked — that keeps today's behaviour,
 *    where existing data stays readable and only creating is upgrade-locked.
 */
export function applyModuleRules(granted: FeatureKey[], disabled: FeatureKey[]): { features: FeatureKey[]; blockedModules: FeatureKey[] } {
  const grantedSet = new Set(granted);
  const blocked = new Set<FeatureKey>(disabled);
  for (const k of AREA_MODULE_KEYS) if (!grantedSet.has(k)) blocked.add(k);
  for (const m of MODULE_CATALOGUE) {
    const area = areaOf(m.key)!;
    if (blocked.has(area.root)) blocked.add(m.key);
  }
  const features = granted.filter(k => !blocked.has(k));
  const blockedModules = MODULE_CATALOGUE.map(m => m.key).filter(k => blocked.has(k));
  return { features, blockedModules };
}

/** Pure evaluation — exported so it can be unit-tested without a database. */
export function evaluateLicense(sub: SubRow, now = new Date(), cfg: PricingConfig = DEFAULT_PRICING): EffectiveLicense {
  const plan: PlanKey = isPlanKey(sub.plan) ? sub.plan : 'FREE';
  const stripeManaged = !!sub.stripeSubscriptionId;
  const extra = (sub.extraFeatures ?? []).filter(isFeatureKey);
  const disabled = [...new Set((sub.disabledFeatures ?? []).filter(isFeatureKey))];
  const withExtras = (features: FeatureKey[]) => applyModuleRules([...new Set([...features, ...extra])], disabled);
  const seatsWithOverride = (seats: number) => (sub.seatsOverride && sub.seatsOverride > 0 ? sub.seatsOverride : seats);

  const limitsFor = (p: PlanKey) => ({
    aiTokensMonthly: resolveAiTokenLimit(sub.aiTokenLimitMonthly, p, cfg),
    platformEmailMonthly: resolveSendQuota(sub.platformEmailQuotaMonthly, cfg.platformEmailMonthly, p),
    platformWhatsAppMonthly: resolveSendQuota(sub.platformWhatsAppQuotaMonthly, cfg.platformWhatsAppMonthly, p),
  });

  const base = {
    disabledFeatures: disabled,
    orgId: sub.orgId, plan, status: sub.status, interval: sub.interval,
    currentPeriodEnd: sub.currentPeriodEnd, graceUntil: sub.graceUntil, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    trialEndsAt: sub.trialEndsAt ?? null, stripeManaged,
    manualExpiresAt: stripeManaged ? null : (sub.manualExpiresAt ?? null),
  };

  const paidFeatures: FeatureKey[] = plan === 'CUSTOM'
    ? [...new Set([...planFeaturesFor('CUSTOM', cfg), ...(normaliseModules(sub.features).filter(isFeatureKey) as FeatureKey[])])]
    : planFeaturesFor(plan, cfg);
  const paidStorage = sub.storageQuotaOverrideGb ?? (plan === 'CUSTOM'
    ? (sub.features.includes('hosted_storage') ? cfg.customStorageGb : 0)
    : PLANS[plan].storageQuotaGB);
  // FREE is always the fixed 5 seats on the row (the row's seats column may be
  // stale from an old plan); an operator comp goes through seatsOverride.
  const paidSeats = plan === 'FREE' ? PLANS.FREE.seats : sub.seats;

  const full: EffectiveLicense = {
    ...base, ...limitsFor(plan), effectivePlan: plan, seats: seatsWithOverride(paidSeats),
    ...withExtras(paidFeatures), storageQuotaGB: paidStorage, access: 'full', reason: null,
  };
  const lapsed = (reason: string): EffectiveLicense => ({
    ...base, ...limitsFor('FREE'), effectivePlan: 'FREE', seats: seatsWithOverride(PLANS.FREE.seats),
    ...withExtras(planFeaturesFor('FREE', cfg)),
    // An explicit operator override still wins on a lapsed org (it is a deliberate comp)
    storageQuotaGB: sub.storageQuotaOverrideGb ?? PLANS.FREE.storageQuotaGB, access: 'lapsed', reason,
  });

  if (plan === 'FREE') return full;
  if (LAPSED_STATUSES.has(sub.status)) return lapsed(`Your subscription is ${sub.status}.`);

  if (GRACE_STATUSES.has(sub.status)) {
    // graceUntil is written by the webhook the moment payment fails. Without
    // it, never fall back to currentPeriodEnd: on a renewal failure Stripe has
    // already advanced the period, which used to grant a whole extra month
    // (or year) of paid features. Count from the failure instead.
    const failedAt = sub.lastPaymentFailedAt ?? sub.updatedAt ?? null;
    const graceEnd = sub.graceUntil ?? (failedAt ? addDays(failedAt, cfg.gracePeriodDays) : null);
    if (graceEnd && now <= graceEnd) {
      return { ...full, graceUntil: graceEnd, access: 'grace', reason: `Your last payment failed. Update your payment method before ${graceEnd.toDateString()} to keep ${PLANS[plan].name} features.` };
    }
    return lapsed('Your last payment failed and the grace period has ended.');
  }

  if (ACTIVE_STATUSES.has(sub.status)) {
    if (stripeManaged) {
      // Stripe renews currentPeriodEnd on every successful invoice; a date
      // well in the past means we stopped hearing from Stripe.
      if (sub.currentPeriodEnd && now > addDays(sub.currentPeriodEnd, cfg.gracePeriodDays)) {
        return lapsed('Your subscription period ended and was not renewed.');
      }
    } else if (sub.manualExpiresAt && now > sub.manualExpiresAt) {
      // Manual licences (comped / invoiced offline / seeded) expire only on an
      // explicit date the operator set; currentPeriodEnd is ignored for them.
      return lapsed(`Your licence expired on ${sub.manualExpiresAt.toDateString()}.`);
    }
    return full;
  }

  return lapsed(`Your subscription status "${sub.status}" is not active.`);
}

const CACHE_TTL_MS = 30_000;
const licenseCache = new Map<string, { at: number; value: EffectiveLicense }>();

/** Call after any Subscription write (webhooks, platform-admin edits) so the next request sees it. */
export function invalidateLicenseCache(orgId?: string) {
  if (orgId) licenseCache.delete(orgId); else licenseCache.clear();
}

export async function getEffectiveLicense(orgId: string): Promise<EffectiveLicense> {
  const hit = licenseCache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const [sub, cfg] = await Promise.all([getOrCreateSubscription(orgId), getPricingConfig()]);
  const value = evaluateLicense(sub as unknown as SubRow, new Date(), cfg);
  licenseCache.set(orgId, { at: Date.now(), value });
  return value;
}

type CountClient = { user: { count: (args: any) => Promise<number> } };

/** Active users whose role counts against the seat limit (everything but EMPLOYEE). */
export async function getBillableSeatCount(orgId: string, client: CountClient = prisma): Promise<number> {
  return client.user.count({
    where: { orgId, isActive: true, role: { notIn: ['EMPLOYEE', 'PLATFORM_ADMIN'] } },
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
 *
 * Pass `client` (a transaction) together with withSeatLock() so the count and
 * the insert can't race another request taking the last seat.
 */
export async function assertSeatAvailable(orgId: string, role: string, client: CountClient = prisma): Promise<void> {
  if (!isMeteredRole(role)) return;

  const lic = await getEffectiveLicense(orgId);
  const billableCount = await getBillableSeatCount(orgId, client);

  if (billableCount >= lic.seats) {
    const lapsedNote = lic.access === 'lapsed' ? ` ${lic.reason} Until payment is restored your organisation is limited to the Free plan's seats.` : '';
    throw new AppError(
      402,
      `Your ${PLANS[lic.effectivePlan].name} plan includes ${lic.seats} seat${lic.seats === 1 ? '' : 's'}. ` +
      `You're already using all ${billableCount} (every role except Employee counts toward this). ` +
      `Upgrade your plan or add seats under Billing to add more people.${lapsedNote}`
    );
  }
}

export interface SeatTransition {
  wasActive: boolean;
  wasRole: string | null;
  willBeActive: boolean;
  willBeRole: string;
}

/** Pure: does this change newly make someone a billable seat? (spec §3.2)
 *  True for: a new active billable user, reactivating a billable user, or
 *  promoting an EMPLOYEE to a billable role. False for lateral moves between
 *  billable roles, demotions and deactivations — those never add a seat. */
export function consumesNewSeat(t: SeatTransition): boolean {
  const wasBillable = t.wasActive && !!t.wasRole && isMeteredRole(t.wasRole);
  const willBeBillable = t.willBeActive && isMeteredRole(t.willBeRole);
  return willBeBillable && !wasBillable;
}

/** Seat check for any user change (create, role change, reactivation). */
export async function assertSeatForTransition(orgId: string, t: SeatTransition, client: CountClient = prisma): Promise<void> {
  if (!consumesNewSeat(t)) return;
  await assertSeatAvailable(orgId, t.willBeRole, client);
}

/**
 * Serialises seat-consuming writes per org: takes a transaction-scoped
 * Postgres advisory lock on the org, so two concurrent invites/creates can't
 * both pass the count and overshoot the limit. `fn` receives the transaction
 * — do the seat check and the user write through it.
 */
export async function withSeatLock<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'seat:' + orgId}))`;
    return fn(tx);
  });
}

// ─── Feature gating ──────────────────────────────────────────────────────────
//
// Coarse-grained on purpose — see the FeatureKey comment in utils/stripe.ts.
// A plan value that isn't a known key in PLANS fails safe to FREE's features
// rather than throwing, so an unrecognized plan blocks access to Pro+
// features instead of accidentally granting them.

export async function hasFeature(orgId: string, feature: FeatureKey): Promise<boolean> {
  const lic = await getEffectiveLicense(orgId);
  return lic.features.includes(feature);
}

const FEATURE_NAMES: Record<FeatureKey, string> = {
  ai_advanced: 'Advanced AI', workflow_automation: 'Workflow automation', customer_portal: 'The customer portal',
  advanced_analytics: 'Advanced analytics', custom_branding: 'Custom branding', sso: 'Single sign-on configuration',
  directory_sync: 'Directory sync', api_access: 'API access', custom_modules: 'Custom modules', hr_core: 'HR',
  payroll: 'Payroll', attendance: 'Attendance', campaigns: 'Campaigns',
  crm: 'CRM', itdesk: 'IT Desk', sales_docs: 'Quotes & Invoices', assets: 'Assets', knowledge_base: 'The knowledge base',
};

export function featureNotIncludedMessage(lic: EffectiveLicense, feature: FeatureKey): string {
  const name = FEATURE_NAMES[feature] ?? 'This feature';
  // Switched off by the platform operator — upgrading won't help, so don't
  // send the customer to Billing; their provider has to turn it back on.
  if (lic.disabledFeatures.includes(feature)) {
    return `${name} isn't enabled for your organisation — it has been switched off by your service provider. Contact your administrator if you need it.`;
  }
  const area = areaOf(feature);
  if (area && lic.disabledFeatures.includes(area.root)) {
    return `${name} is part of the ${area.label} area, which isn't enabled for your organisation. Contact your administrator if you need it.`;
  }
  const why = lic.access === 'lapsed'
    ? `${lic.reason} Restore payment under Billing to regain access.`
    : `Upgrade your plan or add it to a custom licence under Billing to unlock it.`;
  return `${name} isn't included in your ${PLANS[lic.effectivePlan].name} plan. ${why}`;
}

/** Express middleware factory — 402s with an upgrade message if the org's
 * plan doesn't include `feature`. Mirrors requireRole()'s call shape
 * (middleware/authenticate.ts) so route tables read consistently. */
export function requireFeature(feature: FeatureKey) {
  return async (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      const orgId = req.user?.orgId;
      if (!orgId) return next(); // no org (platform admin) — nothing to license
      const lic = await getEffectiveLicense(orgId);
      if (!lic.features.includes(feature)) {
        throw new AppError(402, featureNotIncludedMessage(lic, feature));
      }
      next();
    } catch (err) { next(err); }
  };
}

/**
 * requireFeature for a router MOUNT POINT (app.use('/api/hr/…', gate, router)),
 * where authenticate() hasn't run yet because each router authenticates
 * itself. Identifies the org from req.user (API key) or by verifying the
 * bearer token; with neither it simply passes through, so the router's own
 * authenticate() still returns its 401 and any deliberately public route in
 * the router keeps working.
 */
export function requireFeatureAtMount(feature: FeatureKey) {
  const gate = requireFeature(feature);
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.orgId) return gate(req, res, next);
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if (!token || !process.env.JWT_SECRET) return next();
    let orgId: string | undefined;
    try {
      orgId = (jwt.verify(token, process.env.JWT_SECRET) as { orgId?: string }).orgId;
    } catch { return next(); }
    if (!orgId) return next();
    return gate({ ...req, user: { orgId } } as unknown as AuthRequest, res, next);
  };
}

/** True while a catalogue module is off as a whole for the org (EffectiveLicense.blockedModules). */
export async function isModuleBlocked(orgId: string, key: FeatureKey): Promise<boolean> {
  const lic = await getEffectiveLicense(orgId);
  return lic.blockedModules.includes(key);
}

/** Org ids among `orgIds` for which `key` is off — for background jobs that
 *  sweep many orgs (SLA monitor, attendance auto-checkout, payroll crons). */
export async function orgsWithModuleBlocked(orgIds: string[], key: FeatureKey): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all([...new Set(orgIds)].map(async id => {
    try { if (await isModuleBlocked(id, key)) out.add(id); } catch { /* fail open: never stop a job on a licence read */ }
  }));
  return out;
}

/**
 * Whole-router gate for a catalogue module (index.ts mounts each module's
 * routers behind it — see utils/modules.ts apiPrefixes). 402s while the
 * module is in blockedModules. Same org identification as
 * requireFeatureAtMount: req.user (API key) or the bearer token (staff or
 * portal JWT); with neither it passes through, so the router's own auth still
 * answers 401 and its public routes (shared quote links, CSAT survey, web
 * forms) keep working.
 */
export function requireModuleAtMount(key: FeatureKey) {
  const gate = async (orgId: string, next: NextFunction) => {
    try {
      const lic = await getEffectiveLicense(orgId);
      if (lic.blockedModules.includes(key)) throw new AppError(402, featureNotIncludedMessage(lic, key));
      next();
    } catch (err) { next(err); }
  };
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    const orgId = req.user?.orgId ?? orgIdFromBearer(req);
    if (!orgId) return next();
    return gate(orgId, next);
  };
}

function orgIdFromBearer(req: AuthRequest): string | undefined {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  if (!token || !process.env.JWT_SECRET) return undefined;
  try {
    return (jwt.verify(token, process.env.JWT_SECRET) as { orgId?: string }).orgId || undefined;
  } catch { return undefined; }
}

// ─── Hosted storage quota ─────────────────────────────────────────────────
//
// Separate from the seat/feature checks above: this gates the "use our
// hosted storage" option in Settings → Storage (utils/s3Storage.ts), an
// alternative to bring-your-own Google Drive. Same fail-safe-to-0 pattern
// as planFeatures() for an unrecognized plan value.

export async function getStorageQuotaBytes(orgId: string): Promise<number> {
  // A per-org override set by the platform operator in the license editor
  // beats the plan default (evaluateLicense applies it); a CUSTOM licence
  // gets the operator-set customStorageGb when it includes the hosted_storage module.
  const lic = await getEffectiveLicense(orgId);
  return lic.storageQuotaGB * 1024 * 1024 * 1024;
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

// Bytes of uploads that passed the quota check but whose Attachment row isn't
// written yet. Without this, two concurrent uploads both see the same
// "used" total and together overshoot the quota (LIC-22). In-process only —
// the deployment runs one API process; a multi-instance setup would need a
// shared counter.
const pendingHostedBytes = new Map<string, number>();
const RESERVATION_TTL_MS = 2 * 60_000;

function reserveHostedBytes(orgId: string, bytes: number): () => void {
  pendingHostedBytes.set(orgId, (pendingHostedBytes.get(orgId) ?? 0) + bytes);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (pendingHostedBytes.get(orgId) ?? 0) - bytes;
    if (left > 0) pendingHostedBytes.set(orgId, left); else pendingHostedBytes.delete(orgId);
  };
  // Safety net if a caller never releases (crash between upload and insert).
  setTimeout(release, RESERVATION_TTL_MS).unref?.();
  return release;
}

/**
 * Throws AppError(402) before an upload would push the org over its plan's
 * hosted-storage quota (or if the plan doesn't include hosted storage at
 * all, i.e. quota is 0 — FREE orgs must use their own Google Drive).
 * `additionalBytes` is the size of the file about to be uploaded.
 *
 * Reserves the bytes until the returned function is called — call it once
 * the Attachment row is written (or the upload failed).
 */
export async function assertHostedStorageAvailable(orgId: string, additionalBytes: number): Promise<() => void> {
  const lic = await getEffectiveLicense(orgId);
  const sub = { plan: PLANS[lic.effectivePlan].name };
  const quotaBytes = lic.storageQuotaGB * 1024 * 1024 * 1024;

  if (quotaBytes === 0) {
    throw new AppError(
      402,
      `Hosted storage isn't included in your ${sub.plan} plan — connect your own Google Drive or your own S3-compatible bucket in Settings → Storage instead, or upgrade to Pro for 5GB of hosted storage.`
    );
  }

  // Reserve synchronously BEFORE the await, so a concurrent upload's check
  // already counts this one.
  const release = reserveHostedBytes(orgId, additionalBytes);
  try {
    const usedBytes = await getHostedStorageUsageBytes(orgId);
    const pending = pendingHostedBytes.get(orgId) ?? additionalBytes; // includes this upload
    if (usedBytes + pending > quotaBytes) {
      const usedGB = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
      const quotaGB = (quotaBytes / (1024 * 1024 * 1024)).toFixed(0);
      throw new AppError(
        402,
        `This upload would exceed your ${sub.plan} plan's ${quotaGB}GB hosted storage quota (${usedGB}GB used). Delete some files, switch to your own Google Drive, or upgrade your plan.`
      );
    }
  } catch (err) {
    release();
    throw err;
  }
  return release;
}

// ─── Platform-fallback send quotas (LIC-18) ──────────────────────────────────
//
// Email / WhatsApp that go out through OUR accounts (the white-label fallback
// in utils/mailer.ts / utils/whatsapp.ts) cost us money per message, so each
// plan gets a monthly allowance (PricingConfig.platformEmailMonthly /
// platformWhatsAppMonthly, per-org override on the Subscription row). Sending
// through the org's own SMTP / Twilio account is never counted or limited.

export type PlatformSendKind = 'email' | 'whatsapp';

export class PlatformQuotaExceededError extends AppError {
  constructor(public kind: PlatformSendKind, public used: number, public quota: number) {
    super(429, kind === 'email'
      ? `This month's allowance of ${quota.toLocaleString()} emails sent through the platform mailer is used up (${used.toLocaleString()} sent). Connect your own email account in Settings → Email to keep sending, or upgrade your plan.`
      : `This month's allowance of ${quota.toLocaleString()} WhatsApp messages sent through the platform number is used up (${used.toLocaleString()} sent). Connect your own WhatsApp number in Inbox → Settings to keep sending, or upgrade your plan.`);
  }
}

/** Pure: null quota = unlimited. */
export function isOverQuota(used: number, quota: number | null): boolean {
  return quota !== null && used >= quota;
}

/** UTC calendar month — same window the AI gateway budgets on. */
export function currentMonthWindow(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export async function getPlatformSendUsage(orgId: string, now = new Date()): Promise<{ email: number; whatsapp: number }> {
  const { start, end } = currentMonthWindow(now);
  const rows = await prisma.usageEvent.groupBy({
    by: ['type'],
    where: { orgId, source: 'PLATFORM', type: { in: ['EMAIL_SEND', 'WHATSAPP_SEND'] }, createdAt: { gte: start, lt: end } },
    _count: { _all: true },
  });
  const n = (t: string) => rows.find(r => r.type === t)?._count._all ?? 0;
  return { email: n('EMAIL_SEND'), whatsapp: n('WHATSAPP_SEND') };
}

/** Throws PlatformQuotaExceededError when the org has used its platform allowance for this month. */
export async function assertPlatformSendQuota(orgId: string, kind: PlatformSendKind): Promise<void> {
  const [lic, usage] = await Promise.all([getEffectiveLicense(orgId), getPlatformSendUsage(orgId)]);
  const quota = kind === 'email' ? lic.platformEmailMonthly : lic.platformWhatsAppMonthly;
  const used = kind === 'email' ? usage.email : usage.whatsapp;
  if (isOverQuota(used, quota)) throw new PlatformQuotaExceededError(kind, used, quota!);
}
