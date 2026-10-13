import { Router } from 'express';
import { authenticate, requireRole, MANAGERS } from '../../middleware/authenticate';
import { requireFeature } from '../../utils/licensing';
import * as wf from './workflows.controller';

export const workflowsRouter = Router();
workflowsRouter.use(authenticate);

// Only managers can manage automation rules. Workflow automation is a Pro+
// feature (utils/licensing.ts). Creating a rule, editing one (an edit can
// rewrite its trigger and actions — effectively a new rule), switching one
// ON and running one by hand are gated; existing ACTIVE rules from a
// since-downgraded org keep running (the engine itself doesn't check plan),
// and listing, logs, deleting and switching a rule OFF stay open — matching
// the grandfathering policy: block new usage, never revoke what's there.
// toggleActive checks the feature itself, only when turning a rule on.
const automation = requireFeature('workflow_automation');
workflowsRouter.get('/',              requireRole(...MANAGERS), wf.list);
workflowsRouter.post('/',             requireRole(...MANAGERS), automation, wf.create);
workflowsRouter.put('/:id',           requireRole(...MANAGERS), automation, wf.update);
workflowsRouter.delete('/:id',        requireRole(...MANAGERS), wf.remove);
workflowsRouter.get('/:id/logs',      requireRole(...MANAGERS), wf.getLogs);
workflowsRouter.patch('/:id/toggle',  requireRole(...MANAGERS), wf.toggleActive);
workflowsRouter.post('/:id/run-now',  requireRole(...MANAGERS), automation, wf.runDateRule);
