import { Router } from 'express';
import { authenticate, requireRole,
         MANAGERS, IT_MANAGERS, CRM_MANAGERS } from '../../middleware/authenticate';
import * as c from './analytics.controller';

const router = Router();
router.use(authenticate);

router.get('/overview', requireRole(...MANAGERS),     c.overview);
router.get('/tickets',  requireRole(...IT_MANAGERS),  c.ticketAnalytics);
router.get('/crm',      requireRole(...CRM_MANAGERS), c.crmAnalytics);

export { router as analyticsRouter };
