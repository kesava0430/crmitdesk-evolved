/**
 * AI Studio — Business Context, Custom AI Functions, Custom Scripts
 *
 * Business Context  : GET/PUT /api/ai/studio/context
 * Custom Functions  : CRUD   /api/ai/studio/functions
 *                     POST   /api/ai/studio/functions/:id/run
 * Custom Scripts    : CRUD   /api/ai/studio/scripts
 *                     POST   /api/ai/studio/scripts/validate
 */
import { Response, NextFunction } from 'express';
import { complete } from '../../utils/aiGateway';
import { z } from 'zod';
import OpenAI from 'openai';
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';

// Use Groq via the OpenAI-compatible endpoint (same pattern as utils/ai.ts)
function getAiClient(): OpenAI | null {
  if (process.env.GROQ_API_KEY) {
    // Bounded — see the note in utils/ai.ts. AI Studio has no retry loop of
    // its own, so an unbounded request here just hangs the request thread.
    return new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1', timeout: 30_000, maxRetries: 1 });
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });
  }
  return null;
}
// llama-3.1-8b-instant was decommissioned by Groq on 2026-08-16; default now
// tracks their recommended replacement, overridable via AI_MODEL_FAST (same
// convention as utils/ai.ts).
const AI_MODEL = process.env.AI_MODEL_FAST || (process.env.GROQ_API_KEY ? 'openai/gpt-oss-20b' : 'gpt-4o-mini');
const groq = getAiClient();

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getContext(orgId: string) {
  return prisma.businessContext.findUnique({ where: { orgId } });
}

function buildSystemPrefix(ctx: any): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.industry)     parts.push(`Industry: ${ctx.industry}.`);
  if (ctx.companyDesc)  parts.push(`About the company: ${ctx.companyDesc}`);
  if (ctx.tone)         parts.push(`Tone: ${ctx.tone}.`);
  if (ctx.customSystem) parts.push(ctx.customSystem);
  if (ctx.terminology && typeof ctx.terminology === 'object') {
    const terms = Object.entries(ctx.terminology as Record<string, string>)
      .map(([k, v]) => `${k} = ${v}`)
      .join('; ');
    if (terms) parts.push(`Domain terminology: ${terms}.`);
  }
  return parts.join(' ');
}

// ─── Business Context ─────────────────────────────────────────────────────────

const ContextSchema = z.object({
  // These map to nullable columns in the BusinessContext model. GET returns
  // `null` (not omitted) for any field that hasn't been set yet, and the
  // frontend round-trips that same shape back on save — so `.optional()`
  // alone (undefined-only) rejected every re-save with a 400 once a row
  // existed. `.nullable()` lets the schema accept the null Prisma gives us.
  industry:     z.string().nullable().optional(),
  companyDesc:  z.string().nullable().optional(),
  terminology:  z.record(z.string()).nullable().optional(),
  customSystem: z.string().nullable().optional(),
  tone:         z.enum(['professional', 'casual', 'technical']).optional(),
});

export async function getBusinessContext(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getContext(req.user!.orgId);
    res.json(ctx ?? {});
  } catch (err) { next(err); }
}

/**
 * Label overrides only, for ALL_STAFF — not MANAGERS-gated like the rest of
 * Business Context. Relabeled terminology has to be visible to every staff
 * member who sees the entity in question (a sales rep looking at "Policies"
 * needs that label too), not just the managers who configured it, so this
 * intentionally exposes a narrower slice of BusinessContext under a looser
 * role check rather than loosening getBusinessContext itself (which also
 * returns industry/companyDesc/customSystem — reasonable to keep those
 * manager-only as configuration data).
 */
export async function getLabelOverrides(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getContext(req.user!.orgId);
    res.json({ labelOverrides: ctx?.labelOverrides ?? null });
  } catch (err) { next(err); }
}

export async function upsertBusinessContext(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = ContextSchema.parse(req.body);
    // Prisma's Json? column doesn't accept a plain `null` — it needs the
    // Prisma.JsonNull sentinel to actually store a JSON null. Swap it in
    // only when terminology was explicitly sent as null.
    const { terminology, ...rest } = data;
    const prismaData = {
      ...rest,
      ...(terminology !== undefined && { terminology: terminology === null ? Prisma.JsonNull : terminology }),
    };
    const ctx = await prisma.businessContext.upsert({
      where:  { orgId: req.user!.orgId },
      create: { ...prismaData, orgId: req.user!.orgId },
      update: prismaData,
    });
    res.json(ctx);
  } catch (err) { next(err); }
}

