import { prisma } from './prisma';
import { DEMO_VERTICAL_SLUGS } from './seedDemoData';

/**
 * The public demo orgs (utils/seedDemoData.ts) are open to anyone:
 * POST /api/auth/demo-login hands an anonymous visitor a SUPER_ADMIN session.
 * That is the point of "Try Demo", but it also means anything a demo org can
 * send out is sent on behalf of an unauthenticated stranger — and the
 * platform mailer sends it from OUR domain, dressed in whatever company name
 * and logo the visitor typed into Branding. Inviting victim@anywhere as a
 * user or portal customer turned the demo into a free phishing relay (invites
 * are "essential" mail, so not even the platform send quota applied).
 *
 * So mail from a demo org only goes to the demo's own mailboxes (the seeded
 * @crmitdesk.com / @<vertical>.demo users), unless the operator opts in with
 * DEMO_ORG_EXTERNAL_EMAIL=true. Real orgs are never affected.
 */

const DEMO_SLUGS = new Set(DEMO_VERTICAL_SLUGS);
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { demo: boolean; at: number }>();

/** Seeded demo mailboxes: the default vertical keeps @crmitdesk.com, the rest use @<slug>.demo. */
export function isDemoMailbox(address: string): boolean {
  const domain = address.trim().toLowerCase().split('@').pop() || '';
  return domain === 'crmitdesk.com' || domain.endsWith('.demo');
}

export async function isDemoOrg(orgId: string): Promise<boolean> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.demo;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  const demo = !!org && DEMO_SLUGS.has(org.slug);
  cache.set(orgId, { demo, at: Date.now() });
  return demo;
}

/** True when this message must not leave the platform (see the note above). */
export async function demoOrgMailBlocked(orgId: string | undefined, to: string): Promise<boolean> {
  if (!orgId || process.env.DEMO_ORG_EXTERNAL_EMAIL === 'true') return false;
  const recipients = to.split(',').map(s => s.trim()).filter(Boolean);
  if (recipients.length > 0 && recipients.every(isDemoMailbox)) return false;
  try {
    return await isDemoOrg(orgId);
  } catch {
    return false; // never let a lookup failure stop a real org's mail
  }
}

/** Test hook. */
export function _resetDemoOrgCache(): void { cache.clear(); }
