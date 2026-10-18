import { Router } from 'express';
import { authenticate, requireRole,
         MANAGERS, IT_MANAGERS, CRM_MANAGERS, ALL_USERS } from '../../middleware/authenticate';
import { requireFeature, requireModuleAtMount as requireModule } from '../../utils/licensing';
import * as c from './analytics.controller';
import * as q from './query.controller';

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

// Semantic query layer (utils/analytics/). Not plan-gated: it powers
// dashboards on every plan and returns nothing a caller couldn't already list
// — every dataset is filtered by the org's areas and the caller's own record
// scope and field permissions. AI answers on top of it (/ai/query) stay
// behind ai_advanced.
router.get('/catalog',   requireRole(...ALL_USERS), q.catalog);
router.post('/query',    requireRole(...ALL_USERS), q.query);
router.post('/forecast', requireRole(...ALL_USERS), q.forecast);

export { router as analyticsRouter };
