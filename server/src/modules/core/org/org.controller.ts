import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';

const UpdateSchema = z.object({
  name: z.string().min(2).optional(),
});

export async function getOrg(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.orgId },
      include: { _count: { select: { users: true, contacts: true, deals: true, tickets: true } } },
    });
    if (!org) throw new AppError(404, 'Organization not found');
    res.json(org);
  } catch (err) { next(err); }
}

export async function updateOrg(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = UpdateSchema.parse(req.body);
    const org = await prisma.organization.update({ where: { id: req.user!.orgId }, data });
    res.json(org);
  } catch (err) { next(err); }
}

export async function listInvites(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const invites = await prisma.inviteToken.findMany({
      where: { orgId: req.user!.orgId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(invites);
  } catch (err) { next(err); }
}
