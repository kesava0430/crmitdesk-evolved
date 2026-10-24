/**
 * Follow-ups: My Work list, snooze, reminder preferences, AI email drafts
 * with fact check, sending from the app, and AI next-step suggestions.
 * Logic lives in utils/followups/; this file is request handling only.
 *
 * Mounted at /api/crm/followups (behind the CRM area gate), except the two
 * AI endpoints, which live on /api/ai (aiAdvanced) and check the CRM area
 * themselves.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { getPermCtx, can } from '../../../utils/permissions';
import { isModuleBlocked } from '../../../utils/licensing';
import { readPersistentCache, writePersistentCache } from '../../../utils/aiCache';
import { aiConfigSource, AI_NOT_CONFIGURED_MESSAGE } from '../../../utils/aiStatus';
import { recordUsage } from '../../../utils/usageTracking';
import { draftFollowUpEmailJson, suggestNextStepJson } from '../../../utils/ai';
import { handleAIError } from '../../ai/ai.controller';
import { cachedLessonsChecklist } from '../deals/dealLinks.controller';
import { myFollowUps, loadActionableFollowUp, orgTimeZone } from '../../../utils/followups/collect';
import { parseDueInput, isDateOnly } from '../../../utils/followups/time';
import { gatherContext, CtxKind } from '../../../utils/followups/context';
import {
  DraftOptionsSchema, buildEmailPrompt, parseEmailReply, factCheck, EMAIL_MAX_TOKENS,
  SendSchema, sendFollowUpEmail, sendChannel, sendTarget,
} from '../../../utils/followups/email';
import { buildNextStepPrompt, parseNextStep, cooldownLeft, NEXT_STEP_MAX_TOKENS, defaultDue, NextStepSuggestion } from '../../../utils/followups/nextStep';
import { whatsappTarget } from '../../../utils/followups/reminders';

// ─── My Work / dashboard ────────────────────────────────────────────────────

export async function mine(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    const r = await myFollowUps(ctx);
    res.json({ ...r, timezone: await orgTimeZone(ctx.orgId) });
  } catch (err) { next(err); }
}

const SnoozeSchema = z.object({
  source: z.enum(['ACTIVITY', 'TASK']),
  id: z.string().min(1),
  preset: z.enum(['1h', '3h', 'tomorrow', 'custom']),
  until: z.string().optional(),
});

/** Moves the follow-up's due time (and re-arms its reminder). Same effect as editing the due date. */
export async function snooze(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    const body = SnoozeSchema.parse(req.body);
    const found = await loadActionableFollowUp(ctx, body.source, body.id);
    if (!found) throw new AppError(404, 'Follow-up not found');
    const now = new Date();
    let dueAt: Date | null;
    if (body.preset === '1h') dueAt = new Date(now.getTime() + 3_600_000);
    else if (body.preset === '3h') dueAt = new Date(now.getTime() + 3 * 3_600_000);
    else if (body.preset === 'tomorrow') dueAt = defaultDue(now, await orgTimeZone(ctx.orgId));
    else dueAt = parseDueInput(body.until);
    if (!dueAt) throw new AppError(400, 'Pick a date and time to snooze until.');
    if (!isDateOnly(dueAt) && dueAt.getTime() <= now.getTime()) throw new AppError(400, 'Snooze to a time in the future.');
    if (body.preset !== 'custom' && isDateOnly(dueAt)) dueAt = new Date(dueAt.getTime() + 60_000);
    if (body.source === 'ACTIVITY') {
      await prisma.activity.updateMany({ where: { id: body.id, orgId: ctx.orgId }, data: { dueAt, remindedAt: null } });
    } else {
      await prisma.task.updateMany({ where: { id: body.id, orgId: ctx.orgId }, data: { dueAt, remindedAt: null } });
    }
    res.json({ id: body.id, source: body.source, dueAt: dueAt.toISOString() });
  } catch (err) { next(err); }
}

// ─── Preferences ────────────────────────────────────────────────────────────

