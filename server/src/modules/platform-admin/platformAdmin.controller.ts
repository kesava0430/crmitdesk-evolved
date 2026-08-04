import { Response, NextFunction, Request } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../utils/prisma';
import { AppError } from '../../middleware/errorHandler';
import { AuthRequest } from '../../middleware/authenticate';

/**
 * POST /platform/bootstrap — creates (or promotes) the first PLATFORM_ADMIN
 * account. Gated by a shared secret header rather than a login session, same
 * pattern as demo.controller.ts's resetDemo(): if PLATFORM_BOOTSTRAP_SECRET
 * isn't set, the endpoint 404s so its existence isn't observable on a
 * deployment where nobody set the secret yet.
 *
 * Idempotent by email — safe to re-run (e.g. to reset the password) without
 * creating duplicate accounts. orgId is left null: PLATFORM_ADMIN users are
 * not scoped to any Organization (see schema.prisma UserRole comment).
 */
const BootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

export async function bootstrap(req: Request, res: Response, next: NextFunction) {
  try {
    const configuredSecret = process.env.PLATFORM_BOOTSTRAP_SECRET;
    if (!configuredSecret) throw new AppError(404, 'Not found');

    const providedSecret = req.header('x-platform-bootstrap-secret');
    if (!providedSecret || providedSecret !== configuredSecret) {
      throw new AppError(404, 'Not found');
    }

    const { email, password, name } = BootstrapSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.upsert({
      where: { email },
      update: { role: 'PLATFORM_ADMIN', orgId: null, passwordHash, isActive: true },
      create: { email, name, passwordHash, role: 'PLATFORM_ADMIN', orgId: null },
    });

    res.json({ success: true, id: user.id, email: user.email });
  } catch (err) { next(err); }
}

/**
 * GET /platform/orgs — every Organization with the license/branding/sending
 * fields a platform operator needs at a glance. Deliberately omits secrets
 * (EmailAccount.password, WhatsAppConfig.authToken/accountSid) — only
 * connection status and the non-secret identifying fields are surfaced.
 */
export async function listOrgs(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgs = await prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        subscription: true,
        branding: true,
        emailAccount: { select: { email: true, smtpHost: true, lastSyncAt: true } },
        whatsAppConfig: { select: { phoneNumber: true, notifyNumber: true } },
        _count: { select: { users: true, contacts: true, tickets: true } },
      },
    });

    res.json(orgs.map(o => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      plan: o.plan,
      createdAt: o.createdAt,
      subscription: o.subscription
        ? {
            plan: o.subscription.plan,
            status: o.subscription.status,
            seats: o.subscription.seats,
            currentPeriodEnd: o.subscription.currentPeriodEnd,
            cancelAtPeriodEnd: o.subscription.cancelAtPeriodEnd,
            stripeCustomerId: o.subscription.stripeCustomerId,
          }
        : null,
      branding: o.branding
        ? {
            companyName: o.branding.companyName,
            logoUrl: o.branding.logoUrl,
            primaryColor: o.branding.primaryColor,
            supportEmail: o.branding.supportEmail,
          }
        : null,
      emailSending: {
        connected: !!o.emailAccount,
        email: o.emailAccount?.email ?? null,
        smtpHost: o.emailAccount?.smtpHost ?? null,
        lastSyncAt: o.emailAccount?.lastSyncAt ?? null,
      },
      whatsappSending: {
        connected: !!o.whatsAppConfig,
        phoneNumber: o.whatsAppConfig?.phoneNumber ?? null,
        notifyNumber: o.whatsAppConfig?.notifyNumber ?? null,
      },
      counts: { users: o._count.users, contacts: o._count.contacts, tickets: o._count.tickets },
    })));
  } catch (err) { next(err); }
}

/** GET /platform/orgs/:id — fuller detail for a single org, including its staff user list (no password hashes). */
export async function getOrg(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.params.id },
      include: {
        subscription: true,
        branding: true,
        emailAccount: { select: { email: true, imapHost: true, smtpHost: true, smtpPort: true, lastSyncAt: true } },
        whatsAppConfig: { select: { phoneNumber: true, notifyNumber: true, createdAt: true } },
        users: {
          select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { contacts: true, tickets: true, deals: true } },
      },
    });
    if (!org) throw new AppError(404, 'Organization not found');
    res.json(org);
  } catch (err) { next(err); }
}
