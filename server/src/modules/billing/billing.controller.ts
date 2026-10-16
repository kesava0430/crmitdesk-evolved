import { publicCatalogue } from '../../utils/modules';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { stripe, verifyStripeWebhook, PLANS, PlanKey, isPlanKey, isBillingEnabled, StripeApiError } from '../../utils/stripe';
import {
  getBillableSeatCount, getEffectiveLicense, invalidateLicenseCache, planFeaturesFor, getPlatformSendUsage, currentMonthWindow,
} from '../../utils/licensing';
import { getUsageSummary } from '../../utils/usageTracking';
import { computeQuote, normaliseModules, pricingCatalogue, getPricingConfig, BillingInterval, PricingConfig } from '../../utils/pricing';
import {
  processStripeEvent, subscriptionFieldsFromStripe, buildSubscriptionUpdate, idempotencyKey, checkoutExtras,
  LIVE_STRIPE_STATUSES, DesiredLicence, WebhookDeps, ExistingSubRow,
} from './billingLogic';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const PRODUCT_PREFIX = process.env.STRIPE_PRODUCT_PREFIX || 'Zenkara 360';

// ─── Ensure subscription row exists ──────────────────────────────────────────

async function getOrCreateSubscription(orgId: string) {
  return prisma.subscription.upsert({
    where: { orgId },
    create: { orgId, plan: 'FREE', status: 'active', seats: 5 },
    update: {},
  });
}

/** LIC-16: never start a payment we couldn't record. */
function assertBillingEnabled() {
  if (!isBillingEnabled()) {
    throw new AppError(503, "Online payment isn't available right now. Please contact us to change your plan.");
  }
}

async function ensureStripeCustomer(req: AuthRequest, sub: { stripeCustomerId: string | null }): Promise<string> {
  if (sub.stripeCustomerId) return sub.stripeCustomerId;
  const orgId = req.user!.orgId;
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  // Idempotency-Key per org (LIC-22): two concurrent checkouts get the SAME
  // Stripe customer instead of two.
  const customer = await stripe.customers.create(
    { email: req.user!.email || '', name: org?.name || '', metadata: { orgId } },
    { idempotencyKey: `cust-${orgId}` },
  );
  await prisma.subscription.update({ where: { orgId }, data: { stripeCustomerId: customer.id } });
  return customer.id as string;
}

/** What the Billing page shows as "planConfig" — for CUSTOM the seats/price come from the row. */
function planPrice(plan: PlanKey, cfg: PricingConfig): number {
  return plan === 'PRO' || plan === 'ENTERPRISE' ? cfg.planPrices[plan] : 0;
}

function planView(sub: { plan: string; seats: number; amountCents: number; interval: string; features: string[] }, cfg: PricingConfig) {
  const key: PlanKey = isPlanKey(sub.plan) ? sub.plan : 'FREE';
  const p = PLANS[key];
  const isCustom = key === 'CUSTOM';
  return {
    name: p.name,
    seats: isCustom ? sub.seats : p.seats,
    /** Monthly-equivalent list price in major units (what the summary card shows) */
    price: isCustom ? Math.round(sub.amountCents / (sub.interval === 'year' ? 12 : 1) / 100) : planPrice(key, cfg),
    priceId: null,
    features: isCustom ? normaliseModules(sub.features) : planFeaturesFor(key, cfg),
    storageQuotaGB: isCustom ? (sub.features.includes('hosted_storage') ? cfg.customStorageGb : 0) : p.storageQuotaGB,
  };
}