async function prefsView(orgId: string, userId: string) {
  const [p, wa, link, user] = await Promise.all([
    prisma.followUpPrefs.findUnique({ where: { userId } }),
    prisma.whatsAppConfig.findUnique({ where: { orgId }, select: { id: true } }),
    prisma.assistantWhatsAppLink.findUnique({ where: { userId }, select: { phoneE164: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { phone: true } }),
  ]);
  const verified = !!link && !!user?.phone;
  return {
    whatsapp: p?.whatsapp ?? false,
    digest: p?.digest ?? true,
    whatsappAvailable: !!wa && verified,
    whatsappHint: !wa ? 'Your organisation has no WhatsApp number connected (Inbox → Settings).'
      : !verified ? 'Verify your WhatsApp number with the assistant (Profile → WhatsApp) to get reminders there.' : null,
    whatsappActive: (await whatsappTarget(orgId, userId).catch(() => null)) !== null,
  };
}

export async function getPrefs(req: AuthRequest, res: Response, next: NextFunction) {
  try { res.json(await prefsView(req.user!.orgId, req.user!.id)); } catch (err) { next(err); }
}

export async function putPrefs(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = z.object({ whatsapp: z.boolean().optional(), digest: z.boolean().optional() }).parse(req.body);
    const { orgId, id: userId } = req.user!;
    await prisma.followUpPrefs.upsert({ where: { userId }, create: { userId, orgId, ...data }, update: data });
    res.json(await prefsView(orgId, userId));
  } catch (err) { next(err); }
}

// ─── Email: channel, fact check, send ───────────────────────────────────────

const RecordQuery = z.object({ entityType: z.enum(['LEAD', 'DEAL']), entityId: z.string().min(1) });

/** What pressing Send will do — shown on the confirmation. */
export async function emailChannel(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    const q = RecordQuery.parse(req.query);
    const [target, channel] = await Promise.all([sendTarget(ctx, q.entityType, q.entityId), sendChannel(ctx.orgId)]);
    res.json({ to: target.email, toName: target.name, canSend: can(ctx, 'crm.activity.create') && !!target.email, ...channel });
  } catch (err) { next(err); }
}

/** Re-runs the fact check on an edited draft against the record as it is now (no AI). */
export async function checkEmail(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    const b = RecordQuery.extend({ subject: z.string().max(200).default(''), body: z.string().max(10_000) }).parse(req.body);
    const lessons = b.entityType === 'DEAL' ? await cachedLessonsChecklist(ctx, b.entityId) : null;
    const c = await gatherContext(ctx, b.entityType, b.entityId, { lessons: lessons ?? [] });
    const prompt = buildEmailPrompt(c, { purpose: 'check_in', tone: 'friendly', language: 'en', refresh: false });
    res.json({ flags: factCheck(c, prompt.contextText, b.subject, b.body) });
  } catch (err) { next(err); }
}

export async function send(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    const input = SendSchema.parse(req.body);
    const r = await sendFollowUpEmail(ctx, input);
    res.status(r.sent ? 201 : 200).json(r);
  } catch (err) { next(err); }
}

// ─── AI: email draft (POST /ai/lead/:id/follow-up, /ai/deal/:id/follow-up) ──

const DRAFT_CACHE_TTL_MS = 24 * 3_600_000;

function safeJson(s: string | null): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function draftEmail(kind: CtxKind) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.orgId;
      if (await isModuleBlocked(orgId, 'crm')) throw new AppError(402, 'CRM is switched off for this organisation.');
      const ctx = await getPermCtx(req.user!);
      const opts = DraftOptionsSchema.parse(req.body ?? {});
      // Lessons are reused only if already generated — never a new lessons call from here.
      const lessons = kind === 'DEAL' ? await cachedLessonsChecklist(ctx, req.params.id) : null;
      const c = await gatherContext(ctx, kind, req.params.id, { lessons: lessons ?? [] });
      const prompt = buildEmailPrompt(c, opts);
      const basedOn = { notes: prompt.notesShown, notesAvailable: prompt.notesTotal, planned: c.planned.length, quote: !!c.quote, lessons: lessons?.length ?? 0 };
      const cacheKey = `followup-email:${prompt.cacheKey}`;

      if (!opts.refresh) {
        const hit = safeJson(await readPersistentCache(orgId, cacheKey));
        if (hit?.subject) return res.json({ ...hit, cached: true });
      }
      if ((await aiConfigSource()) === 'none') {
        return res.status(503).json({ error: AI_NOT_CONFIGURED_MESSAGE, code: 'AI_NOT_CONFIGURED' });
      }
      recordUsage(orgId, 'AI_CALL');
      const feature = kind === 'LEAD' ? 'lead' : 'deal';
      const first = await draftFollowUpEmailJson(feature, prompt.system, prompt.user, EMAIL_MAX_TOKENS);
      let parsed = parseEmailReply(first);
      if (!parsed.ok) {
        const repair = await draftFollowUpEmailJson(feature, prompt.system,
          `${prompt.user}\n\nYour previous reply:\n${(first ?? '').slice(0, 1500)}\n\nIt was rejected because:\n- ${parsed.problems.join('\n- ')}\n\nReturn the corrected JSON object only.`,
          EMAIL_MAX_TOKENS);
        parsed = parseEmailReply(repair);
      }
      if (!parsed.ok) return res.status(502).json({ error: 'The AI couldn’t produce a usable email. Try again in a minute.' });

      const result = {
        subject: parsed.subject, body: parsed.body,
        flags: factCheck(c, prompt.contextText, parsed.subject, parsed.body),
        basedOn, estTokens: prompt.estRequestTokens, options: { purpose: opts.purpose, tone: opts.tone, language: opts.language },
        generatedAt: new Date().toISOString(),
      };
      await writePersistentCache(orgId, cacheKey, `${feature}.followUp`, JSON.stringify(result), DRAFT_CACHE_TTL_MS);
      res.json({ ...result, cached: false });
    } catch (err: any) { if (!handleAIError(err, res)) next(err); }
  };
}

