import { Router } from 'express';
import { authenticate, requireRole, CRM_STAFF } from '../../middleware/authenticate';
import * as c from './quotes.controller';

const router = Router();
router.use(authenticate);

// CRM staff manage quotes (proposals to customers)
router.get('/',              requireRole(...CRM_STAFF), c.list);
router.post('/',             requireRole(...CRM_STAFF), c.create);
router.get('/:id',           requireRole(...CRM_STAFF), c.getOne);
router.patch('/:id',         requireRole(...CRM_STAFF), c.update);
router.patch('/:id/status',  requireRole(...CRM_STAFF), c.changeStatus);
router.delete('/:id',        requireRole(...CRM_STAFF), c.remove);

export { router as quotesRouter };