// ─── GET /api/billing/pricing ────────────────────────────────────────────────
export async function getPricing(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const cfg = await getPricingConfig();
    const billingEnabled = isBillingEnabled();
    res.json({
      ...pricingCatalogue(cfg),
      billingEnabled,
      // Plan cards are rendered from this — seats, storage, allowances and
      // features all come from the live config, never hard-coded copy (LIC-27).
      plans: (['FREE', 'PRO', 'ENTERPRISE'] as const).map(k => ({
        key: k, name: PLANS[k].name, price: planPrice(k, cfg), seats: PLANS[k].seats,
        features: planFeaturesFor(k, cfg), storageQuotaGB: PLANS[k].storageQuotaGB,
        aiTokensMonthly: cfg.aiTokensMonthly[k], platformEmailMonthly: cfg.platformEmailMonthly[k],
        platformWhatsAppMonthly: cfg.platformWhatsAppMonthly[k],
        stripeConfigured: billingEnabled && k !== 'FREE',
      })),
      customLimits: {
        aiTokensMonthly: cfg.aiTokensMonthly.CUSTOM, platformEmailMonthly: cfg.platformEmailMonthly.CUSTOM,
        platformWhatsAppMonthly: cfg.platformWhatsAppMonthly.CUSTOM, baseFeatures: cfg.planFeatures.CUSTOM,
      },
    });
  } catch (err) { next(err); }
}

// ─── GET /api/billing/entitlements  (any signed-in user) ─────────────────────
export async function getEntitlements(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const [lic, cfg] = await Promise.all([getEffectiveLicense(req.user!.orgId), getPricingConfig()]);
    // The area / module catalogue rides along so the app can hide switched-off
    // areas (sidebar, routes, dashboard, quick-create) without its own copy
    // of which routes belong to which module (utils/modules.ts).
    res.json({ ...lic, gracePeriodDays: cfg.gracePeriodDays, ...publicCatalogue() });
  } catch (err) { next(err); }
}

// ─── GET /api/billing/subscription ───────────────────────────────────────────
export async function getSubscription(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const sub = await getOrCreateSubscription(orgId);
    const { start } = currentMonthWindow();
    // seatsUsed counts every active user except EMPLOYEE (see utils/licensing.ts)
    // — mirrors exactly what assertSeatAvailable() checks, so the billing page
    // never shows a number that disagrees with what actually gets blocked.
    const [seatsUsed, usage, license, cfg, platformSends, tokenAgg] = await Promise.all([
      getBillableSeatCount(orgId),
      getUsageSummary(orgId),
      getEffectiveLicense(orgId),
      getPricingConfig(),
      getPlatformSendUsage(orgId),
      prisma.aiInteractionLog.aggregate({ where: { orgId, createdAt: { gte: start } }, _sum: { totalTokens: true } }),
    ]);
    // Operator-only fields stay server-side.
    const { manualNote: _note, ...publicSub } = sub as typeof sub & { manualNote?: string | null };
    res.json({
      ...publicSub, seatsUsed, license, planConfig: planView(sub, cfg),
      usage: {
        ...usage,
        aiTokens: Number(tokenAgg._sum.totalTokens ?? 0),
        aiTokensLimit: license.aiTokensMonthly,
        platformEmails: platformSends.email,
        platformEmailsLimit: license.platformEmailMonthly,
        platformWhatsApp: platformSends.whatsapp,
        platformWhatsAppLimit: license.platformWhatsAppMonthly,
      },
      billingEnabled: isBillingEnabled(),
      trialEligible: cfg.trialDays > 0 && !sub.hadPaidSubscription && !sub.stripeSubscriptionId,
    });
  } catch (err) { next(err); }
}

// ─── POST /api/billing/quote — price a custom licence, no side effects ───────
const QuoteSchema = z.object({
  seats: z.number().int().min(1).max(100_000),
  modules: z.array(z.string()).default([]),
  interval: z.enum(['month', 'year']).default('month'),
});

/** Parse + validate against the live pricing config (seat bounds, purchasable modules). */
async function parseQuoteInput(body: unknown, orgId: string, alreadyLicensed: string[] = []) {
  const input = QuoteSchema.parse(body);
  const cfg = await getPricingConfig();
  if (input.seats < cfg.minSeats || input.seats > cfg.maxSeats) {
    throw new AppError(400, `Seats must be between ${cfg.minSeats} and ${cfg.maxSeats}.`);
  }
  // A module the org already licenses stays purchasable for it even if the
  // operator has since stopped selling it (grandfathered).
  const disabled = normaliseModules(input.modules)
    .filter(k => !cfg.modules.find(m => m.key === k)?.enabled && !alreadyLicensed.includes(k));
  if (disabled.length) throw new AppError(400, `These modules are not currently available: ${disabled.join(', ')}.`);
  const seatsUsed = await getBillableSeatCount(orgId);
  return { input, cfg, seatsUsed, minSeats: Math.max(cfg.minSeats, seatsUsed) };
}

