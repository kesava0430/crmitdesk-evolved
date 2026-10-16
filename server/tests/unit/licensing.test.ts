/**
 * Licensing / pricing / Stripe-webhook logic (audit 2026-10-13, LIC-21).
 *
 * Everything here is pure: evaluateLicense() decides what an org may do,
 * computeQuote()/mergePricing() decide what it pays, and processStripeEvent()
 * decides what a webhook writes — the last one with its database and Stripe
 * calls replaced by an in-memory fake (see FakeStore below), driven by
 * fixture events shaped like Stripe's.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  evaluateLicense, consumesNewSeat, isOverQuota, resolveAiTokenLimit, resolveSendQuota, planFeaturesFor,
  type SubRow,
} from '../../src/utils/licensing';
import { computeQuote, mergePricing, DEFAULT_PRICING, normaliseModules, pricingCatalogue } from '../../src/utils/pricing';
import { verifyStripeWebhook, encodeStripeParams, PLANS } from '../../src/utils/stripe';
import {
  processStripeEvent, subscriptionFieldsFromStripe, buildSubscriptionUpdate, idempotencyKey, checkoutExtras,
  isStaleEvent, parseLicenceMetadata, type WebhookDeps, type ExistingSubRow,
} from '../../src/modules/billing/billingLogic';

const NOW = new Date('2026-10-13T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

function sub(over: Partial<SubRow> = {}): SubRow {
  return {
    orgId: 'org1', plan: 'PRO', status: 'active', seats: 25, features: [], interval: 'month',
    currentPeriodEnd: days(20), graceUntil: null, cancelAtPeriodEnd: false, storageQuotaOverrideGb: null,
    stripeSubscriptionId: 'sub_1', ...over,
  };
}

// ─── evaluateLicense ─────────────────────────────────────────────────────────

test('evaluateLicense: FREE gets 5 seats and the core areas, even if the row says otherwise', () => {
  const lic = evaluateLicense(sub({ plan: 'FREE', seats: 40, stripeSubscriptionId: null }), NOW);
  assert.equal(lic.access, 'full');
  assert.equal(lic.seats, 5);
  assert.ok(lic.features.includes('hr_core') && lic.features.includes('attendance') && lic.features.includes('payroll'));
  assert.ok(!lic.features.includes('ai_advanced'));
  assert.ok(!lic.features.includes('sso'));
});

test('evaluateLicense: active PRO has Pro features; SSO stays Enterprise', () => {
  const lic = evaluateLicense(sub(), NOW);
  assert.equal(lic.access, 'full');
  assert.equal(lic.effectivePlan, 'PRO');
  assert.ok(lic.features.includes('ai_advanced'));
  assert.ok(lic.features.includes('workflow_automation'));
  assert.ok(!lic.features.includes('sso'));
  assert.ok(evaluateLicense(sub({ plan: 'ENTERPRISE' }), NOW).features.includes('sso'));
});

test('evaluateLicense: CUSTOM = base areas + purchased modules, storage only with hosted_storage', () => {
  const lic = evaluateLicense(sub({ plan: 'CUSTOM', seats: 12, features: ['workflow_automation', 'hosted_storage'] }), NOW);
  assert.equal(lic.seats, 12);
  assert.ok(lic.features.includes('workflow_automation'));
  assert.ok(lic.features.includes('hr_core'), 'custom licences keep HR (base area)');
  assert.ok(!lic.features.includes('ai_advanced'));
  assert.equal(lic.storageQuotaGB, DEFAULT_PRICING.customStorageGb);
  assert.ok(!(lic.features as string[]).includes('hosted_storage'), 'hosted_storage is a quota, not a feature key');
});

test('evaluateLicense: past_due inside the grace window keeps paid features', () => {
  const lic = evaluateLicense(sub({ status: 'past_due', graceUntil: days(3) }), NOW);
  assert.equal(lic.access, 'grace');
  assert.ok(lic.features.includes('ai_advanced'));
});

test('evaluateLicense: past_due after graceUntil lapses to Free limits (existing users untouched)', () => {
  const lic = evaluateLicense(sub({ status: 'past_due', graceUntil: days(-1) }), NOW);
  assert.equal(lic.access, 'lapsed');
  assert.equal(lic.effectivePlan, 'FREE');
  assert.equal(lic.seats, 5);
  assert.ok(lic.features.includes('hr_core'), 'lapsed orgs keep the core areas');
});

test('evaluateLicense: past_due without graceUntil does NOT get grace from an advanced period end (LIC-6)', () => {
  // Renewal failed 10 days ago; Stripe already moved current_period_end a month ahead.
  const lic = evaluateLicense(sub({ status: 'past_due', currentPeriodEnd: days(20), lastPaymentFailedAt: days(-10) }), NOW);
  assert.equal(lic.access, 'lapsed');
  const fresh = evaluateLicense(sub({ status: 'past_due', currentPeriodEnd: days(20), lastPaymentFailedAt: days(-2) }), NOW);
  assert.equal(fresh.access, 'grace');
});

test('evaluateLicense: canceled / unpaid are lapsed immediately', () => {
  for (const status of ['canceled', 'unpaid', 'incomplete_expired', 'paused']) {
    assert.equal(evaluateLicense(sub({ status }), NOW).access, 'lapsed', status);
  }
});

test('evaluateLicense: Stripe-managed with a long-stale period end lapses', () => {
  assert.equal(evaluateLicense(sub({ currentPeriodEnd: days(-30) }), NOW).access, 'lapsed');
  assert.equal(evaluateLicense(sub({ currentPeriodEnd: days(-3) }), NOW).access, 'full', 'within grace days');
});

test('evaluateLicense: manual licence ignores currentPeriodEnd and expires only on manualExpiresAt (LIC-20)', () => {
  const seeded = sub({ plan: 'ENTERPRISE', stripeSubscriptionId: null, currentPeriodEnd: days(-60) });
  assert.equal(evaluateLicense(seeded, NOW).access, 'full', 'seeded / comped orgs no longer drop to Free');
  assert.equal(evaluateLicense({ ...seeded, manualExpiresAt: days(5) }, NOW).access, 'full');
  const expired = evaluateLicense({ ...seeded, manualExpiresAt: days(-1) }, NOW);
  assert.equal(expired.access, 'lapsed');
  assert.match(expired.reason!, /expired/);
});

test('evaluateLicense: operator overrides apply on top, including on a lapsed org (LIC-7)', () => {
  const comp = { seatsOverride: 40, extraFeatures: ['sso', 'not_a_feature'] };
  const active = evaluateLicense(sub(comp), NOW);
  assert.equal(active.seats, 40);
  assert.ok(active.features.includes('sso'));
  assert.ok(!(active.features as string[]).includes('not_a_feature'));
  const lapsed = evaluateLicense(sub({ ...comp, status: 'canceled' }), NOW);
  assert.equal(lapsed.seats, 40);
  assert.ok(lapsed.features.includes('sso'));
  const free = evaluateLicense(sub({ plan: 'FREE', seatsOverride: 8, stripeSubscriptionId: null }), NOW);
  assert.equal(free.seats, 8, 'a FREE comp goes through seatsOverride');
});

test('evaluateLicense: unknown plan fails safe to FREE', () => {
  const lic = evaluateLicense(sub({ plan: 'PLATINUM' }), NOW);
  assert.equal(lic.effectivePlan, 'FREE');
  assert.ok(!lic.features.includes('ai_advanced'));
});

test('evaluateLicense: operator plan→feature mapping is honoured (LIC-8)', () => {
  const cfg = mergePricing({ planFeatures: { FREE: ['hr_core'], PRO: ['ai_advanced', 'sso'] } });
  // Only the pre-catalogue keys are governed by this (old-style) override; the
  // area keys added later follow their default (see modules.test.ts).
  const legacy = ['ai_advanced', 'workflow_automation', 'customer_portal', 'advanced_analytics', 'custom_branding', 'sso', 'directory_sync', 'api_access', 'custom_modules', 'hr_core', 'payroll', 'attendance', 'campaigns'];
  assert.deepEqual(evaluateLicense(sub({ plan: 'FREE', stripeSubscriptionId: null }), NOW, cfg).features.filter(f => legacy.includes(f)), ['hr_core']);
  const pro = evaluateLicense(sub(), NOW, cfg);
  assert.ok(pro.features.includes('sso'));
  assert.ok(!pro.features.includes('attendance'));
  assert.deepEqual(planFeaturesFor('ENTERPRISE', cfg), DEFAULT_PRICING.planFeatures.ENTERPRISE);
});

test('allowances: defaults are unlimited, so deploying changes nothing', () => {
  for (const p of ['FREE', 'PRO', 'ENTERPRISE', 'CUSTOM'] as const) {
    assert.equal(DEFAULT_PRICING.aiTokensMonthly[p], null);
    assert.equal(DEFAULT_PRICING.platformEmailMonthly[p], null);
    assert.equal(DEFAULT_PRICING.platformWhatsAppMonthly[p], null);
  }
  const lic = evaluateLicense(sub({ plan: 'FREE', stripeSubscriptionId: null }), NOW);
  assert.equal(lic.aiTokensMonthly, null);
  assert.equal(lic.platformEmailMonthly, null);
});

test('allowances: AI tokens and platform sends resolve override → plan default (LIC-18/19)', () => {
  const cfg = mergePricing({ aiTokensMonthly: { FREE: 500_000 }, platformEmailMonthly: { FREE: 500, PRO: 5000 } });
  assert.equal(resolveAiTokenLimit(null, 'FREE', cfg), 500_000);
  assert.equal(resolveAiTokenLimit(null, 'ENTERPRISE', cfg), null, 'unset plan stays unlimited');
  assert.equal(resolveAiTokenLimit(0, 'FREE', cfg), null, '0 override = explicitly unlimited');
  assert.equal(resolveAiTokenLimit(1234, 'FREE', cfg), 1234);
  assert.equal(resolveSendQuota(null, cfg.platformEmailMonthly, 'PRO'), 5000);
  assert.equal(resolveSendQuota(0, cfg.platformEmailMonthly, 'PRO'), 0);
  const lic = evaluateLicense(sub({ status: 'canceled', platformWhatsAppQuotaMonthly: 77 }), NOW, cfg);
  assert.equal(lic.platformWhatsAppMonthly, 77);
  assert.equal(lic.platformEmailMonthly, 500, 'lapsed org gets Free allowances');
  assert.equal(isOverQuota(10, null), false);
  assert.equal(isOverQuota(9, 10), false);
  assert.equal(isOverQuota(10, 10), true);
});

// ─── Seat transitions (LIC-2) ────────────────────────────────────────────────

test('consumesNewSeat: only changes that newly make someone billable', () => {
  const t = (wasActive: boolean, wasRole: string | null, willBeActive: boolean, willBeRole: string) =>
    consumesNewSeat({ wasActive, wasRole, willBeActive, willBeRole });
  assert.equal(t(false, null, true, 'SALES_REP'), true, 'new billable user');
  assert.equal(t(false, null, true, 'EMPLOYEE'), false, 'new employee is free');
  assert.equal(t(true, 'EMPLOYEE', true, 'IT_AGENT'), true, 'promotion from Employee');
  assert.equal(t(false, 'IT_AGENT', true, 'IT_AGENT'), true, 'reactivating a billable user');
  assert.equal(t(false, 'EMPLOYEE', true, 'EMPLOYEE'), false, 'reactivating an employee');
  assert.equal(t(true, 'SALES_REP', true, 'CRM_MANAGER'), false, 'lateral move');
  assert.equal(t(true, 'IT_AGENT', true, 'EMPLOYEE'), false, 'demotion');
  assert.equal(t(true, 'IT_AGENT', false, 'IT_AGENT'), false, 'deactivation');
  assert.equal(t(false, 'EMPLOYEE', true, 'SUPER_ADMIN'), true, 'reactivate + promote');
});

// ─── Pricing ─────────────────────────────────────────────────────────────────

test('computeQuote: base + modules per seat, volume discount, yearly months', () => {
  const cfg = mergePricing({ baseSeatPriceCents: 800, modules: [{ key: 'workflow_automation', pricePerSeatCents: 400 }], volumeTiers: [{ minSeats: 50, discountPct: 10 }], yearlyMonthsCharged: 10 });
  const q = computeQuote({ seats: 10, modules: ['workflow_automation'], interval: 'month' }, cfg);
  assert.equal(q.perSeatMonthlyCents, 1200);
  assert.equal(q.totalPerIntervalCents, 12_000);
  assert.equal(q.currency, cfg.currency);
  const big = computeQuote({ seats: 50, modules: ['workflow_automation'], interval: 'year' }, cfg);
  assert.equal(big.volumeDiscountPct, 10);
  assert.equal(big.unitAmountPerIntervalCents, 1080 * 10);
  assert.equal(big.totalPerIntervalCents, 1080 * 10 * 50);
  assert.equal(big.intervalSavingCents, 1080 * 50 * 12 - 1080 * 10 * 50);
});

test('computeQuote: seats are clamped to the configured bounds and unknown modules dropped', () => {
  const cfg = mergePricing({ minSeats: 3, maxSeats: 20 });
  assert.equal(computeQuote({ seats: 1, modules: [], interval: 'month' }, cfg).seats, 3);
  assert.equal(computeQuote({ seats: 999, modules: [], interval: 'month' }, cfg).seats, 20);
  assert.deepEqual(computeQuote({ seats: 5, modules: ['bogus', 'ai_advanced'], interval: 'month' }, cfg).modules, ['ai_advanced']);
});

test('mergePricing: sanitises overrides and keeps defaults for blanks', () => {
  const cfg = mergePricing({
    currency: 'INR', trialDays: 14, planPrices: { PRO: -5 } as any, gracePeriodDays: 9999,
    platformEmailMonthly: { FREE: null, PRO: 12.6 } as any,
    planFeatures: { FREE: ['hr_core', 'nonsense', 'hr_core'] },
  });
  assert.equal(cfg.currency, 'inr');
  assert.equal(cfg.trialDays, 14);
  assert.equal(cfg.planPrices.PRO, 0);
  assert.equal(cfg.planPrices.ENTERPRISE, DEFAULT_PRICING.planPrices.ENTERPRISE);
  assert.equal(cfg.gracePeriodDays, 365);
  assert.equal(cfg.platformEmailMonthly.FREE, null, 'null = unlimited is preserved');
  assert.equal(cfg.platformEmailMonthly.PRO, 13);
  assert.equal(cfg.platformEmailMonthly.ENTERPRISE, DEFAULT_PRICING.platformEmailMonthly.ENTERPRISE);
  assert.deepEqual(cfg.planFeatures.FREE, ['hr_core', 'crm', 'sales_docs', 'itdesk', 'assets', 'knowledge_base'], 'deduped, unknown dropped; keys newer than the override follow their default');
  assert.deepEqual(cfg.planFeatures.PRO, DEFAULT_PRICING.planFeatures.PRO);
  assert.equal(mergePricing({ currency: 'dollars' }).currency, DEFAULT_PRICING.currency);
});

test('pricing: Enterprise-tier modules are not sold à la carte by default (LIC-3)', () => {
  const cat = pricingCatalogue(DEFAULT_PRICING);
  const keys = cat.modules.map(m => m.key);
  assert.ok(!keys.includes('custom_branding'));
  assert.ok(!keys.includes('sso'));
  assert.ok(keys.includes('workflow_automation'));
  // …but an org that already licensed one keeps it.
  assert.deepEqual(normaliseModules(['custom_branding']), ['custom_branding']);
  const enabled = pricingCatalogue(mergePricing({ modules: [{ key: 'custom_branding', enabled: true }] }));
  assert.ok(enabled.modules.some(m => m.key === 'custom_branding'));
});

// ─── Stripe REST encoding & signatures ───────────────────────────────────────

test('encodeStripeParams: nested items / price_data use Stripe bracket notation', () => {
  const body = decodeURIComponent(encodeStripeParams({
    items: [{ id: 'si_1', quantity: 3, price_data: { currency: 'usd', product: 'prod_1', unit_amount: 500, recurring: { interval: 'month' } } }],
    proration_behavior: 'create_prorations', cancel_at_period_end: false,
  }));
  assert.match(body, /items\[0\]\[id\]=si_1/);
  assert.match(body, /items\[0\]\[price_data\]\[recurring\]\[interval\]=month/);
  assert.match(body, /items\[0\]\[price_data\]\[product\]=prod_1/);
  assert.match(body, /proration_behavior=create_prorations/);
  assert.match(body, /cancel_at_period_end=false/);
});

function sign(payload: string, secret: string, t: number) {
  return crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
}

test('verifyStripeWebhook: accepts any matching v1, rejects old and future timestamps (LIC-25)', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1' });
  const now = NOW.getTime();
  const t = Math.floor(now / 1000);
  const good = sign(payload, secret, t);
  const header = `t=${t},v1=${'0'.repeat(64)},v1=${good}`;
  assert.equal(verifyStripeWebhook(Buffer.from(payload), header, now, secret).id, 'evt_1');
  assert.throws(() => verifyStripeWebhook(Buffer.from(payload), `t=${t},v1=${'0'.repeat(64)}`, now, secret), /mismatch/);
  const old = t - 301;
  assert.throws(() => verifyStripeWebhook(Buffer.from(payload), `t=${old},v1=${sign(payload, secret, old)}`, now, secret), /tolerance/);
  const future = t + 301;
  assert.throws(() => verifyStripeWebhook(Buffer.from(payload), `t=${future},v1=${sign(payload, secret, future)}`, now, secret), /tolerance/);
  assert.throws(() => verifyStripeWebhook(Buffer.from(payload), '', now, secret));
});

// ─── In-place update params (LIC-1) ──────────────────────────────────────────

test('buildSubscriptionUpdate: swaps the price on the EXISTING item, prorates, updates metadata', () => {
  const stripeSub = { id: 'sub_1', items: { data: [{ id: 'si_42', quantity: 1 }] } };
  const p = buildSubscriptionUpdate(stripeSub, 'org1', {
    plan: 'ENTERPRISE', seats: 999, interval: 'year', features: [], unitAmount: 149_000, quantity: 1, currency: 'usd',
  }, 'prod_ent');
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].id, 'si_42', 'no second subscription item / subscription');
  assert.equal(p.items[0].price_data.product, 'prod_ent');
  assert.equal(p.items[0].price_data.recurring.interval, 'year');
  assert.equal(p.proration_behavior, 'create_prorations');
  assert.equal(p.metadata.plan, 'ENTERPRISE');
  assert.equal(p.metadata.orgId, 'org1');
  assert.equal(p.metadata.amountCents, '149000');
  assert.throws(() => buildSubscriptionUpdate({ items: { data: [] } }, 'org1', { plan: 'PRO', seats: 25, interval: 'month', features: [], unitAmount: 1, quantity: 1, currency: 'usd' }, 'p'));
});

test('idempotencyKey: same request in the same window → same key; new window or params → new key', () => {
  const t = NOW.getTime();
  assert.equal(idempotencyKey('x', { a: 1 }, t), idempotencyKey('x', { a: 1 }, t + 1000));
  assert.notEqual(idempotencyKey('x', { a: 1 }, t), idempotencyKey('x', { a: 2 }, t));
  assert.notEqual(idempotencyKey('x', { a: 1 }, t), idempotencyKey('x', { a: 1 }, t + 10 * 60_000));
});

test('checkoutExtras: address + tax id always, automatic tax and trial only when configured', () => {
  const a = checkoutExtras({ automaticTax: false, trialDays: 14, eligibleForTrial: true });
  assert.equal(a.billing_address_collection, 'required');
  assert.deepEqual(a.tax_id_collection, { enabled: true });
  assert.equal((a as any).automatic_tax, undefined);
  assert.equal(a.trialDays, 14);
  assert.equal(checkoutExtras({ automaticTax: true, trialDays: 14, eligibleForTrial: false }).trialDays, 0);
  assert.deepEqual((checkoutExtras({ automaticTax: true, trialDays: 0, eligibleForTrial: true }) as any).automatic_tax, { enabled: true });
});

// ─── Webhook processing (LIC-9 / LIC-6 / LIC-24) ─────────────────────────────

class FakeStore {
  rows = new Map<string, ExistingSubRow & Record<string, any>>();
  saves: { orgId: string; data: Record<string, any> }[] = [];
  cancelled: string[] = [];
  stripeSubs = new Map<string, any>();

  constructor(rows: (Partial<ExistingSubRow> & { orgId: string })[] = []) {
    for (const r of rows) this.rows.set(r.orgId, {
      plan: 'FREE', seats: 5, features: [], status: 'active', stripeSubscriptionId: null, stripeCustomerId: null,
      graceUntil: null, lastPaymentFailedAt: null, lastStripeEventAt: null, ...r,
    });
  }

  deps(over: Partial<WebhookDeps> = {}): WebhookDeps {
    const all = () => [...this.rows.values()];
    return {
      findByStripeSubscriptionId: async id => all().find(r => r.stripeSubscriptionId === id) ?? null,
      findByOrgId: async orgId => this.rows.get(orgId) ?? null,
      findByCustomerId: async id => all().find(r => r.stripeCustomerId === id) ?? null,
      retrieveSubscription: async id => this.stripeSubs.get(id) ?? null,
      cancelSubscription: async id => { this.cancelled.push(id); },
      saveSubscription: async (orgId, data) => {
        this.saves.push({ orgId, data });
        this.rows.set(orgId, { ...(this.rows.get(orgId) as any), orgId, ...data });
      },
      saveIfCurrentSubscription: async (orgId, subId, data) => {
        const row = this.rows.get(orgId);
        if (!row || row.stripeSubscriptionId !== subId) return false;
        this.saves.push({ orgId, data });
        this.rows.set(orgId, { ...row, ...data });
        return true;
      },
      getSeatsUsed: async () => 3,
      gracePeriodDays: 7,
      now: NOW,
      log: () => {},
      ...over,
    };
  }
}

const proMeta = { orgId: 'org1', plan: 'PRO', seats: '25', interval: 'month', features: '', amountCents: '4900' };

function stripeSubFixture(over: Record<string, any> = {}) {
  return {
    id: 'sub_new', object: 'subscription', status: 'active', customer: 'cus_1', cancel_at_period_end: false,
    current_period_end: sec(days(30)), trial_end: null, metadata: proMeta,
    items: { data: [{ id: 'si_1', quantity: 1, price: { unit_amount: 4900, recurring: { interval: 'month' } } }] },
    ...over,
  };
}

const evt = (type: string, object: any, createdAt = NOW, id = `evt_${Math.random().toString(36).slice(2)}`) =>
  ({ id, type, created: sec(createdAt), data: { object } });

test('webhook: checkout.session.completed (paid) retrieves the subscription and grants the plan', async () => {
  const store = new FakeStore([{ orgId: 'org1' }]);
  store.stripeSubs.set('sub_new', stripeSubFixture());
  const r = await processStripeEvent(evt('checkout.session.completed', {
    mode: 'subscription', payment_status: 'paid', subscription: 'sub_new', customer: 'cus_1', metadata: proMeta,
  }), store.deps());
  assert.equal(r.action, 'applied');
  const row = store.rows.get('org1')!;
  assert.equal(row.plan, 'PRO');
  assert.equal(row.stripeSubscriptionId, 'sub_new');
  assert.equal(row.stripeCustomerId, 'cus_1');
  assert.equal(row.seats, PLANS.PRO.seats);
  assert.equal(row.amountCents, 4900);
  assert.deepEqual(row.currentPeriodEnd, days(30), 'period end comes from the retrieved subscription');
  assert.equal(row.hadPaidSubscription, true);
});

test('webhook: checkout with payment_status unpaid grants nothing', async () => {
  const store = new FakeStore([{ orgId: 'org1' }]);
  store.stripeSubs.set('sub_new', stripeSubFixture());
  const r = await processStripeEvent(evt('checkout.session.completed', {
    mode: 'subscription', payment_status: 'unpaid', subscription: 'sub_new', customer: 'cus_1', metadata: proMeta,
  }), store.deps());
  assert.equal(r.action, 'ignored');
  assert.equal(store.saves.length, 0);
});

test('webhook: a second subscription at checkout cancels the superseded one (no double billing)', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'PRO', stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1' }]);
  store.stripeSubs.set('sub_new', stripeSubFixture({ metadata: { ...proMeta, plan: 'ENTERPRISE', seats: '999' } }));
  await processStripeEvent(evt('checkout.session.completed', {
    mode: 'subscription', payment_status: 'paid', subscription: 'sub_new', customer: 'cus_1', metadata: { ...proMeta, plan: 'ENTERPRISE' },
  }), store.deps());
  assert.deepEqual(store.cancelled, ['sub_old']);
  assert.equal(store.rows.get('org1')!.stripeSubscriptionId, 'sub_new');
  assert.equal(store.rows.get('org1')!.plan, 'ENTERPRISE');
});

test('webhook: the new subscription is saved BEFORE the old one is cancelled, and its deleted event is a no-op (L1)', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'PRO', stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1' }]);
  store.stripeSubs.set('sub_new', stripeSubFixture({ metadata: { ...proMeta, plan: 'ENTERPRISE', seats: '999' } }));
  let idAtCancel: string | null | undefined;
  const deps = store.deps({ cancelSubscription: async () => { idAtCancel = store.rows.get('org1')!.stripeSubscriptionId; } });
  await processStripeEvent(evt('checkout.session.completed', {
    mode: 'subscription', payment_status: 'paid', subscription: 'sub_new', customer: 'cus_1', metadata: proMeta,
  }), deps);
  assert.equal(idAtCancel, 'sub_new', 'org already points at the new subscription when the old is cancelled');
  // The old subscription's deleted event, even if it races, must not downgrade.
  const r = await processStripeEvent(evt('customer.subscription.deleted', stripeSubFixture({ id: 'sub_old', status: 'canceled' })), store.deps());
  assert.notEqual(r.action, 'applied');
  assert.equal(store.rows.get('org1')!.plan, 'ENTERPRISE');
});

test('webhook: deleted is conditional on the stored id even if it changed after the lookup (L1)', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'PRO', stripeSubscriptionId: 'sub_old' }]);
  const deps = store.deps();
  const realFind = deps.findByStripeSubscriptionId;
  deps.findByStripeSubscriptionId = async id => {
    const row = await realFind(id);
    // a checkout swaps in sub_new between the lookup and the write
    store.rows.set('org1', { ...store.rows.get('org1')!, stripeSubscriptionId: 'sub_new', plan: 'ENTERPRISE' });
    return row;
  };
  const r = await processStripeEvent(evt('customer.subscription.deleted', stripeSubFixture({ id: 'sub_old', status: 'canceled' })), deps);
  assert.equal(r.action, 'ignored');
  assert.equal(store.rows.get('org1')!.plan, 'ENTERPRISE');
});

test('webhook: subscription.created before checkout completes is adopted via metadata.orgId', async () => {
  const store = new FakeStore([{ orgId: 'org1' }]);
  const r = await processStripeEvent(evt('customer.subscription.created', stripeSubFixture()), store.deps());
  assert.equal(r.action, 'applied');
  assert.equal(store.rows.get('org1')!.stripeSubscriptionId, 'sub_new');
  assert.equal(store.rows.get('org1')!.plan, 'PRO');
});

test('webhook: an update for a subscription that is not the org\'s current one is ignored', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'ENTERPRISE', stripeSubscriptionId: 'sub_current' }]);
  const r = await processStripeEvent(evt('customer.subscription.updated', stripeSubFixture({ id: 'sub_orphan' })), store.deps());
  assert.equal(r.action, 'ignored');
  assert.equal(store.rows.get('org1')!.plan, 'ENTERPRISE');
});

test('webhook: past_due starts the grace clock now, not from current_period_end (LIC-6)', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'PRO', stripeSubscriptionId: 'sub_new' }]);
  await processStripeEvent(evt('customer.subscription.updated', stripeSubFixture({ status: 'past_due', current_period_end: sec(days(30)) })), store.deps());
  const row = store.rows.get('org1')!;
  assert.equal(row.status, 'past_due');
  assert.deepEqual(row.graceUntil, days(7));
  // Back to active clears it.
  await processStripeEvent(evt('customer.subscription.updated', stripeSubFixture(), days(0.01)), store.deps());
  assert.equal(store.rows.get('org1')!.graceUntil, null);
});

test('webhook: out-of-order (older) events are ignored', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'ENTERPRISE', stripeSubscriptionId: 'sub_new', lastStripeEventAt: NOW }]);
  const r = await processStripeEvent(evt('customer.subscription.updated', stripeSubFixture(), days(-1)), store.deps());
  assert.equal(r.action, 'stale');
  assert.equal(store.saves.length, 0);
  assert.equal(isStaleEvent(sec(NOW), NOW), false, 'same second is not stale');
});

test('webhook: CUSTOM seat quantity from the portal updates seats; amount = unit × qty (LIC-24)', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'CUSTOM', seats: 10, stripeSubscriptionId: 'sub_c' }]);
  const logs: string[] = [];
  await processStripeEvent(evt('customer.subscription.updated', stripeSubFixture({
    id: 'sub_c', metadata: { orgId: 'org1', plan: 'CUSTOM', seats: '10', interval: 'month', features: 'workflow_automation', amountCents: '12000' },
    items: { data: [{ id: 'si_c', quantity: 2, price: { unit_amount: 1200, recurring: { interval: 'month' } } }] },
  })), store.deps({ log: m => logs.push(m) }));
  const row = store.rows.get('org1')!;
  assert.equal(row.seats, 2);
  assert.equal(row.amountCents, 2400);
  assert.deepEqual(row.features, ['workflow_automation']);
  assert.ok(logs.some(l => /in use/.test(l)), 'seat reduction below usage is flagged');
});

test('webhook: subscription.deleted resets to Free but keeps the customer', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'PRO', stripeSubscriptionId: 'sub_new', stripeCustomerId: 'cus_1' }]);
  await processStripeEvent(evt('customer.subscription.deleted', stripeSubFixture({ status: 'canceled' })), store.deps());
  const row = store.rows.get('org1')!;
  assert.equal(row.plan, 'FREE');
  assert.equal(row.stripeSubscriptionId, null);
  assert.equal(row.stripeCustomerId, 'cus_1');
  // A late "updated" for the dead subscription must not re-grant anything.
  const r = await processStripeEvent(evt('customer.subscription.updated', stripeSubFixture({ status: 'canceled' }), days(-0.5)), store.deps());
  assert.notEqual(r.action, 'applied');
  assert.equal(store.rows.get('org1')!.plan, 'FREE');
});

test('webhook: invoice.payment_failed keeps an already-running grace deadline', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'PRO', stripeSubscriptionId: 'sub_new', graceUntil: days(2) }]);
  await processStripeEvent(evt('invoice.payment_failed', { subscription: 'sub_new' }), store.deps());
  const row = store.rows.get('org1')!;
  assert.equal(row.status, 'past_due');
  assert.deepEqual(row.graceUntil, days(2));
  assert.deepEqual(row.lastPaymentFailedAt, NOW);
});

test('webhook: invoice.paid (newer API shape) reactivates; the total goes to lastInvoiceAmountCents', async () => {
  const store = new FakeStore([{ orgId: 'org1', plan: 'PRO', status: 'past_due', stripeSubscriptionId: 'sub_new', graceUntil: days(2) }]);
  await processStripeEvent(evt('invoice.paid', {
    parent: { subscription_details: { subscription: 'sub_new' } }, amount_paid: 5782,
    lines: { data: [{ period: { end: sec(days(31)) } }] },
  }), store.deps());
  const row = store.rows.get('org1')!;
  assert.equal(row.status, 'active');
  assert.equal(row.graceUntil, null);
  assert.equal(row.lastInvoiceAmountCents, 5782);
  assert.equal(row.amountCents, undefined, 'recurring amount is not overwritten by an invoice total');
  assert.deepEqual(row.currentPeriodEnd, days(31));
});

test('webhook: first invoice.paid before checkout completes adopts the subscription', async () => {
  const store = new FakeStore([{ orgId: 'org1' }]);
  store.stripeSubs.set('sub_new', stripeSubFixture());
  const r = await processStripeEvent(evt('invoice.paid', {
    subscription: 'sub_new', customer: 'cus_1', amount_paid: 4900, subscription_details: { metadata: proMeta },
  }), store.deps());
  assert.equal(r.action, 'applied');
  assert.equal(store.rows.get('org1')!.plan, 'PRO');
});

test('subscriptionFieldsFromStripe: period end from items (basil), trial end, plan from metadata', () => {
  const f = subscriptionFieldsFromStripe({
    id: 'sub_t', status: 'trialing', customer: { id: 'cus_9' }, trial_end: sec(days(14)), metadata: { ...proMeta, plan: 'ENTERPRISE' },
    items: { data: [{ id: 'si', quantity: 1, current_period_end: sec(days(14)), price: { unit_amount: 14900, recurring: { interval: 'month' } } }] },
  }, null, { now: NOW, gracePeriodDays: 7 });
  assert.deepEqual(f.currentPeriodEnd, days(14));
  assert.deepEqual(f.trialEndsAt, days(14));
  assert.equal(f.plan, 'ENTERPRISE');
  assert.equal(f.seats, PLANS.ENTERPRISE.seats);
  assert.equal(f.stripeCustomerId, 'cus_9');
  assert.equal(parseLicenceMetadata({ plan: 'FREE' }), null);
});
