import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { encryptSecret } from '../../utils/crypto';
import { entraRedirectUri, testEntraTenant } from '../../utils/entraAuth';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const ConfigSchema = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  // Blank means "keep the existing secret" — the form never round-trips the
  // real secret back to the client (see getConfig below), so a save that
  // doesn't touch this field must not overwrite it with an empty string.
  clientSecret: z.string().optional(),
  loginSlug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers, and hyphens only'),
  isEnabled: z.boolean().default(true),
});

/** GET /directory/config — never returns the actual secret, just whether one is set */
export async function getConfig(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const config = await prisma.directoryConfig.findUnique({ where: { orgId: req.user!.orgId } });
    if (!config) return res.json(null);
    res.json({
      tenantId: config.tenantId,
      clientId: config.clientId,
      hasClientSecret: !!config.clientSecretEnc,
      loginSlug: config.loginSlug,
      isEnabled: config.isEnabled,
      loginUrl: `${FRONTEND_URL}/login/${config.loginSlug}`,
      redirectUri: entraRedirectUri(),
      updatedAt: config.updatedAt,
    });
  } catch (err) { next(err); }
}

export async function saveConfig(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = ConfigSchema.parse(req.body);

    const existing = await prisma.directoryConfig.findUnique({ where: { orgId } });
    if (!data.clientSecret && !existing) {
      throw new AppError(400, 'A client secret is required');
    }

    // Encrypted at most once (previously this could run twice — once for
    // `update`, once for `create` — even though only one of the two branches
    // is ever actually used for a given save).
    const clientSecretEnc = data.clientSecret ? encryptSecret(data.clientSecret) : undefined;

    try {
      const config = await prisma.directoryConfig.upsert({
        where: { orgId },
        create: {
          orgId,
          tenantId: data.tenantId,
          clientId: data.clientId,
          clientSecretEnc: clientSecretEnc!, // guaranteed set — see the `existing` check above
          loginSlug: data.loginSlug,
          isEnabled: data.isEnabled,
        },
        update: {
          tenantId: data.tenantId,
          clientId: data.clientId,
          loginSlug: data.loginSlug,
          isEnabled: data.isEnabled,
          ...(clientSecretEnc ? { clientSecretEnc } : {}),
        },
      });
      res.json({
        tenantId: config.tenantId, clientId: config.clientId, hasClientSecret: true,
        loginSlug: config.loginSlug, isEnabled: config.isEnabled,
        loginUrl: `${FRONTEND_URL}/login/${config.loginSlug}`, redirectUri: entraRedirectUri(),
        updatedAt: config.updatedAt,
      });
    } catch (err: any) {
      if (err.code === 'P2002') throw new AppError(409, 'That sign-in link is already taken — choose a different one');
      throw err;
    }
  } catch (err) { next(err); }
}

export async function deleteConfig(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.directoryConfig.deleteMany({ where: { orgId: req.user!.orgId } });
    res.json({ message: 'Single sign-on disconnected' });
  } catch (err) { next(err); }
}

/** POST /directory/test — confirms the tenant ID is real/reachable; can't validate the client secret without a real sign-in */
export async function testConnection(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const config = await prisma.directoryConfig.findUnique({ where: { orgId: req.user!.orgId } });
    if (!config) return res.status(400).json({ error: 'No single sign-on configuration found' });
    const result = await testEntraTenant(config.tenantId);
    if (!result.ok) return res.status(400).json({ error: result.error || 'Could not reach that tenant' });
    res.json({ message: 'Tenant found — client ID and secret are verified the first time someone signs in.' });
  } catch (err) { next(err); }
}