export async function quoteCustom(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const sub = await getOrCreateSubscription(req.user!.orgId);
    const { input, cfg, seatsUsed, minSeats } = await parseQuoteInput(req.body, req.user!.orgId, sub.plan === 'CUSTOM' ? sub.features : []);
    // minSeats lets the licence builder stop the stepper at what's in use (LIC-3).
    res.json({ ...computeQuote(input, cfg), minSeats, seatsUsed });
  } catch (err) { next(err); }
}

// ─── Shared: change the existing subscription, or start a checkout ──────────

interface ChangeRequest extends DesiredLicence {
  productName: string;
  productDescription: string;
  cancelPath: string;
}

/**
 * LIC-1: an org with a live Stripe subscription gets that subscription
 * UPDATED IN PLACE (price swap on its existing item, Stripe prorates) —
 * opening a second Checkout here used to leave the first subscription
 * running and billing. Only an org without one goes to Checkout.
 */
async function changeOrCheckout(req: AuthRequest, want: ChangeRequest): Promise<{ updated: true } | { url: string }> {
  assertBillingEnabled();
  const orgId = req.user!.orgId;
  const [sub, cfg] = await Promise.all([getOrCreateSubscription(orgId), getPricingConfig()]);
  const amountCents = want.unitAmount * want.quantity;
  const metadata = { orgId, plan: want.plan, seats: String(want.seats), interval: want.interval, features: want.features.join(','), amountCents: String(amountCents) };

  if (sub.stripeSubscriptionId) {
    let stripeSub: any = null;
    try {
      stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    } catch (e) {
      // Deleted in Stripe but we never heard — fall through to a fresh checkout.
      if (!(e instanceof StripeApiError && e.statusCode === 404)) throw e;
    }
    if (stripeSub?.status === 'unpaid') {
      throw new AppError(409, 'Your subscription has an unpaid invoice. Settle it under "Manage billing" before changing plans.');
    }
    if (stripeSub && LIVE_STRIPE_STATUSES.has(stripeSub.status)) {
      // Subscription items take a product id (not inline product_data), so
      // the new plan gets its own product — never rename a shared one.
      const product = await stripe.products.create(
        { name: want.productName, description: want.productDescription, metadata: { orgId, plan: want.plan } },
        { idempotencyKey: idempotencyKey(`prod-${orgId}`, metadata) },
      );
      const params = buildSubscriptionUpdate(stripeSub, orgId, want, product.id);
      const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, params, {
        idempotencyKey: idempotencyKey(`subupd-${orgId}`, params),
      });
      // Reflect it immediately; the customer.subscription.updated webhook
      // follows with the same data. lastStripeEventAt is deliberately NOT
      // bumped from our clock — skew would make genuine Stripe events look
      // stale. The ordering guard stays driven by Stripe's own timestamps.
      const fields = subscriptionFieldsFromStripe(updated, sub, { now: new Date(), gracePeriodDays: cfg.gracePeriodDays, fallbackMetadata: metadata });
      await prisma.subscription.update({ where: { orgId }, data: fields as any });
      invalidateLicenseCache(orgId);
      return { updated: true };
    }
  }

  const customer = await ensureStripeCustomer(req, sub);
  const extras = checkoutExtras({
    automaticTax: process.env.STRIPE_AUTOMATIC_TAX === 'true',
    trialDays: cfg.trialDays,
    eligibleForTrial: !sub.hadPaidSubscription,
  });
  const { trialDays, ...sessionExtras } = extras;
  const session = await stripe.checkout.sessions.create({
    customer,
    mode: 'subscription',
    success_url: `${FRONTEND_URL}/billing?success=1`,
    cancel_url: `${FRONTEND_URL}${want.cancelPath}`,
    line_items: [{
      quantity: want.quantity,
      price_data: {
        currency: want.currency, unit_amount: want.unitAmount, recurring: { interval: want.interval },
        product_data: { name: want.productName, description: want.productDescription, metadata: { plan: want.plan, features: want.features.join(',') } },
      },
    }],
    allow_promotion_codes: true,
    metadata,
    subscription_data: { metadata, ...(trialDays ? { trial_period_days: trialDays } : {}) },
    ...sessionExtras,
  }, { idempotencyKey: idempotencyKey(`checkout-${orgId}`, metadata, Date.now(), 60_000) });
  return { url: (session as any).url };
}