// ─── Custom AI Functions ──────────────────────────────────────────────────────

const InputFieldSchema = z.object({
  name:     z.string(),
  type:     z.enum(['text', 'number', 'boolean', 'select']),
  label:    z.string(),
  required: z.boolean().optional(),
  options:  z.array(z.string()).optional(), // for type=select
});

const FunctionSchema = z.object({
  name:         z.string().min(1).max(80),
  description:  z.string().optional(),
  systemPrompt: z.string().min(1),
  inputSchema:  z.array(InputFieldSchema).default([]),
  outputType:   z.enum(['text', 'json', 'number']).default('text'),
  isActive:     z.boolean().optional(),
});

export async function listFunctions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const fns = await prisma.customAIFunction.findMany({
      where: { orgId: req.user!.orgId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(fns);
  } catch (err) { next(err); }
}

export async function createFunction(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = FunctionSchema.parse(req.body);
    const fn = await prisma.customAIFunction.create({
      data: { ...data, orgId: req.user!.orgId },
    });
    res.status(201).json(fn);
  } catch (err) { next(err); }
}

export async function updateFunction(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = FunctionSchema.partial().parse(req.body);
    const fn = await prisma.customAIFunction.updateMany({
      where: { id: req.params.id, orgId: req.user!.orgId },
      data,
    });
    if (!fn.count) throw new AppError(404, 'Function not found');
    const updated = await prisma.customAIFunction.findUnique({ where: { id: req.params.id } });
    res.json(updated);
  } catch (err) { next(err); }
}

export async function deleteFunction(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.customAIFunction.deleteMany({
      where: { id: req.params.id, orgId: req.user!.orgId },
    });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
}

export async function runFunction(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const fn = await prisma.customAIFunction.findFirst({
      where: { id: req.params.id, orgId: req.user!.orgId, isActive: true },
    });
    if (!fn) throw new AppError(404, 'Function not found or inactive');
    if (!groq) throw new AppError(503, 'AI service not configured');

    // Build prompt: system = business context + function prompt
    const ctx = await getContext(req.user!.orgId);
    const contextPrefix = buildSystemPrefix(ctx);
    const systemPrompt = contextPrefix
      ? `${contextPrefix}\n\n${fn.systemPrompt}`
      : fn.systemPrompt;

    // Build user message from inputs
    const inputs = req.body.inputs ?? {};
    const inputLines = Object.entries(inputs)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const userMessage = inputLines || (req.body.text ?? 'Run this function.');

    /* Through the gateway, so a custom function is budgeted, logged and
       costed like every other AI call. It used to use a module-level client
       directly, which meant AI Studio usage never appeared in AI Governance
       and could not be capped. */
    const result = await complete({
      orgId: req.user!.orgId,
      userId: req.user!.id,
      feature: 'studio.function',
      task: 'FAST',
      system: systemPrompt,
      user: userMessage,
      temperature: 0.4,
      maxTokens: 1024,
    });
    if (result.blocked) {
      throw new AppError(402, 'Monthly AI budget reached. Raise the limit in AI Governance, or wait for the next billing period.');
    }

    const raw = result.text;

    // Parse output based on outputType
    let output: any = raw;
    if (fn.outputType === 'json') {
      try {
        const match = raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        output = JSON.parse(match ? match[1] : raw);
      } catch { output = raw; }
    } else if (fn.outputType === 'number') {
      const num = parseFloat(raw.replace(/[^0-9.]/g, ''));
      output = isNaN(num) ? raw : num;
    }

    // Increment run count
    prisma.customAIFunction.update({
      where: { id: fn.id },
      data: { runCount: { increment: 1 } },
    }).catch(() => {});

    res.json({ output, raw });
  } catch (err: any) {
    if (err?.status === 429) return res.status(402).json({ error: 'AI quota exceeded.' });
    next(err);
  }
}

// ─── Custom Scripts ───────────────────────────────────────────────────────────

const ScriptSchema = z.object({
  name:        z.string().min(1).max(80),
  description: z.string().optional(),
  entityType:  z.enum(['ticket', 'contact', 'deal', 'lead', 'asset', 'global']),
  trigger:     z.enum(['onLoad', 'onChange', 'onSubmit', 'onValidate', 'onFieldChange']),
  fieldTarget: z.string().optional(),
  script:      z.string().min(1),
  isActive:    z.boolean().optional(),
});

export async function listScripts(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const where: any = { orgId: req.user!.orgId };
    if (req.query.entityType) where.entityType = req.query.entityType;
    if (req.query.trigger)    where.trigger    = req.query.trigger;
    const scripts = await prisma.customScript.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    res.json(scripts);
  } catch (err) { next(err); }
}

