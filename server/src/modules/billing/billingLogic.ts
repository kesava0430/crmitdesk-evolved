/**
 * Billing logic that doesn't need a database or the network: Stripe
 * parameter builders, the mapping from a Stripe subscription to our
 * Subscription row, and the webhook event processor (with its I/O injected
 * through WebhookDeps so it can be unit-tested with fixture events — see
 * tests/unit/billing.test.ts).
 *
 * billing.controller.ts wires these to Prisma and utils/stripe.ts.
 */
import crypto from 'crypto';
import { PLANS, PlanKey, isPlanKey } from '../../utils/stripe';
import { normaliseModules, BillingInterval } from '../../utils/pricing';

// ─── Licence metadata we put on Checkout sessions / subscriptions ────────────

export interface LicenceMetadata {
  plan: PlanKey;
  seats: number;
  interval: BillingInterval;
  features: string[];
  amountCents: number;
}

/** Licence fields we stash in Checkout/Subscription metadata. FREE / unknown → null. */
export function parseLicenceMetadata(md: Record<string, string> | null | undefined): LicenceMetadata | null {
  if (!md?.plan || !isPlanKey(md.plan) || md.plan === 'FREE') return null;
  const plan = md.plan;
  const seats = Math.max(1, parseInt(md.seats || '', 10) || PLANS[plan].seats || 5);
  const interval: BillingInterval = md.interval === 'year' ? 'year' : 'month';
  const features = plan === 'CUSTOM' ? normaliseModules((md.features || '').split(',')) : [];
  const amountCents = parseInt(md.amountCents || '0', 10) || 0;
  return { plan, seats, interval, features, amountCents };
}

export function licenceMetadata(orgId: string, l: LicenceMetadata): Record<string, string> {
  return {
    orgId, plan: l.plan, seats: String(l.seats), interval: l.interval,
    features: l.features.join(','), amountCents: String(l.amountCents),
  };
}

// ─── Stripe object accessors (tolerant of API-version differences) ───────────
//
// We pin Stripe-Version 2024-06-20 for our own calls, but webhook payloads are
// rendered in the endpoint's API version. From 2025-03-31 ("basil") the period
// moved onto subscription items and invoice.subscription moved under
// invoice.parent — read both shapes so a newer endpoint version can't silently
// break renewals.

const tsToDate = (s: unknown): Date | null => (typeof s === 'number' && s > 0 ? new Date(s * 1000) : null);

export function subscriptionPeriodEnd(sub: any): Date | null {
  return tsToDate(sub?.current_period_end) ?? tsToDate(sub?.items?.data?.[0]?.current_period_end);
}

export function invoiceSubscriptionId(inv: any): string | null {
  const s = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? null;
  return typeof s === 'string' ? s : s?.id ?? null;
}

export function invoiceSubscriptionMetadata(inv: any): Record<string, string> | null {
  return inv?.subscription_details?.metadata ?? inv?.parent?.subscription_details?.metadata ?? null;
}

const idOf = (v: any): string | null => (typeof v === 'string' ? v : v?.id ?? null);

// ─── Stripe subscription → Subscription row ──────────────────────────────────

export interface ExistingSubRow {
  id?: string;
  orgId: string;
  plan: string;
  seats: number;
  features: string[];
  status: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  graceUntil: Date | null;
  lastPaymentFailedAt?: Date | null;
  lastStripeEventAt: Date | null;
}

export const PAYMENT_PROBLEM_STATUSES = new Set(['past_due', 'unpaid', 'incomplete']);
export const LIVE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due']);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/**
 * Fields to write for a Stripe subscription object. Plan/features come from
 * the metadata WE set (checkout subscription_data + in-place updates); seats
 * for CUSTOM follow the Stripe quantity (portal seat changes). Operator
 * overrides live in separate columns (seatsOverride, extraFeatures, …) that
 * this never touches, so Stripe and Platform Admin no longer overwrite each
 * other (LIC-7).
 */
