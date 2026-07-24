import { Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { logAction } from '../../utils/auditLog';

const SCOPES = ['read', 'write', 'admin'] as const;

// ─── Generate a new API key ───────────────────────────────────────────────────

export async function createKey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { name, scopes, expiresAt } = z.object({
      name:      z.string().min(1).max(80),
      scopes:    z.array(z.string()).default([]),
      expiresAt: z.string().optional(),
    }).parse(req.body);

    // Generate: crm_<32 random hex chars>
    const raw = `crm_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
    const keyPrefix = raw.slice(0, 12); // e.g. "crm_a1b2c3d4"

    const key = await prisma.apiKey.create({
      data: {
        orgId,
        name,
        keyHash,
        keyPrefix,
        scopes,
        createdBy: req.user!.id,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      },
    });

    logAction(req.user!.id, 'CREATE', 'ApiKey', key.id, { name: key.name, scopes: key.scopes });
    // Return raw key only once — never stored
    res.status(201).json({ ...key, rawKey: raw });
  } catch (err) { next(err); }
}

export async function listKeys(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { orgId: req.user!.orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, keyPrefix: true, scopes: true,
        lastUsedAt: true, expiresAt: true, createdAt: true,
        creator: { select: { name: true } },
      },
    });
    res.json({ data: keys });
  } catch (err) { next(err); }
}

export async function revokeKey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const deleted = await prisma.apiKey.deleteMany({
      where: { id: req.params.id, orgId: req.user!.orgId },
    });
    if (!deleted.count) throw new AppError(404, 'API key not found');
    logAction(req.user!.id, 'DELETE', 'ApiKey', req.params.id);
    res.json({ message: 'API key revoked' });
  } catch (err) { next(err); }
}

// ─── Middleware: authenticate via X-API-Key header ───────────────────────────

export async function authenticateApiKey(
  req: AuthRequest, res: Response, next: NextFunction,
) {
  const header = req.headers['x-api-key'] as string | undefined;
  if (!header) return next(); // fall through to JWT auth

  const keyHash = crypto.createHash('sha256').update(header).digest('hex');
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });

  if (!apiKey) return res.status(401).json({ error: 'Invalid API key' });
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return res.status(401).json({ error: 'API key expired' });
  }

  // Update last used (fire-and-forget)
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  // Attach minimal user-like context
  req.user = { id: 'api', orgId: apiKey.orgId, role: 'API' as any, email: '' };
  next();
}