export async function createScript(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = ScriptSchema.parse(req.body);
    const script = await prisma.customScript.create({
      data: { ...data, orgId: req.user!.orgId },
    });
    res.status(201).json(script);
  } catch (err) { next(err); }
}

export async function updateScript(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = ScriptSchema.partial().parse(req.body);
    const result = await prisma.customScript.updateMany({
      where: { id: req.params.id, orgId: req.user!.orgId },
      data,
    });
    if (!result.count) throw new AppError(404, 'Script not found');
    const updated = await prisma.customScript.findUnique({ where: { id: req.params.id } });
    res.json(updated);
  } catch (err) { next(err); }
}

export async function deleteScript(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.customScript.deleteMany({
      where: { id: req.params.id, orgId: req.user!.orgId },
    });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
}

/**
 * Validate script syntax server-side (dry run in a try/catch new Function()).
 * Does NOT execute the script body — just checks it parses.
 */
export async function validateScript(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { script } = z.object({ script: z.string() }).parse(req.body);
    try {
      // eslint-disable-next-line no-new-func
      new Function('context', script);
      res.json({ valid: true });
    } catch (e: any) {
      res.json({ valid: false, error: e.message });
    }
  } catch (err) { next(err); }
}

// ─── AI Setup Generator ────────────────────────────────────────────────────────
// "Describe your business once, get relabeled terminology + draft workflow
// rules tailored to it." Two-step propose/confirm, same shape as the AI
// Action Registry (ai.controller.ts planActionHandler/executeActionHandler):
// generateSetup only reads BusinessContext and calls the model — it never
// writes anything. applySetup is the only endpoint that actually persists
// label overrides or creates workflow rules, and only for whatever the org
// admin reviewed and approved on the client.

// Keep this in sync with the client-side label lookup (useLabels.ts) and
// with wherever labels actually get rendered (AppLayout, entity pages) —
// proposing an override for a key nothing reads would just be a confusing
// no-op in the UI.
const ENTITY_KEYS = ['ticket', 'deal', 'lead', 'contact'] as const;
const ENTITY_FIELD_KEYS: Record<(typeof ENTITY_KEYS)[number], string[]> = {
  ticket:  ['title', 'priority', 'status', 'description'],
  deal:    ['title', 'value', 'stage'],
  lead:    ['name', 'status', 'source'],
  contact: ['name', 'email', 'phone', 'jobTitle'],
};

const WORKFLOW_TRIGGERS = [
  'TICKET_CREATED', 'TICKET_UPDATED', 'TICKET_STATUS_CHANGED',
  'LEAD_CREATED', 'LEAD_STATUS_CHANGED',
  'DEAL_STAGE_CHANGED', 'DEAL_WON', 'DEAL_LOST',
  'SLA_BREACH',
] as const;

// CREATE_TICKET and SCORE_LEAD are declared in workflow-engine.ts's `Action`
// type union but have no `case` in executeAction()'s switch (they fall to
// the `default: 'Unknown action type'` branch) — proposing them here would
// generate rules that silently do nothing when they fire. Left out on
// purpose until those are actually implemented.
const WORKFLOW_ACTIONS = [
  'ASSIGN_TO', 'SET_PRIORITY', 'SET_STATUS', 'SEND_EMAIL',
  'SEND_WHATSAPP', 'ADD_NOTE', 'SEND_WEBHOOK',
] as const;

// Params that, if left blank, need a human to fill in something org-specific
// (a real user ID, a real address/URL) before the rule can safely run.
// Computed here rather than trusted from the model's own output.
const REQUIRED_PARAM_KEYS: Record<string, string[]> = {
  ASSIGN_TO: ['userId'],
  SEND_EMAIL: ['to'],
  SEND_WEBHOOK: ['url'],
};

function needsInputFor(actions: Array<{ type: string; params: Record<string, any> }>): string[] {
  const missing = new Set<string>();
  for (const action of actions) {
    const required = REQUIRED_PARAM_KEYS[action.type];
    if (!required) continue;
    for (const key of required) {
      if (!action.params?.[key]) missing.add(`${action.type}.${key}`);
    }
  }
  return [...missing];
}

const GeneratedLabelsSchema = z.object({
  entities: z.record(z.object({ singular: z.string(), plural: z.string() })).optional(),
  fields: z.record(z.record(z.string())).optional(),
});

const GeneratedRuleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  trigger: z.enum(WORKFLOW_TRIGGERS),
  conditions: z.array(z.object({
    field: z.string(),
    operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains', 'in']),
    value: z.union([z.string(), z.number(), z.array(z.string())]),
  })).default([]),
  actions: z.array(z.object({
    type: z.enum(WORKFLOW_ACTIONS),
    params: z.record(z.union([z.string(), z.number()])).default({}),
  })).min(1),
});

/** Drops any entity/field key the model invented outside our whitelist. */
function cleanLabelOverrides(labels: z.infer<typeof GeneratedLabelsSchema>) {
  const clean: { entities: Record<string, any>; fields: Record<string, any> } = { entities: {}, fields: {} };
  for (const [k, v] of Object.entries(labels.entities ?? {})) {
    if ((ENTITY_KEYS as readonly string[]).includes(k)) clean.entities[k] = v;
  }
  for (const [entityKey, fieldMap] of Object.entries(labels.fields ?? {})) {
    if (!(ENTITY_KEYS as readonly string[]).includes(entityKey)) continue;
    const allowed = ENTITY_FIELD_KEYS[entityKey as (typeof ENTITY_KEYS)[number]];
    const filtered: Record<string, string> = {};
    for (const [fk, label] of Object.entries(fieldMap as Record<string, string>)) {
      if (allowed.includes(fk)) filtered[fk] = label;
    }
    if (Object.keys(filtered).length) clean.fields[entityKey] = filtered;
  }
  return clean;
}

export async function generateSetup(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!groq) throw new AppError(503, 'AI service not configured — add GROQ_API_KEY or OPENAI_API_KEY to .env');

    const ctx = await getContext(req.user!.orgId);
    if (!ctx?.industry && !ctx?.companyDesc) {
      throw new AppError(400, 'Fill in your industry and company description in Business Context first, then generate a setup.');
    }

    const contextPrefix = buildSystemPrefix(ctx);
    const systemPrompt = `You are helping configure a CRM + IT helpdesk product for a specific organization, based on their business context below.
${contextPrefix}

Produce TWO things as a single JSON object:

1. "labels" — renamed terminology for this org's domain, ONLY for these exact keys (never invent new ones):
   entities: ${ENTITY_KEYS.map(k => `"${k}"`).join(', ')} — each needs {"singular": "...", "plural": "..."}
   fields: for each entity, only these field keys may be relabeled — ${ENTITY_KEYS.map(k => `${k}: [${ENTITY_FIELD_KEYS[k].map(f => `"${f}"`).join(', ')}]`).join('; ')}.
   Only include an entity or field if renaming it genuinely fits this domain — skip ones that should stay generic (e.g. a plain B2B software company probably shouldn't rename "deal" or "contact" at all).

2. "workflowRules" — 2 to 5 draft automation rules that make sense for this business, each shaped as:
   {"name": "...", "description": "...", "trigger": one of [${WORKFLOW_TRIGGERS.join(', ')}],
    "conditions": [{"field": "...", "operator": one of [eq,neq,gt,lt,contains,in], "value": "..."}] (can be empty array),
    "actions": [{"type": one of [${WORKFLOW_ACTIONS.join(', ')}], "params": {...}}]}
   Action param shapes — ASSIGN_TO: {"userId": ""} (always leave blank, a human assigns the real user), SET_PRIORITY: {"priority": "LOW|MEDIUM|HIGH|URGENT"}, SET_STATUS: {"status": "..."}, SEND_EMAIL: {"to": "", "subject": "...", "body": "..."} (leave "to" blank unless there's an obvious fixed recipient; subject/body may use {{title}} {{status}} {{priority}} {{id}} as template variables), SEND_WHATSAPP: {"recipientType": "ASSIGNEE|ORG_DEFAULT|CUSTOM_NUMBER", "message": "..."}, ADD_NOTE: {"body": "..."}, SEND_WEBHOOK: {"url": ""} (always leave blank, a human fills a real endpoint).

Respond with ONLY the JSON object, no markdown fences, no commentary — exactly:
{"labels": {"entities": {...}, "fields": {...}}, "workflowRules": [...]}`;

    const result = await complete({
      orgId: req.user!.orgId,
      userId: req.user!.id,
      feature: 'studio.generateSetup',
      task: 'FAST',
      system: systemPrompt,
      user: 'Generate the setup now.',
      temperature: 0.5,
      maxTokens: 2000,
    });
    if (result.blocked) {
      throw new AppError(402, 'Monthly AI budget reached. Raise the limit in AI Governance, or wait for the next billing period.');
    }

    const raw = result.text || '{}';
    let parsed: any;
    try {
      const match = raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/(\{[\s\S]*\})/);
      parsed = JSON.parse(match ? match[1] : raw);
    } catch {
      throw new AppError(502, 'AI returned a response that could not be parsed — try again.');
    }

    // Validate + drop anything the model got wrong rather than fail the
    // whole request over one bad field — a partial-but-safe result beats a
    // hard error when the org still gets most of the value.
    const labelsResult = GeneratedLabelsSchema.safeParse(parsed.labels ?? {});
    const cleanLabels = labelsResult.success ? cleanLabelOverrides(labelsResult.data) : { entities: {}, fields: {} };

    const rulesInput = Array.isArray(parsed.workflowRules) ? parsed.workflowRules : [];
    const rules = rulesInput
      .map((r: any) => GeneratedRuleSchema.safeParse(r))
      .filter((r: any): r is { success: true; data: z.infer<typeof GeneratedRuleSchema> } => r.success)
      .map((r: any, i: number) => ({
        ...r.data,
        _draftId: `draft-${i}`,
        needsInput: needsInputFor(r.data.actions),
      }));

    res.json({ labelOverrides: cleanLabels, workflowRules: rules });
  } catch (err: any) {
    if (err instanceof AppError) return next(err);
    // Whichever provider getAiClient() above actually picked (Groq is
    // preferred whenever GROQ_API_KEY is set) is whichever error message
    // should reference — see ai.controller.ts's handleAIError for the same
    // fix and fuller explanation of why a Groq 429 isn't a billing issue.
    const usingGroq = !!process.env.GROQ_API_KEY;
    if (err?.status === 429 || err?.code === 'insufficient_quota') {
      return res.status(402).json({
        error: usingGroq
          ? 'Groq rate limit or usage cap reached. Check your usage at console.groq.com — usually temporary.'
          : 'AI quota exceeded. Add billing credits at platform.openai.com.',
      });
    }
    if (err?.status === 401) {
      return res.status(401).json({ error: usingGroq ? 'Invalid API key. Check GROQ_API_KEY in server/.env and restart the server.' : 'Invalid API key. Check OPENAI_API_KEY in server/.env and restart the server.' });
    }
    next(err);
  }
}

