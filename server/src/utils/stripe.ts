import https from 'https';
import crypto from 'crypto';

// ─── Low-level Stripe REST helpers ────────────────────────────────────────────
//
// No Stripe SDK: a small form-encoded wrapper over https, pinned to one API
// version so response shapes (top-level current_period_end etc.) are stable.

export const STRIPE_API_VERSION = '2024-06-20';

/** Online payments need both keys: the secret to call Stripe, the webhook
 *  secret so payments actually reach the Subscription row. With either
 *  missing, checkout would take money we can never record. */
export function isBillingEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_WEBHOOK_SECRET;
}

export class StripeApiError extends Error {
  constructor(message: string, public statusCode: number, public code?: string, public type?: string) {
    super(message);
  }
}

interface StripeRequestOptions {
  /** Stripe dedupes POSTs carrying the same key for 24h — a retried or
   *  double-clicked request returns the first result instead of acting twice. */
  idempotencyKey?: string;
}

function stripeRequest<T = any>(method: string, path: string, body?: Record<string, any>, opts: StripeRequestOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) return reject(new Error('STRIPE_SECRET_KEY not configured'));

    const params = body ? encodeStripeParams(body) : '';
    // GET/DELETE carry their params in the query string; Stripe ignores a body there.
    const inQuery = method === 'GET' || method === 'DELETE';
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${apiKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
    if (!inQuery) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(params);
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const reqOpts: https.RequestOptions = {
      hostname: 'api.stripe.com',
      port: 443,
      path: `/v1${path}${inQuery && params ? `?${params}` : ''}`,
      method,
      headers,
    };

    const req = https.request(reqOpts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new StripeApiError(json.error.message, res.statusCode || 500, json.error.code, json.error.type));
          resolve(json as T);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (params && !inQuery) req.write(params);
    req.end();
  });
}

/** Form-encode for Stripe: `{ items: [{ price_data: { unit_amount: 5 } }] }` →
 *  `items[0][price_data][unit_amount]=5`. Exported for unit tests. */
export function encodeStripeParams(body: Record<string, any>): string {
  return new URLSearchParams(flattenStripeParams(body)).toString();
}

// Flatten nested objects for Stripe's form encoding: { line_items: [{ price_data: { ... } }] }
export function flattenStripeParams(obj: Record<string, any>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          Object.assign(result, flattenStripeParams(item, `${fullKey}[${i}]`));
        } else {
          result[`${fullKey}[${i}]`] = String(item);
        }
      });
    } else if (typeof value === 'object' && value !== null) {
      Object.assign(result, flattenStripeParams(value, fullKey));
    } else if (value !== undefined && value !== null) {
      result[fullKey] = String(value);
    }
  }
  return result;
}

// ─── Stripe API surface ───────────────────────────────────────────────────────

type PriceData = {
  currency: string;
  unit_amount: number;
  recurring: { interval: 'month' | 'year' };
};

export interface SubscriptionItemChange {
  /** Existing subscription item id (si_…) — replacing its price keeps ONE
   *  subscription instead of opening a second one. */
  id: string;
  quantity: number;
  /** Subscription items take `product` (an id), not inline product_data. */
  price_data: PriceData & { product: string };
}

