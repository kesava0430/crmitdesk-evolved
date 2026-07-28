import { Router, Response, NextFunction } from 'express';
import { authenticate, requireRole, AuthRequest,
         IT_STAFF, CRM_STAFF, CRM_MANAGERS,
         MANAGERS, ALL_STAFF } from '../../middleware/authenticate';
import * as ai from './ai.controller';
import * as studio from './aiStudio.controller';
import { recordUsage } from '../../utils/usageTracking';

export const aiRouter = Router();
aiRouter.use(authenticate);

// Logged only on routes that actually reach the LLM (see usageTracking.ts) —
// pure CRUD endpoints below (rules/functions/scripts/context list-create-
// update-delete, label reads) are deliberately not wrapped with this, since
// they never call out to Groq/OpenAI. Fires before the handler runs rather
// than after, so a downstream error doesn't skip the count — an attempted
// AI call still costs the same API round-trip either way.
function trackAiCall(req: AuthRequest, _res: Response, next: NextFunction) {
  recordUsage(req.user!.orgId, 'AI_CALL');
  next();
}

// ── CRM AI (leads, deals, contacts) ──────────────────────────────────────────
aiRouter.post('/lead/:id/score',           requireRole(...CRM_STAFF),    trackAiCall, ai.scoreLeadHandler);
aiRouter.post('/lead/:id/follow-up',       requireRole(...CRM_STAFF),    trackAiCall, ai.leadFollowUpHandler);
aiRouter.post('/lead/:id/nurture-sequence',requireRole(...CRM_STAFF),    trackAiCall, ai.nurtureSequenceHandler);
aiRouter.post('/deal/:id/follow-up',       requireRole(...CRM_STAFF),    trackAiCall, ai.dealFollowUpHandler);
aiRouter.post('/deal/:id/win-probability', requireRole(...CRM_STAFF),    trackAiCall, ai.winProbabilityHandler);
aiRouter.post('/deal/:id/close-date',      requireRole(...CRM_STAFF),    trackAiCall, ai.dealCloseDateHandler);
aiRouter.post('/pipeline/health',          requireRole(...CRM_MANAGERS), trackAiCall, ai.pipelineHealthHandler);
aiRouter.post('/contact/:id/churn-risk',   requireRole(...CRM_STAFF),    trackAiCall, ai.churnRiskHandler);
aiRouter.post('/contact/:id/health',       requireRole(...CRM_STAFF),    trackAiCall, ai.contactHealthHandler);
aiRouter.post('/detect-competitors',       requireRole(...CRM_STAFF),    trackAiCall, ai.competitorDetectHandler);
aiRouter.post('/leads/bulk-score',         requireRole(...CRM_MANAGERS), trackAiCall, ai.bulkScoreHandler);

// ── IT Desk AI (tickets) ─────────────────────────────────────────────────────
aiRouter.post('/ticket/:id/sentiment',     requireRole(...IT_STAFF),     trackAiCall, ai.ticketSentimentHandler);
aiRouter.post('/ticket/:id/reply',         requireRole(...IT_STAFF),     trackAiCall, ai.ticketReplyHandler);
aiRouter.post('/ticket/:id/auto-route',    requireRole(...IT_STAFF),     trackAiCall, ai.autoRouteHandler);
aiRouter.post('/ticket/check-duplicate',   requireRole(...IT_STAFF),     trackAiCall, ai.duplicateDetectHandler);
aiRouter.post('/ticket/:id/kb-article',    requireRole(...IT_STAFF),     trackAiCall, ai.kbArticleHandler);
aiRouter.post('/ticket/:id/summarize',     requireRole(...IT_STAFF),     trackAiCall, ai.summarizeHandler);
aiRouter.post('/ticket/:id/estimate',      requireRole(...IT_STAFF),     trackAiCall, ai.estimateHandler);
aiRouter.post('/ticket/:id/sla-risk',      requireRole(...IT_STAFF),     trackAiCall, ai.slaRiskHandler);
aiRouter.post('/ticket/:id/auto-tag',      requireRole(...IT_STAFF),     trackAiCall, ai.autoTagHandler);

