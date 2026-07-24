import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { parsePagination, paginate } from '../../../utils/pagination';

const Schema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  // The "— none —" option in the category <select> submits '' rather than
  // omitting the field; without this coercion Prisma tries to link a
  // Category row with id '', which violates the FK constraint and 500s
  // (same fix already applied in contacts/deals/leads/tickets controllers).
  // Also accepts null: editing an article re-submits the full fetched
  // article, and an uncategorized article's categoryId comes back from
  // Prisma as null (not omitted) — without .nullable() that 400s too
  // (same issue as the Business Context categoryId/terminology fields).
  categoryId: z.string().nullable().optional().or(z.literal('')).transform(v => v || undefined),
  status: z.enum(['DRAFT','PUBLISHED','ARCHIVED']).optional(),
});

const include = {
  author: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
};

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { status, search } = req.query as Record<string, string>;
    const where: any = { orgId };
    if (status) where.status = status;
    else where.status = 'PUBLISHED';
    if (search) where.title = { contains: search, mode: 'insensitive' };
    if (['IT_AGENT','IT_MANAGER','SUPER_ADMIN'].includes(req.user!.role) && req.query.all) delete where.status;
    const pag = parsePagination(req);
    const [articles, total] = await Promise.all([
      prisma.knowledgeArticle.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: pag.limit, skip: pag.skip }),
      prisma.knowledgeArticle.count({ where }),
    ]);
    res.json(paginate(articles, total, pag));
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.parse(req.body);
    const article = await prisma.knowledgeArticle.create({
      data: { ...data, orgId: req.user!.orgId, authorId: req.user!.id, publishedAt: data.status === 'PUBLISHED' ? new Date() : undefined },
      include
    });
    res.status(201).json(article);
  } catch (err) { next(err); }
}

export async function getOne(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const article = await prisma.knowledgeArticle.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId }, include });
    if (!article) throw new AppError(404, 'Article not found');
    res.json(article);
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = Schema.partial().parse(req.body);
    await prisma.knowledgeArticle.updateMany({ where: { id: req.params.id, orgId: req.user!.orgId }, data: { ...data, publishedAt: data.status === 'PUBLISHED' ? new Date() : undefined } });
    const article = await prisma.knowledgeArticle.findUnique({ where: { id: req.params.id }, include });
    res.json(article);
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.knowledgeArticle.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
}
