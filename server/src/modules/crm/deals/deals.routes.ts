import { Router } from 'express';
import { authenticate, requireRole,
         CRM_STAFF, CRM_MANAGERS } from '../../../middleware/authenticate';
import * as c from './deals.controller';
import * as links from './dealLinks.controller';

export const dealsRouter = Router();
dealsRouter.use(authenticate);

dealsRouter.get('/',              requireRole(...CRM_STAFF),    c.list);
dealsRouter.post('/',             requireRole(...CRM_STAFF),    c.create);
dealsRouter.get('/pipeline',      requireRole(...CRM_STAFF),    c.pipeline);
dealsRouter.get('/reports',       requireRole(...CRM_MANAGERS), c.reports);
// Related deals (utils/dealLinks). Registered before '/:id' so "link-rule"
// isn't read as a deal id. The rule is org-wide config: CRM admins only.
dealsRouter.get('/link-rule',        requireRole(...CRM_STAFF),    links.getRule);
dealsRouter.put('/link-rule',        requireRole(...CRM_MANAGERS), links.putRule);
dealsRouter.post('/related-preview', requireRole(...CRM_STAFF),    links.preview);
dealsRouter.get('/related-counts',   requireRole(...CRM_STAFF),    links.outcomeCounts);
dealsRouter.get('/:id/related',      requireRole(...CRM_STAFF),    links.related);
dealsRouter.get('/:id',           requireRole(...CRM_STAFF),    c.getOne);
dealsRouter.patch('/:id',         requireRole(...CRM_STAFF),    c.update);
dealsRouter.patch('/:id/stage',   requireRole(...CRM_STAFF),    c.moveStage);
dealsRouter.delete('/:id',        requireRole(...CRM_MANAGERS), c.remove);
