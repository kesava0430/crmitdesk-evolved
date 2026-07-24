import express, { Router } from 'express';
import { authenticate, requireRole, ADMIN } from '../../middleware/authenticate';
import * as c from './billing.controller';

const router = Router();

// Webhook must receive raw body for Stripe signature verification (no auth)
router.post('/webhook', express.raw({ type: 'application/json' }), c.handleWebhook);

// Only org admin can manage billing
router.get('/subscription',  authenticate, requireRole(...ADMIN), c.getSubscription);
router.post('/checkout',     authenticate, requireRole(...ADMIN), c.createCheckout);
router.post('/portal',       authenticate, requireRole(...ADMIN), c.createPortal);

export { router as billingRouter };
