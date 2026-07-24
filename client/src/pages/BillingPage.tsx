import { useSearchParams } from 'react-router-dom';
import { CreditCard, CheckCircle, Zap, Building2, Star, ExternalLink, AlertCircle } from 'lucide-react';
import { useSubscription, useCreateCheckout, useCreatePortal } from '../api/billing';
import { Spinner } from '../shared/components';

const PLAN_ICONS = { FREE: Star, PRO: Zap, ENTERPRISE: Building2 };
const PLAN_COLORS = {
  FREE: { bg: 'bg-gray-50', border: 'border-gray-200', badge: 'bg-gray-100 text-gray-600', btn: 'bg-gray-200 text-gray-500 cursor-not-allowed' },
  PRO: { bg: 'bg-violet-50', border: 'border-violet-300', badge: 'bg-violet-100 text-violet-700', btn: 'bg-brand-600 text-white hover:bg-brand-700' },
  ENTERPRISE: { bg: 'bg-blue-50', border: 'border-blue-300', badge: 'bg-blue-100 text-blue-700', btn: 'bg-blue-600 text-white hover:bg-blue-700' },
};

const FEATURES: Record<string, string[]> = {
  FREE:       ['Up to 5 users', 'CRM + IT Desk', 'Email notifications', 'AI features (limited)', 'Community support'],
  PRO:        ['Up to 25 users', 'Everything in Free', 'Unlimited inbox messages', 'Workflow automation', 'Customer portal', 'Advanced analytics', 'Priority support'],
  ENTERPRISE: ['Unlimited users', 'Everything in Pro', 'SSO / SAML', 'Custom branding', 'SLA guarantees', 'Dedicated account manager'],
};

export function BillingPage() {
  const [searchParams] = useSearchParams();
  const { data: sub, isLoading } = useSubscription();
  const checkout = useCreateCheckout();
  const portal = useCreatePortal();

  const success = searchParams.get('success') === '1';
  const canceled = searchParams.get('canceled') === '1';

  if (isLoading) return <div className="p-6 flex justify-center"><Spinner label="Loading billing…" /></div>;

  const current = sub?.plan || 'FREE';

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <CreditCard size={20} className="text-brand-600" />
            <h1 className="text-xl font-bold text-gray-900">Billing & Plans</h1>
          </div>
          <p className="text-sm text-gray-500">Manage your subscription and billing details.</p>
        </div>
        {sub?.stripeCustomerId && (
          <button onClick={() => portal.mutate()} disabled={portal.isPending}
            className="flex items-center gap-2 px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 disabled:opacity-40">
            {portal.isPending ? <Spinner /> : <ExternalLink size={14} />}
            Manage billing
          </button>
        )}
      </div>

      {/* Flash messages */}
      {success && (
        <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl mb-6">
          <CheckCircle size={18} className="text-green-600 flex-shrink-0" />
          <p className="text-sm text-green-800 font-medium">Subscription updated successfully! Your plan is now active.</p>
        </div>
      )}
      {canceled && (
        <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl mb-6">
          <AlertCircle size={18} className="text-amber-600 flex-shrink-0" />
          <p className="text-sm text-amber-800">Checkout was cancelled. Your current plan is unchanged.</p>
        </div>
      )}

      {/* Current plan summary */}
      {sub && (
        <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-8">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-xs text-gray-500 mb-1">Current plan</p>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-gray-900">{sub.planConfig.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sub.status === 'active' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                  {sub.status}
                </span>
                {sub.cancelAtPeriodEnd && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">Cancels at period end</span>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-1">{sub.seats} seats · {sub.planConfig.price > 0 ? `$${sub.planConfig.price}/mo` : 'Free forever'}</p>
            </div>
            {sub.currentPeriodEnd && (
              <div className="text-right">
                <p className="text-xs text-gray-400">Next billing date</p>
                <p className="text-sm font-medium text-gray-700">{new Date(sub.currentPeriodEnd).toLocaleDateString()}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Plan cards */}
      <h2 className="text-base font-semibold text-gray-900 mb-4">Available Plans</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(['FREE', 'PRO', 'ENTERPRISE'] as const).map(plan => {
          const isCurrent = plan === current;
          const colors = PLAN_COLORS[plan];
          const Icon = PLAN_ICONS[plan];
          const price = plan === 'FREE' ? 0 : plan === 'PRO' ? 49 : 149;

          return (
            <div key={plan}
              className={`relative rounded-2xl border-2 p-6 flex flex-col ${isCurrent ? `${colors.bg} ${colors.border}` : 'bg-white border-gray-200'}`}>
              {isCurrent && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className={`text-xs font-semibold px-3 py-1 rounded-full ${colors.badge}`}>Current plan</span>
                </div>
              )}
              {plan === 'PRO' && !isCurrent && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="text-xs font-semibold px-3 py-1 rounded-full bg-brand-600 text-white">Most popular</span>
                </div>
              )}

              <div className="flex items-center gap-2 mb-3">
                <Icon size={18} className={plan === 'FREE' ? 'text-gray-400' : plan === 'PRO' ? 'text-brand-600' : 'text-blue-600'} />
                <h3 className="font-bold text-gray-900">{plan === 'FREE' ? 'Free' : plan === 'PRO' ? 'Pro' : 'Enterprise'}</h3>
              </div>

              <div className="mb-5">
                <span className="text-3xl font-bold text-gray-900">${price}</span>
                <span className="text-sm text-gray-400">/mo</span>
              </div>

              <ul className="space-y-2 flex-1 mb-6">
                {FEATURES[plan].map(f => (
                  <li key={f} className="flex items-center gap-2 text-sm text-gray-600">
                    <CheckCircle size={13} className="text-green-500 flex-shrink-0" /> {f}
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <button disabled className="w-full py-2.5 rounded-xl text-sm font-medium bg-gray-100 text-gray-400 cursor-not-allowed">
                  Current plan
                </button>
              ) : plan === 'FREE' ? (
                <button disabled className="w-full py-2.5 rounded-xl text-sm font-medium bg-gray-100 text-gray-400 cursor-not-allowed">
                  Downgrade
                </button>
              ) : (
                <button onClick={() => checkout.mutate(plan)} disabled={checkout.isPending}
                  className={`w-full py-2.5 rounded-xl text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2 ${colors.btn}`}>
                  {checkout.isPending ? <Spinner /> : null}
                  Upgrade to {plan === 'PRO' ? 'Pro' : 'Enterprise'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Stripe setup note */}
      {!sub?.stripeCustomerId && sub?.plan === 'FREE' && (
        <div className="mt-8 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <p className="font-medium mb-1">Configure Stripe to enable payments</p>
          <p>Add <code className="bg-amber-100 px-1 rounded">STRIPE_SECRET_KEY</code>, <code className="bg-amber-100 px-1 rounded">STRIPE_WEBHOOK_SECRET</code>, <code className="bg-amber-100 px-1 rounded">STRIPE_PRO_PRICE_ID</code>, and <code className="bg-amber-100 px-1 rounded">STRIPE_ENTERPRISE_PRICE_ID</code> to <code className="bg-amber-100 px-1 rounded">server/.env</code>.</p>
        </div>
      )}
    </div>
  );
}
