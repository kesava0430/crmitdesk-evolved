import { Router } from 'express';
import { authenticate, requireRole, IT_MANAGERS } from '../../middleware/authenticate';
import * as c from './portalUsers.controller';

const router = Router();
router.use(authenticate);

// Only IT managers can manage customer portal accounts
router.get('/',                    requireRole(...IT_MANAGERS), c.list);
router.post('/',                   requireRole(...IT_MANAGERS), c.create);
router.patch('/:id/toggle',        requireRole(...IT_MANAGERS), c.toggleActive);
router.post('/:id/resend-invite',  requireRole(...IT_MANAGERS), c.resendInvite);
router.delete('/:id',              requireRole(...IT_MANAGERS), c.remove);

export { router as portalUsersRouter };
