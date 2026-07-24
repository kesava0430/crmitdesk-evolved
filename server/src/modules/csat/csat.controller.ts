import { Response, NextFunction, Request } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';

// ─── Public: submit CSAT rating (no auth — linked from email) ────────────────

export async function submitRating(req: Request, res: Response, next: NextFunction) {
  try {
    const { ticketId } = req.params;
    const { rating, comment } = z.object({
      rating:  z.number().int().min(1).max(5),
      comment: z.string().max(1000).optional(),
    }).parse(req.body);

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new AppError(404, 'Ticket not found');

    // One response per ticket
    const existing = await prisma.csatResponse.findFirst({ where: { ticketId } });
    if (existing) return res.json({ message: 'Rating already submitted', rating: existing.rating });

    const response = await prisma.csatResponse.create({
      data: { orgId: ticket.orgId, ticketId, rating, comment },
    });
    res.status(201).json({ message: 'Thank you for your feedback!', rating: response.rating });
  } catch (err) { next(err); }
}

// ─── Admin: list CSAT responses ───────────────────────────────────────────────

export async function listResponses(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);

    const [data, total] = await Promise.all([
      prisma.csatResponse.findMany({
        where: { orgId },
        orderBy: { submittedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          ticket: { select: { id: true, title: true, status: true } },
        },
      }),
      prisma.csatResponse.count({ where: { orgId } }),
    ]);
    res.json({ data, total, page, limit });
  } catch (err) { next(err); }
}

// ─── Admin: CSAT analytics ────────────────────────────────────────────────────

export async function csatStats(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const responses = await prisma.csatResponse.findMany({ where: { orgId }, select: { rating: true } });
    const total = responses.length;
    const avg = total ? responses.reduce((s, r) => s + r.rating, 0) / total : 0;
    const dist = [1, 2, 3, 4, 5].map(r => ({
      rating: r,
      count: responses.filter(x => x.rating === r).length,
    }));
    const satisfied = responses.filter(r => r.rating >= 4).length;
    const satisfactionRate = total ? Math.round((satisfied / total) * 100) : 0;

    res.json({ total, avg: Math.round(avg * 10) / 10, dist, satisfactionRate });
  } catch (err) { next(err); }
}
