import { useSearchParams } from 'react-router-dom';
import { CreditCard, CheckCircle, Zap, Building2, Star, ExternalLink } from 'lucide-react';
import { useSubscription, useCreateCheckout, useCreatePortal } from '../api/billing';
import {
  PageHeader, PageBody, Card, StatTile, SectionHeader, Button, Badge, Alert, Spinner,
} from '../shared/components';
import { useFormat } from '../hooks/useFormat';

const PLAN_ICONS = { FREE: Star, PRO: Zap, ENTERPRISE: Building2 };

/**
 * Tint for the *current* plan's card only. Marked `!` because it deliberately
 * overrides `<Card>`'s default surface — everything else about the card
 * (radius, padding, shadow) still comes from the component.
 */
const PLAN_TINT = {
  FREE: '!bg-surface-sunken !border-line',
  PRO: '!bg-violet-50 dark:!bg-violet-500/10 !border-violet-300 dark:!border-violet-500/30',
  ENTERPRISE: '!bg-blue-50 dark:!bg-blue-500/10 !border-blue-300 dark:!border-blue-500/30',
} as const;

const PLAN_BADGE = { FREE: 'gray', PRO: 'purple', ENTERPRISE: 'blue' } as const;

const FEATURES: Record<string, string[]> = {
  FREE:       ['5 billable seats (Employees are unlimited)', 'CRM + IT Desk', 'Email notifications', 'AI features (limited)', 'Attachments via your own Google Drive', 'Community support'],
  PRO:        ['25 billable seats (Employees are unlimited)', 'Everything in Free', 'Unlimited inbox messages', 'Workflow automation', 'Customer portal', 'Advanced analytics', '5GB hosted attachment storage (or keep using your own Drive)', 'Priority support'],
  ENTERPRISE: ['Unlimited billable seats', 'Everything in Pro', 'SSO / SAML', 'Custom branding', '50GB hosted attachment storage', 'SLA guarantees', 'Dedicated account manager'],
};

