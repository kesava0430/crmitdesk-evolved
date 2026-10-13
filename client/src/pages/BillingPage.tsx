import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CreditCard, CheckCircle, Zap, Building2, Star, ExternalLink, Sparkles, AlertTriangle, Gift } from 'lucide-react';
import {
  useSubscription, useCreateCheckout, useCreatePortal, usePricing, fmtMoney, fmtLimit, BillingInterval, PlanCard,
} from '../api/billing';
import {
  PageHeader, PageBody, Card, StatTile, SectionHeader, Button, Badge, Alert, SkeletonCard, AccessDenied, Modal,
} from '../shared/components';
import { useFormat } from '../hooks/useFormat';
import { useAuth } from '../contexts/AuthContext';
import { can } from '../shared/permissions';
import { featureLabel } from '../shared/licenseFeatures';

const PLAN_ICONS = { FREE: Star, PRO: Zap, ENTERPRISE: Building2, CUSTOM: Sparkles };

/** Icon tint per plan — accent marks "us / recommended", never a loose hue. */
const PLAN_ICON_TINT = {
  FREE: 'text-fg-subtle',
  PRO: 'text-accent',
  ENTERPRISE: 'text-info',
  CUSTOM: 'text-warning',
} as const;

const PLAN_BADGE = { FREE: 'gray', PRO: 'purple', ENTERPRISE: 'blue', CUSTOM: 'yellow' } as const;
const PLAN_NAMES = { FREE: 'Free', PRO: 'Pro', ENTERPRISE: 'Enterprise', CUSTOM: 'Custom' } as const;

/** Core areas shown as one line instead of five badges. */
const CORE_AREAS = new Set(['hr_core', 'attendance', 'payroll', 'campaigns', 'custom_modules', 'api_access']);

/** Plan card bullets, built from GET /billing/pricing so the copy can never
 *  promise something the server doesn't enforce (LIC-27). */
function planBullets(card: PlanCard | undefined, prev: PlanCard | undefined): string[] {
  if (!card) return [];
  const out: string[] = [];
  out.push(`${card.seats >= 999 ? 'Up to ' : ''}${card.seats} billable seats (Employees are unlimited)`);
  out.push(prev ? `Everything in ${prev.name}` : 'CRM + IT Desk, core AI (lead scoring, sentiment, routing, tagging)');
  const prevSet = new Set(prev?.features ?? []);
  const fresh = card.features.filter(f => !prevSet.has(f));
  const core = fresh.filter(f => CORE_AREAS.has(f));
  if (core.length) out.push(core.map(featureLabel).join(', '));
  for (const f of fresh.filter(f => !CORE_AREAS.has(f))) out.push(featureLabel(f));
  out.push(card.storageQuotaGB > 0 ? `${card.storageQuotaGB}GB hosted attachment storage` : 'Attachments via your own Google Drive or S3');
  out.push(card.aiTokensMonthly === null ? 'Unlimited AI tokens' : `${fmtLimit(card.aiTokensMonthly)} AI tokens / month`);
  out.push(card.platformEmailMonthly === null && card.platformWhatsAppMonthly === null
    ? 'Unlimited email & WhatsApp via our sender'
    : `${fmtLimit(card.platformEmailMonthly)} emails · ${fmtLimit(card.platformWhatsAppMonthly)} WhatsApp / month via our sender (unlimited with your own)`);
  return out;
}

function UsageMeter({ label, used, limit, hint }: { label: string; used: number; limit: number | null; hint?: string }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11.5px] font-medium text-fg-muted">{label}</p>
        <p className={`text-[11.5px] font-semibold tabular-nums ${limit !== null && used >= limit ? 'text-danger' : 'text-fg'}`}>
          {used.toLocaleString()} / {limit === null ? 'unlimited' : limit.toLocaleString()}
        </p>
      </div>
      {limit !== null && (
        <div className="w-full h-1.5 bg-surface-sunken rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {hint && <p className="text-[11px] text-fg-subtle mt-1">{hint}</p>}
    </div>
  );
}

