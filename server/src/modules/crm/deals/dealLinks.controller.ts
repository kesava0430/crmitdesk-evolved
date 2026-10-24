/**
 * Related deals: the org's matching rule, the Related deals panel, the
 * board/create-form hints, and the "Lessons from related deals" AI card.
 * Logic lives in utils/dealLinks/; this file is request handling only.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { getPermCtx, can, canAccessRecord, PermCtx } from '../../../utils/permissions';
import { isModuleBlocked } from '../../../utils/licensing';
import { logAction } from '../../../utils/auditLog';
import { LinkRuleSchema, dedupeFields, MatchableDeal, normaliseValue } from '../../../utils/dealLinks/match';
import {
  loadRule, dealCustomFields, matchableDeal, sharedOnLabels, findRelatedDeals, gatherLessonDeals,
  outcomeCountsFor, DescribedRule,
} from '../../../utils/dealLinks/service';
import {
  buildLessonsPrompt, checkLessons, LessonsReplySchema, replyProblems, LESSONS_MAX_TOKENS, LessonsResult,
} from '../../../utils/dealLinks/lessons';
import { analysePastDealsJson } from '../../../utils/ai';
import { readPersistentCache, writePersistentCache } from '../../../utils/aiCache';
import { aiConfigSource, AI_NOT_CONFIGURED_MESSAGE } from '../../../utils/aiStatus';
import { recordUsage } from '../../../utils/usageTracking';
import { handleAIError } from '../../ai/ai.controller';

const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'CRM_MANAGER']);

/** The deal, if it is in the org and the viewer's deal scope; else 404 (no existence leak). */
async function visibleDeal(ctx: PermCtx, id: string) {
  if (!can(ctx, 'crm.deal.read')) throw new AppError(403, 'Insufficient permissions');
  const deal = await prisma.deal.findFirst({
    where: { id, orgId: ctx.orgId },
    select: { id: true, title: true, status: true, stage: true, value: true, assignedTo: true, accountId: true, contactId: true, pipelineId: true },
  });
  if (!deal || !canAccessRecord(ctx, 'deal', 'crm.deal.read', deal)) throw new AppError(404, 'Deal not found');
  return deal;
}

// ─── Rule ────────────────────────────────────────────────────────────────────

export async function getRule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const [loaded, defs] = await Promise.all([loadRule(orgId), dealCustomFields(orgId)]);
    res.json({
      rule: loaded?.described ?? null,
      canEdit: ADMIN_ROLES.has(req.user!.role),
      options: {
        customFields: defs.map(d => ({ id: d.id, label: d.label, fieldType: d.fieldType })),
        builtins: [{ kind: 'account', label: 'Account' }, { kind: 'contact', label: 'Contact' }, { kind: 'pipeline', label: 'Pipeline' }],
      },
    });
  } catch (err) { next(err); }
}

export async function putRule(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const body = LinkRuleSchema.parse(req.body);
    const fields = dedupeFields(body.fields);
    const defs = await dealCustomFields(orgId);
    const known = new Set(defs.map(d => d.id));
    for (const f of fields) {
      if (f.kind === 'custom' && !known.has(f.fieldId)) throw new AppError(400, 'That custom field is not a Deal field in this organisation');
    }
    if (!fields.length) {
      // Nothing chosen = turn the feature off.
      await prisma.dealLinkRule.deleteMany({ where: { orgId } });
    } else {
      await prisma.dealLinkRule.upsert({
        where: { orgId },
        create: { orgId, fields: fields as any, mode: body.mode, updatedBy: req.user!.id },
        update: { fields: fields as any, mode: body.mode, updatedBy: req.user!.id },
      });
    }
    logAction(req.user!.id, 'UPDATE', 'DealLinkRule', orgId, { fields, mode: body.mode });
    const loaded = await loadRule(orgId);
    res.json({ rule: loaded?.described ?? null });
  } catch (err) { next(err); }
}

// ─── Related deals panel ─────────────────────────────────────────────────────

const missingLabels = (described: DescribedRule, d: MatchableDeal) =>
  described.fields.filter(f => {
    if (f.kind === 'custom') return !normaliseValue(d.custom?.[f.fieldId!]);
    return !(f.kind === 'account' ? d.accountId : f.kind === 'contact' ? d.contactId : d.pipelineId);
  }).map(f => f.label);

