import { Router } from 'express';
import { authenticate, requireRole,
         MANAGERS, IT_MANAGERS, CRM_MANAGERS } from '../../middleware/authenticate';
import { requireFeature, requireModuleAtMount as requireModule } from '../../utils/licensing';
import * as c from './analytics.controller';

const router = Router();
router.use(authenticate);

// Advanced analytics is a Pro+ feature — unlike workflow/portal above,
// there's nothing to "create" here, just read access, so all three routes
// are gated directly rather than only the write path.
const advancedAnalytics = requireFeature('advanced_analytics');
router.get('/overview', requireRole(...MANAGERS),     advancedAnalytics, c.overview);
// Area-specific analytics are off while the area is (Platform Admin → Areas).
router.get('/tickets',  requireRole(...IT_MANAGERS),  advancedAnalytics, requireModule('itdesk'), c.ticketAnalytics);
router.get('/crm',      requireRole(...CRM_MANAGERS), advancedAnalytics, requireModule('crm'), c.crmAnalytics);

export { router as analyticsRouter };