export function BillingPage() {
  const { date, timezone } = useFormat();
  const monthDay = (v: string) => new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: 'short', day: 'numeric' }).format(new Date(v));
  const [searchParams] = useSearchParams();
  /* GET /billing/subscription is SUPER_ADMIN-only, and so are checkout and the
     billing portal — there is nothing on this page anyone else can use, and
     without the subscription every plan card silently claimed "Free" was the
     current plan. Refuse the page rather than mislead. */
  const { user } = useAuth();
  const canReadBilling = can.readBilling(user?.role);
  const { data: sub, isLoading } = useSubscription(canReadBilling);
  const { data: pricing } = usePricing(canReadBilling);
  const checkout = useCreateCheckout();
  const portal = useCreatePortal();
  const [interval, setInterval] = useState<BillingInterval>('month');
  /** Plan change on an existing subscription is applied in place — confirm first. */
  const [confirmPlan, setConfirmPlan] = useState<'PRO' | 'ENTERPRISE' | null>(null);
  const [changed, setChanged] = useState(false);

  const success = searchParams.get('success') === '1';
  const canceled = searchParams.get('canceled') === '1';

  if (!canReadBilling) return <AccessDenied />;

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Billing & Plans" subtitle="Manage your subscription and billing details." />
        <PageBody>
          <SkeletonCard lines={4} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4" aria-hidden="true">
            <SkeletonCard lines={6} />
            <SkeletonCard lines={6} />
            <SkeletonCard lines={6} />
          </div>
        </PageBody>
      </div>
    );
  }

  const currency = pricing?.currency ?? 'usd';
  const money = (cents: number) => fmtMoney(cents, currency);
  const billingEnabled = pricing?.billingEnabled ?? sub?.billingEnabled ?? false;
  const current = sub?.plan || 'FREE';
  const lic = sub?.license;
  const monthsCharged = pricing?.yearlyMonthsCharged ?? 10;
  const yearlySavePct = Math.round((12 - monthsCharged) / 12 * 100);
  const licensedFeatures = lic?.features ?? sub?.planConfig.features ?? [];
  const storageGb = lic?.storageQuotaGB ?? sub?.planConfig.storageQuotaGB ?? 0;
  const statusVariant = sub?.status === 'active' || sub?.status === 'trialing' ? 'green' : sub?.status === 'past_due' ? 'yellow' : 'red';
  // Enforcement reads the EFFECTIVE seats (lapse → 5, operator comps …), never the raw row (LIC-15).
  const seatLimit = lic?.seats ?? sub?.seats ?? 5;
  const seatsUsed = sub?.seatsUsed ?? 0;
  const hasLiveStripeSub = !!sub?.stripeSubscriptionId && ['active', 'trialing', 'past_due'].includes(sub.status);
  const contact = pricing?.contactEmail;
  const cards = pricing?.plans ?? [];
  const cardFor = (k: string) => cards.find(p => p.key === k);

  const startCheckout = (plan: 'PRO' | 'ENTERPRISE') => {
    if (hasLiveStripeSub) { setConfirmPlan(plan); return; }
    checkout.mutate({ plan, interval });
  };

  return (
    <div>
      <PageHeader
        title="Billing & Plans"
        subtitle="Manage your subscription and billing details."
        actions={sub?.stripeCustomerId && billingEnabled ? (
          <Button
            variant="secondary"
            icon={<ExternalLink size={14} />}
            loading={portal.isPending}
            onClick={() => portal.mutate()}
          >
            Manage billing
          </Button>
        ) : undefined}
      />

      <PageBody>
        {/* Flash messages */}
        {(success || changed) && (
          <Alert tone="success" icon={<CheckCircle size={18} />}>
            {changed
              ? 'Your subscription was updated. Stripe prorates the difference on your next invoice.'
              : 'Subscription updated successfully! Your plan is now active.'}
          </Alert>
        )}
        {canceled && (
          <Alert tone="warning">
            Checkout was cancelled. Your current plan is unchanged.
          </Alert>
        )}

        {/* No Stripe keys on the server: say so plainly instead of failing at checkout (LIC-16). */}
        {!billingEnabled && (
          <div data-testid="billing-unavailable">
            <Alert tone="info" icon={<CreditCard size={15} />} title="Online payment isn't available">
              Plan changes are handled by our team for now — contact us{contact ? <> at <a className="underline font-medium" href={`mailto:${contact}`}>{contact}</a></> : ''} and we'll set up the licence you need.
            </Alert>
          </div>
        )}

        {/* Trial */}
        {sub?.status === 'trialing' && sub.trialEndsAt && (
          <Alert tone="info" icon={<Gift size={16} />} title="Free trial">
            Your {sub.planConfig.name} trial ends on {date(sub.trialEndsAt)}. Add a payment method under "Manage billing" to keep it after that.
          </Alert>
        )}

        {/* Payment state — the server already applies this to what the org can do */}
        {lic?.access === 'grace' && (
          <div data-testid="licence-grace-banner">
            <Alert tone="warning" icon={<AlertTriangle size={16} />} title="Payment problem — grace period active">
              {lic.reason} Use "Manage billing" to update your payment method.
            </Alert>
          </div>
        )}
        {lic?.access === 'lapsed' && (
          <div data-testid="licence-lapsed-banner">
            <Alert tone="danger" icon={<AlertTriangle size={16} />} title="Your paid licence has lapsed">
              {lic.reason} Until payment is restored your organisation has Free-plan limits: existing users, rules and files keep working, but paid features and extra seats are locked. Use "Manage billing" or choose a plan below.
            </Alert>
          </div>
        )}

        {/* Current plan summary */}
        {sub && (
          <Card>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">Current plan</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[17px] font-semibold text-fg tracking-tight">{sub.planConfig.name}</span>
                  <Badge variant={statusVariant} dot>{sub.status.replace(/_/g, ' ')}</Badge>
                  {sub.cancelAtPeriodEnd && <Badge variant="yellow">Cancels at period end</Badge>}
                  {sub.interval === 'year' && <Badge variant="gray">Yearly</Badge>}
                </div>
                <p className="text-[13px] text-fg-muted mt-1 tabular-nums">
                  {seatLimit} seats{seatLimit !== sub.seats && sub.plan !== 'FREE' ? ` (subscription: ${sub.seats})` : ''} · {sub.plan === 'CUSTOM'
                    ? `${money(sub.amountCents)}/${sub.interval === 'year' ? 'year' : 'month'} (${money(Math.round(sub.amountCents / (sub.interval === 'year' ? 12 : 1) / Math.max(1, sub.seats)))}/seat/month)`
                    : sub.planConfig.price > 0 ? `${money(sub.planConfig.price * 100)}/mo` : 'Free forever'}
                </p>
                {sub.lastInvoiceAmountCents != null && sub.lastInvoiceAmountCents !== sub.amountCents && sub.lastInvoiceAmountCents > 0 && (
                  <p className="text-[11.5px] text-fg-subtle mt-0.5 tabular-nums">Last invoice: {money(sub.lastInvoiceAmountCents)} (incl. tax / proration)</p>
                )}
              </div>
              <div className="text-right">
                {sub.currentPeriodEnd && sub.stripeSubscriptionId && (
                  <>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{sub.cancelAtPeriodEnd ? 'Access until' : 'Next billing date'}</p>
                    <p className="text-[13px] font-medium text-fg mt-0.5 tabular-nums">{date(sub.currentPeriodEnd)}</p>
                  </>
                )}
                {lic?.manualExpiresAt && (
                  <>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Licence valid until</p>
                    <p className="text-[13px] font-medium text-fg mt-0.5 tabular-nums">{date(lic.manualExpiresAt)}</p>
                  </>
                )}
                {sub.plan === 'CUSTOM' && (
                  <Link to="/billing/custom" className="inline-block mt-2 text-[12.5px] font-medium text-accent hover:underline">Change modules or seats →</Link>
                )}
              </div>
            </div>

            {/* Licensed modules */}
            <div className="mt-4 pt-4 border-t border-line-subtle">
              <p className="text-[11.5px] font-medium text-fg-muted mb-1.5">Licensed modules</p>
              <div className="flex flex-wrap gap-1.5" data-testid="licensed-modules">
                <Badge variant="green">CRM + IT Desk core</Badge>
                {licensedFeatures.map(k => <Badge key={k} variant="gray">{featureLabel(k)}</Badge>)}
                {storageGb > 0 && <Badge variant="gray">{storageGb}GB hosted storage</Badge>}
                {lic?.access === 'lapsed' && <Badge variant="red">Limited to Free until payment is restored</Badge>}
              </div>
            </div>

            {/* Seat usage */}
            <div className="mt-4 pt-4 border-t border-line-subtle">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11.5px] font-medium text-fg-muted">Billable seats used</p>
                <p className={`text-[11.5px] font-semibold tabular-nums ${seatsUsed >= seatLimit ? 'text-danger' : 'text-fg'}`} data-testid="seat-usage">
                  {seatsUsed} / {seatLimit}
                </p>
              </div>
              <div className="w-full h-2 bg-surface-sunken rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${seatsUsed >= seatLimit ? 'bg-danger' : seatsUsed / seatLimit >= 0.8 ? 'bg-warning' : 'bg-accent'}`}
                  style={{ width: `${Math.min(100, (seatsUsed / Math.max(1, seatLimit)) * 100)}%` }}
                />
              </div>
              <p className="text-[11.5px] text-fg-subtle mt-1.5">
                Every role counts except Employee — those logins are free and unlimited.
                {seatsUsed >= seatLimit && ' You\'re at your limit; upgrade to add more people in a billable role.'}
              </p>
            </div>
          </Card>
        )}

        {/* Usage this month, against the plan's allowances (null = unlimited). */}
        {sub && (
          <Card>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-3">
              Usage this month <span className="font-normal normal-case tracking-normal text-fg-subtle">({monthDay(sub.usage.periodStart)} – {monthDay(sub.usage.periodEnd)})</span>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <StatTile tone="sunken" label="AI calls" value={sub.usage.aiCalls.toLocaleString()} />
              <StatTile tone="sunken" label="WhatsApp messages sent" value={sub.usage.whatsappSends.toLocaleString()} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
              <UsageMeter label="AI tokens" used={sub.usage.aiTokens ?? 0} limit={sub.usage.aiTokensLimit ?? null} />
              <UsageMeter label="Emails via our sender" used={sub.usage.platformEmails ?? 0} limit={sub.usage.platformEmailsLimit ?? null} hint="Unlimited through your own connected mailbox." />
              <UsageMeter label="WhatsApp via our number" used={sub.usage.platformWhatsApp ?? 0} limit={sub.usage.platformWhatsAppLimit ?? null} hint="Unlimited through your own WhatsApp number." />
            </div>
          </Card>
        )}

        {/* Plan cards */}
        <SectionHeader
          title="Available Plans"
          actions={
            <div role="radiogroup" aria-label="Billing cycle" className="inline-flex rounded-lg border border-line p-0.5 bg-surface-sunken">
              {(['month', 'year'] as const).map(i => (
                <button
                  key={i} type="button" role="radio" aria-checked={interval === i} onClick={() => setInterval(i)}
                  className={`px-3 py-1 rounded-md text-[12px] font-medium transition ${interval === i ? 'bg-surface shadow-ui-sm text-fg' : 'text-fg-muted hover:text-fg'}`}
                >
                  {i === 'month' ? 'Monthly' : `Yearly · save ${yearlySavePct}%`}
                </button>
              ))}
            </div>
          }
        />
        {sub?.trialEligible && billingEnabled && (pricing?.trialDays ?? 0) > 0 && (
          <p className="text-[12.5px] text-success font-medium -mt-2"><Gift size={13} className="inline mr-1" />Paid plans start with a {pricing!.trialDays}-day free trial.</p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {(['FREE', 'PRO', 'ENTERPRISE', 'CUSTOM'] as const).map(plan => {
            const isCurrent = plan === current;
            const Icon = PLAN_ICONS[plan];
            const card = plan === 'CUSTOM' ? undefined : cardFor(plan);
            const monthly = card?.price ?? 0;
            const monthlyCents = Math.round(monthly * 100);
            const priceCents = interval === 'year' ? Math.round(monthlyCents * monthsCharged / 12) : monthlyCents;
            const locked = isCurrent || plan === 'FREE';
            const bullets = plan === 'CUSTOM'
              ? [
                  'Pick exactly the modules you need',
                  'Billable seats priced per seat',
                  ...(pricing?.volumeTiers?.length ? [`Volume discounts from ${Math.min(...pricing.volumeTiers.map(t => t.minSeats))} seats`] : []),
                  'Monthly or yearly billing',
                  ...(pricing?.modules?.some(m => m.key === 'hosted_storage') ? ['Optional hosted attachment storage'] : []),
                ]
              : planBullets(card, plan === 'PRO' ? cardFor('FREE') : plan === 'ENTERPRISE' ? cardFor('PRO') : undefined);

            return (
              <Card
                key={plan}
                data-testid={`plan-card-${plan}`}
                padding="lg"
                className={`relative flex flex-col card-hover ${
                  isCurrent ? '!border-accent shadow-ui-md' : ''
                }`}
              >
                {isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant="accent">Current plan</Badge>
                  </div>
                )}
                {plan === 'PRO' && !isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant={PLAN_BADGE.PRO}>Most popular</Badge>
                  </div>
                )}

                <div className="flex items-center gap-2 mb-3">
                  <Icon size={18} className={PLAN_ICON_TINT[plan]} />
                  <h3 className="text-[14px] font-semibold text-fg tracking-tight">{PLAN_NAMES[plan]}</h3>
                </div>

                <div className="mb-5">
                  {plan === 'CUSTOM' ? (
                    <>
                      <span className="text-[13px] text-fg-subtle">from </span>
                      <span className="text-[28px] font-semibold text-fg tracking-tight tabular-nums">{money(interval === 'year' ? Math.round((pricing?.baseSeatPriceCents ?? 800) * monthsCharged / 12) : (pricing?.baseSeatPriceCents ?? 800))}</span>
                      <span className="text-[13px] text-fg-subtle">/seat/mo</span>
                    </>
                  ) : (
                    <>
                      <span className="text-[28px] font-semibold text-fg tracking-tight tabular-nums">{money(priceCents)}</span>
                      <span className="text-[13px] text-fg-subtle">/mo</span>
                      {interval === 'year' && monthly > 0 && <p className="text-[11.5px] text-success mt-0.5">billed {money(Math.round(monthlyCents * monthsCharged))}/year</p>}
                    </>
                  )}
                </div>

                <ul className="space-y-2 flex-1 mb-6">
                  {bullets.map(f => (
                    <li key={f} className="flex items-start gap-2 text-[13px] text-fg-muted leading-relaxed">
                      <CheckCircle size={13} className="text-success flex-shrink-0 mt-0.5" /> <span>{f}</span>
                    </li>
                  ))}
                </ul>

                {/* One disabled state, two labels — this used to be two identical
                    buttons that differed only in their text. */}
                {plan === 'CUSTOM' ? (
                  <Link to="/billing/custom" data-testid="build-custom-licence">
                    <Button block variant={isCurrent ? 'secondary' : 'primary'} icon={<Sparkles size={14} />}>
                      {isCurrent ? 'Adjust licence' : 'Build your licence'}
                    </Button>
                  </Link>
                ) : locked ? (
                  <Button block variant="secondary" disabled title={plan === 'FREE' && !isCurrent ? 'Cancel your subscription from Manage billing to return to Free' : undefined}>
                    {isCurrent ? 'Current plan' : 'Downgrade via Manage billing'}
                  </Button>
                ) : (
                  <Button
                    block loading={checkout.isPending && checkout.variables?.plan === plan}
                    disabled={!billingEnabled}
                    title={!billingEnabled ? "Online payment isn't available — contact us" : undefined}
                    onClick={() => startCheckout(plan)}
                  >
                    {current === 'FREE' ? 'Upgrade to' : 'Switch to'} {PLAN_NAMES[plan]}
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      </PageBody>

      {/* In-place change of an existing subscription (no second subscription, LIC-1) */}
      {confirmPlan && (
        <Modal
          open
          onClose={() => setConfirmPlan(null)}
          title={`Switch to ${PLAN_NAMES[confirmPlan]}?`}
          icon={<CreditCard size={16} />}
          size="md"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmPlan(null)} disabled={checkout.isPending}>Cancel</Button>
              <Button
                loading={checkout.isPending}
                onClick={() => checkout.mutate({ plan: confirmPlan, interval }, {
                  onSuccess: data => { setConfirmPlan(null); if (data.updated) setChanged(true); },
                })}
              >
                Confirm change
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-fg-muted leading-relaxed">
            Your current subscription is changed to <strong className="text-fg">{PLAN_NAMES[confirmPlan]}</strong>, billed {interval === 'year' ? 'yearly' : 'monthly'}, straight away — using the card already on file.
            Stripe credits the unused part of your current plan and charges the difference on your next invoice. You keep a single subscription.
          </p>
        </Modal>
      )}
    </div>
  );
}
