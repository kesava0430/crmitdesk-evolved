/**
 * Runs a confirmed plan, step by step, as the confirming user.
 *
 * Contract:
 *  - The plan the client sends is never trusted: every step is normalised
 *    again (schema, role, permission engine, areas, record scope, name
 *    resolution) before ANYTHING runs. A step that isn't allowed, still has an
 *    unanswered "which one did you mean?", or is high-risk without the
 *    explicit second confirmation stops the whole plan up front.
 *  - Steps run in order; "$N.id" references are filled from earlier outputs.
 *  - The first failure stops the plan. The report says exactly which steps
 *    completed (with links), which one failed and why, and which were not
 *    started — there is no rollback, so nothing is left ambiguous.
 *  - Every completed step writes an audit row marked AI-initiated, carrying
 *    the AiInteractionLog id of the plan, and the interaction is marked
 *    executed (AI Governance).
 *  - A retried confirmation (double click, flaky network) with the same
 *    idempotency key returns the first run's report instead of running twice.
 */
import crypto from 'crypto';
import { prisma } from '../prisma';
import { logAction } from '../auditLog';
import { markActionExecuted } from '../aiGateway';
import { AppError } from '../../middleware/errorHandler';
import { getAiAction } from '../ai-actions';
import { substituteRefs, parseRef, type StepOutput } from './refs';
import { ENTITIES, recordAllowed } from './entities';
import { envFor, normalizeSteps, type PlanUser } from './planner';
import type { AiActionContext, Risk } from './types';

export type StepStatus = 'done' | 'failed' | 'skipped';

export interface StepReport {
  index: number;
  action: string;
  label: string;
  status: StepStatus;
  summary?: string;
  error?: string;
  output?: StepOutput;
}

export interface ExecutionReport {
  ok: boolean;
  planId: string;
  summary: string;
  completed: number;
  failedAt: number | null;
  steps: StepReport[];
}

// ─── Pure orchestration (unit-tested with fake steps) ────────────────────────

export interface RunnableStep<P = Record<string, unknown>> { action: string; label: string; params: P }

/**
 * Runs `steps` in order, filling references from earlier outputs, stopping at
 * the first failure. `run` does the real work for one step.
 */
export async function runSequential<P>(
  steps: Array<RunnableStep<P>>,
  run: (step: RunnableStep<P>, params: P, index: number) => Promise<{ summary: string; output?: StepOutput }>,
): Promise<Omit<ExecutionReport, 'planId'>> {
  const outputs: Array<StepOutput | undefined> = [];
  const reports: StepReport[] = steps.map((s, i) => ({ index: i + 1, action: s.action, label: s.label, status: 'skipped' }));
  let failedAt: number | null = null;
  for (let i = 0; i < steps.length; i++) {
    try {
      const params = substituteRefs(steps[i].params, outputs);
      const r = await run(steps[i], params, i + 1);
      outputs[i] = r.output ?? {};
      reports[i] = { ...reports[i], status: 'done', summary: r.summary, output: r.output };
    } catch (err: any) {
      failedAt = i + 1;
      reports[i] = { ...reports[i], status: 'failed', error: String(err?.message ?? err) };
      break;
    }
  }
  const completed = reports.filter(r => r.status === 'done').length;
  const total = steps.length;
  let summary: string;
  if (failedAt === null) summary = total === 1 ? (reports[0].summary ?? 'Done.') : `All ${total} steps completed.`;
  else {
    const skipped = total - failedAt;
    summary = `${completed ? `${completed} of ${total} step${total === 1 ? '' : 's'} completed` : 'Nothing was changed'}; step ${failedAt} (${reports[failedAt - 1].label}) failed: ${reports[failedAt - 1].error}`
      + (skipped ? ` ${skipped} later step${skipped === 1 ? ' was' : 's were'} not started.` : '');
  }
  return { ok: failedAt === null, summary, completed, failedAt, steps: reports };
}

// ─── Idempotency (per process; the API runs as one process) ──────────────────

const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const recent = new Map<string, { at: number; report: Promise<ExecutionReport> }>();
function remember(key: string, report: Promise<ExecutionReport>) {
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > IDEMPOTENCY_TTL_MS) recent.delete(k);
  recent.set(key, { at: now, report });
  // A failed request may be retried for real.
  report.catch(() => recent.delete(key));
}

// ─── The real executor ───────────────────────────────────────────────────────

export interface ExecuteInput {
  user: PlanUser;
  steps: Array<{ action: string; params?: Record<string, any> }>;
  command?: string;
  planId?: string;
  interactionLogId?: string | null;
  confirmHighRisk?: boolean;
  idempotencyKey?: string;
}