export function BillingPage() {
  const { date, timezone } = useFormat();
  const monthDay = (v: string) => new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: 'short', day: 'numeric' }).format(new Date(v));
  const [searchParams] = useSearchParams();
  const { data: sub, isLoading } = useSubscription();
  const checkout = useCreateCheckout();
  const portal = useCreatePortal();

  const success = searchParams.get('success') === '1';
  const canceled = searchParams.get('canceled') === '1';

  if (isLoading) return <Spinner label="Loading billing…" />;

  const current = sub?.plan || 'FREE';

  return (
    <div>
      <PageHeader
        title="Billing & Plans"
        subtitle="Manage your subscription and billing details."
        actions={sub?.stripeCustomerId ? (
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
        {success && (
          <Alert tone="success" icon={<CheckCircle size={18} />}>
            Subscription updated successfully! Your plan is now active.
          </Alert>
        )}
        {canceled && (
          <Alert tone="warning">
            Checkout was cancelled. Your current plan is unchanged.
          </Alert>
        )}

        {/* Current plan summary */}
        {sub && (
          <Card>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-[11.5px] text-fg-muted mb-1">Current plan</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-fg">{sub.planConfig.name}</span>
                  <Badge variant={sub.status === 'active' ? 'green' : 'red'}>{sub.status}</Badge>
                  {sub.cancelAtPeriodEnd && <Badge variant="yellow">Cancels at period end</Badge>}
                </div>
                <p className="text-[13px] text-fg-muted mt-1">{sub.seats} seats · {sub.planConfig.price > 0 ? `$${sub.planConfig.price}/mo` : 'Free forever'}</p>
              </div>
              {sub.currentPeriodEnd && (
                <div className="text-right">
                  <p className="text-[11.5px] text-fg-subtle">Next billing date</p>
                  <p className="text-[13px] font-medium text-fg">{date(sub.currentPeriodEnd)}</p>
                </div>
              )}
            </div>

            {/* Seat usage */}
            <div className="mt-4 pt-4 border-t border-line-subtle">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11.5px] font-medium text-fg-muted">Billable seats used</p>
                <p className={`text-[11.5px] font-semibold ${sub.seatsUsed >= sub.seats ? 'text-danger' : 'text-fg'}`}>
                  {sub.seatsUsed} / {sub.seats}
                </p>
              </div>
              <div className="w-full h-2 bg-surface-sunken rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${sub.seatsUsed >= sub.seats ? 'bg-danger' : sub.seatsUsed / sub.seats >= 0.8 ? 'bg-warning' : 'bg-accent'}`}
                  style={{ width: `${Math.min(100, (sub.seatsUsed / sub.seats) * 100)}%` }}
                />
              </div>
              <p className="text-[11.5px] text-fg-subtle mt-1.5">
                Every role counts except Employee — those logins are free and unlimited.
                {sub.seatsUsed >= sub.seats && ' You\'re at your limit; upgrade to add more people in a billable role.'}
              </p>
            </div>
          </Card>
        )}

        {/* Usage this month — informational only, nothing here is billed or
            capped yet. Purely visibility until real limits get set. */}
        {sub && (
          <Card>
            <p className="text-[11.5px] text-fg-muted mb-3">
              Usage this month <span className="text-fg-subtle">({monthDay(sub.usage.periodStart)} – {monthDay(sub.usage.periodEnd)})</span>
            </p>
            <div className="grid grid-cols-2 gap-4">
              <StatTile tone="sunken" label="AI calls" value={sub.usage.aiCalls.toLocaleString()} />
              <StatTile tone="sunken" label="WhatsApp messages sent" value={sub.usage.whatsappSends.toLocaleString()} />
            </div>
            <p className="text-[11.5px] text-fg-subtle mt-3">Not currently limited or billed separately — shown for visibility only.</p>
          </Card>
        )}

        {/* Plan cards */}
        <SectionHeader title="Available Plans" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(['FREE', 'PRO', 'ENTERPRISE'] as const).map(plan => {
            const isCurrent = plan === current;
            const Icon = PLAN_ICONS[plan];
            const price = plan === 'FREE' ? 0 : plan === 'PRO' ? 49 : 149;
            const locked = isCurrent || plan === 'FREE';

            return (
              <Card
                key={plan}
                padding="lg"
                className={`relative flex flex-col !border-2 ${isCurrent ? PLAN_TINT[plan] : ''}`}
              >
                {isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant={PLAN_BADGE[plan]}>Current plan</Badge>
                  </div>
                )}
                {plan === 'PRO' && !isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant="accent">Most popular</Badge>
                  </div>
                )}

                <div className="flex items-center gap-2 mb-3">
                  <Icon size={18} className={plan === 'FREE' ? 'text-fg-subtle' : plan === 'PRO' ? 'text-accent' : 'text-blue-600'} />
                  <h3 className="font-bold text-fg">{plan === 'FREE' ? 'Free' : plan === 'PRO' ? 'Pro' : 'Enterprise'}</h3>
                </div>

                <div className="mb-5">
                  <span className="text-3xl font-bold text-fg">${price}</span>
                  <span className="text-[13px] text-fg-subtle">/mo</span>
                </div>

                <ul className="space-y-2 flex-1 mb-6">
                  {FEATURES[plan].map(f => (
                    <li key={f} className="flex items-center gap-2 text-[13px] text-fg-muted">
                      <CheckCircle size={13} className="text-success flex-shrink-0" /> {f}
                    </li>
                  ))}
                </ul>

                {/* One disabled state, two labels — this used to be two identical
                    buttons that differed only in their text. */}
                {locked ? (
                  <Button block variant="secondary" disabled>
                    {isCurrent ? 'Current plan' : 'Downgrade'}
                  </Button>
                ) : (
                  <Button block loading={checkout.isPending} onClick={() => checkout.mutate(plan)}>
                    Upgrade to {plan === 'PRO' ? 'Pro' : 'Enterprise'}
                  </Button>
                )}
              </Card>
            );
          })}
        </div>

        {/* Stripe setup note */}
        {!sub?.stripeCustomerId && sub?.plan === 'FREE' && (
          <Alert tone="warning" icon={<CreditCard size={15} />} title="Configure Stripe to enable payments">
            <p>Add <code className="bg-warning/15 px-1 rounded">STRIPE_SECRET_KEY</code>, <code className="bg-warning/15 px-1 rounded">STRIPE_WEBHOOK_SECRET</code>, <code className="bg-warning/15 px-1 rounded">STRIPE_PRO_PRICE_ID</code>, and <code className="bg-warning/15 px-1 rounded">STRIPE_ENTERPRISE_PRICE_ID</code> to <code className="bg-warning/15 px-1 rounded">server/.env</code>.</p>
          </Alert>
        )}
      </PageBody>
    </div>
  );
}