const ApplySetupSchema = z.object({
  labelOverrides: GeneratedLabelsSchema.optional(),
  workflowRules: z.array(GeneratedRuleSchema).default([]),
});

export async function applySetup(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const body = ApplySetupSchema.parse(req.body);

    // Re-validated + re-filtered here too, independently of generateSetup —
    // this is a separate request, so a hand-edited or stale client payload
    // gets the same whitelist treatment rather than being trusted outright.
    const cleanLabels = body.labelOverrides ? cleanLabelOverrides(body.labelOverrides) : { entities: {}, fields: {} };
    const hasLabels = Object.keys(cleanLabels.entities).length > 0 || Object.keys(cleanLabels.fields).length > 0;

    if (hasLabels) {
      // Merge into any labelOverrides that already exist rather than
      // clobbering them — an org can run "Generate setup" more than once,
      // or may have hand-edited overrides from an earlier pass.
      const existing = await getContext(orgId);
      const existingOverrides = ((existing?.labelOverrides as any) || {}) as { entities?: any; fields?: any };
      const merged = {
        entities: { ...existingOverrides.entities, ...cleanLabels.entities },
        fields: {
          ...existingOverrides.fields,
          ...Object.fromEntries(
            Object.entries(cleanLabels.fields).map(([k, v]) => [
              k, { ...(existingOverrides.fields?.[k] || {}), ...(v as object) },
            ])
          ),
        },
      };
      await prisma.businessContext.upsert({
        where: { orgId },
        create: { orgId, labelOverrides: merged },
        update: { labelOverrides: merged },
      });
    }

    let createdCount = 0;
    for (const rule of body.workflowRules) {
      // Server-side backstop: the client UI is expected to require filling
      // in userId/to/url before letting a rule be checked off for apply,
      // but skip rather than fail the whole batch if one still slipped
      // through incomplete — the other approved rules in this request
      // shouldn't be blocked by it.
      if (needsInputFor(rule.actions).length) continue;
      await prisma.workflowRule.create({
        data: {
          orgId,
          name: rule.name,
          description: rule.description,
          trigger: rule.trigger,
          conditions: rule.conditions,
          actions: rule.actions,
          isActive: true,
        },
      });
      createdCount++;
    }

    res.json({
      labelOverrides: hasLabels ? cleanLabels : null,
      rulesCreated: createdCount,
      rulesSkipped: body.workflowRules.length - createdCount,
    });
  } catch (err) { next(err); }
}