export function subscriptionFieldsFromStripe(
  stripeSub: any,
  existing: Pick<ExistingSubRow, 'plan' | 'graceUntil' | 'lastPaymentFailedAt'> | null,
  opts: { now: Date; gracePeriodDays: number; fallbackMetadata?: Record<string, string> | null },
): Record<string, unknown> {
  const item = stripeSub?.items?.data?.[0];
  const qty: number | undefined = typeof item?.quantity === 'number' ? item.quantity : undefined;
  const unit: number | undefined = typeof item?.price?.unit_amount === 'number' ? item.price.unit_amount : undefined;
  const recurring: string | undefined = item?.price?.recurring?.interval;
  const lic = parseLicenceMetadata(stripeSub?.metadata) ?? parseLicenceMetadata(opts.fallbackMetadata ?? null);
  const plan = lic?.plan ?? (existing && isPlanKey(existing.plan) ? existing.plan : null);
  const status: string = stripeSub?.status ?? 'active';
  const periodEnd = subscriptionPeriodEnd(stripeSub);

  const data: Record<string, unknown> = {
    stripeSubscriptionId: stripeSub.id,
    status,
    cancelAtPeriodEnd: !!stripeSub.cancel_at_period_end,
    trialEndsAt: tsToDate(stripeSub.trial_end),
    hadPaidSubscription: true,
  };
  const customer = idOf(stripeSub.customer);
  if (customer) data.stripeCustomerId = customer;
  if (periodEnd) data.currentPeriodEnd = periodEnd;
  if (lic) { data.plan = lic.plan; data.features = lic.features; }
  if (plan && plan !== 'CUSTOM' && plan !== 'FREE') data.seats = PLANS[plan].seats;
  // Seat changes made in the Stripe portal on a per-seat (CUSTOM) subscription
  if (plan === 'CUSTOM' && qty) data.seats = qty;
  else if (plan === 'CUSTOM' && lic) data.seats = lic.seats;
  if (recurring === 'month' || recurring === 'year') data.interval = recurring;
  // What Stripe actually bills per interval = list price × quantity (LIC-24:
  // never an invoice total, which includes tax / proration / discounts).
  if (unit !== undefined && qty) data.amountCents = unit * qty;
  else if (lic?.amountCents) data.amountCents = lic.amountCents;

  if (status === 'active' || status === 'trialing') {
    data.graceUntil = null;
    data.lastPaymentFailedAt = null;
  } else if (PAYMENT_PROBLEM_STATUSES.has(status) && !existing?.graceUntil) {
    // LIC-6: start the grace clock the moment Stripe reports a payment
    // problem — not from current_period_end, which Stripe has already
    // advanced on a failed renewal.
    data.graceUntil = addDays(opts.now, opts.gracePeriodDays);
    if (!existing?.lastPaymentFailedAt) data.lastPaymentFailedAt = opts.now;
  }
  return data;
}

export const FREE_RESET = {
  plan: 'FREE', status: 'active', stripeSubscriptionId: null, seats: PLANS.FREE.seats, features: [] as string[],
  interval: 'month', amountCents: 0, cancelAtPeriodEnd: false, currentPeriodEnd: null, graceUntil: null,
  lastPaymentFailedAt: null, trialEndsAt: null,
};

/** Stripe doesn't guarantee delivery order: ignore an event older than the newest one already applied. */
export function isStaleEvent(eventCreatedSec: number, lastAppliedAt: Date | null): boolean {
  if (!lastAppliedAt || typeof eventCreatedSec !== 'number') return false;
  return eventCreatedSec * 1000 < lastAppliedAt.getTime();
}

const eventTime = (event: any): Date => new Date((typeof event.created === 'number' ? event.created : Date.now() / 1000) * 1000);
const laterOf = (a: Date | null, b: Date): Date => (a && a > b ? a : b);

// ─── Webhook processing ──────────────────────────────────────────────────────

