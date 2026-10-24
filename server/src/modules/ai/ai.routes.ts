import { Router, Response, NextFunction } from 'express';
import { authenticate, requireRole, AuthRequest,
         IT_STAFF, CRM_STAFF, CRM_MANAGERS,
         MANAGERS, ALL_STAFF, ALL_USERS } from '../../middleware/authenticate';
import * as ai from './ai.controller';
import * as studio from './aiStudio.controller';
import * as solution from './solutionBuilder.controller';
import { pastLessons } from '../crm/deals/dealLinks.controller';
import { recordUsage } from '../../utils/usageTracking';
import { requireFeature } from '../../utils/licensing';
import { aiConfigSource, AI_NOT_CONFIGURED_MESSAGE } from '../../utils/aiStatus';

export const aiRouter = Router();
aiRouter.use(authenticate);

// Logged only on routes that actually reach the LLM (see usageTracking.ts) —
// pure CRUD endpoints below (rules/functions/scripts/context list-create-
// update-delete, label reads) are deliberately not wrapped with this, since
// they never call out to Groq/OpenAI. Fires before the handler runs rather
// than after, so a downstream error doesn't skip the count — an attempted
// AI call still costs the same API round-trip either way.
async function trackAiCall(req: AuthRequest, res: Response, next: NextFunction) {
  /* With no provider configured, every AI handler used to "succeed" with an
     empty answer (utils/ai.ts returns early without a key), so the whole AI
     surface looked silently broken with no hint why. Say so explicitly —
     503 and a message the UI shows — instead. */
  if ((await aiConfigSource()) === 'none') {
    return res.status(503).json({ error: AI_NOT_CONFIGURED_MESSAGE, code: 'AI_NOT_CONFIGURED' });
  }
  recordUsage(req.user!.orgId, 'AI_CALL');
  next();
}

// Feature-gated to Pro/Enterprise (utils/licensing.ts requireFeature). Free
// keeps exactly four capabilities ungated below: lead scoring, ticket
// sentiment, auto-routing, and auto-tagging — everything else AI-related
// requires the 'ai_advanced' feature. Placed after requireRole so a 403
// (wrong role) always wins over a 402 (wrong plan) when both would apply.
const aiAdvanced = requireFeature('ai_advanced');

// ── Health: is AI configured on this server, and does a real call work? ──────
// GET /ai/status → config only; GET /ai/status?test=1 → also makes one tiny
// provider call and explains any failure. Managers only; never returns keys.
aiRouter.get('/status', requireRole(...MANAGERS), ai.aiStatusHandler);

// ── CRM AI (leads, deals, contacts) ──────────────────────────────────────────
aiRouter.post('/lead/:id/score',           requireRole(...CRM_STAFF),    trackAiCall, ai.scoreLeadHandler); // Free
aiRouter.post('/lead/:id/follow-up',       requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.leadFollowUpHandler);
aiRouter.post('/lead/:id/nurture-sequence',requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.nurtureSequenceHandler);
aiRouter.post('/deal/:id/follow-up',       requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.dealFollowUpHandler);
aiRouter.post('/deal/:id/win-probability', requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.winProbabilityHandler);
aiRouter.post('/deal/:id/close-date',      requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.dealCloseDateHandler);
// Lessons from related deals: no trackAiCall — the handler records usage only
// when it actually calls the model (not set up / no history / cache hit are free).
aiRouter.post('/deal/:id/past-lessons',    requireRole(...CRM_STAFF),    aiAdvanced, pastLessons);
aiRouter.post('/pipeline/health',          requireRole(...CRM_MANAGERS), aiAdvanced, trackAiCall, ai.pipelineHealthHandler);
aiRouter.post('/contact/:id/churn-risk',   requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.churnRiskHandler);
aiRouter.post('/contact/:id/health',       requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.contactHealthHandler);
aiRouter.post('/detect-competitors',       requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.competitorDetectHandler);
aiRouter.post('/leads/bulk-score',         requireRole(...CRM_MANAGERS), aiAdvanced, trackAiCall, ai.bulkScoreHandler);

