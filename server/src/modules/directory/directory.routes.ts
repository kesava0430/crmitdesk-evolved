import { Router, Response, NextFunction } from 'express';
import { authenticate, requireRole, IT_MANAGERS } from '../../middleware/authenticate';
import { AuthRequest } from '../../middleware/authenticate';
import { prisma } from '../../utils/prisma';
import { requireFeature } from '../../utils/licensing';
import type { FeatureKey } from '../../utils/stripe';
import * as c from './directory.controller';

/**
 * SSO / directory-sync CONFIGURATION is Enterprise (or a custom licence with
 * the module) — LIC-8. Grandfathered: an org that already set it up keeps
 * managing it (e.g. rotating an expiring client secret) on any plan, and the
 * Entra sign-in routes in auth.routes.ts are never gated, so nobody who
 * already signs in with Microsoft is ever locked out.
 */
function requireFeatureUnlessConfigured(feature: FeatureKey, alreadyConfigured: (orgId: string) => Promise<boolean>) {
  const gate = requireFeature(feature);
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (await alreadyConfigured(req.user!.orgId)) return next();
      return gate(req, res, next);
    } catch (err) { next(err); }
  };
}
const ssoConfig = requireFeatureUnlessConfigured('sso', async orgId => !!(await prisma.directoryConfig.findUnique({ where: { orgId }, select: { id: true } })));
const directorySync = requireFeatureUnlessConfigured('directory_sync', async orgId => (await prisma.directoryRoleMapping.count({ where: { orgId } })) > 0);

const router = Router();

// Unattended cron target (GitHub Actions → this endpoint, no user session) —
// must be registered BEFORE router.use(authenticate) below, since it's gated
// by its own shared secret instead of a JWT. Mirrors demo.routes.ts's
// POST /demo/reset.
router.post('/sync-all', c.syncAll);

router.use(authenticate);

// Single sign-on is an IT-owned integration, same gating as Slack/Teams.
router.get('/config',    requireRole(...IT_MANAGERS), c.getConfig);
router.put('/config',    requireRole(...IT_MANAGERS), ssoConfig, c.saveConfig);
router.delete('/config', requireRole(...IT_MANAGERS), c.deleteConfig);
router.post('/test',     requireRole(...IT_MANAGERS), ssoConfig, c.testConnection);

router.get('/mappings',       requireRole(...IT_MANAGERS), c.listMappings);
router.post('/mappings',      requireRole(...IT_MANAGERS), directorySync, c.createMapping);
router.patch('/mappings/:id', requireRole(...IT_MANAGERS), directorySync, c.updateMapping);
router.delete('/mappings/:id', requireRole(...IT_MANAGERS), c.deleteMapping);

router.post('/sync',       requireRole(...IT_MANAGERS), directorySync, c.syncNow);
router.get('/sync-logs',   requireRole(...IT_MANAGERS), c.listSyncLogs);

export { router as directoryRouter };
