import { Router } from 'express';
import { authenticate, requireRole, IT_MANAGERS } from '../../middleware/authenticate';
import * as c from './directory.controller';

const router = Router();
router.use(authenticate);

// Single sign-on is an IT-owned integration, same gating as Slack/Teams.
router.get('/config',    requireRole(...IT_MANAGERS), c.getConfig);
router.put('/config',    requireRole(...IT_MANAGERS), c.saveConfig);
router.delete('/config', requireRole(...IT_MANAGERS), c.deleteConfig);
router.post('/test',     requireRole(...IT_MANAGERS), c.testConnection);

export { router as directoryRouter };