// ── IT Desk AI (tickets) ─────────────────────────────────────────────────────
aiRouter.post('/ticket/:id/sentiment',     requireRole(...IT_STAFF),     trackAiCall, ai.ticketSentimentHandler); // Free
aiRouter.post('/ticket/:id/reply',         requireRole(...IT_STAFF),     aiAdvanced, trackAiCall, ai.ticketReplyHandler);
aiRouter.post('/ticket/:id/auto-route',    requireRole(...IT_STAFF),     trackAiCall, ai.autoRouteHandler); // Free
aiRouter.post('/ticket/check-duplicate',   requireRole(...IT_STAFF),     aiAdvanced, trackAiCall, ai.duplicateDetectHandler);
aiRouter.post('/ticket/:id/kb-article',    requireRole(...IT_STAFF),     aiAdvanced, trackAiCall, ai.kbArticleHandler);
aiRouter.post('/invoice/:id/reminder',     requireRole(...CRM_STAFF),    aiAdvanced, trackAiCall, ai.invoiceReminderHandler);
aiRouter.post('/ticket/:id/summarize',     requireRole(...IT_STAFF),     aiAdvanced, trackAiCall, ai.summarizeHandler);
aiRouter.post('/ticket/:id/estimate',      requireRole(...IT_STAFF),     aiAdvanced, trackAiCall, ai.estimateHandler);
aiRouter.post('/ticket/:id/sla-risk',      requireRole(...IT_STAFF),     aiAdvanced, trackAiCall, ai.slaRiskHandler);
aiRouter.post('/ticket/:id/auto-tag',      requireRole(...IT_STAFF),     trackAiCall, ai.autoTagHandler); // Free

// ── Cross-functional AI ───────────────────────────────────────────────────────
// Ask anything: answers come from the query layer with the asker's own record
// scope and field rules, so it's open to all staff (an agent gets answers
// about the tickets they can see), not only managers.
// ALL_USERS: employees already ask the same questions over WhatsApp/Slack
// and in the chat bubble — their catalog holds only their own records.
aiRouter.post('/query',          requireRole(...ALL_USERS),  aiAdvanced, trackAiCall, ai.nlQueryHandler);   // dashboard Ask AI
aiRouter.post('/insights',       requireRole(...MANAGERS),   aiAdvanced, trackAiCall, ai.insightsHandler);  // proactive insights
aiRouter.post('/meeting-notes',  requireRole(...ALL_STAFF),  aiAdvanced, trackAiCall, ai.meetingNotesHandler);
aiRouter.post('/tone-check',     requireRole(...ALL_STAFF),  aiAdvanced, trackAiCall, ai.toneCheckHandler);
aiRouter.post('/command',        requireRole(...ALL_STAFF),  aiAdvanced, trackAiCall, ai.nlCommandHandler);

// ── AI Actions (whitelisted "do it for me" commands) ─────────────────────────
// Route-level gate is just "must be staff" — the real, per-action role check
// happens inside executeActionHandler against each action's own allowedRoles.
// Both tracked: plan always calls the LLM to parse the command, and most
// whitelisted actions execute() calls also go through AI helpers.
// Metadata only — no LLM call, not feature-gated (see listActionsHandler's
// comment). Registered before the two below just to keep all three
// /actions/* routes grouped; there's no path-matching ambiguity since the
// method+suffix differ from both.
// ALL_USERS: employees can run their own self-service actions (leave, WFH,
// tasks, tickets) by typing. What each role may actually do is decided per
// action inside the planner/executor (role, permission engine, areas), and
// the menu an employee's planner sees only contains those actions.
aiRouter.get('/actions',          requireRole(...ALL_USERS), ai.listActionsHandler);
aiRouter.post('/actions/plan',    requireRole(...ALL_USERS), aiAdvanced, trackAiCall, ai.planActionHandler);
aiRouter.post('/actions/execute', requireRole(...ALL_USERS), aiAdvanced, trackAiCall, ai.executeActionHandler);
// Re-validate a plan after the user picked a candidate — no model call, so not tracked as one.
aiRouter.post('/actions/review',  requireRole(...ALL_USERS), aiAdvanced, ai.reviewPlanHandler);

// ── Chat Copilot (multi-turn chat that answers or proposes actions) ─────────
// ALL_USERS like /actions/plan: the bubble is on every screen, employees use it
// for self-service (leave, WFH, tickets, tasks) exactly as over WhatsApp; the
// planner/executor and the query layer decide per action / dataset.
aiRouter.post('/chat',                     requireRole(...ALL_USERS), aiAdvanced, trackAiCall, ai.chatCopilotHandler);
aiRouter.post('/conversation/:id/plan',    requireRole(...ALL_STAFF), aiAdvanced, trackAiCall, ai.conversationPlanHandler);

