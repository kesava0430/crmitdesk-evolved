import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';

const Schema = z.object({
  type: z.enum(['CALL','EMAIL','MEETING','TASK']),
  title: z.string().min(1),
  body: z.string().optional(),
  dealId: z.string().optional(),
  contactId: z.string().optional(),
  dueAt: z.string().optional(),
  done: z.boolean().optional(),
});

const include = { createdByUser: { select: { id: true, name: true } } };

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { dealId, contactId } = req.query as Record<string, string>;
    const where: any = { orgId };
    if (dealId) where.dealId = dealId;
    if (contactId) where.contactId = contactId;
    const activities = await prisma.activity.findMany({ where, include, orderBy: { createdAt: 'desc' } });
    res.json(activities);
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.parse(req.body);
    const activity = await prisma.activity.create({
      data: {
        ...data,
        dueAt: data.dueAt ? new Date(data.dueAt) : undefined,
        createdBy: req.user!.id,
        orgId: req.user!.orgId,
      },
      include,
    });
    res.status(201).json(activity);
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.partial().parse(req.body);
    await prisma.activity.updateMany({
      where: { id: req.params.id, orgId: req.user!.orgId },
      data: { ...data, dueAt: data.dueAt ? new Date(data.dueAt) : undefined },
    });
    const activity = await prisma.activity.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId }, include });
    res.json(activity);
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.activity.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
}
