import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { stripe, verifyStripeWebhook, PLANS } from '../../utils/stripe';
import { getBillableSeatCount } from '../../utils/licensing';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ─── Ensure subscription row exists ──────────────────────────────────────────

async function getOrCreateSubscription(orgId: string) {
  return prisma.subscription.upsert({
    where: { orgId },
    create: { orgId, plan: 'FREE', status: 'active', seats: 5 },
    update: {},
  });
}

// GET /api/billing/subscription
export async function getSubscription(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const sub = await getOrCreateSubscription(req.user!.orgId);
    // seatsUsed counts every active user except EMPLOYEE (see utils/licensing.ts)
    // — mirrors exactly what assertSeatAvailable() checks, so the billing page
    // never shows a number that disagrees with what actually gets blocked.
    const seatsUsed = await getBillableSeatCount(req.user!.orgId);
    res.json({ ...sub, seatsUsed, planConfig: PLANS[sub.plan as keyof typeof PLANS] });
  } catch (err) { next(err); }
}

// POST /api/billing/checkout
// Creates a Stripe Checkout session for upgrading plan
export async function createCheckout(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { plan } = req.body as { plan: 'PRO' | 'ENTERPRISE' };
    if (!plan || !PLANS[plan]?.priceId) throw new AppError(400, 'Invalid plan or Stripe price ID not configured');

    const orgId = req.user!.orgId;
    let sub = await getOrCreateSubscription(orgId);

    // Get or create Stripe customer
    let stripeCustomerId = sub.stripeCustomerId;
    if (!stripeCustomerId) {
      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      const customer = await stripe.customers.create({ email: req.user!.email || '', name: org?.name || '', metadata: { orgId } });
      stripeCustomerId = customer.id;
      await prisma.subscription.update({ where: { orgId }, data: { stripeCustomerId } });
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId ?? undefined,
      mode: 'subscription',
      success_url: `${FRONTEND_URL}/billing?success=1`,
      cancel_url: `${FRONTEND_URL}/billing?canceled=1`,
      line_items: [{ price: PLANS[plan].priceId, quantity: 1 }],
      metadata: { orgId, plan },
    });

    res.json({ url: (session as any).url });
  } catch (err) { next(err); }
}

// POST /api/billing/portal
// Creates a Stripe Billing Portal session for managing subscription
export async function createPortal(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const sub = await prisma.subscription.findUnique({ where: { orgId: req.user!.orgId } });
    if (!sub?.stripeCustomerId) throw new AppError(400, 'No active Stripe subscription');

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${FRONTEND_URL}/billing`,
    });

    res.json({ url: (session as any).url });
  } catch (err) { next(err); }
}

// POST /api/billing/webhook  (public — no auth)
export async function handleWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const sig = req.headers['stripe-signature'] as string;
    let event: any;
    try {
      event = verifyStripeWebhook(req.body as Buffer, sig);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }

    const data = event.data.object;

    switch (event.type) {
      case 'checkout.session.completed': {
        const orgId = data.metadata?.orgId;
        const plan = data.metadata?.plan;
        if (!orgId || !plan) break;
        await prisma.subscription.upsert({
          where: { orgId },
          create: { orgId, stripeCustomerId: data.customer, stripeSubscriptionId: data.subscription, plan, status: 'active', seats: PLANS[plan as keyof typeof PLANS]?.seats || 5 },
          update: { stripeCustomerId: data.customer, stripeSubscriptionId: data.subscription, plan, status: 'active', seats: PLANS[plan as keyof typeof PLANS]?.seats || 5 },
        });
        break;
      }
      case 'customer.subscription.updated': {
        const sub = await prisma.subscription.findFirst({ where: { stripeSubscriptionId: data.id } });
        if (!sub) break;
        await prisma.subscription.update({
          where: { id: sub.id },
          data: {
            status: data.status,
            cancelAtPeriodEnd: data.cancel_at_period_end,
            currentPeriodEnd: new Date(data.current_period_end * 1000),
          },
        });
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = await prisma.subscription.findFirst({ where: { stripeSubscriptionId: data.id } });
        if (!sub) break;
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { plan: 'FREE', status: 'active', stripeSubscriptionId: null, seats: 5, cancelAtPeriodEnd: false, currentPeriodEnd: null },
        });
        break;
      }
    }

    res.json({ received: true });
  } catch (err) { next(err); }
}
