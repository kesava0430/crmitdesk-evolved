import { Router } from 'express';
import { authenticate, requireRole, MANAGERS } from '../../middleware/authenticate';
import * as wf from './workflows.controller';

export const workflowsRouter = Router();
workflowsRouter.use(authenticate);

// Only managers can manage automation rules
workflowsRouter.get('/',              requireRole(...MANAGERS), wf.list);
workflowsRouter.post('/',             requireRole(...MANAGERS), wf.create);
workflowsRouter.put('/:id',           requireRole(...MANAGERS), wf.update);
workflowsRouter.delete('/:id',        requireRole(...MANAGERS), wf.remove);
workflowsRouter.get('/:id/logs',      requireRole(...MANAGERS), wf.getLogs);
workflowsRouter.patch('/:id/toggle',  requireRole(...MANAGERS), wf.toggleActive);
