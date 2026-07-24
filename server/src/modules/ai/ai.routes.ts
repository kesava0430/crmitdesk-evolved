import { Router } from 'express';
import { authenticate, requireRole,
         IT_STAFF, CRM_STAFF, CRM_MANAGERS,
         MANAGERS, ALL_STAFF } from '../../middleware/authenticate';
import * as ai from './ai.controller';
import * as studio from './aiStudio.controller';

export const aiRouter = Router();
aiRouter.use(authenticate);

// ── CRM AI (leads, deals, contacts) ──────────────────────────────────────────
aiRouter.post('/lead/:id/score',           requireRole(...CRM_STAFF),    ai.scoreLeadHandler);
aiRouter.post('/lead/:id/follow-up',       requireRole(...CRM_STAFF),    ai.leadFollowUpHandler);
aiRouter.post('/lead/:id/nurture-sequence',requireRole(...CRM_STAFF),    ai.nurtureSequenceHandler);
aiRouter.post('/deal/:id/follow-up',       requireRole(...CRM_STAFF),    ai.dealFollowUpHandler);
aiRouter.post('/deal/:id/win-probability', requireRole(...CRM_STAFF),    ai.winProbabilityHandler);
aiRouter.post('/deal/:id/close-date',      requireRole(...CRM_STAFF),    ai.dealCloseDateHandler);
aiRouter.post('/pipeline/health',          requireRole(...CRM_MANAGERS), ai.pipelineHealthHandler);
aiRouter.post('/contact/:id/churn-risk',   requireRole(...CRM_STAFF),    ai.churnRiskHandler);
aiRouter.post('/contact/:id/health',       requireRole(...CRM_STAFF),    ai.contactHealthHandler);
aiRouter.post('/detect-competitors',       requireRole(...CRM_STAFF),    ai.competitorDetectHandler);
aiRouter.post('/leads/bulk-score',         requireRole(...CRM_MANAGERS), ai.bulkScoreHandler);

// ── IT Desk AI (tickets) ─────────────────────────────────────────────────────
aiRouter.post('/ticket/:id/sentiment',     requireRole(...IT_STAFF),     ai.ticketSentimentHandler);
aiRouter.post('/ticket/:id/reply',         requireRole(...IT_STAFF),     ai.ticketReplyHandler);
aiRouter.post('/ticket/:id/auto-route',    requireRole(...IT_STAFF),     ai.autoRouteHandler);
aiRouter.post('/ticket/check-duplicate',   requireRole(...IT_STAFF),     ai.duplicateDetectHandler);
aiRouter.post('/ticket/:id/kb-article',    requireRole(...IT_STAFF),     ai.kbArticleHandler);
aiRouter.post('/ticket/:id/summarize',     requireRole(...IT_STAFF),     ai.summarizeHandler);
aiRouter.post('/ticket/:id/estimate',      requireRole(...IT_STAFF),     ai.estimateHandler);
aiRouter.post('/ticket/:id/sla-risk',      requireRole(...IT_STAFF),     ai.slaRiskHandler);
aiRouter.post('/ticket/:id/auto-tag',      requireRole(...IT_STAFF),     ai.autoTagHandler);

// ── Cross-functional AI ───────────────────────────────────────────────────────
aiRouter.post('/query',          requireRole(...MANAGERS),   ai.nlQueryHandler);   // dashboard NL query
aiRouter.post('/insights',       requireRole(...MANAGERS),   ai.insightsHandler);  // proactive insights
aiRouter.post('/meeting-notes',  requireRole(...ALL_STAFF),  ai.meetingNotesHandler);
aiRouter.post('/tone-check',     requireRole(...ALL_STAFF),  ai.toneCheckHandler);
aiRouter.post('/command',        requireRole(...ALL_STAFF),  ai.nlCommandHandler);

// ── AI Actions (whitelisted "do it for me" commands) ─────────────────────────
// Route-level gate is just "must be staff" — the real, per-action role check
// happens inside executeActionHandler against each action's own allowedRoles.
aiRouter.post('/actions/plan',    requireRole(...ALL_STAFF), ai.planActionHandler);
aiRouter.post('/actions/execute', requireRole(...ALL_STAFF), ai.executeActionHandler);

// ── AI Feature Builder (custom rules) ────────────────────────────────────────
aiRouter.get('/rules',           requireRole(...MANAGERS),   ai.listAIRulesHandler);
aiRouter.post('/rules',          requireRole(...MANAGERS),   ai.createAIRuleHandler);
aiRouter.patch('/rules/:id',     requireRole(...MANAGERS),   ai.updateAIRuleHandler);
aiRouter.delete('/rules/:id',    requireRole(...MANAGERS),   ai.deleteAIRuleHandler);
aiRouter.post('/rules/:id/run',  requireRole(...ALL_STAFF),  ai.runAIRuleHandler);

// ── AI Studio ─────────────────────────────────────────────────────────────────
// Business Context
aiRouter.get('/studio/context',              requireRole(...MANAGERS),  studio.getBusinessContext);
aiRouter.put('/studio/context',              requireRole(...MANAGERS),  studio.upsertBusinessContext);

// Custom AI Functions
aiRouter.get('/studio/functions',            requireRole(...MANAGERS),  studio.listFunctions);
aiRouter.post('/studio/functions',           requireRole(...MANAGERS),  studio.createFunction);
aiRouter.patch('/studio/functions/:id',      requireRole(...MANAGERS),  studio.updateFunction);
aiRouter.delete('/studio/functions/:id',     requireRole(...MANAGERS),  studio.deleteFunction);
aiRouter.post('/studio/functions/:id/run',   requireRole(...ALL_STAFF), studio.runFunction);

// Custom Scripts
aiRouter.get('/studio/scripts',              requireRole(...MANAGERS),  studio.listScripts);
aiRouter.post('/studio/scripts',             requireRole(...MANAGERS),  studio.createScript);
aiRouter.patch('/studio/scripts/:id',        requireRole(...MANAGERS),  studio.updateScript);
aiRouter.delete('/studio/scripts/:id',       requireRole(...MANAGERS),  studio.deleteScript);
aiRouter.post('/studio/scripts/validate',    requireRole(...MANAGERS),  studio.validateScript);
