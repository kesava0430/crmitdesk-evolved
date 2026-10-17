import { useAreaCopy } from '../shared/modules';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Lock, Minus, Plus, Users, CalendarClock, ShieldCheck, CheckCircle } from 'lucide-react';
import {
  usePricing, useSubscription, useQuote, useCreateCustomCheckout, fmtMoney, BillingInterval, ModuleDef,
} from '../api/billing';
import {
  PageHeader, PageBody, Card, Button, Badge, Alert, SkeletonCard, AccessDenied, InlineSpinner,
} from '../shared/components';
import { useAuth } from '../contexts/AuthContext';
import { can } from '../shared/permissions';
import { featureLabel } from '../shared/licenseFeatures';

const SEAT_PRESETS = [5, 10, 25, 50, 100, 250];

export function CustomLicensePage() {
  // Names only the areas the org has (Platform Admin → Areas).
  const areaCopy = useAreaCopy();
  const [searchParams] = useSearchParams();
  const canceled = searchParams.get('canceled') === '1';
  const { user } = useAuth();
  const canReadBilling = can.readBilling(user?.role);

  const { data: pricing, isLoading: pricingLoading } = usePricing(canReadBilling);
  const { data: sub } = useSubscription(canReadBilling);
  const checkout = useCreateCustomCheckout();

  const [seats, setSeats] = useState(10);
  const [interval, setInterval] = useState<BillingInterval>('month');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [updated, setUpdated] = useState(false);

  // Pre-fill from the org's current licence so an admin can adjust what they already have
  useEffect(() => {
    if (seeded || !pricing || !sub) return;
    // Includes modules the org already licenses that are no longer sold à la
    // carte (e.g. Custom Branding) — the server keeps pricing them for this
    // org, so an update must not silently drop them.
    // Switching from a fixed plan pre-fills only modules this org can use (Platform Admin → Areas).
    const current = sub.plan === 'CUSTOM' ? [...sub.planConfig.features] : sub.planConfig.features.filter(k => pricing.modules.some(m => m.key === k) && areaCopy.isFeatureRelevant(k));
    if (sub.plan === 'CUSTOM' && sub.planConfig.storageQuotaGB > 0) current.push('hosted_storage');
    setSelected(new Set(current.length ? current : ['workflow_automation', 'advanced_analytics'].filter(k => areaCopy.isFeatureRelevant(k))));
    setSeats(Math.min(pricing.maxSeats, Math.max(pricing.minSeats, sub.seatsUsed, sub.plan === 'CUSTOM' ? sub.seats : Math.max(sub.seatsUsed, 5))));
    if (sub.interval === 'year') setInterval('year');
    setSeeded(true);
  }, [pricing, sub, seeded]);

  const modules = useMemo(() => [...selected], [selected]);
  const { data: quote, isFetching: quoting } = useQuote({ seats, modules, interval }, canReadBilling && !!pricing);

  if (!canReadBilling) return <AccessDenied />;

  if (pricingLoading || !pricing) {
    return (
      <div>
        <PageHeader title="Build a Custom Licence" subtitle="Choose the modules and seats you need — pricing updates live." />
        <PageBody><SkeletonCard lines={6} /></PageBody>
      </div>
    );
  }

  // Never below the billable seats already in use (LIC-3) — the server rejects that too.
  const minSeats = Math.max(pricing.minSeats, sub?.seatsUsed ?? 0, quote?.minSeats ?? 0);
  const clampSeats = (n: number) => Math.min(pricing.maxSeats, Math.max(minSeats, Math.floor(n) || minSeats));
  const fmtUsd = (cents: number) => fmtMoney(cents, pricing.currency);
  const billingEnabled = pricing.billingEnabled;
  const updatesInPlace = !!sub?.stripeSubscriptionId && ['active', 'trialing', 'past_due'].includes(sub.status);
  const toggle = (key: string) => setSelected(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const tiers = [...pricing.volumeTiers].filter(t => t.discountPct > 0).sort((a, b) => a.minSeats - b.minSeats);
  const nextTier = tiers.find(t => t.minSeats > seats);
  const grandfathered = [...selected].filter(k => !pricing.modules.some(m => m.key === k));
  const canCheckout = selected.size > 0 && !!quote && !checkout.isPending && billingEnabled && seats >= minSeats;
  const yearlySavePct = Math.round((12 - pricing.yearlyMonthsCharged) / 12 * 100);

  return (
    <div>
      <PageHeader
        title="Build a Custom Licence"
        subtitle="Choose only the modules you need and the number of billable seats. Pricing updates live."
        breadcrumb="Billing"
        actions={<Link to="/billing"><Button variant="secondary" size="sm">Back to Billing</Button></Link>}
      />

      <PageBody>
        {canceled && <Alert tone="warning">Checkout was cancelled. Your current licence is unchanged.</Alert>}
        {updated && <Alert tone="success">Your licence was updated. Stripe prorates the difference on your next invoice.</Alert>}
        {!billingEnabled && (
          <Alert tone="info" title="Online payment isn't available">
            You can price a licence here; to buy it, contact us{pricing.contactEmail ? <> at <a className="underline font-medium" href={`mailto:${pricing.contactEmail}`}>{pricing.contactEmail}</a></> : ''}.
          </Alert>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
          {/* Configuration */}
          <div className="lg:col-span-2 space-y-5">
            {/* Seats */}
            <Card>
              <div className="flex items-center gap-2 mb-1">
                <Users size={15} className="text-accent" />
                <h2 className="text-[14px] font-semibold text-fg tracking-tight">Billable seats</h2>
              </div>
              <p className="text-[12px] text-fg-muted mb-4">
                Every role counts except Employee — those logins are free and unlimited. Platform base {fmtUsd(pricing.baseSeatPriceCents)}/seat/month.
                {sub && <> You currently use <strong className="text-fg">{sub.seatsUsed}</strong> billable seat{sub.seatsUsed === 1 ? '' : 's'}, so the licence needs at least {minSeats}.</>}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <div className="inline-flex items-center rounded-lg border border-line overflow-hidden bg-surface">
                  <button type="button" aria-label="Decrease seats" onClick={() => setSeats(s => clampSeats(s - 1))} className="px-3 py-2 text-fg-muted hover:bg-surface-sunken"><Minus size={14} /></button>
                  <input
                    aria-label="Number of seats" type="number" min={minSeats} max={pricing.maxSeats} value={seats}
                    onChange={e => setSeats(clampSeats(Number(e.target.value)))}
                    className="w-20 text-center py-2 text-[13px] font-semibold bg-transparent outline-none border-x border-line text-fg tabular-nums"
                  />
                  <button type="button" aria-label="Increase seats" onClick={() => setSeats(s => clampSeats(s + 1))} className="px-3 py-2 text-fg-muted hover:bg-surface-sunken"><Plus size={14} /></button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SEAT_PRESETS.filter(n => n >= minSeats && n <= pricing.maxSeats).map(n => (
                    <Button key={n} size="sm" variant={seats === n ? 'primary' : 'secondary'} onClick={() => setSeats(n)}>{n}</Button>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {tiers.map(t => (
                  <Badge key={t.minSeats} variant={seats >= t.minSeats ? 'green' : 'gray'}>{t.minSeats}+ seats · {t.discountPct}% off</Badge>
                ))}
                {nextTier && (
                  <span className="text-[11.5px] text-fg-subtle">Add {nextTier.minSeats - seats} more seat{nextTier.minSeats - seats === 1 ? '' : 's'} for {nextTier.discountPct}% off</span>
                )}
              </div>
            </Card>

            {/* Billing cycle */}
            <Card>
              <div className="flex items-center gap-2 mb-1">
                <CalendarClock size={15} className="text-accent" />
                <h2 className="text-[14px] font-semibold text-fg tracking-tight">Billing cycle</h2>
              </div>
              <p className="text-[12px] text-fg-muted mb-4">Pay yearly and get {12 - pricing.yearlyMonthsCharged} months free.</p>
              <div role="radiogroup" className="inline-flex rounded-lg border border-line p-1 bg-surface-sunken">
                {(['month', 'year'] as const).map(i => (
                  <button
                    key={i} type="button" role="radio" aria-checked={interval === i} onClick={() => setInterval(i)}
                    className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition ${interval === i ? 'bg-surface shadow-ui-sm text-fg' : 'text-fg-muted hover:text-fg'}`}
                  >
                    {i === 'month' ? 'Monthly' : <>Yearly <span className="ml-1 text-[11px] text-success font-semibold">save {yearlySavePct}%</span></>}
                  </button>
                ))}
              </div>
            </Card>

            {/* Modules */}
            <Card>
              <div className="flex items-center justify-between mb-1 gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={15} className="text-accent" />
                  <h2 className="text-[14px] font-semibold text-fg tracking-tight">Modules</h2>
                  <span className="text-[11.5px] text-fg-subtle">{selected.size - grandfathered.length} of {pricing.modules.length} selected</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(pricing.modules.map(m => m.key)))}>Select all</Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
                </div>
              </div>
              <p className="text-[12px] text-fg-muted mb-4">
                {areaCopy.areaNames}, {areaCopy.coreAi} and attachments via your own Google Drive are always included. Each module below adds a per-seat price.
              </p>
              {grandfathered.length > 0 && (
                <p className="text-[12px] text-fg-muted mb-3">
                  Also kept from your current licence: <strong className="text-fg">{grandfathered.map(featureLabel).join(', ')}</strong> (no longer sold separately — "Clear" drops it for good).
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ModuleCard module={{ key: 'core', name: `${areaCopy.areaPlus} core`, description: areaCopy.coreSummary, pricePerSeatCents: 0 }} checked locked fmt={fmtUsd} />
                {pricing.modules.filter(m => m.key === 'hosted_storage' || areaCopy.isFeatureRelevant(m.key) || selected.has(m.key)).map(m => (
                  <ModuleCard key={m.key} module={m.key === 'advanced_analytics' ? { ...m, description: `Analytics dashboards and ${[areaCopy.areaPlus.includes('IT Desk') && 'ticket', areaCopy.areaPlus.includes('CRM') && 'CRM'].filter(Boolean).join(' / ')} reports` } : m} checked={selected.has(m.key)} onToggle={() => toggle(m.key)} fmt={fmtUsd} />
                ))}
              </div>
            </Card>
          </div>

          {/* Live quote */}
          <aside className="lg:sticky lg:top-20">
            <Card padding="lg" className="!border-accent shadow-ui-md" data-testid="license-summary">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[14px] font-semibold text-fg tracking-tight">Your licence</h2>
                {quoting && <InlineSpinner />}
              </div>

              {quote ? (
                <>
                  <div className="mb-4">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[28px] font-semibold text-fg tracking-tight tabular-nums" data-testid="quote-total">{fmtUsd(quote.totalPerIntervalCents)}</span>
                      <span className="text-[13px] text-fg-subtle">/{interval === 'year' ? 'year' : 'month'}</span>
                    </div>
                    <p className="text-[12px] text-fg-muted mt-1 tabular-nums">
                      {fmtUsd(Math.round(quote.unitAmountPerIntervalCents / quote.monthsCharged))}/seat/month × {quote.seats} seat{quote.seats === 1 ? '' : 's'}
                      {interval === 'year' && <> · {fmtUsd(Math.round(quote.totalPerIntervalCents / 12))}/month equivalent</>}
                    </p>
                    {interval === 'year' && quote.intervalSavingCents > 0 && (
                      <p className="text-[12px] text-success font-medium mt-1">You save {fmtUsd(quote.intervalSavingCents)} a year vs monthly billing</p>
                    )}
                  </div>

                  <dl className="space-y-1.5 text-[13px] border-t border-line-subtle pt-3">
                    {quote.lines.map(l => (
                      <div key={l.key} className="flex justify-between gap-3 text-fg-muted">
                        <dt>{l.name} <span className="text-fg-subtle text-[11px]">({fmtUsd(l.pricePerSeatCents)}/seat)</span></dt>
                        <dd className="tabular-nums shrink-0">{fmtUsd(l.monthlyCents)}</dd>
                      </div>
                    ))}
                    <div className="flex justify-between text-fg font-medium border-t border-line-subtle pt-2">
                      <dt>Subtotal / month</dt><dd className="tabular-nums">{fmtUsd(quote.subtotalMonthlyCents)}</dd>
                    </div>
                    {quote.volumeDiscountPct > 0 && (
                      <div className="flex justify-between text-success">
                        <dt>Volume discount ({quote.volumeDiscountPct}%)</dt><dd className="tabular-nums">−{fmtUsd(quote.volumeDiscountMonthlyCents)}</dd>
                      </div>
                    )}
                    <div className="flex justify-between text-fg font-semibold">
                      <dt>Total / month</dt><dd className="tabular-nums">{fmtUsd(quote.totalMonthlyCents)}</dd>
                    </div>
                    {interval === 'year' && (
                      <div className="flex justify-between text-fg-muted">
                        <dt>Billed yearly ({quote.monthsCharged} months charged)</dt><dd className="tabular-nums">{fmtUsd(quote.totalPerIntervalCents)}</dd>
                      </div>
                    )}
                  </dl>
                </>
              ) : (
                <div className="py-6 flex justify-center"><InlineSpinner /></div>
              )}

              <Button
                block className="mt-5" icon={<Lock size={14} />} loading={checkout.isPending} disabled={!canCheckout}
                onClick={() => checkout.mutate({ seats, modules, interval }, { onSuccess: data => { if (data.updated) setUpdated(true); } })}
              >
                {updatesInPlace ? 'Update licence' : 'Continue to checkout'}
              </Button>
              {selected.size === 0 && <p className="text-[11.5px] text-warning mt-2 text-center">Select at least one module to continue.</p>}
              <p className="text-[11px] text-fg-subtle mt-3 text-center">
                {updatesInPlace
                  ? 'Applied to your existing subscription straight away, using the card on file.'
                  : 'Secure payment via Stripe. Change seats or cancel any time from Billing.'}
              </p>
            </Card>

            {sub && sub.plan !== 'FREE' && (
              <p className="text-[11.5px] text-fg-subtle mt-3 px-1">
                {updatesInPlace ? 'Updating changes' : 'Checking out replaces'} your current <strong className="text-fg">{sub.planConfig.name}</strong> plan ({sub.license?.seats ?? sub.seats} seats) — you keep one subscription and Stripe prorates the difference.
              </p>
            )}
          </aside>
        </div>
      </PageBody>
    </div>
  );
}

function ModuleCard({ module, checked, locked, onToggle, fmt }: { module: ModuleDef; checked: boolean; locked?: boolean; onToggle?: () => void; fmt: (cents: number) => string }) {
  return (
    <button
      type="button" role="checkbox" aria-checked={checked} aria-label={module.name} disabled={locked} onClick={onToggle}
      data-testid={`module-${module.key}`}
      className={`text-left rounded-lg border p-3.5 flex gap-3 transition ${
        locked ? 'bg-surface-sunken border-line-subtle cursor-default'
          : checked ? 'bg-accent-soft border-accent' : 'bg-surface border-line hover:border-line-strong'
      }`}
    >
      <span className={`mt-0.5 w-5 h-5 rounded-md flex items-center justify-center shrink-0 border ${checked ? 'bg-accent border-accent text-white' : 'border-line bg-surface'}`}>
        {checked && <Check size={12} />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-fg truncate">{module.name}</span>
          <span className={`text-[11.5px] font-semibold whitespace-nowrap ${locked ? 'text-success' : 'text-fg-muted'}`}>
            {locked ? 'Included' : `+${fmt(module.pricePerSeatCents)}/seat`}
          </span>
        </span>
        <span className="block text-[11.5px] text-fg-subtle mt-0.5 leading-relaxed">{module.description}</span>
        {locked && <span className="inline-flex items-center gap-1 text-[11px] text-fg-subtle mt-1"><CheckCircle size={11} /> Always on</span>}
      </span>
    </button>
  );
}