export interface WebhookDeps {
  findByStripeSubscriptionId(id: string): Promise<ExistingSubRow | null>;
  findByOrgId(orgId: string): Promise<ExistingSubRow | null>;
  findByCustomerId(customerId: string): Promise<ExistingSubRow | null>;
  retrieveSubscription(id: string): Promise<any>;
  /** Immediately cancel (with proration credit) a subscription we no longer track. */
  cancelSubscription(id: string): Promise<void>;
  /** Upsert by orgId. */
  saveSubscription(orgId: string, data: Record<string, unknown>): Promise<void>;
  /** Update only if the row's stripeSubscriptionId still equals subId; true if a row was written. */
  saveIfCurrentSubscription(orgId: string, subId: string, data: Record<string, unknown>): Promise<boolean>;
  getSeatsUsed?(orgId: string): Promise<number>;
  gracePeriodDays: number;
  now: Date;
  log?(message: string): void;
}

export interface WebhookResult {
  orgId?: string;
  action: 'applied' | 'ignored' | 'stale';
  note?: string;
}

const ignored = (note: string, orgId?: string): WebhookResult => ({ action: 'ignored', note, orgId });

/** Find our row for a Stripe subscription: by id, then metadata.orgId, then customer. */
async function locateRow(deps: WebhookDeps, subId: string | null, metadata: Record<string, string> | null, customerId: string | null) {
  if (subId) {
    const bySub = await deps.findByStripeSubscriptionId(subId);
    if (bySub) return bySub;
  }
  if (metadata?.orgId) {
    const byOrg = await deps.findByOrgId(metadata.orgId);
    if (byOrg) return byOrg;
  }
  if (customerId) return deps.findByCustomerId(customerId);
  return null;
}

/**
 * Apply one (signature-verified, not-yet-seen) Stripe event. Deduplication by
 * event id happens in the caller; ordering is handled here via
 * lastStripeEventAt.
 */