export async function related(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    const deal = await visibleDeal(ctx, req.params.id);
    const loaded = await loadRule(ctx.orgId);
    const canEdit = ADMIN_ROLES.has(req.user!.role);
    if (!loaded) return res.json({ configured: false, canEdit });
    const base = await matchableDeal(loaded.rule, deal);
    const limit = Number(req.query.limit) || 20;
    const result = await findRelatedDeals(ctx, loaded.rule, base, limit);
    res.json({
      configured: true,
      canEdit,
      rule: loaded.described,
      sharedOn: await sharedOnLabels(ctx.orgId, loaded.described, base),
      // Fields this deal hasn't filled in yet (ALL needs every one).
      missing: result ? [] : missingLabels(loaded.described, base),
      ...(result ?? { deals: [], counts: { lost: 0, won: 0, open: 0, total: 0 }, hasMore: false }),
    });
  } catch (err) { next(err); }
}

// ─── Hints ───────────────────────────────────────────────────────────────────

const PreviewSchema = z.object({
  excludeId: z.string().optional(),
  accountId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  pipelineId: z.string().optional().nullable(),
  /** fieldKey → value, as the create form holds them. */
  custom: z.record(z.string().max(500).nullable()).optional(),
});

/** Create/edit form: "2 earlier deals on this unit were lost" before saving. */
export async function preview(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    if (!can(ctx, 'crm.deal.read')) throw new AppError(403, 'Insufficient permissions');
    const body = PreviewSchema.parse(req.body ?? {});
    const loaded = await loadRule(ctx.orgId);
    if (!loaded) return res.json({ configured: false });
    // The form keys custom values by fieldKey; the rule by field id.
    const defs = await dealCustomFields(ctx.orgId);
    const custom: Record<string, string> = {};
    for (const d of defs) {
      const v = body.custom?.[d.fieldKey];
      if (v) custom[d.id] = v;
    }
    let pipelineId = body.pipelineId ?? null;
    if (!pipelineId && loaded.rule.fields.some(f => f.kind === 'pipeline')) {
      // New deals land on the default pipeline (deals.controller create).
      pipelineId = (await prisma.pipeline.findFirst({ where: { orgId: ctx.orgId, isDefault: true }, select: { id: true } }))?.id ?? null;
    }
    const target: MatchableDeal = { id: body.excludeId || '__new__', accountId: body.accountId ?? null, contactId: body.contactId ?? null, pipelineId, custom };
    const counts = (await outcomeCountsFor(ctx, loaded.rule, [target])).get(target.id) ?? { lost: 0, won: 0, open: 0 };
    res.json({ configured: true, counts, sharedOn: await sharedOnLabels(ctx.orgId, loaded.described, target) });
  } catch (err) { next(err); }
}

/** Board cards: lost/won counts of related deals for the given deal ids. */
export async function outcomeCounts(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    if (!can(ctx, 'crm.deal.read')) throw new AppError(403, 'Insufficient permissions');
    const ids = String(req.query.ids ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 300);
    const loaded = await loadRule(ctx.orgId);
    if (!loaded || !ids.length) return res.json({ configured: !!loaded, counts: {} });
    const deals = await prisma.deal.findMany({
      where: { id: { in: ids }, orgId: ctx.orgId },
      select: { id: true, assignedTo: true, accountId: true, contactId: true, pipelineId: true },
    });
    const visible = deals.filter(d => canAccessRecord(ctx, 'deal', 'crm.deal.read', d));
    const cvs = await prisma.customFieldValue.findMany({
      where: { entityId: { in: visible.map(d => d.id) }, customFieldId: { in: loaded.rule.fields.flatMap(f => (f.kind === 'custom' ? [f.fieldId] : [])) } },
      select: { entityId: true, customFieldId: true, value: true },
    });
    const targets: MatchableDeal[] = visible.map(d => ({
      ...d,
      custom: Object.fromEntries(cvs.filter(c => c.entityId === d.id && c.value != null).map(c => [c.customFieldId, c.value!])),
    }));
    const map = await outcomeCountsFor(ctx, loaded.rule, targets);
    res.json({ configured: true, counts: Object.fromEntries(map) });
  } catch (err) { next(err); }
}

// ─── Lessons from related deals (AI) ─────────────────────────────────────────

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * POST /ai/deal/:id/past-lessons. Behind aiAdvanced (route), but usage is
 * recorded here and only when the model is actually called: "not set up",
 * "no closed related deals" and cache hits cost nothing and work even with no
 * AI provider configured.
 */
