import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { parsePagination, paginate } from '../../../utils/pagination';
import { logAction } from '../../../utils/auditLog';

const Schema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  jobTitle: z.string().optional(),
  accountId: z.string().optional().or(z.literal('')).transform(v => v || undefined),
  source: z.string().optional(),
});

const include = { account: { select: { id: true, name: true } }, owner: { select: { id: true, name: true } } };

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { search, accountId } = req.query as Record<string, string>;
    const pag = parsePagination(req);
    const where: any = { orgId };
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }];
    if (accountId) where.accountId = accountId;
    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: pag.limit, skip: pag.skip }),
      prisma.contact.count({ where }),
    ]);
    res.json(paginate(contacts, total, pag));
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.parse(req.body);
    const contact = await prisma.contact.create({ data: { ...data, orgId: req.user!.orgId, ownerId: req.user!.id }, include });
    logAction(req.user!.id, 'CREATE', 'Contact', contact.id, { name: contact.name, email: contact.email });
    res.status(201).json(contact);
  } catch (err) { next(err); }
}

export async function getOne(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, orgId: req.user!.orgId },
      include: {
        account: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        deals: {
          include: { assignee: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
        activities: {
          include: { createdByUser: { select: { id: true, name: true } } },
          orderBy: { dueAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!contact) throw new AppError(404, 'Contact not found');
    res.json(contact);
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.partial().parse(req.body);
    const contact = await prisma.contact.updateMany({ where: { id: req.params.id, orgId: req.user!.orgId }, data });
    if (contact.count === 0) throw new AppError(404, 'Contact not found');
    const updated = await prisma.contact.findUnique({ where: { id: req.params.id }, include });
    logAction(req.user!.id, 'UPDATE', 'Contact', req.params.id, data as Record<string, unknown>);
    res.json(updated);
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.contact.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    logAction(req.user!.id, 'DELETE', 'Contact', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
}