export async function processStripeEvent(event: any, deps: WebhookDeps): Promise<WebhookResult> {
  const data = event?.data?.object ?? {};
  const created: number = event?.created;
  const at = eventTime(event);

  switch (event?.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (data.mode && data.mode !== 'subscription') return ignored('not a subscription checkout');
      // Only grant once the money is in: 'unpaid' happens with delayed
      // payment methods — async_payment_succeeded follows when it clears.
      // 'no_payment_required' is a trial or a 100% promotion code.
      if (data.payment_status && data.payment_status !== 'paid' && data.payment_status !== 'no_payment_required') {
        return ignored(`payment_status ${data.payment_status}`);
      }
      const subId = idOf(data.subscription);
      if (!subId) return ignored('no subscription on session');
      const customerId = idOf(data.customer);
      const row = await locateRow(deps, null, data.metadata ?? null, customerId);
      const orgId: string | undefined = data.metadata?.orgId ?? row?.orgId;
      if (!orgId) return ignored('no orgId on session');

      // The session only carries ids — fetch the subscription for its real
      // status, period end, price and quantity.
      const stripeSub = await deps.retrieveSubscription(subId);
      if (!stripeSub || !LIVE_STRIPE_STATUSES.has(stripeSub.status)) {
        return ignored(`subscription ${subId} is ${stripeSub?.status ?? 'missing'}`, orgId);
      }

      const fields = subscriptionFieldsFromStripe(stripeSub, row, { now: deps.now, gracePeriodDays: deps.gracePeriodDays, fallbackMetadata: data.metadata });
      // Save the NEW subscription first: cancelling the old one fires
      // customer.subscription.deleted for it, which must find the org already
      // pointing at the new id (and so leave it alone) — see the deleted case.
      await deps.saveSubscription(orgId, { ...fields, ...(customerId ? { stripeCustomerId: customerId } : {}), lastStripeEventAt: laterOf(row?.lastStripeEventAt ?? null, at) });

      // A second subscription for an org that already had a live one (two
      // checkout tabs, or a session opened before in-place updates existed):
      // keep the newest and cancel the old one, so nobody is billed twice.
      if (row?.stripeSubscriptionId && row.stripeSubscriptionId !== subId) {
        try {
          await deps.cancelSubscription(row.stripeSubscriptionId);
          deps.log?.(`[billing] org ${orgId}: cancelled superseded subscription ${row.stripeSubscriptionId} in favour of ${subId}`);
        } catch (e: any) {
          deps.log?.(`[billing] org ${orgId}: FAILED to cancel superseded subscription ${row.stripeSubscriptionId}: ${e?.message} — cancel it in the Stripe dashboard`);
        }
      }
      return { action: 'applied', orgId };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const row = await locateRow(deps, data.id, data.metadata ?? null, idOf(data.customer));
      if (!row) return ignored('no matching organisation');
      if (row.stripeSubscriptionId && row.stripeSubscriptionId !== data.id) {
        // Not the subscription we track (an old/orphaned one, or a new one
        // whose checkout.session.completed hasn't arrived yet — that event
        // swaps it in). Never let it overwrite the live licence.
        return ignored(`subscription ${data.id} is not the org's current subscription`, row.orgId);
      }
      if (!row.stripeSubscriptionId && !LIVE_STRIPE_STATUSES.has(data.status)) {
        return ignored(`not adopting ${data.status} subscription`, row.orgId);
      }
      if (isStaleEvent(created, row.lastStripeEventAt)) return { action: 'stale', orgId: row.orgId };

      const fields = subscriptionFieldsFromStripe(data, row, { now: deps.now, gracePeriodDays: deps.gracePeriodDays });
      if (row.plan === 'CUSTOM' || fields.plan === 'CUSTOM') {
        const qty = data.items?.data?.[0]?.quantity;
        if (deps.getSeatsUsed && typeof qty === 'number') {
          const used = await deps.getSeatsUsed(row.orgId);
          // LIC-3: a portal seat decrease below what's in use is stored (Stripe
          // bills it) — new billable users are blocked until they match again.
          if (qty < used) deps.log?.(`[billing] org ${row.orgId}: seats reduced to ${qty} in Stripe but ${used} are in use — new billable users are blocked until within the limit`);
        }
      }
      await deps.saveSubscription(row.orgId, { ...fields, lastStripeEventAt: at });
      return { action: 'applied', orgId: row.orgId };
    }

    case 'customer.subscription.deleted': {
      const row = await deps.findByStripeSubscriptionId(data.id);
      if (!row) return ignored('subscription not tracked');
      // Conditional write: only downgrade if the org STILL points at this
      // subscription (a concurrent checkout may have just swapped in a new one).
      const applied = await deps.saveIfCurrentSubscription(row.orgId, data.id, { ...FREE_RESET, hadPaidSubscription: true, lastStripeEventAt: laterOf(row.lastStripeEventAt, at) });
      return applied ? { action: 'applied', orgId: row.orgId } : ignored('subscription was superseded', row.orgId);
    }

    case 'invoice.payment_failed': {
      const subId = invoiceSubscriptionId(data);
      const row = subId ? await deps.findByStripeSubscriptionId(subId) : null;
      if (!row) return ignored('subscription not tracked');
      if (isStaleEvent(created, row.lastStripeEventAt)) return { action: 'stale', orgId: row.orgId };
      await deps.saveSubscription(row.orgId, {
        status: 'past_due',
        lastPaymentFailedAt: deps.now,
        // Keep an already-running grace deadline; Stripe retries several times
        graceUntil: row.graceUntil ?? addDays(deps.now, deps.gracePeriodDays),
        lastStripeEventAt: at,
      });
      return { action: 'applied', orgId: row.orgId };
    }

    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const subId = invoiceSubscriptionId(data);
      if (!subId) return ignored('not a subscription invoice');
      let row = await deps.findByStripeSubscriptionId(subId);
      if (!row) {
        // First invoice can arrive before checkout.session.completed — adopt
        // the subscription now if it belongs to an org with none tracked.
        const md = invoiceSubscriptionMetadata(data);
        const candidate = await locateRow(deps, null, md, idOf(data.customer));
        if (!candidate || candidate.stripeSubscriptionId) return ignored('subscription not tracked', candidate?.orgId);
        const stripeSub = await deps.retrieveSubscription(subId);
        if (!stripeSub || !LIVE_STRIPE_STATUSES.has(stripeSub.status)) return ignored('subscription not live', candidate.orgId);
        const fields = subscriptionFieldsFromStripe(stripeSub, candidate, { now: deps.now, gracePeriodDays: deps.gracePeriodDays, fallbackMetadata: md });
        await deps.saveSubscription(candidate.orgId, { ...fields, lastInvoiceAmountCents: data.amount_paid ?? null, lastStripeEventAt: laterOf(candidate.lastStripeEventAt, at) });
        return { action: 'applied', orgId: candidate.orgId };
      }
      if (isStaleEvent(created, row.lastStripeEventAt)) return { action: 'stale', orgId: row.orgId };
      const periodEnds: number[] = (data.lines?.data ?? []).map((l: any) => l?.period?.end).filter((n: unknown) => typeof n === 'number');
      const periodEnd = periodEnds.length ? new Date(Math.max(...periodEnds) * 1000) : null;
      await deps.saveSubscription(row.orgId, {
        status: 'active',
        graceUntil: null,
        lastPaymentFailedAt: null,
        hadPaidSubscription: true,
        ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
        // LIC-24: the invoice total (tax, proration, discounts) is display-only;
        // amountCents stays the recurring list amount from the subscription.
        ...(typeof data.amount_paid === 'number' ? { lastInvoiceAmountCents: data.amount_paid } : {}),
        lastStripeEventAt: at,
      });
      return { action: 'applied', orgId: row.orgId };
    }
  }
  return ignored(`unhandled event type ${event?.type}`);
}

