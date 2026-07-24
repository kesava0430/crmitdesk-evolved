import { Response, NextFunction } from 'express';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';

export async function search(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const q = (req.query.q as string || '').trim();
    if (!q || q.length < 2) return res.json({ contacts: [], deals: [], tickets: [], leads: [] });

    const orgId = req.user!.orgId;
    const mode = 'insensitive' as const;

    const [contacts, deals, tickets, leads] = await Promise.all([
      prisma.contact.findMany({
        where: { orgId, OR: [{ name: { contains: q, mode } }, { email: { contains: q, mode } }] },
        select: { id: true, name: true, email: true, jobTitle: true },
        take: 5,
      }),
      prisma.deal.findMany({
        where: { orgId, title: { contains: q, mode } },
        select: { id: true, title: true, stage: true, value: true, status: true },
        take: 5,
      }),
      prisma.ticket.findMany({
        where: { orgId, OR: [{ title: { contains: q, mode } }, { body: { contains: q, mode } }] },
        select: { id: true, title: true, status: true, priority: true },
        take: 5,
      }),
      prisma.lead.findMany({
        where: { orgId, contact: { name: { contains: q, mode } } },
        select: { id: true, status: true, source: true, contact: { select: { name: true, email: true } } },
        take: 5,
      }),
    ]);

    res.json({ contacts, deals, tickets, leads });
  } catch (err) { next(err); }
}
