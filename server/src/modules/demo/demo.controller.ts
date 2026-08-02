import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler';
import { seedAllDemoOrgs, VERTICALS } from '../../utils/seedDemoData';

/**
 * POST /demo/reset — re-seeds every industry-vertical showcase org from
 * scratch (see utils/seedDemoData.ts). No user JWT is involved here — this
 * is meant to be called by an external scheduler (a nightly GitHub Actions
 * workflow) hitting the deployed API directly, so it's gated by a shared
 * secret header instead of a login session.
 *
 * If DEMO_RESET_SECRET isn't set, the endpoint refuses everything (404,
 * rather than 401/403) so its existence isn't even observable — safer
 * default than an accidentally-open reset endpoint on a deployment where
 * nobody got around to setting the secret yet.
 */
export async function resetDemo(req: Request, res: Response, next: NextFunction) {
  try {
    const configuredSecret = process.env.DEMO_RESET_SECRET;
    if (!configuredSecret) {
      throw new AppError(404, 'Not found');
    }
    const providedSecret = req.header('x-demo-reset-secret');
    if (!providedSecret || providedSecret !== configuredSecret) {
      throw new AppError(404, 'Not found');
    }

    const orgs = await seedAllDemoOrgs();
    res.json({ success: true, orgs: orgs.map(o => o.name), resetAt: new Date().toISOString() });
  } catch (err) { next(err); }
}

/** GET /demo/verticals — public list for the /demo landing page's vertical picker. No auth. */
export async function listVerticals(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(VERTICALS.map(v => ({ slug: v.slug, orgName: v.orgName, industry: v.industry, primaryColor: v.primaryColor })));
  } catch (err) { next(err); }
}
