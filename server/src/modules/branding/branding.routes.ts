import { Router } from 'express';
import { authenticate, requireRole,
         ALL_USERS, ADMIN } from '../../middleware/authenticate';
import * as c from './branding.controller';

const router = Router();

// Public — portal uses this (no auth required)
router.get('/public/:orgId', c.getPublicBranding);

router.use(authenticate);
// Any authenticated user can read branding (used for org logo display)
router.get('/',  requireRole(...ALL_USERS), c.getBranding);
// Only org admin can change branding
router.post('/', requireRole(...ADMIN),     c.saveBranding);
router.put('/',  requireRole(...ADMIN),     c.saveBranding);

export { router as brandingRouter };