// ─── POST /api/billing/checkout — fixed plan (PRO / ENTERPRISE) ──────────────
// Always priced from PricingConfig.planPrices via price_data (LIC-10), so the
// amount Stripe charges is the amount the Billing page shows; yearly = monthly
// × yearlyMonthsCharged.
const CheckoutSchema = z.object({
  plan: z.enum(['PRO', 'ENTERPRISE']),
  interval: z.enum(['month', 'year']).default('month'),
});

export async function createCheckout(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { plan, interval } = CheckoutSchema.parse(req.body);
    const def = PLANS[plan];
    const cfg = await getPricingConfig();
    const monthlyCents = Math.round(planPrice(plan, cfg) * 100);
    const unitAmount = Math.round(interval === 'year' ? monthlyCents * cfg.yearlyMonthsCharged : monthlyCents);
    if (unitAmount <= 0) throw new AppError(400, `The ${def.name} plan has no price configured.`);

    const result = await changeOrCheckout(req, {
      plan, seats: def.seats, interval, features: [], unitAmount, quantity: 1, currency: cfg.currency,
      productName: `${PRODUCT_PREFIX} ${def.name}`,
      productDescription: `${def.name} plan · ${def.seats} billable seats · billed ${interval === 'year' ? 'yearly' : 'monthly'}`,
      cancelPath: '/billing?canceled=1',
    });
    res.json(result);
  } catch (err) { next(err); }
}

// ─── POST /api/billing/custom-checkout — build-your-own licence ──────────────
// Per-seat: Stripe quantity = seats, unit_amount = discounted per-seat price
// per interval (see computeQuote). Modules/seats/interval ride along in
// metadata so the webhook can write them onto the Subscription row.
export async function createCustomCheckout(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const sub = await getOrCreateSubscription(orgId);
    const { input, cfg, seatsUsed } = await parseQuoteInput(req.body, orgId, sub.plan === 'CUSTOM' ? sub.features : []);
    const quote = computeQuote(input, cfg);
    if (quote.modules.length === 0) throw new AppError(400, 'Select at least one module for a custom licence.');
    // LIC-3: a licence below the seats already in use would be instantly over
    // its limit (and undercut the fixed plans).
    if (quote.seats < seatsUsed) {
      throw new AppError(400, `You have ${seatsUsed} billable users, so a custom licence needs at least ${seatsUsed} seats. Deactivate users or change them to Employee first to buy fewer.`);
    }

    const moduleNames = quote.modules.map(k => cfg.modules.find(m => m.key === k)?.name ?? k).join(', ');
    const result = await changeOrCheckout(req, {
      plan: 'CUSTOM', seats: quote.seats, interval: quote.interval, features: quote.modules,
      unitAmount: quote.unitAmountPerIntervalCents, quantity: quote.seats, currency: cfg.currency,
      productName: `${PRODUCT_PREFIX} Custom Licence — per seat, ${quote.interval === 'year' ? 'yearly' : 'monthly'}`,
      productDescription: `Modules: ${moduleNames}${quote.volumeDiscountPct ? ` · ${quote.volumeDiscountPct}% volume discount` : ''}`,
      cancelPath: '/billing/custom?canceled=1',
    });
    res.json({ ...result, quote });
  } catch (err) { next(err); }
}