export const stripe = {
  customers: {
    create: (params: { email: string; name: string; metadata?: Record<string, string> }, opts?: StripeRequestOptions) =>
      stripeRequest('POST', '/customers', params, opts),
    retrieve: (id: string) => stripeRequest('GET', `/customers/${id}`),
  },
  products: {
    create: (params: { name: string; description?: string; metadata?: Record<string, string> }, opts?: StripeRequestOptions) =>
      stripeRequest('POST', '/products', params, opts),
  },
  checkout: {
    sessions: {
      create: (params: {
        success_url: string;
        cancel_url: string;
        mode: 'subscription' | 'payment';
        customer?: string;
        customer_email?: string;
        line_items: (
          | { price: string; quantity: number }
          | {
              quantity: number;
              price_data: PriceData & {
                product_data: { name: string; description?: string; metadata?: Record<string, string> };
              };
            }
        )[];
        subscription_data?: { metadata?: Record<string, string>; trial_period_days?: number };
        allow_promotion_codes?: boolean;
        metadata?: Record<string, string>;
        billing_address_collection?: 'auto' | 'required';
        tax_id_collection?: { enabled: boolean };
        automatic_tax?: { enabled: boolean };
        /** Required with tax_id_collection / automatic_tax when `customer` is passed. */
        customer_update?: { address?: 'auto' | 'never'; name?: 'auto' | 'never' };
      }, opts?: StripeRequestOptions) => stripeRequest('POST', '/checkout/sessions', params, opts),
    },
  },
  billingPortal: {
    sessions: {
      create: (params: { customer: string; return_url: string }) =>
        stripeRequest('POST', '/billing_portal/sessions', params),
    },
  },
  subscriptions: {
    retrieve: (id: string) => stripeRequest('GET', `/subscriptions/${id}`),
    /** POST /v1/subscriptions/:id — in-place plan/seat change or cancel-at-period-end. */
    update: (id: string, params: {
      items?: SubscriptionItemChange[];
      proration_behavior?: 'create_prorations' | 'none' | 'always_invoice';
      cancel_at_period_end?: boolean;
      metadata?: Record<string, string>;
    }, opts?: StripeRequestOptions) => stripeRequest('POST', `/subscriptions/${id}`, params, opts),
    /** DELETE /v1/subscriptions/:id — immediate cancel; prorate credits unused time. */
    cancel: (id: string, params?: { prorate?: boolean; invoice_now?: boolean }) =>
      stripeRequest('DELETE', `/subscriptions/${id}`, params),
  },
};

// ─── Webhook signature verification ──────────────────────────────────────────

/** Tolerance for the signed timestamp, both directions (Stripe's own default). */
const WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifyStripeWebhook(payload: Buffer, signature: string, nowMs = Date.now(), secret = process.env.STRIPE_WEBHOOK_SECRET): any {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  if (!signature) throw new Error('Missing Stripe signature header');

  // A header can carry several v1 signatures (Stripe sends one per active
  // secret while a webhook secret is being rolled) — any match is valid.
  let timestamp: string | undefined;
  const v1: string[] = [];
  for (const part of signature.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!timestamp || v1.length === 0) throw new Error('Invalid Stripe signature header');

  const signedPayload = `${timestamp}.${payload.toString('utf8')}`;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(signedPayload).digest('hex'));
  const matched = v1.some(sig => {
    const got = Buffer.from(sig);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  if (!matched) throw new Error('Stripe webhook signature mismatch');

  // Replay protection: reject events signed too long ago — or in the future
  // (a forged/skewed timestamp must not buy itself a longer replay window).
  const diff = Math.floor(nowMs / 1000) - parseInt(timestamp, 10);
  if (!Number.isFinite(diff) || Math.abs(diff) > WEBHOOK_TOLERANCE_SECONDS) throw new Error('Stripe webhook timestamp outside the tolerance window');

  return JSON.parse(payload.toString('utf8'));
}

// ─── Plan config ─────────────────────────────────────────────────────────────

// Feature keys gated by plan (see utils/licensing.ts requireFeature()).
// Deliberately coarse-grained: 25+ distinct AI endpoints all fall under the
// single 'ai_advanced' key rather than per-endpoint keys, since the actual
// business decision was binary (Free gets core lead-scoring/ticket-sentiment/
// auto-routing/auto-tagging; everything else AI-related is Pro+), not a
// per-feature matrix. Lead scoring, ticket sentiment, auto-routing, and
// auto-tagging are NOT listed here because they're free on every plan and
// have no gate at all.
//
// The second group (hr_core … campaigns, plus sso/directory_sync) gates whole
// product areas. Their plan mapping is operator-configurable
// (PricingConfig.planFeatures, Platform Admin → Pricing); the code defaults in
// DEFAULT_PLAN_FEATURES below include every area on every plan except SSO /
// directory sync, so introducing the keys changed nothing for existing orgs.
export const FEATURE_KEYS = [
  'ai_advanced', 'workflow_automation', 'customer_portal', 'advanced_analytics', 'custom_branding',
  'sso', 'directory_sync', 'api_access', 'custom_modules', 'hr_core', 'payroll', 'attendance', 'campaigns',
  // Product areas added with the module catalogue (utils/modules.ts) so the
  // platform operator can switch CRM / IT Desk / … off per org. Every plan
  // includes them by default (CORE_AREA_FEATURES), and a saved plan mapping
  // that predates them treats them as included (utils/pricing.ts
  // mergePlanFeatures), so adding them changed nothing for existing orgs.
  'crm', 'itdesk', 'sales_docs', 'assets', 'knowledge_base',
] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];
export function isFeatureKey(v: unknown): v is FeatureKey { return typeof v === 'string' && (FEATURE_KEYS as readonly string[]).includes(v); }

