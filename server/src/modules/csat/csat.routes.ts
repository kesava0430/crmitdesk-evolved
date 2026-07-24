import { Router } from 'express';
import { authenticate, requireRole, IT_MANAGERS } from '../../middleware/authenticate';
import * as c from './csat.controller';

const router = Router();

// Public: customer submits rating via emailed link (no auth)
router.post('/submit/:ticketId', c.submitRating);

router.use(authenticate);
// Only IT managers can view CSAT analytics
router.get('/',       requireRole(...IT_MANAGERS), c.listResponses);
router.get('/stats',  requireRole(...IT_MANAGERS), c.csatStats);

export { router as csatRouter };