// ─── AI: next step (POST /ai/crm/next-step) ─────────────────────────────────

const inflight = new Map<string, Promise<any>>();

export async function nextStep(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    if (await isModuleBlocked(orgId, 'crm')) throw new AppError(402, 'CRM is switched off for this organisation.');
    const ctx = await getPermCtx(req.user!);
    const b = RecordQuery.extend({ auto: z.boolean().optional() }).parse(req.body);
    const tz = await orgTimeZone(orgId);
    const c = await gatherContext(ctx, b.entityType, b.entityId);
    const prompt = buildNextStepPrompt(c);
    // Keyed per user too: the context is built with the viewer's permissions.
    const key = `next-step:${b.entityType}:${b.entityId}:${ctx.userId}`;
    const stored = safeJson(await readPersistentCache(orgId, key)) as { hash: string; at: number; suggestion: NextStepSuggestion | null } | null;
    if (stored && stored.hash === prompt.contextHash) {
      return res.json({ suggestion: stored.suggestion, cached: true, estTokens: prompt.estRequestTokens });
    }
    const left = cooldownLeft(stored?.at ?? null, Date.now());
    if (left > 0) {
      return res.json({ suggestion: stored?.suggestion ?? null, cached: true, stale: true, retryInSeconds: Math.ceil(left / 1000), estTokens: prompt.estRequestTokens });
    }
    if ((await aiConfigSource()) === 'none') {
      return res.status(503).json({ error: AI_NOT_CONFIGURED_MESSAGE, code: 'AI_NOT_CONFIGURED' });
    }
    const run = inflight.get(key) ?? (async () => {
      recordUsage(orgId, 'AI_CALL');
      const now = new Date();
      const first = await suggestNextStepJson(prompt.system, prompt.user, NEXT_STEP_MAX_TOKENS);
      let parsed = parseNextStep(first, now, tz);
      if (!parsed.ok) {
        const repair = await suggestNextStepJson(prompt.system,
          `${prompt.user}\n\nYour previous reply:\n${(first ?? '').slice(0, 600)}\n\nIt was rejected because:\n- ${parsed.problems.join('\n- ')}\n\nReturn the corrected JSON object only.`,
          NEXT_STEP_MAX_TOKENS);
        parsed = parseNextStep(repair, now, tz);
      }
      const suggestion = parsed.ok ? parsed.suggestion : null;
      // Even a failed call starts the cooldown — retrying every save would just burn the quota.
      await writePersistentCache(orgId, key, 'crm.nextStep', JSON.stringify({ hash: prompt.contextHash, at: Date.now(), suggestion }));
      return suggestion;
    })();
    inflight.set(key, run);
    try {
      const suggestion = await run;
      if (!suggestion) return res.status(502).json({ error: 'The AI couldn’t suggest a usable next step. Try again in a few minutes.' });
      res.json({ suggestion, cached: false, estTokens: prompt.estRequestTokens });
    } finally {
      inflight.delete(key);
    }
  } catch (err: any) { if (!handleAIError(err, res)) next(err); }
}
