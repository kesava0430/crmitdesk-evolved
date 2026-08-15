import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest, IT_STAFF } from '../../middleware/authenticate';
import {
  scoreLead,
  generateFollowUp,
  analyzeTicketSentiment,
  suggestTicketReply,
  naturalLanguageQuery,
  autoRouteTicket,
  generateKbArticle,
  detectDuplicates,
  summarizeThread,
  estimateResolutionTime,
  predictSlaBreach,
  calculateWinProbability,
  generatePipelineHealth,
  detectChurnRisk,
  generateNurtureSequence,
  parseMeetingNotes,
  generateInsights,
  checkEmailTone,
  parseNaturalLanguageCommand,
  planAiAction,
} from '../../utils/ai';
import { getAiAction, actionMenuForPrompt } from '../../utils/ai-actions';
import { logAction } from '../../utils/auditLog';

function handleAIError(err: any, res: Response): boolean {
  if (err?.status === 429 || err?.code === 'insufficient_quota') {
    res.status(402).json({ error: 'OpenAI quota exceeded. Add billing credits at platform.openai.com.' });
    return true;
  }
  if (err?.status === 401) {
    res.status(401).json({ error: 'Invalid API key. Check GROQ_API_KEY in server/.env and restart the server.' });
    return true;
  }
  return false; // caller must call next(err)
}

// ─── Lead: Score ──────────────────────────────────────────────────────────────

export async function scoreLeadHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        contact: { select: { name: true, email: true, jobTitle: true } },
      },
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const result = await scoreLead(lead);

    await prisma.lead.updateMany({
      where: { id: req.params.id, orgId },
      data: { aiScore: result.score, aiScoreReason: result.reason },
    });

    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Lead: Follow-up Email ────────────────────────────────────────────────────

export async function leadFollowUpHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, orgId },
      include: { contact: { select: { name: true, email: true } } },
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const result = await generateFollowUp({
      type: 'lead',
      title: lead.contact?.name || 'Lead',
      contactName: lead.contact?.name ?? undefined,
      contactEmail: lead.contact?.email ?? undefined,
      notes: lead.notes ?? undefined,
    });
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Deal: Follow-up Email ────────────────────────────────────────────────────

export async function dealFollowUpHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const deal = await prisma.deal.findFirst({
      where: { id: req.params.id, orgId },
      include: { contact: { select: { name: true, email: true } } },
    });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const result = await generateFollowUp({
      type: 'deal',
      title: deal.title,
      stage: deal.stage,
      contactName: deal.contact?.name ?? undefined,
      contactEmail: deal.contact?.email ?? undefined,
      value: Number(deal.value),
    });
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Ticket: Sentiment ────────────────────────────────────────────────────────