// ── Cross-functional AI ───────────────────────────────────────────────────────
aiRouter.post('/query',          requireRole(...MANAGERS),   trackAiCall, ai.nlQueryHandler);   // dashboard NL query
aiRouter.post('/insights',       requireRole(...MANAGERS),   trackAiCall, ai.insightsHandler);  // proactive insights
aiRouter.post('/meeting-notes',  requireRole(...ALL_STAFF),  trackAiCall, ai.meetingNotesHandler);
aiRouter.post('/tone-check',     requireRole(...ALL_STAFF),  trackAiCall, ai.toneCheckHandler);
aiRouter.post('/command',        requireRole(...ALL_STAFF),  trackAiCall, ai.nlCommandHandler);

// ── AI Actions (whitelisted "do it for me" commands) ─────────────────────────
// Route-level gate is just "must be staff" — the real, per-action role check
// happens inside executeActionHandler against each action's own allowedRoles.
// Both tracked: plan always calls the LLM to parse the command, and most
// whitelisted actions execute() calls also go through AI helpers.
aiRouter.post('/actions/plan',    requireRole(...ALL_STAFF), trackAiCall, ai.planActionHandler);
aiRouter.post('/actions/execute', requireRole(...ALL_STAFF), trackAiCall, ai.executeActionHandler);

// ── AI Feature Builder (custom rules) ────────────────────────────────────────
aiRouter.get('/rules',           requireRole(...MANAGERS),   ai.listAIRulesHandler);
aiRouter.post('/rules',          requireRole(...MANAGERS),   ai.createAIRuleHandler);
aiRouter.patch('/rules/:id',     requireRole(...MANAGERS),   ai.updateAIRuleHandler);
aiRouter.delete('/rules/:id',    requireRole(...MANAGERS),   ai.deleteAIRuleHandler);
aiRouter.post('/rules/:id/run',  requireRole(...ALL_STAFF),  trackAiCall, ai.runAIRuleHandler);

// ── AI Studio ─────────────────────────────────────────────────────────────────
// Business Context
aiRouter.get('/studio/context',              requireRole(...MANAGERS),  studio.getBusinessContext);
aiRouter.put('/studio/context',              requireRole(...MANAGERS),  studio.upsertBusinessContext);
// Narrower than /studio/context — ALL_STAFF, not just MANAGERS, since
// relabeled terminology needs to render for every staff member who sees
// that entity, not just whoever configured it.
aiRouter.get('/studio/labels',               requireRole(...ALL_STAFF), studio.getLabelOverrides);

// Custom AI Functions
aiRouter.get('/studio/functions',            requireRole(...MANAGERS),  studio.listFunctions);
aiRouter.post('/studio/functions',           requireRole(...MANAGERS),  studio.createFunction);
aiRouter.patch('/studio/functions/:id',      requireRole(...MANAGERS),  studio.updateFunction);
aiRouter.delete('/studio/functions/:id',     requireRole(...MANAGERS),  studio.deleteFunction);
aiRouter.post('/studio/functions/:id/run',   requireRole(...ALL_STAFF), trackAiCall, studio.runFunction);

// Custom Scripts
aiRouter.get('/studio/scripts',              requireRole(...MANAGERS),  studio.listScripts);
aiRouter.post('/studio/scripts',             requireRole(...MANAGERS),  studio.createScript);
aiRouter.patch('/studio/scripts/:id',        requireRole(...MANAGERS),  studio.updateScript);
aiRouter.delete('/studio/scripts/:id',       requireRole(...MANAGERS),  studio.deleteScript);
aiRouter.post('/studio/scripts/validate',    requireRole(...MANAGERS),  studio.validateScript);

// AI Setup Generator — propose (plan) then apply (confirm), same pattern as
// AI Actions above. generateSetup never writes; applySetup is the only one
// that persists label overrides / creates workflow rules.
aiRouter.post('/studio/generate-setup',      requireRole(...MANAGERS),  trackAiCall, studio.generateSetup);
aiRouter.post('/studio/apply-setup',         requireRole(...MANAGERS),  studio.applySetup);