/** Areas every plan includes by default (no behaviour change when they were introduced). */
export const CORE_AREA_FEATURES: FeatureKey[] = [
  'crm', 'sales_docs', 'itdesk', 'assets', 'knowledge_base',
  'hr_core', 'attendance', 'payroll', 'campaigns', 'custom_modules', 'api_access',
];

/** The keys that existed before the module catalogue. A saved operator plan
 *  mapping without a `planFeaturesKeys` list was written knowing only these;
 *  any other key in it follows the code default (see pricing.ts). Never edit. */
export const LEGACY_FEATURE_KEYS: readonly FeatureKey[] = [
  'ai_advanced', 'workflow_automation', 'customer_portal', 'advanced_analytics', 'custom_branding',
  'sso', 'directory_sync', 'api_access', 'custom_modules', 'hr_core', 'payroll', 'attendance', 'campaigns',
];
const PRO_FEATURES: FeatureKey[] = ['ai_advanced', 'workflow_automation', 'customer_portal', 'advanced_analytics'];

/** Code defaults for plan → features. CUSTOM here is the BASE every custom
 *  licence gets before its purchased modules (Subscription.features). */
export const DEFAULT_PLAN_FEATURES: Record<'FREE' | 'PRO' | 'ENTERPRISE' | 'CUSTOM', FeatureKey[]> = {
  FREE: [...CORE_AREA_FEATURES],
  PRO: [...CORE_AREA_FEATURES, ...PRO_FEATURES],
  ENTERPRISE: [...CORE_AREA_FEATURES, ...PRO_FEATURES, 'custom_branding', 'sso', 'directory_sync'],
  CUSTOM: [...CORE_AREA_FEATURES],
};

// storageQuotaGB is how much of OUR storage (the "use our hosted storage"
// option in Settings → Storage, utils/s3Storage.ts) each plan gets, in
// gigabytes. 0 means the plan can't use it at all — those orgs must bring
// their own Google Drive instead, which costs us nothing. This is entirely
// separate from BYO-Drive, which has no quota on any plan since it's the
// customer's own storage.
//
// `features` are the code defaults only — read the effective list through
// licensing.ts (evaluateLicense / planFeaturesFor), which layers the
// operator's PricingConfig.planFeatures on top.
//
// priceId (STRIPE_PRO_PRICE_ID / STRIPE_ENTERPRISE_PRICE_ID) is no longer used
// for checkout: every checkout is priced from PricingConfig.planPrices via
// price_data, so the Billing page and Stripe can never disagree (LIC-10).
export const PLANS = {
  FREE:       { name: 'Free',       seats: 5,   price: 0,    priceId: null, features: DEFAULT_PLAN_FEATURES.FREE, storageQuotaGB: 0 },
  PRO:        { name: 'Pro',        seats: 25,  price: 49,   priceId: process.env.STRIPE_PRO_PRICE_ID || '',
    features: DEFAULT_PLAN_FEATURES.PRO, storageQuotaGB: 5 },
  ENTERPRISE: { name: 'Enterprise', seats: 999, price: 149,  priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || '',
    features: DEFAULT_PLAN_FEATURES.ENTERPRISE, storageQuotaGB: 50 },
  // Self-serve custom licence: seats, features and storage are stored on the
  // Subscription row itself (built on /billing/custom, priced in utils/pricing.ts),
  // so the static config here only carries the base areas — see licensing.ts
  // evaluateLicense() for how a CUSTOM row is read.
  CUSTOM:     { name: 'Custom',     seats: 0,   price: 0,    priceId: null, features: DEFAULT_PLAN_FEATURES.CUSTOM, storageQuotaGB: 0 },
} as const;

export type PlanKey = keyof typeof PLANS;
export function isPlanKey(v: unknown): v is PlanKey { return typeof v === 'string' && v in PLANS; }
