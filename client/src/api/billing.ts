import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type PlanKey = 'FREE' | 'PRO' | 'ENTERPRISE' | 'CUSTOM';
export type BillingInterval = 'month' | 'year';

export interface ModuleDef {
  key: string;
  name: string;
  description: string;
  pricePerSeatCents: number;
}

export interface PlanCard {
  key: 'FREE' | 'PRO' | 'ENTERPRISE';
  name: string;
  price: number;
  seats: number;
  features: string[];
  storageQuotaGB: number;
  /** Monthly allowances; null = unlimited */
  aiTokensMonthly: number | null;
  platformEmailMonthly: number | null;
  platformWhatsAppMonthly: number | null;
  stripeConfigured: boolean;
}

export interface PricingCatalogue {
  currency: string;
  trialDays: number;
  contactEmail: string;
  /** False when the server has no Stripe keys — no checkout is offered. */
  billingEnabled: boolean;
  baseSeatPriceCents: number;
  minSeats: number;
  maxSeats: number;
  yearlyMonthsCharged: number;
  volumeTiers: { minSeats: number; discountPct: number }[];
  gracePeriodDays: number;
  customStorageGb: number;
  modules: ModuleDef[];
  plans: PlanCard[];
  customLimits?: { aiTokensMonthly: number | null; platformEmailMonthly: number | null; platformWhatsAppMonthly: number | null; baseFeatures: string[] };
}

/** GET /billing/entitlements — the org's effective licence after payment state is applied. */
export interface License {
  orgId: string;
  plan: PlanKey;
  effectivePlan: PlanKey;
  status: string;
  seats: number;
  features: string[];
  storageQuotaGB: number;
  interval: string;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  stripeManaged: boolean;
  manualExpiresAt: string | null;
  aiTokensMonthly: number | null;
  platformEmailMonthly: number | null;
  platformWhatsAppMonthly: number | null;
  access: 'full' | 'grace' | 'lapsed';
  reason: string | null;
  gracePeriodDays?: number;
  /** Keys the platform operator switched off for this org. */
  disabledFeatures?: string[];
  /** Area sub-modules that are off as a whole (hidden in the app, APIs 402). */
  blockedModules?: string[];
  /** Area / module catalogue (server utils/modules.ts). */
  areas?: AreaInfo[];
  modules?: ModuleInfo[];
}

export interface AreaInfo { key: 'hr' | 'crm' | 'itdesk'; root: string; label: string; description: string; roles: string[]; modules: string[] }
export interface ModuleInfo { key: string; area: 'hr' | 'crm' | 'itdesk'; label: string; description: string; routes: string[] }

export interface Subscription {
  id: string;
  orgId: string;
  plan: PlanKey;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  seats: number;
  seatsUsed: number;
  interval: BillingInterval;
  features: string[];
  amountCents: number;
  graceUntil: string | null;
  lastPaymentFailedAt: string | null;
  trialEndsAt: string | null;
  lastInvoiceAmountCents: number | null;
  usage: {
    aiCalls: number; whatsappSends: number; periodStart: string; periodEnd: string;
    aiTokens: number; aiTokensLimit: number | null;
    platformEmails: number; platformEmailsLimit: number | null;
    platformWhatsApp: number; platformWhatsAppLimit: number | null;
  };
  billingEnabled: boolean;
  trialEligible: boolean;
  createdAt: string;
  license: License;
  planConfig: { name: string; seats: number; price: number; priceId: string | null; features: string[]; storageQuotaGB: number };
}

export interface QuoteLine { key: string; name: string; pricePerSeatCents: number; monthlyCents: number }

export interface Quote {
  seats: number;
  interval: BillingInterval;
  modules: string[];
  currency: string;
  lines: QuoteLine[];
  perSeatMonthlyCents: number;
  subtotalMonthlyCents: number;
  volumeDiscountPct: number;
  volumeDiscountMonthlyCents: number;
  totalMonthlyCents: number;
  monthsCharged: number;
  intervalSavingCents: number;
  totalPerIntervalCents: number;
  unitAmountPerIntervalCents: number;
  /** max(config minimum, billable seats in use) — the licence can't go below it */
  minSeats?: number;
  seatsUsed?: number;
}

export interface QuoteInput { seats: number; modules: string[]; interval: BillingInterval }

/** Format minor units (cents / paise) in the licence currency (PricingConfig.currency). */
export const fmtMoney = (cents: number, currency = 'usd') => {
  const code = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency: code, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)} ${code}`;
  }
};
/** @deprecated USD-only — use fmtMoney(cents, pricing.currency). */
export const fmtUsd = (cents: number) => fmtMoney(cents, 'usd');

/** Compact allowance label: null = Unlimited. */
export const fmtLimit = (n: number | null | undefined) =>
  n === null || n === undefined ? 'Unlimited' : n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();

/** Checkout either redirects to Stripe or — for an org that already has a
 *  subscription — changes it in place and returns { updated: true }. */
export type CheckoutResult = { url: string; updated?: undefined } | { updated: true; url?: undefined };

/** GET /billing/subscription is SUPER_ADMIN-only — callers pass `can.readBilling(role)`. */
export function useSubscription(enabled = true) {
  return useQuery<Subscription>({
    queryKey: ['subscription'],
    queryFn: () => api.get('/billing/subscription').then(r => r.data),
    enabled,
  });
}

export function usePricing(enabled = true) {
  return useQuery<PricingCatalogue>({
    queryKey: ['billing-pricing'],
    queryFn: () => api.get('/billing/pricing').then(r => r.data),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/** Any signed-in user — drives the payment-state banner. */
export function useLicense(enabled = true) {
  return useQuery<License>({
    queryKey: ['license'],
    queryFn: () => api.get('/billing/entitlements').then(r => r.data),
    staleTime: 60 * 1000,
    // Drives which areas the app shows (Platform Admin can switch HR / CRM /
    // IT Desk per org), so refresh when the app comes back to the foreground
    // and every few minutes while it stays open — the global default skips
    // window-focus refetches.
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60 * 1000,
    enabled,
  });
}

export function useQuote(input: QuoteInput, enabled = true) {
  return useQuery<Quote>({
    queryKey: ['billing-quote', input.seats, input.interval, [...input.modules].sort().join(',')],
    queryFn: () => api.post('/billing/quote', input).then(r => r.data),
    enabled,
    placeholderData: prev => prev,
  });
}

function useCheckoutResult() {
  const qc = useQueryClient();
  return (data: CheckoutResult) => {
    if (data.url) { window.location.href = data.url; return; }
    // Changed in place — no redirect; refresh everything licence-related.
    qc.invalidateQueries({ queryKey: ['subscription'] });
    qc.invalidateQueries({ queryKey: ['license'] });
  };
}

export function useCreateCheckout() {
  const onResult = useCheckoutResult();
  return useMutation({
    mutationFn: (body: { plan: 'PRO' | 'ENTERPRISE'; interval?: BillingInterval }) =>
      api.post('/billing/checkout', body).then(r => r.data as CheckoutResult),
    onSuccess: onResult,
  });
}

export function useCreateCustomCheckout() {
  const onResult = useCheckoutResult();
  return useMutation({
    mutationFn: (body: QuoteInput) => api.post('/billing/custom-checkout', body).then(r => r.data as CheckoutResult & { quote: Quote }),
    onSuccess: onResult,
  });
}

export function useCreatePortal() {
  return useMutation({
    mutationFn: () => api.post('/billing/portal').then(r => r.data),
    onSuccess: (data: { url: string }) => { window.location.href = data.url; },
  });
}
