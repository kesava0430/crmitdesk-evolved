import { Router, Response, NextFunction } from 'express';
import { authenticate, requireRole, AuthRequest, ALL_USERS } from '../../middleware/authenticate';
import { requireFeature } from '../../utils/licensing';
import { recordUsage } from '../../utils/usageTracking';
import { aiConfigSource, AI_NOT_CONFIGURED_MESSAGE } from '../../utils/aiStatus';
import * as c from './dashboards.controller';

// Dashboards — every signed-in org member, every plan. What each widget shows
// is decided per viewer at render time (utils/dashboards/render.ts), so even
// an employee's view of an org-wide dashboard only ever holds their own data.
const router = Router();
router.use(authenticate, requireRole(...ALL_USERS));

// Same contract as /api/ai's trackAiCall: say plainly when no provider is
// configured, and count the call before it runs.
async function trackAiCall(req: AuthRequest, res: Response, next: NextFunction) {
  if ((await aiConfigSource()) === 'none') {
    return res.status(503).json({ error: AI_NOT_CONFIGURED_MESSAGE, code: 'AI_NOT_CONFIGURED' });
  }
  recordUsage(req.user!.orgId, 'AI_CALL');
  next();
}
const aiAdvanced = requireFeature('ai_advanced');

router.get('/', c.list);
router.post('/', c.create);
router.get('/home', c.getHome);
router.put('/home', c.setHome);
router.get('/share-options', c.shareOptions);
router.post('/render-specs', c.renderSpecs);
router.post('/ai/propose', aiAdvanced, trackAiCall, c.aiPropose);
router.post('/ai/modify-widget', aiAdvanced, trackAiCall, c.aiModifyWidget);

router.get('/:id', c.get);
router.patch('/:id', c.update);
router.put('/:id/share', c.share);
router.delete('/:id', c.remove);
router.post('/:id/duplicate', c.duplicate);
router.post('/:id/render', c.render);
router.post('/:id/widgets', c.addWidget);
router.patch('/:id/widgets/:widgetId', c.updateWidget);
router.delete('/:id/widgets/:widgetId', c.removeWidget);
router.post('/:id/widgets/:widgetId/duplicate', c.duplicateWidget);

export { router as dashboardsRouter };