export async function ticketSentimentHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ticket = await prisma.ticket.findFirst({ where: { id: req.params.id, orgId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const sentiment = await analyzeTicketSentiment({
      title: ticket.title,
      body: ticket.body,
      priority: ticket.priority,
    });

    await prisma.ticket.updateMany({
      where: { id: req.params.id, orgId },
      data: { sentiment },
    });

    res.json({ sentiment });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Ticket: AI Reply Suggestion ──────────────────────────────────────────────

export async function ticketReplyHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ticket = await prisma.ticket.findFirst({
      where: { id: req.params.id, orgId },
      include: { category: { select: { name: true } } },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Pull up to 3 published KB articles to help the AI
    const articles = await prisma.knowledgeArticle.findMany({
      where: { orgId, status: 'PUBLISHED' },
      select: { title: true, body: true },
      take: 3,
    });

    const reply = await suggestTicketReply(
      {
        title: ticket.title,
        body: ticket.body,
        priority: ticket.priority,
        category: ticket.category?.name ?? null,
      },
      articles
    );
    res.json({ reply });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Ticket: AI Auto-Routing ──────────────────────────────────────────────────

export async function autoRouteHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ticket = await prisma.ticket.findFirst({
      where: { id: req.params.id, orgId },
      include: { category: { select: { name: true } } },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const [categories, agents] = await Promise.all([
      prisma.category.findMany({ where: { orgId }, select: { id: true, name: true } }),
      prisma.user.findMany({
        where: { orgId, role: { in: ['IT_AGENT', 'IT_MANAGER', 'SUPER_ADMIN'] } },
        select: { id: true, name: true, role: true },
      }),
    ]);

    const { apply } = req.body as { apply?: boolean };
    const result = await autoRouteTicket(
      { title: ticket.title, body: ticket.body, priority: ticket.priority },
      categories,
      agents
    );

    if (apply && (result.categoryId || result.agentId)) {
      await prisma.ticket.updateMany({
        where: { id: req.params.id, orgId },
        data: {
          ...(result.categoryId ? { categoryId: result.categoryId } : {}),
          ...(result.agentId ? { assignedTo: result.agentId } : {}),
        },
      });
    }

    res.json({ ...result, applied: apply ?? false });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Natural Language Dashboard Query ────────────────────────────────────────

export async function nlQueryHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { question } = z.object({ question: z.string().min(1).max(500) }).parse(req.body);
    const orgId = req.user!.orgId;

    const [
      totalDeals, openDeals, wonDeals, lostDeals,
      totalContacts, totalTickets, openTickets, resolvedTickets,
      totalLeads, activeLeads,
    ] = await Promise.all([
      prisma.deal.count({ where: { orgId } }),
      prisma.deal.count({ where: { orgId, status: 'OPEN' } }),
      prisma.deal.count({ where: { orgId, status: 'WON' } }),
      prisma.deal.count({ where: { orgId, status: 'LOST' } }),
      prisma.contact.count({ where: { orgId } }),
      prisma.ticket.count({ where: { orgId } }),
      prisma.ticket.count({ where: { orgId, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.ticket.count({ where: { orgId, status: 'RESOLVED' } }),
      prisma.lead.count({ where: { orgId } }),
      prisma.lead.count({ where: { orgId, status: { notIn: ['CONVERTED', 'UNQUALIFIED'] } } }),
    ]);

    // Calculate forecast from open deals
    const openDealData = await prisma.deal.findMany({
      where: { orgId, status: 'OPEN' },
      select: { value: true, probability: true },
    });
    const forecastRevenue = Math.round(
      openDealData.reduce((sum, d) => sum + (Number(d.value) * d.probability / 100), 0)
    );

    const answer = await naturalLanguageQuery(question, {
      totalDeals, openDeals, wonDeals, lostDeals,
      totalContacts, totalTickets, openTickets, resolvedTickets,
      totalLeads, activeLeads, forecastRevenue,
    });

    res.json({ answer, question });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── KB Article Generator ─────────────────────────────────────────────────────
export async function kbArticleHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ticket = await prisma.ticket.findFirst({
      where: { id: req.params.id, orgId },
      include: { category: { select: { name: true } } },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const comments = await prisma.comment.findMany({
      where: { entityType: 'TICKET', entityId: req.params.id },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const result = await generateKbArticle(
      { title: ticket.title, body: ticket.body, priority: ticket.priority, category: ticket.category?.name },
      comments.map(c => ({ body: c.body, author: (c as any).author?.name }))
    );
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Duplicate Detector ───────────────────────────────────────────────────────
export async function duplicateDetectHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { title, body } = z.object({ title: z.string(), body: z.string().optional().default('') }).parse(req.body);
    const orgId = req.user!.orgId;
    const existing = await prisma.ticket.findMany({
      where: { orgId, status: { not: 'RESOLVED' } },
      select: { id: true, title: true, body: true, status: true },
      take: 30,
      orderBy: { createdAt: 'desc' },
    });
    const result = await detectDuplicates({ title, body }, existing);
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Thread Summarizer ────────────────────────────────────────────────────────
export async function summarizeHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ticket = await prisma.ticket.findFirst({ where: { id: req.params.id, orgId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const comments = await prisma.comment.findMany({
      where: { entityType: 'TICKET', entityId: req.params.id },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const summary = await summarizeThread(
      { title: ticket.title, body: ticket.body },
      comments.map(c => ({ body: c.body, author: (c as any).author?.name, createdAt: c.createdAt }))
    );
    res.json({ summary });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Resolution Time Estimator ────────────────────────────────────────────────
export async function estimateHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ticket = await prisma.ticket.findFirst({
      where: { id: req.params.id, orgId },
      include: { category: { select: { name: true } } },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const result = await estimateResolutionTime({
      title: ticket.title, body: ticket.body, priority: ticket.priority, category: ticket.category?.name,
    });
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── SLA Breach Predictor ─────────────────────────────────────────────────────
export async function slaRiskHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ticket = await prisma.ticket.findFirst({ where: { id: req.params.id, orgId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const commentCount = await prisma.comment.count({ where: { entityType: 'TICKET', entityId: req.params.id } });
    const result = await predictSlaBreach({
      title: ticket.title, body: ticket.body, priority: ticket.priority,
      createdAt: ticket.createdAt, slaDeadline: (ticket as any).slaDeadline,
      responseCount: commentCount,
    });
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Deal Win Probability ─────────────────────────────────────────────────────
export async function winProbabilityHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const deal = await prisma.deal.findFirst({
      where: { id: req.params.id, orgId },
      include: { contact: { select: { name: true } } },
    });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const wonCount = await prisma.deal.count({ where: { orgId, status: 'WON' } });
    const totalClosed = await prisma.deal.count({ where: { orgId, status: { in: ['WON','LOST'] } } });
    const orgWinRate = totalClosed > 0 ? Math.round((wonCount / totalClosed) * 100) : 30;
    const daysOpen = Math.floor((Date.now() - new Date(deal.createdAt).getTime()) / 86400000);
    const result = await calculateWinProbability(
      { title: deal.title, value: Number(deal.value), stage: deal.stage, probability: deal.probability, daysOpen, contactName: deal.contact?.name },
      orgWinRate
    );
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Pipeline Health Report ───────────────────────────────────────────────────
export async function pipelineHealthHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const [totalDeals, openDeals, wonDeals, lostDeals] = await Promise.all([
      prisma.deal.count({ where: { orgId } }),
      prisma.deal.count({ where: { orgId, status: 'OPEN' } }),
      prisma.deal.count({ where: { orgId, status: 'WON' } }),
      prisma.deal.count({ where: { orgId, status: 'LOST' } }),
    ]);
    const openDealData = await prisma.deal.findMany({
      where: { orgId, status: 'OPEN' },
      select: { value: true, stage: true, createdAt: true },
    });
    const totalValue = openDealData.reduce((s, d) => s + Number(d.value), 0);
    const now = Date.now();
    const avgDaysOpen = openDealData.length > 0
      ? openDealData.reduce((s, d) => s + (now - new Date(d.createdAt).getTime()) / 86400000, 0) / openDealData.length
      : 0;
    const staleDealCount = openDealData.filter(d => (now - new Date(d.createdAt).getTime()) / 86400000 > 14).length;
    const stageMap: Record<string, { count: number; value: number }> = {};
    for (const d of openDealData) {
      if (!stageMap[d.stage]) stageMap[d.stage] = { count: 0, value: 0 };
      stageMap[d.stage].count++;
      stageMap[d.stage].value += Number(d.value);
    }
    const stageBreakdown = Object.entries(stageMap).map(([stage, v]) => ({ stage, ...v }));
    const result = await generatePipelineHealth({ totalDeals, openDeals, wonDeals, lostDeals, totalValue, avgDaysOpen: Math.round(avgDaysOpen), staleDealCount, stageBreakdown });
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Churn Risk ───────────────────────────────────────────────────────────────
export async function churnRiskHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const contact = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const recentTickets = await prisma.ticket.findMany({
      where: { orgId },
      select: { sentiment: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const result = await detectChurnRisk(
      { name: contact.name, createdAt: contact.createdAt },
      recentTickets
    );
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Nurture Sequence ─────────────────────────────────────────────────────────
export async function nurtureSequenceHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, orgId },
      include: { contact: { select: { name: true, email: true } } },
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const result = await generateNurtureSequence({
      status: lead.status, source: lead.source, notes: lead.notes,
      contactName: lead.contact?.name, contactEmail: lead.contact?.email ?? undefined,
    });
    res.json({ sequence: result });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Meeting Notes Parser ─────────────────────────────────────────────────────
export async function meetingNotesHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { notes } = z.object({ notes: z.string().min(10).max(10000) }).parse(req.body);
    const result = await parseMeetingNotes(notes);
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── AI Insights ──────────────────────────────────────────────────────────────
export async function insightsHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const now = Date.now();
    const weekAgo = new Date(now - 7 * 86400000);
    const [openDeals, openTickets, recentTickets, weeklyLeads, unfollowedLeads] = await Promise.all([
      prisma.deal.findMany({ where: { orgId, status: 'OPEN' }, select: { value: true, createdAt: true } }),
      prisma.ticket.findMany({ where: { orgId, status: { in: ['OPEN','IN_PROGRESS'] } }, select: { createdAt: true } }),
      prisma.ticket.count({ where: { orgId, createdAt: { gte: weekAgo } } }),
      prisma.lead.count({ where: { orgId, createdAt: { gte: weekAgo } } }),
      prisma.lead.count({ where: { orgId, status: 'NEW' } }),
    ]);
    // Count SLA-breached tickets: slaDueAt is past and ticket is not resolved/closed
    const slaBreached = await prisma.ticket.count({
      where: { orgId, slaDueAt: { lt: new Date() }, status: { notIn: ['RESOLVED', 'CLOSED'] } },
    });
    const staleDealCount = openDeals.filter(d => (now - new Date(d.createdAt).getTime()) / 86400000 > 14).length;
    const staleDealValue = openDeals.filter(d => (now - new Date(d.createdAt).getTime()) / 86400000 > 14).reduce((s, d) => s + Number(d.value), 0);
    const avgTicketAgeHours = openTickets.length > 0 ? openTickets.reduce((s, t) => s + (now - new Date(t.createdAt).getTime()) / 3600000, 0) / openTickets.length : 0;
    const negativeTickets = await prisma.ticket.count({ where: { orgId, sentiment: { in: ['NEGATIVE','FRUSTRATED'] }, status: { not: 'RESOLVED' } } });
    const result = await generateInsights({ staleDealCount, staleDealValue: Math.round(staleDealValue), openTickets: openTickets.length, avgTicketAgeHours: Math.round(avgTicketAgeHours), slaBreachedCount: slaBreached, weeklyTicketGrowth: recentTickets, weeklyLeadsGrowth: weeklyLeads, unfollowedLeads, topNegativeTickets: negativeTickets });
    res.json({ insights: result });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Tone Checker ─────────────────────────────────────────────────────────────
export async function toneCheckHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { subject, body, context } = z.object({
      subject: z.string(),
      body: z.string().min(10),
      context: z.string().optional(),
    }).parse(req.body);
    const result = await checkEmailTone({ subject, body, context });
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Natural Language Command (AI CRUD) ───────────────────────────────────────
export async function nlCommandHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { command } = z.object({ command: z.string().min(3).max(500) }).parse(req.body);
    const orgId = req.user!.orgId;
    const [users, categories, contacts] = await Promise.all([
      prisma.user.findMany({ where: { orgId }, select: { id: true, name: true }, take: 20 }),
      prisma.category.findMany({ where: { orgId }, select: { id: true, name: true } }),
      prisma.contact.findMany({ where: { orgId }, select: { id: true, name: true }, take: 30, orderBy: { createdAt: 'desc' } }),
    ]);
    const result = await parseNaturalLanguageCommand(command, { users, categories, contacts });
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Ticket: Auto-Tag ─────────────────────────────────────────────────────────
export async function autoTagHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const ticket = await prisma.ticket.findFirst({
      where: { id: req.params.id, orgId },
      include: { category: { select: { name: true } } },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const { autoTagTicket } = await import('../../utils/ai');
    const tags = await autoTagTicket({
      title: ticket.title,
      body: ticket.body ?? '',
      category: (ticket.category as any)?.name ?? null,
    });
    res.json({ tags });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Contact: Health Score ────────────────────────────────────────────────────
export async function contactHealthHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        deals: { select: { value: true, stage: true } },
        activities: { select: { id: true }, take: 100 },
      },
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const { scoreContactHealth } = await import('../../utils/ai');
    const openDealValue = (contact.deals as any[])
      .filter((d: any) => !['Won', 'Lost'].includes(d.stage))
      .reduce((sum: number, d: any) => sum + Number(d.value || 0), 0);

    const result = await scoreContactHealth({
      name: contact.name,
      createdAt: contact.createdAt,
      lastActivityAt: (contact as any).lastActivityAt ?? null,
      dealCount: (contact.deals as any[]).length,
      openDealValue,
      ticketCount: (contact.activities as any[]).length,
      negativeTickets: 0,
    });
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Deal: Predict Close Date ─────────────────────────────────────────────────
export async function dealCloseDateHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const deal = await prisma.deal.findFirst({ where: { id: req.params.id, orgId } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // Calculate historical avg close days from won deals
    const wonDeals = await prisma.deal.findMany({
      where: { orgId, stage: 'Won' },
      select: { createdAt: true, updatedAt: true },
      take: 50,
    });
    const avgDays = wonDeals.length > 0
      ? wonDeals.reduce((s, d) => s + (d.updatedAt.getTime() - d.createdAt.getTime()) / 86400000, 0) / wonDeals.length
      : 30;

    const { predictDealCloseDate } = await import('../../utils/ai');
    const result = await predictDealCloseDate({
      title: deal.title,
      stage: deal.stage,
      value: Number(deal.value),
      probability: deal.probability ?? 50,
      daysOpen: Math.floor((Date.now() - deal.createdAt.getTime()) / 86400000),
      expectedCloseDate: deal.closeDate ?? null,
      notes: null,
    }, Math.round(avgDays));
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Ticket/Deal/Lead: Competitor Detection ───────────────────────────────────
export async function competitorDetectHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rawText = req.body?.text;
    if (!rawText || typeof rawText !== 'string') {
      return res.status(400).json({ error: 'text field is required' });
    }
    const { text, competitors } = z.object({
      text: z.string().min(1).max(5000),
      competitors: z.array(z.string()).optional(),
    }).parse(req.body);
    const { detectCompetitorMentions } = await import('../../utils/ai');
    const result = await detectCompetitorMentions(text, competitors);
    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── Leads: Bulk Score ────────────────────────────────────────────────────────
export async function bulkScoreHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const leads = await prisma.lead.findMany({
      where: { orgId, aiScore: null },
      include: { contact: { select: { name: true } } },
      take: 50,
    });
    if (leads.length === 0) return res.json({ scored: 0, message: 'All leads already scored' });

    const { bulkScoreLeads } = await import('../../utils/ai');
    const scored = await bulkScoreLeads(leads.map(l => ({
      id: l.id,
      status: l.status,
      source: l.source,
      notes: l.notes,
      contactName: (l.contact as any)?.name,
      daysOld: Math.floor((Date.now() - l.createdAt.getTime()) / 86400000),
    })));

    // Persist scores
    await Promise.all(scored.map(s =>
      prisma.lead.updateMany({ where: { id: s.id, orgId }, data: { aiScore: s.score, aiScoreReason: s.reason } })
    ));
    res.json({ scored: scored.length, results: scored });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── AI Actions: Plan (parse only — no mutation) ─────────────────────────────
// Companion to nlCommandHandler above, but for the whitelisted action
// registry (state changes / reminders / notes / scoring / toggles) rather
// than the 5-entity create/update flow. This endpoint never writes anything
// — it only asks the model to pick an action + params, which the client then
// shows to the user to confirm before calling executeActionHandler below.
export async function planActionHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { command } = z.object({ command: z.string().min(3).max(500) }).parse(req.body);
    const orgId = req.user!.orgId;

    const [deals, tickets, leads, rules, contacts, modules, assignableUsers] = await Promise.all([
      prisma.deal.findMany({ where: { orgId }, select: { id: true, title: true, stage: true }, take: 25, orderBy: { updatedAt: 'desc' } }),
      prisma.ticket.findMany({ where: { orgId }, select: { id: true, title: true, status: true }, take: 25, orderBy: { updatedAt: 'desc' } }),
      prisma.lead.findMany({ where: { orgId }, select: { id: true, contact: { select: { name: true } } }, take: 25, orderBy: { createdAt: 'desc' } }),
      prisma.workflowRule.findMany({ where: { orgId }, select: { id: true, name: true, isActive: true }, take: 25 }),
      prisma.contact.findMany({ where: { orgId }, select: { id: true, name: true }, take: 25, orderBy: { createdAt: 'desc' } }),
      // Active modules only, but deliberately NOT filtered to "has fields" —
      // unlike the sidebar's nav injection (AppLayout.tsx), a fieldless
      // module is still a valid target here: it's exactly what
      // ADD_CUSTOM_MODULE_FIELD needs to add someone's first field to a
      // module they just created via CREATE_CUSTOM_MODULE.
      prisma.customModule.findMany({
        where: { orgId, isActive: true },
        select: { id: true, name: true, fields: { select: { fieldKey: true, label: true, fieldType: true }, orderBy: { position: 'asc' } } },
        take: 25,
      }),
      // For ASSIGN_TICKET's name -> id resolution — same role set tickets
      // are normally assigned to (IT_STAFF), not every org member.
      prisma.user.findMany({ where: { orgId, isActive: true, role: { in: [...IT_STAFF] } }, select: { id: true, name: true }, take: 50 }),
    ]);

    const plan = await planAiAction(command, {
      actions: actionMenuForPrompt(),
      deals,
      tickets,
      leads: leads.map(l => ({ id: l.id, name: (l as any).contact?.name || 'Unknown' })),
      rules,
      contacts,
      modules,
      assignableUsers,
    });

    // Filter to what this user's role is actually allowed to run, so the
    // confirm card never shows an action the execute step will just reject.
    const actionDef = plan.action ? getAiAction(plan.action) : undefined;
    const allowed = actionDef ? actionDef.allowedRoles.includes(req.user!.role as any) : true;

    res.json({
      ...plan,
      allowed,
      label: actionDef?.label,
      requiresConfirmation: actionDef?.requiresConfirmation ?? true,
    });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── AI Actions: Execute (re-validates everything, then runs) ───────────────
export async function executeActionHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { action, params, command } = z.object({
      action: z.string().min(1),
      params: z.record(z.any()).default({}),
      command: z.string().optional(),
    }).parse(req.body);

    const actionDef = getAiAction(action);
    if (!actionDef) return res.status(404).json({ error: `Unknown action: ${action}` });

    // The model's own opinion of what's allowed is never trusted — the role
    // check happens here, server-side, against the actual logged-in user,
    // exactly like every other mutating endpoint in the app.
    if (!actionDef.allowedRoles.includes(req.user!.role as any)) {
      return res.status(403).json({ error: `Your role isn't permitted to run "${actionDef.label}"` });
    }

    const parsedParams = actionDef.schema.parse(params);
    const result = await actionDef.handler(parsedParams, { orgId: req.user!.orgId, userId: req.user!.id });

    logAction(req.user!.id, 'UPDATE', `AI:${action}`, (parsedParams as any).dealId || (parsedParams as any).ticketId || (parsedParams as any).leadId || (parsedParams as any).ruleId || (parsedParams as any).moduleId || (parsedParams as any).entityId || 'n/a', {
      viaAI: true,
      command,
      params: parsedParams,
    });

    res.json(result);
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}

// ─── AI Feature Builder: List Rules ──────────────────────────────────────────
export async function listAIRulesHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const rules = await (prisma as any).aICustomRule.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' } });
    res.json(rules);
  } catch (err: any) { next(err); }
}

// ─── AI Feature Builder: Create Rule ─────────────────────────────────────────
export async function createAIRuleHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const body = z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      trigger: z.enum(['TICKET_CREATED', 'LEAD_SCORED', 'DEAL_STAGE_CHANGED', 'CONTACT_UPDATED', 'TICKET_RESOLVED', 'MANUAL']),
      action: z.enum(['TAG', 'ROUTE', 'EMAIL', 'NOTIFY', 'SCORE', 'SUMMARIZE', 'CUSTOM_PROMPT']),
      customPrompt: z.string().optional(),
      outputField: z.string().optional(),
      isActive: z.boolean().default(true),
    }).parse(req.body);
    const rule = await (prisma as any).aICustomRule.create({ data: { ...body, orgId } });
    res.status(201).json(rule);
  } catch (err: any) { next(err); }
}

// ─── AI Feature Builder: Update Rule ─────────────────────────────────────────
export async function updateAIRuleHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const body = z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().optional(),
      trigger: z.enum(['TICKET_CREATED', 'LEAD_SCORED', 'DEAL_STAGE_CHANGED', 'CONTACT_UPDATED', 'TICKET_RESOLVED', 'MANUAL']).optional(),
      action: z.enum(['TAG', 'ROUTE', 'EMAIL', 'NOTIFY', 'SCORE', 'SUMMARIZE', 'CUSTOM_PROMPT']).optional(),
      customPrompt: z.string().optional(),
      outputField: z.string().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);
    // updateMany returns { count } — use update to return the full record
    const existing = await (prisma as any).aICustomRule.findFirst({ where: { id: req.params.id, orgId } });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    const rule = await (prisma as any).aICustomRule.update({ where: { id: req.params.id }, data: body });
    res.json(rule);
  } catch (err: any) { next(err); }
}

// ─── AI Feature Builder: Delete Rule ─────────────────────────────────────────
export async function deleteAIRuleHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    await (prisma as any).aICustomRule.deleteMany({ where: { id: req.params.id, orgId } });
    res.status(204).end();
  } catch (err: any) { next(err); }
}

// ─── AI Feature Builder: Test/Run Rule ───────────────────────────────────────
export async function runAIRuleHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const { entityType, entityId, inputText } = z.object({
      entityType: z.enum(['ticket', 'lead', 'deal', 'contact']).optional(),
      entityId: z.string().optional(),
      inputText: z.string().optional(),
    }).parse(req.body);

    const rule = await (prisma as any).aICustomRule.findFirst({ where: { id: req.params.id, orgId } });
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    // Execute the custom prompt against entity data or provided text
    const OpenAI = (await import('openai')).default;
    const client = process.env.GROQ_API_KEY
      ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' })
      : process.env.OPENAI_API_KEY
        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        : null;
    if (!client) return res.json({ result: 'AI not configured — add GROQ_API_KEY or OPENAI_API_KEY to .env' });

    const context = inputText || `Entity: ${entityType} (${entityId})`;
    const model = process.env.GROQ_API_KEY ? 'llama-3.3-70b-versatile' : 'gpt-4o';
    const aiRes = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: rule.customPrompt || 'You are a helpful CRM AI assistant.' },
        { role: 'user', content: context },
      ],
      temperature: 0.4,
      max_tokens: 800,
    });
    const output = aiRes.choices[0]?.message?.content?.trim() || '';
    res.json({ output, result: output, rule: rule.name });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}