// ── AI Feature Builder (custom rules) ────────────────────────────────────────
// List stays open (grandfathered rules from a since-downgraded plan remain
// visible/readable); creating, editing, deleting, or running one is gated.
aiRouter.get('/rules',           requireRole(...MANAGERS),   ai.listAIRulesHandler);
aiRouter.post('/rules',          requireRole(...MANAGERS),   aiAdvanced, ai.createAIRuleHandler);
aiRouter.patch('/rules/:id',     requireRole(...MANAGERS),   aiAdvanced, ai.updateAIRuleHandler);
aiRouter.delete('/rules/:id',    requireRole(...MANAGERS),   ai.deleteAIRuleHandler); // deleting/turning off is never gated
aiRouter.post('/rules/:id/run',  requireRole(...ALL_STAFF),  aiAdvanced, trackAiCall, ai.runAIRuleHandler);

// ── AI Studio ─────────────────────────────────────────────────────────────────
// Business Context — reads stay open (harmless/already-applied config);
// only writing new context is gated.
aiRouter.get('/studio/context',              requireRole(...MANAGERS),  studio.getBusinessContext);
aiRouter.put('/studio/context',              requireRole(...MANAGERS),  aiAdvanced, studio.upsertBusinessContext);
// Narrower than /studio/context — ALL_USERS, not just MANAGERS, since
// relabeled terminology needs to render for everyone who sees that entity,
// not just whoever configured it. Never gated: a downgraded org's staff
// should keep seeing whatever terminology was already applied.
//
// ALL_USERS rather than ALL_STAFF: EMPLOYEE renders these labels too — they
// file and read tickets — so an org that renamed "Tickets" to "Cases" was
// showing "Cases" to everyone except its own employees. And because the app
// shell requests this on every page, that exclusion also produced a 403 on
// every single navigation for those users. The response carries nothing but
// cosmetic strings (getLabelOverrides returns only ctx.labelOverrides, and
// deliberately not the industry/companyDesc/customSystem configuration), so
// there is nothing here to withhold from a signed-in member of the org.
aiRouter.get('/studio/labels',               requireRole(...ALL_USERS), studio.getLabelOverrides);

// Custom AI Functions
aiRouter.get('/studio/functions',            requireRole(...MANAGERS),  studio.listFunctions);
aiRouter.post('/studio/functions',           requireRole(...MANAGERS),  aiAdvanced, studio.createFunction);
aiRouter.patch('/studio/functions/:id',      requireRole(...MANAGERS),  aiAdvanced, studio.updateFunction);
aiRouter.delete('/studio/functions/:id',     requireRole(...MANAGERS),  studio.deleteFunction);
aiRouter.post('/studio/functions/:id/run',   requireRole(...ALL_STAFF), aiAdvanced, trackAiCall, studio.runFunction);

// Custom Scripts
aiRouter.get('/studio/scripts',              requireRole(...MANAGERS),  studio.listScripts);
aiRouter.post('/studio/scripts',             requireRole(...MANAGERS),  aiAdvanced, studio.createScript);
aiRouter.patch('/studio/scripts/:id',        requireRole(...MANAGERS),  aiAdvanced, studio.updateScript);
aiRouter.delete('/studio/scripts/:id',       requireRole(...MANAGERS),  studio.deleteScript);
aiRouter.post('/studio/scripts/validate',    requireRole(...MANAGERS),  aiAdvanced, studio.validateScript);

// The old /studio/generate-setup + /studio/apply-setup endpoints were
// removed — fully superseded by the Solution Builder routes below, which
// cover terminology AND modules/pipelines/skin/automations in one flow.

// AI Solution Builder (platform Phase 3) — one description in, a whole
// workspace out. Same propose→confirm split: generate never writes; apply
// re-validates the blueprint and creates modules/skin/labels/rules.
aiRouter.post('/solution/generate',          requireRole(...MANAGERS),  aiAdvanced, trackAiCall, solution.generateSolutionHandler);
// apply makes no AI call (it validates and writes config), so it carries no
// aiAdvanced gate — stamping a template must work on AI-less plans too.
// It does create custom modules, so it needs custom_modules (on every plan by default).
aiRouter.post('/solution/apply',             requireRole(...MANAGERS),  requireFeature('custom_modules'), solution.applySolutionHandler);

// Solution templates (platform Phase 4) — snapshot this workspace as a
// reusable blueprint, list own + shared, load one for preview, delete own.
// No aiAdvanced gate: templates involve no AI call, and the partner stamping
// flow must work even for orgs whose plan has no AI features at all.
aiRouter.get('/solution/templates',          requireRole(...MANAGERS),  solution.listTemplatesHandler);
aiRouter.post('/solution/templates',         requireRole(...MANAGERS),  solution.saveTemplateHandler);
aiRouter.get('/solution/templates/:id',      requireRole(...MANAGERS),  solution.getTemplateHandler);
aiRouter.delete('/solution/templates/:id',   requireRole(...MANAGERS),  solution.deleteTemplateHandler);