// ─── POST /api/billing/portal ────────────────────────────────────────────────
// Stripe's hosted portal: card updates, invoices, cancellation (and seat
// changes, if enabled in the portal settings — see deploy/README.md).
export async function createPortal(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    assertBillingEnabled();
    const sub = await prisma.subscription.findUnique({ where: { orgId: req.user!.orgId } });
    if (!sub?.stripeCustomerId) throw new AppError(400, 'No Stripe billing account yet — choose a plan first.');

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${FRONTEND_URL}/billing`,
    });

    res.json({ url: (session as any).url });
  } catch (err) { next(err); }
}

// ─── POST /api/billing/webhook  (public — raw body, Stripe signature) ────────

const SUB_SELECT = {
  id: true, orgId: true, plan: true, seats: true, features: true, status: true, stripeSubscriptionId: true,
  stripeCustomerId: true, graceUntil: true, lastPaymentFailedAt: true, lastStripeEventAt: true,
} as const;

function prismaWebhookDeps(gracePeriodDays: number): WebhookDeps {
  return {
    findByStripeSubscriptionId: id => prisma.subscription.findFirst({ where: { stripeSubscriptionId: id }, select: SUB_SELECT }) as Promise<ExistingSubRow | null>,
    findByOrgId: async orgId => {
      // metadata.orgId comes from our own signed metadata, but only ever
      // upsert for an org that actually exists.
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
      if (!org) return null;
      return (await prisma.subscription.findUnique({ where: { orgId }, select: SUB_SELECT })) as ExistingSubRow | null
        ?? { orgId, plan: 'FREE', seats: 5, features: [], status: 'active', stripeSubscriptionId: null, stripeCustomerId: null, graceUntil: null, lastPaymentFailedAt: null, lastStripeEventAt: null };
    },
    findByCustomerId: id => prisma.subscription.findFirst({ where: { stripeCustomerId: id }, select: SUB_SELECT }) as Promise<ExistingSubRow | null>,
    retrieveSubscription: id => stripe.subscriptions.retrieve(id),
    cancelSubscription: async id => { await stripe.subscriptions.cancel(id, { prorate: true }); },
    saveSubscription: async (orgId, data) => {
      await prisma.subscription.upsert({ where: { orgId }, create: { orgId, ...(data as any) }, update: data as any });
    },
    saveIfCurrentSubscription: async (orgId, subId, data) => {
      const r = await prisma.subscription.updateMany({ where: { orgId, stripeSubscriptionId: subId }, data: data as any });
      return r.count > 0;
    },
    getSeatsUsed: orgId => getBillableSeatCount(orgId),
    gracePeriodDays,
    now: new Date(),
    log: msg => console.warn(msg),
  };
}

export async function handleWebhook(req: Request, res: Response, next: NextFunction) {
  let claimedId: string | null = null;
  try {
    const sig = req.headers['stripe-signature'] as string;
    let event: any;
    try {
      event = verifyStripeWebhook(req.body as Buffer, sig);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }

    // LIC-9: Stripe retries and may deliver the same event twice — claim the
    // id first; a duplicate hits the primary key and is acknowledged untouched.
    try {
      await prisma.stripeEvent.create({ data: { id: event.id, type: event.type, createdAt: new Date((event.created ?? 0) * 1000) } });
      claimedId = event.id;
    } catch (e: any) {
      if (e?.code === 'P2002') return res.json({ received: true, duplicate: true });
      throw e;
    }

    const cfg = await getPricingConfig();
    const result = await processStripeEvent(event, prismaWebhookDeps(cfg.gracePeriodDays));
    if (result.orgId) invalidateLicenseCache(result.orgId);
    if (result.action !== 'applied' && result.note) console.log(`[billing] ${event.type} ${event.id}: ${result.action} — ${result.note}`);

    // Keep the dedupe table small; Stripe stops retrying after 3 days.
    prisma.stripeEvent.deleteMany({ where: { processedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } }).catch(() => {});
    res.json({ received: true });
  } catch (err) {
    // Release the claim so Stripe's retry gets processed instead of skipped.
    if (claimedId) await prisma.stripeEvent.delete({ where: { id: claimedId } }).catch(() => {});
    next(err);
  }
}