const RISK_ORDER: Risk[] = ['low', 'medium', 'high'];

export async function executePlan(input: ExecuteInput): Promise<ExecutionReport> {
  if (input.idempotencyKey) {
    const key = `${input.user.id}:${input.idempotencyKey}`;
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < IDEMPOTENCY_TTL_MS) return hit.report;
    const p = doExecute(input);
    remember(key, p);
    return p;
  }
  return doExecute(input);
}

async function doExecute(input: ExecuteInput): Promise<ExecutionReport> {
  const { user } = input;
  if (!input.steps.length) throw new AppError(400, 'Nothing to run.');
  if (input.steps.length > 6) throw new AppError(400, 'A plan can have at most 6 steps.');
  const planId = input.planId || crypto.randomUUID();
  const env = await envFor(user);

  // 1. Re-validate everything before anything runs.
  const norm = await normalizeSteps(env, input.steps);
  const blocked = norm.find(s => !s.allowed);
  if (blocked) throw new AppError(403, `Step ${blocked.index} (${blocked.label}): ${blocked.blockedReason}`);
  const unclear = norm.find(s => s.needs.length);
  if (unclear) throw new AppError(409, `Step ${unclear.index} (${unclear.label}): pick which ${unclear.needs[0].noun} you mean for “${unclear.needs[0].query}”.`);
  const invalid = norm.find(s => s.errors.length);
  if (invalid) throw new AppError(400, `Step ${invalid.index} (${invalid.label}): ${invalid.errors.join('; ')}`);
  const top = norm.reduce<Risk>((m, s) => (RISK_ORDER.indexOf(s.risk) > RISK_ORDER.indexOf(m) ? s.risk : m), 'low');
  if (top === 'high' && !input.confirmHighRisk) {
    throw new AppError(428, 'This plan includes a high-risk step — confirm it a second time to run it.');
  }

  // The interaction log must be this org's (and this user's) to be linked.
  let logId: string | null = null;
  if (input.interactionLogId) {
    const log = await prisma.aiInteractionLog.findFirst({ where: { id: input.interactionLogId, orgId: user.orgId }, select: { id: true, userId: true } }).catch(() => null);
    if (log && (!log.userId || log.userId === user.id)) logId = log.id;
  }

  const ctx: AiActionContext = { orgId: user.orgId, userId: user.id, role: user.role, email: user.email, perm: env.perm, timeZone: env.timeZone, interactionLogId: logId };

  // 2. Run in order, stop at the first failure.
  const report = await runSequential(
    norm.map(s => ({ action: s.action, label: s.label, params: s.params })),
    async (step, params, index) => {
      const def = getAiAction(step.action)!;
      const source = norm[index - 1];
      // A record that came from an earlier step is checked now that it exists.
      if (def.record && parseRef(source.params[def.record.param])) {
        const row = await ENTITIES[def.record.entity].load(user.orgId, String((params as any)[def.record.param]));
        if (!row) throw new Error(`The ${ENTITIES[def.record.entity].noun} from an earlier step can't be found.`);
        if (!recordAllowed(env.perm, def.record.entity, def.record.permission, row)) throw new Error(`You don't have access to change this ${ENTITIES[def.record.entity].noun}.`);
      }
      const parsed = def.schema.parse(params);
      const result = await def.handler(parsed, ctx);
      const output: StepOutput = def.output ? def.output(result, parsed) : { id: (result.data as any)?.id };
      logAction(user.id, def.name.startsWith('CREATE') || def.name.startsWith('ADD') ? 'CREATE' : 'UPDATE', `AI:${def.name}`, String(output.id ?? (def.record ? (parsed as any)[def.record.param] : 'n/a')), {
        viaAI: true, aiInitiated: true, interactionLogId: logId, planId, step: index, of: norm.length,
        command: input.command?.slice(0, 500), params: parsed, risk: source.risk, summary: result.summary,
      });
      return { summary: result.summary, output };
    },
  );

  if (logId && report.completed) {
    markActionExecuted(logId, norm.slice(0, report.completed).map(s => s.action).join('+').slice(0, 190), user.id).catch(() => {});
  }
  if (!report.ok) {
    logAction(user.id, 'UPDATE', 'AI:PLAN_FAILED', planId, { viaAI: true, interactionLogId: logId, failedAt: report.failedAt, completed: report.completed, error: report.steps[(report.failedAt ?? 1) - 1]?.error });
  }
  return { planId, ...report };
}
