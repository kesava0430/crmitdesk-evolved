import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';

const RuleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  trigger: z.enum([
    'TICKET_CREATED', 'TICKET_UPDATED', 'TICKET_STATUS_CHANGED',
    'LEAD_CREATED', 'LEAD_STATUS_CHANGED',
    'DEAL_STAGE_CHANGED', 'DEAL_WON', 'DEAL_LOST',
    'SLA_BREACH',
  ]),
  conditions: z.array(z.object({
    field: z.string(),
    operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains', 'in']),
    value: z.union([z.string(), z.number(), z.array(z.string())]),
  })),
  actions: z.array(z.object({
    // SEND_WHATSAPP was added to the workflow engine's execution switch and
    // the client's action-type list, but not here — this schema gates the
    // create/update endpoint itself, so a rule using it was silently
    // rejected by Zod (400) before ever reaching the engine. The dialog
    // appearing to "hang open" on save was this validation failure, not a
    // UI bug.
    type: z.enum(['ASSIGN_TO', 'SET_PRIORITY', 'SET_STATUS', 'SEND_EMAIL', 'SEND_WHATSAPP', 'ADD_NOTE', 'SEND_WEBHOOK', 'SCORE_LEAD']),
    params: z.record(z.union([z.string(), z.number()])),
  })),
  isActive: z.boolean().default(true),
});

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const rules = await prisma.workflowRule.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { logs: true } } },
    });
    res.json(rules);
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const data = RuleSchema.parse(req.body);
    const rule = await prisma.workflowRule.create({ data: { ...data, orgId } });
    res.status(201).json(rule);
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const orgId = req.user!.orgId;
    const data = RuleSchema.partial().parse(req.body);
    const rule = await prisma.workflowRule.findFirst({ where: { id, orgId } });
    if (!rule) throw new AppError(404, 'Rule not found');
    const updated = await prisma.workflowRule.update({ where: { id }, data });
    res.json(updated);
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const orgId = req.user!.orgId;
    await prisma.workflowRule.deleteMany({ where: { id, orgId } });
    res.json({ message: 'Rule deleted' });
  } catch (err) { next(err); }
}

export async function getLogs(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const orgId = req.user!.orgId;
    const rule = await prisma.workflowRule.findFirst({ where: { id, orgId } });
    if (!rule) throw new AppError(404, 'Rule not found');
    const logs = await prisma.workflowLog.findMany({
      where: { ruleId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(logs);
  } catch (err) { next(err); }
}

export async function toggleActive(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const orgId = req.user!.orgId;
    const rule = await prisma.workflowRule.findFirst({ where: { id, orgId } });
    if (!rule) throw new AppError(404, 'Rule not found');
    const updated = await prisma.workflowRule.update({ where: { id }, data: { isActive: !rule.isActive } });
    res.json(updated);
  } catch (err) { next(err); }
}
