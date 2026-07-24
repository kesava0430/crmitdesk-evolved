import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';

const Schema = z.object({
  name: z.string().min(1),
  responseHours: z.number().int().min(1),
  resolutionHours: z.number().int().min(1),
  priorityOverrides: z.any().optional(),
});

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const policies = await prisma.slaPolicy.findMany({ where: { orgId: req.user!.orgId }, orderBy: { name: 'asc' } });
    res.json(policies);
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.parse(req.body);
    const policy = await prisma.slaPolicy.create({ data: { ...data, orgId: req.user!.orgId } });
    res.status(201).json(policy);
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.partial().parse(req.body);
    await prisma.slaPolicy.updateMany({ where: { id: req.params.id, orgId: req.user!.orgId }, data });
    const policy = await prisma.slaPolicy.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    res.json(policy);
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.slaPolicy.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
}
