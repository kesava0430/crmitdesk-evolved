import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';

const LineSchema = z.object({
  description: z.string().min(1),
  quantity:    z.coerce.number().positive().default(1),
  unitPrice:   z.coerce.number().min(0),
  discount:    z.coerce.number().min(0).max(100).default(0),
});

const QuoteSchema = z.object({
  title:      z.string().min(1),
  dealId:     z.string().optional().nullable(),
  notes:      z.string().optional().nullable(),
  validUntil: z.string().optional().nullable(),
  lines:      z.array(LineSchema).min(1),
});

const include = {
  lines: true,
  deal:  { select: { id: true, title: true } },
  creator: { select: { id: true, name: true } },
};

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { dealId, status } = req.query as Record<string, string>;
    const where: any = { orgId: req.user!.orgId };
    if (dealId) where.dealId = dealId;
    if (status) where.status = status;
    const quotes = await prisma.quote.findMany({ where, include, orderBy: { createdAt: 'desc' } });
    res.json({ data: quotes });
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { lines, ...data } = QuoteSchema.parse(req.body);
    const quote = await prisma.quote.create({
      data: {
        ...data,
        orgId,
        createdBy: req.user!.id,
        dealId: data.dealId ?? undefined,
        notes: data.notes ?? undefined,
        validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
        lines: { create: lines },
      },
      include,
    });
    res.status(201).json(quote);
  } catch (err) { next(err); }
}

export async function getOne(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const quote = await prisma.quote.findFirst({
      where: { id: req.params.id, orgId: req.user!.orgId },
      include,
    });
    if (!quote) throw new AppError(404, 'Quote not found');
    res.json(quote);
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lines, ...data } = QuoteSchema.partial().parse(req.body);
    const quote = await prisma.quote.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!quote) throw new AppError(404, 'Quote not found');

    // Replace lines if provided
    if (lines) {
      await prisma.quoteLine.deleteMany({ where: { quoteId: req.params.id } });
    }
    const updated = await prisma.quote.update({
      where: { id: req.params.id },
      data: {
        ...data,
        dealId: data.dealId ?? undefined,
        notes: data.notes ?? undefined,
        validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
        ...(lines ? { lines: { create: lines } } : {}),
      },
      include,
    });
    res.json(updated);
  } catch (err) { next(err); }
}

export async function changeStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { status } = z.object({
      status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED']),
    }).parse(req.body);
    const quote = await prisma.quote.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!quote) throw new AppError(404, 'Quote not found');
    const updated = await prisma.quote.update({ where: { id: req.params.id }, data: { status }, include });
    res.json(updated);
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.quote.deleteMany({ where: { id: req.params.id, orgId: req.user!.orgId } });
    res.json({ message: 'Quote deleted' });
  } catch (err) { next(err); }
}