// ─── In-place subscription change (LIC-1) ────────────────────────────────────

export interface DesiredLicence {
  plan: Exclude<PlanKey, 'FREE'>;
  seats: number;
  interval: BillingInterval;
  features: string[];
  /** Per unit, per interval, minor units */
  unitAmount: number;
  quantity: number;
  currency: string;
}

/**
 * Parameters for POST /v1/subscriptions/:id that swap the price on the EXISTING
 * subscription item (so the customer keeps exactly one subscription) and let
 * Stripe prorate the difference.
 */
export function buildSubscriptionUpdate(stripeSub: any, orgId: string, want: DesiredLicence, productId: string) {
  const itemId: string | undefined = stripeSub?.items?.data?.[0]?.id;
  if (!itemId) throw new Error('Stripe subscription has no items to update');
  const amountCents = want.unitAmount * want.quantity;
  return {
    items: [{
      id: itemId,
      quantity: want.quantity,
      price_data: {
        currency: want.currency,
        product: productId,
        unit_amount: want.unitAmount,
        recurring: { interval: want.interval },
      },
    }],
    proration_behavior: 'create_prorations' as const,
    // Changing plan is a decision to stay — undo a pending cancellation.
    cancel_at_period_end: false,
    metadata: licenceMetadata(orgId, { plan: want.plan, seats: want.seats, interval: want.interval, features: want.features, amountCents }),
  };
}

/** Same params within a few minutes → same key, so a double click can't apply
 *  a change (and its proration) twice; a later, deliberate change gets a new key. */
export function idempotencyKey(prefix: string, payload: unknown, now = Date.now(), bucketMs = 5 * 60_000): string {
  const h = crypto.createHash('sha256').update(JSON.stringify(payload)).update(String(Math.floor(now / bucketMs))).digest('hex').slice(0, 32);
  return `${prefix}-${h}`;
}

/** Checkout options for tax / address / trial (LIC-11, LIC-12). */
export function checkoutExtras(opts: { automaticTax: boolean; trialDays: number; eligibleForTrial: boolean }) {
  return {
    billing_address_collection: 'required' as const,
    tax_id_collection: { enabled: true },
    // Stripe requires these when an existing customer is passed together with
    // tax ID collection / automatic tax: the collected name/address are saved
    // back onto that customer.
    customer_update: { address: 'auto' as const, name: 'auto' as const },
    ...(opts.automaticTax ? { automatic_tax: { enabled: true } } : {}),
    trialDays: opts.eligibleForTrial && opts.trialDays > 0 ? opts.trialDays : 0,
  };
}
