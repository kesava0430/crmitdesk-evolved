import { Router } from 'express';
import { authenticate, requireRole, ADMIN } from '../../middleware/authenticate';
import * as c from './apikeys.controller';
import { requireFeature } from '../../utils/licensing';

const router = Router();
router.use(authenticate);

// Only org admin can manage API keys
router.get('/',       requireRole(...ADMIN), c.listKeys);
// Issuing a key is the licensed step (api_access, LIC-8); existing keys keep working.
router.post('/',      requireRole(...ADMIN), requireFeature('api_access'), c.createKey);
router.delete('/:id', requireRole(...ADMIN), c.revokeKey);

export { router as apiKeysRouter };
