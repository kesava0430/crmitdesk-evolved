// ─── Custom licence pricing ──────────────────────────────────────────────────
//
// Fixed plans (FREE / PRO / ENTERPRISE) keep their flat monthly price and seat
// allowance in utils/stripe.ts PLANS. This file prices the self-serve CUSTOM
// licence: a per-seat base price plus a per-seat add-on for every licensed
// module, a volume discount on seat count, and a yearly discount (12 months
// for the price of YEARLY_MONTHS_CHARGED). All amounts are USD cents.

import { FeatureKey } from './stripe';

export type BillingInterval = 'month' | 'year';

export interface ModuleDef {
  key: FeatureKey | 'hosted_storage';
  name: string;
  description: string;
  /** Add-on per seat per month, in cents */
  pricePerSeatCents: number;
}

/** Everything that can be switched on in a custom licence. Each key maps to
 *  an existing gate: FeatureKeys → requireFeature(); hosted_storage → the
 *  hosted-attachment quota (assertHostedStorageAvailable). */
export const MODULES: ModuleDef[] = [
  { key: 'ai_advanced',         name: 'Advanced AI',          description: 'AI Studio, NL command bar, insights, drafting, custom AI rules & scripts', pricePerSeatCents: 1000 },
  { key: 'workflow_automation', name: 'Workflow Automation',  description: 'Create rule-based automations and triggers', pricePerSeatCents: 400 },
  { key: 'customer_portal',     name: 'Customer Portal',      description: 'Self-service portal accounts for your customers', pricePerSeatCents: 400 },
  { key: 'advanced_analytics',  name: 'Advanced Analytics',   description: 'Analytics dashboards and ticket / CRM reports', pricePerSeatCents: 400 },
  { key: 'custom_branding',     name: 'Custom Branding',      description: 'Your logo and colours on the customer portal', pricePerSeatCents: 300 },
  { key: 'hosted_storage',      name: 'Hosted Storage',       description: `${Number(process.env.LICENSE_CUSTOM_STORAGE_GB || 10)} GB of hosted attachment storage (no Google Drive needed)`, pricePerSeatCents: 200 },
];

export const MODULE_KEYS = MODULES.map(m => m.key as string);

/** Base platform price per seat per month, in cents */
export const BASE_SEAT_PRICE_CENTS = Number(process.env.LICENSE_BASE_SEAT_PRICE_CENTS || 800);
/** Hosted storage granted to a custom licence that includes hosted_storage */
export const CUSTOM_STORAGE_GB = Number(process.env.LICENSE_CUSTOM_STORAGE_GB || 10);

export const MIN_SEATS = 1;
export const MAX_SEATS = 1000;

/** Yearly billing: pay for 10 months, get 12 (≈16.7% off) */
export const YEARLY_MONTHS_CHARGED = Number(process.env.LICENSE_YEARLY_MONTHS_CHARGED || 10);

/** Volume discounts by seat count; first matching tier wins. */
export const VOLUME_TIERS: { minSeats: number; discountPct: number }[] = [
  { minSeats: 201, discountPct: 20 },
  { minSeats: 51,  discountPct: 10 },
  { minSeats: 1,   discountPct: 0 },
];

/** Days of continued paid access after a failed payment before an org is treated as FREE */
export const GRACE_PERIOD_DAYS = Number(process.env.LICENSE_GRACE_PERIOD_DAYS || 7);

export interface QuoteInput { seats: number; modules: string[]; interval: BillingInterval }

export interface QuoteLine { key: string; name: string; pricePerSeatCents: number; monthlyCents: number }

export interface Quote {
  seats: number;
  interval: BillingInterval;
  modules: string[];
  currency: 'usd';
  lines: QuoteLine[];
  perSeatMonthlyCents: number;
  subtotalMonthlyCents: number;
  volumeDiscountPct: number;
  volumeDiscountMonthlyCents: number;
  totalMonthlyCents: number;
  monthsCharged: number;
  /** Saving per interval vs paying monthly (yearly only) */
  intervalSavingCents: number;
  /** What Stripe bills per interval = unitAmountPerIntervalCents × seats */
  totalPerIntervalCents: number;
  unitAmountPerIntervalCents: number;
}

/** Dedupe, drop unknown keys, keep canonical order. */
export function normaliseModules(modules: unknown): string[] {
  const set = new Set<string>();
  if (Array.isArray(modules)) for (const m of modules) if (typeof m === 'string' && MODULE_KEYS.includes(m)) set.add(m);
  return MODULE_KEYS.filter(k => set.has(k));
}

export function volumeDiscountFor(seats: number): number {
  return VOLUME_TIERS.find(t => seats >= t.minSeats)?.discountPct ?? 0;
}

export function computeQuote(input: QuoteInput): Quote {
  const seats = Math.min(MAX_SEATS, Math.max(MIN_SEATS, Math.floor(Number(input.seats) || MIN_SEATS)));
  const interval: BillingInterval = input.interval === 'year' ? 'year' : 'month';
  const modules = normaliseModules(input.modules);

  const lines: QuoteLine[] = [
    { key: 'base', name: 'Platform base (CRM + IT Desk)', pricePerSeatCents: BASE_SEAT_PRICE_CENTS, monthlyCents: BASE_SEAT_PRICE_CENTS * seats },
    ...modules.map(k => MODULES.find(m => m.key === k)!).map(m => ({ key: m.key, name: m.name, pricePerSeatCents: m.pricePerSeatCents, monthlyCents: m.pricePerSeatCents * seats })),
  ];

  const perSeatMonthlyCents = lines.reduce((s, l) => s + l.pricePerSeatCents, 0);
  const subtotalMonthlyCents = perSeatMonthlyCents * seats;
  const volumeDiscountPct = volumeDiscountFor(seats);
  const discountedPerSeatMonthly = Math.round(perSeatMonthlyCents * (100 - volumeDiscountPct) / 100);
  const totalMonthlyCents = discountedPerSeatMonthly * seats;
  const volumeDiscountMonthlyCents = subtotalMonthlyCents - totalMonthlyCents;

  const monthsCharged = interval === 'year' ? YEARLY_MONTHS_CHARGED : 1;
  const unitAmountPerIntervalCents = discountedPerSeatMonthly * monthsCharged;
  const totalPerIntervalCents = unitAmountPerIntervalCents * seats;
  const intervalSavingCents = interval === 'year' ? totalMonthlyCents * (12 - YEARLY_MONTHS_CHARGED) : 0;

  return {
    seats, interval, modules, currency: 'usd', lines,
    perSeatMonthlyCents, subtotalMonthlyCents, volumeDiscountPct, volumeDiscountMonthlyCents,
    totalMonthlyCents, monthsCharged, intervalSavingCents, totalPerIntervalCents, unitAmountPerIntervalCents,
  };
}

/** Client-safe catalogue for the licence builder. */
export function pricingCatalogue() {
  return {
    currency: 'usd',
    baseSeatPriceCents: BASE_SEAT_PRICE_CENTS,
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    yearlyMonthsCharged: YEARLY_MONTHS_CHARGED,
    volumeTiers: VOLUME_TIERS,
    gracePeriodDays: GRACE_PERIOD_DAYS,
    customStorageGb: CUSTOM_STORAGE_GB,
    modules: MODULES,
  };
}
