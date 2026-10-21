import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';

export interface PortalRequest extends Request {
  portal?: { portalUserId: string; orgId: string };
}

export async function authenticatePortal(req: PortalRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Portal token required' });
  const token = auth.slice(7);
  let payload: any;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
  } catch {
    return res.status(401).json({ error: 'Portal token expired or invalid' });
  }
  if (payload?.iss !== 'portal' || !payload.sub || !payload.orgId) return res.status(401).json({ error: 'Invalid portal token' });
  /* Portal sessions last 7 days and used to be checked by signature only, so
     a customer whose portal access was revoked (or removed) kept listing and
     filing tickets until the token ran out. One indexed lookup per request. */
  try {
    const user = await prisma.portalUser.findUnique({ where: { id: payload.sub }, select: { orgId: true, isActive: true } });
    if (!user || !user.isActive || user.orgId !== payload.orgId) {
      return res.status(401).json({ error: 'Portal access has been revoked' });
    }
  } catch (err) { return next(err); }
  req.portal = { portalUserId: payload.sub, orgId: payload.orgId };
  next();
}
