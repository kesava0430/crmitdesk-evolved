import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler';
import { prisma } from '../../utils/prisma';
import { seedAllDemoOrgs, VERTICALS, loginEmailFor } from '../../utils/seedDemoData';

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

/**
 * Which verticals are actually seeded right now.
 *
 * A vertical is only usable if BOTH its org and its admin login exist — the
 * seed deletes an org before rebuilding it, so a failed run can leave neither.
 * One query for each rather than eight round trips.
 */
async function availability(): Promise<Map<string, boolean>> {
  const slugs = VERTICALS.map(v => v.slug);
  const emails = slugs.map(loginEmailFor);

  const [orgs, users] = await Promise.all([
    prisma.organization.findMany({ where: { slug: { in: slugs } }, select: { slug: true } }),
    prisma.user.findMany({ where: { email: { in: emails }, isActive: true }, select: { email: true } }),
  ]);

  const haveOrg = new Set(orgs.map(o => o.slug));
  const haveUser = new Set(users.map(u => u.email));

  return new Map(VERTICALS.map(v => [v.slug, haveOrg.has(v.slug) && haveUser.has(loginEmailFor(v.slug))]));
}

/**
 * GET /demo/verticals — public list for the /demo landing page's picker.
 *
 * Now reports `available` per vertical. Previously this returned the static
 * VERTICALS array regardless of what was in the database, so the landing page
 * cheerfully offered eight demos even when none had been seeded — and every
 * click failed with a message telling the visitor to wait for something that
 * was never going to happen on its own.
 */
export async function listVerticals(_req: Request, res: Response, next: NextFunction) {
  try {
    const avail = await availability();
    res.json(
      VERTICALS.map(v => ({
        slug: v.slug,
        orgName: v.orgName,
        industry: v.industry,
        primaryColor: v.primaryColor,
        currency: v.currency ?? 'USD',
        available: avail.get(v.slug) ?? false,
      }))
    );
  } catch (err) { next(err); }
}

/**
 * GET /demo/status — is the demo actually usable, and if not, what fixes it.
 *
 * Exists because "the demo is warming up" is a dead end when the real answer is
 * "nothing has been seeded". Public and read-only: which demo orgs exist is not
 * sensitive, and being able to check it without a login is the entire point.
 */
export async function demoStatus(_req: Request, res: Response, next: NextFunction) {
  try {
    const avail = await availability();
    const ready = [...avail.values()].filter(Boolean).length;

    // Distinguish "not seeded" from "migration never ran", because the fix is
    // different and the error otherwise looks identical from the outside.
    let peoplePlatform = true;
    try {
      await prisma.employee.findFirst({ select: { id: true } });
    } catch {
      peoplePlatform = false;
    }

    res.json({
      ready: ready > 0,
      seeded: ready,
      total: VERTICALS.length,
      peoplePlatformMigrated: peoplePlatform,
      verticals: VERTICALS.map(v => ({ slug: v.slug, orgName: v.orgName, available: avail.get(v.slug) ?? false })),
      hint:
        ready === 0
          ? peoplePlatform
            ? 'No demo organizations exist. Run `npm run db:seed` in the server directory.'
            : 'The people-platform tables are missing. Run `npx prisma migrate dev` and then `npm run db:seed`.'
          : ready < VERTICALS.length
            ? `${VERTICALS.length - ready} vertical(s) are missing. Re-run \`npm run db:seed\` to rebuild them all.`
            : 'All demo organizations are seeded and ready.',
    });
  } catch (err) { next(err); }
}