/**
 * Everything up to (not including) the model call: the prompt and its cache
 * key, or why there is nothing to ask. Shared with follow-up emails
 * (utils/followups), which reuse an already-cached lessons checklist but
 * never trigger a new lessons call.
 */
export async function lessonsRequest(ctx: PermCtx, deal: Awaited<ReturnType<typeof visibleDeal>>) {
  const orgId = ctx.orgId;
  const loaded = await loadRule(orgId);
  if (!loaded) return { status: 'not_configured' as const };
  const base = await matchableDeal(loaded.rule, deal);
  const gathered = await gatherLessonDeals(ctx, loaded.rule, base);
  if (!gathered) return { status: 'not_usable' as const, missing: missingLabels(loaded.described, base) };
  if (!gathered.deals.length) return { status: 'no_history' as const };
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { currency: true } });
  const prompt = buildLessonsPrompt({
    title: deal.title, status: deal.status, stage: deal.stage, value: Number(deal.value),
    sharedOn: await sharedOnLabels(orgId, loaded.described, base),
  }, gathered.deals, org?.currency ?? 'USD');
  return { status: 'ready' as const, gathered, prompt, cacheKey: `deal-lessons:${prompt.cacheKey}` };
}

/** The lessons checklist if it was already generated for the deal as it is now; null otherwise. No AI call. */
export async function cachedLessonsChecklist(ctx: PermCtx, dealId: string): Promise<string[] | null> {
  try {
    const deal = await visibleDeal(ctx, dealId);
    const r = await lessonsRequest(ctx, deal);
    if (r.status !== 'ready') return null;
    const hit = safeJson(await readPersistentCache(ctx.orgId, r.cacheKey)) as { result?: LessonsResult } | null;
    return hit?.result ? hit.result.checklist.map(c => c.item) : null;
  } catch {
    return null;
  }
}

export async function pastLessons(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    // /api/ai isn't behind the CRM mount gate, so check the area here.
    if (await isModuleBlocked(orgId, 'crm')) throw new AppError(402, 'CRM is switched off for this organisation.');
    const ctx = await getPermCtx(req.user!);
    const deal = await visibleDeal(ctx, req.params.id);
    const r = await lessonsRequest(ctx, deal);
    if (r.status === 'not_configured' || r.status === 'no_history') return res.json({ status: r.status });
    if (r.status === 'not_usable') return res.json({ status: r.status, missing: r.missing });
    const { gathered, prompt, cacheKey } = r;
    const basedOn = {
      lost: gathered.deals.filter(d => d.status === 'LOST').length,
      won: gathered.deals.filter(d => d.status === 'WON').length,
      notes: [...prompt.refs.values()].reduce((n, r) => n + r.notes.length, 0),
    };

    const hit = req.body?.refresh ? null : await readPersistentCache(orgId, cacheKey);
    if (hit) {
      const stored = safeJson(hit) as { result: LessonsResult; generatedAt: string } | null;
      if (stored?.result) return res.json({ status: 'ok', cached: true, generatedAt: stored.generatedAt, basedOn, estTokens: prompt.estRequestTokens, result: stored.result });
    }

    if ((await aiConfigSource()) === 'none') {
      return res.status(503).json({ error: AI_NOT_CONFIGURED_MESSAGE, code: 'AI_NOT_CONFIGURED' });
    }
    recordUsage(orgId, 'AI_CALL');

    const first = await analysePastDealsJson(prompt.system, prompt.user, LESSONS_MAX_TOKENS);
    let raw = safeJson(first);
    let problems = replyProblems(raw);
    if (problems.length) {
      // One repair attempt with the exact problems (same pattern as analytics/ask.ts).
      const repair = await analysePastDealsJson(prompt.system,
        `${prompt.user}\n\nYour previous reply:\n${(first ?? '').slice(0, 2000)}\n\nIt was rejected because:\n- ${problems.join('\n- ')}\n\nReturn the corrected JSON object only.`,
        LESSONS_MAX_TOKENS);
      raw = safeJson(repair);
      problems = replyProblems(raw);
    }
    if (problems.length) {
      return res.status(502).json({ error: 'The AI couldn’t produce a usable summary of the past deals. Try again in a minute.' });
    }
    const result = checkLessons(LessonsReplySchema.parse(raw), prompt.refs);
    const generatedAt = new Date().toISOString();
    await writePersistentCache(orgId, cacheKey, 'deal.pastLessons', JSON.stringify({ result, generatedAt }));
    res.json({ status: 'ok', cached: false, generatedAt, basedOn, estTokens: prompt.estRequestTokens, result });
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}
