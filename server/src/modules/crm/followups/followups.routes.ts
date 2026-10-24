import { Router } from 'express';
import { authenticate, requireRole, CRM_STAFF } from '../../../middleware/authenticate';
import * as c from './followups.controller';

export const followUpsRouter = Router();
followUpsRouter.use(authenticate);

// My Work / dashboard: the caller's own overdue + today follow-ups. Any role
// may ask (an employee assigned a CRM task gets it filtered by permissions);
// the CRM area gate on /api/crm answers 402 when CRM is off.
followUpsRouter.get('/mine',          c.mine);
followUpsRouter.post('/snooze',       c.snooze);
followUpsRouter.get('/prefs',         c.getPrefs);
followUpsRouter.put('/prefs',         c.putPrefs);
followUpsRouter.get('/email-channel', requireRole(...CRM_STAFF), c.emailChannel);
followUpsRouter.post('/check',        requireRole(...CRM_STAFF), c.checkEmail);
followUpsRouter.post('/send',         requireRole(...CRM_STAFF), c.send);
