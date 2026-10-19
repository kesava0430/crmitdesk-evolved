/**
 * The action planner: one plain-language command → an ordered, validated,
 * previewed plan the user confirms on one card.
 *
 * Built for a small model (gpt-oss-20b on Groq):
 *  - JSON mode, a menu filtered to what this user may run in this org's areas,
 *    small enumerated param choices, one worked example;
 *  - the model names records the way the user did — the server resolves names
 *    to ids against the org's own records (scope-filtered) and asks the user
 *    to pick when two match (resolve.ts);
 *  - the model copies date words — the server resolves them in the org's
 *    timezone (dates.ts);
 *  - every step is validated against the action's zod schema, and a plan with
 *    model mistakes (unknown action, bad params, bad step references) gets ONE
 *    repair round-trip with the exact errors before the user sees it.
 *  - the system prompt holds nothing request-specific (no date, no names), so
 *    the provider's prompt cache covers the long menu on every call.
 *
 * Nothing here writes to the database; execution re-validates everything
 * (executor.ts) and never trusts the plan the client sends back.
 */
import crypto from 'crypto';
import { prisma } from '../prisma';
import { complete } from '../aiGateway';
import { tierFor, pickRelevant } from '../ai';
import { getEffectiveLicense } from '../licensing';
import { getPermCtx, type PermCtx } from '../permissions';
import { ensureDefaultPipeline, normalizeStages } from '../../modules/crm/pipelines/pipelines.service';
import { AI_ACTIONS, getAiAction, actionMenuForPrompt, actionBlockedReason, roleBlockedReason, riskOf } from '../ai-actions';
import { resolveDate, describeToday, validTimeZone } from './dates';
import { matchName, type Candidate } from './resolve';
import { parseRef, collectRefs, checkStepRefs } from './refs';
import { ENTITIES, recordAllowed } from './entities';
import { listPreview } from './helpers';
import type { AiActionDefinition, ActionPreview, EntityKey, PreviewInfo, Risk, AiActionContext } from './types';

export interface PlanUser { id: string; orgId: string; role: string; email: string; name?: string }

export interface Ambiguity { param: string; query: string; entity: EntityKey; noun: string; candidates: Candidate[] }

export interface PlanStep {
  index: number;
  action: string;
  label: string;
  category: string;
  params: Record<string, any>;
  risk: Risk;
  allowed: boolean;
  blockedReason?: string;
  /** Problems that stop this step (validation, record not found, bad dates). */
  errors: string[];
  /** Names that matched several records — the user picks one on the card. */
  needs: Ambiguity[];
  /** Soft warnings (a date in the past, an assumed 09:00). */
  warnings: string[];
  preview: ActionPreview;
  dependsOn: number[];
}

export interface ActionPlan {
  planId: string;
  interactionLogId: string | null;
  steps: PlanStep[];
  explanation: string;
  confidence: number;
  risk: Risk;
  requiresSecondConfirmation: boolean;
  /** Every step allowed, valid and unambiguous — the card can run it. */
  ready: boolean;
  repaired: boolean;
  // Mirror of the first step, for clients built before multi-step plans.
  action: string | null;
  params: Record<string, any>;
  label?: string;
  allowed: boolean;
  requiresConfirmation: boolean;
}

export interface NormalizeEnv {
  user: PlanUser;
  perm: PermCtx;
  blockedModules: readonly string[];
  timeZone: string;
  now: Date;
}

const RISK_ORDER: Risk[] = ['low', 'medium', 'high'];
const MAX_STEPS = 6;

// ─── Normalisation of one step (shared with the executor) ────────────────────

/** "the new lead (step 1)" / "the result of step 2 (convert a lead to a deal)". */
export function refLabel(step: number, src?: AiActionDefinition): string {
  if (!src) return `the result of step ${step}`;
  const m = src.label.match(/^(?:Create|Add|Draft|Start|Request|Raise)\s+(?:an?\s+|the\s+)?(.+?)(?:\s*\(.*\))?$/i);
  return m ? `the new ${m[1].toLowerCase()} (step ${step})` : `the result of step ${step} (${src.label.toLowerCase()})`;
}

function stripNulls(value: any): any {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null && v !== '') out[k] = stripNulls(v);
    return out;
  }
  return value;
}

function refEntity(def: AiActionDefinition, param: string, params: any): EntityKey | undefined {
  if (def.record?.param === param) return def.record.entity;
  const r = def.refs?.[param];
  return typeof r === 'function' ? r(params) : r;
}

async function resolveOne(env: NormalizeEnv, entity: EntityKey, raw: string): Promise<
  { ok: true; id: string; label: string } | { ok: false; ambiguous?: Candidate[]; error?: string }
> {
  const def = ENTITIES[entity];
  const value = raw.trim();
  // An id the model (or the user's pick) gave: must exist in this org AND be within the user's read scope.
  if (/^[a-z0-9]{20,40}$/i.test(value) && !/\s/.test(value)) {
    const row = await def.load(env.user.orgId, value).catch(() => null);
    if (row) {
      if (!recordAllowed(env.perm, entity, def.scope?.read, row)) return { ok: false, error: `That ${def.noun} is outside what you can access.` };
      return { ok: true, id: row.id, label: def.title(row) };
    }
  }
  const candidates = await def.search(env.user.orgId, env.perm, value);
  const m = matchName(value, candidates);
  if (m.status === 'ok') return { ok: true, id: m.id, label: m.label };
  if (m.status === 'ambiguous') return { ok: false, ambiguous: m.candidates };
  return { ok: false, error: `No ${def.noun} called “${value}” was found${def.scope ? ' among the records you can see' : ''}.` };
}

/**
 * Turns one raw step (as the model wrote it, or as the client sends it back
 * after the user picked candidates) into validated params + a preview.
 * `steps` is the whole plan so step references can be labelled.
 */
export async function normalizeStep(
  env: NormalizeEnv,
  raw: { action: string; params?: Record<string, any> },
  index: number,
  allSteps: Array<{ action: string }>,
): Promise<PlanStep & { modelErrors: string[] }> {
  const def = getAiAction(String(raw.action ?? '').trim().toUpperCase());
  const base = {
    index, action: String(raw.action ?? ''), category: def?.category ?? 'Shared', label: def?.label ?? String(raw.action ?? 'Unknown action'),
    risk: 'medium' as Risk, allowed: false, errors: [] as string[], needs: [] as Ambiguity[], warnings: [] as string[], modelErrors: [] as string[], dependsOn: [] as number[],
  };
  if (!def) {
    const msg = `“${raw.action}” is not an available action.`;
    return { ...base, params: raw.params ?? {}, errors: [msg], modelErrors: [`Step ${index}: unknown action "${raw.action}" — use only names from the list.`], preview: { title: base.label, changes: [] } };
  }
  let params: Record<string, any> = stripNulls(raw.params && typeof raw.params === 'object' ? raw.params : {});
  base.action = def.name;
  base.dependsOn = [...collectRefs(params)].sort();

  const info: PreviewInfo = { labels: {}, dateLabels: {}, refLabels: {}, row: null };
  for (const [k, v] of Object.entries(params)) {
    const r = parseRef(v);
    if (r) {
      const src = allSteps[r.step - 1];
      const srcDef = src ? getAiAction(String(src.action).toUpperCase()) : undefined;
      info.refLabels[k] = refLabel(r.step, srcDef);
    }
  }

  // 1. Dates in words → concrete values in the org timezone.
  for (const [k, kind] of Object.entries(def.dates ?? {})) {
    if (params[k] === undefined || parseRef(params[k])) continue;
    const d = resolveDate(String(params[k]), kind, { now: env.now, timeZone: env.timeZone });
    if (!d.ok) { base.errors.push(`${k}: ${d.error}`); base.modelErrors.push(`Step ${index} ${k}: ${d.error}`); continue; }
    params[k] = d.value;
    info.dateLabels[k] = d.label + (d.assumedTime ? ' (09:00 assumed — say a time to change it)' : '');
    if (d.past) base.warnings.push(`${k} (${d.label}) is in the past.`);
  }

  // 2. Record names → ids, scope-filtered; ambiguity becomes a question.
  const refParams = new Set([...Object.keys(def.refs ?? {}), ...(def.record ? [def.record.param] : [])]);
  for (const k of refParams) {
    const v = params[k];
    if (v === undefined) continue;
    const entity = refEntity(def, k, params);
    if (!entity) continue;
    const values: Array<{ path: string; value: unknown; set: (id: string) => void }> = Array.isArray(v)
      ? v.map((x, i) => ({ path: `${k}.${i}`, value: x, set: (id: string) => { params[k][i] = id; } }))
      : [{ path: k, value: v, set: (id: string) => { params[k] = id; } }];
    const labels: string[] = [];
    for (const item of values) {
      if (parseRef(item.value)) continue; // shown via refLabels
      if (typeof item.value !== 'string' || !item.value.trim()) continue;
      const r = await resolveOne(env, entity, item.value);
      if (r.ok) { item.set(r.id); labels.push(r.label); }
      else if (r.ambiguous) base.needs.push({ param: item.path, query: String(item.value), entity, noun: ENTITIES[entity].noun, candidates: r.ambiguous });
      else if (r.error) base.errors.push(r.error);
    }
    if (labels.length) info.labels[k] = labels.join(', ');
  }

  // 3. Schema (defaults applied). Unresolved names are reported above, not twice.
  const parsed = def.schema.safeParse(params);
  if (parsed.success) params = parsed.data as Record<string, any>;
  else if (!base.needs.length) {
    for (const i of parsed.error.issues.slice(0, 5)) {
      const msg = `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`;
      base.errors.push(msg);
      base.modelErrors.push(`Step ${index} (${def.name}) ${msg}. Expected params: ${def.paramsHint}`);
    }
  }

  // 4. Who may run it, in which areas.
  const why = roleBlockedReason(def, env.user.role, env.perm) ?? actionBlockedReason(def.name, params, env.blockedModules);
  const risk = riskOf(def, params);

  // 5. The record it changes: exists in this org, and inside the user's scope for this kind of change.
  if (def.record && typeof params[def.record.param] === 'string' && !parseRef(params[def.record.param]) && !base.needs.length) {
    const ent = ENTITIES[def.record.entity];
    info.row = await ent.load(env.user.orgId, params[def.record.param]).catch(() => null);
    if (!info.row) base.errors.push(`That ${ent.noun} no longer exists.`);
    else if (!recordAllowed(env.perm, def.record.entity, def.record.permission, info.row)) {
      base.errors.push(`You don't have access to change this ${ent.noun}.`);
    }
  }

  // 6. The before → after card.
  let preview: ActionPreview = listPreview(def.label, params, info);
  if (!base.needs.length && !base.errors.length) {
    try {
      const ctx: AiActionContext = { orgId: env.user.orgId, userId: env.user.id, role: env.user.role, email: env.user.email, perm: env.perm, timeZone: env.timeZone };
      if (def.preview) preview = await def.preview(params as any, ctx, info);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      base.errors.push(msg);
      base.modelErrors.push(`Step ${index} (${def.name}): ${msg}`);
    }
  }

  return { ...base, params, risk, allowed: !why, ...(why ? { blockedReason: why } : {}), preview };
}

// ─── Context for the model ───────────────────────────────────────────────────

/** Entity types the offered actions can point at. */
function entitiesFor(actions: AiActionDefinition[]): EntityKey[] {
  const set = new Set<EntityKey>();
  for (const a of actions) {
    if (a.record) set.add(a.record.entity);
    for (const r of Object.values(a.refs ?? {})) if (typeof r === 'string') set.add(r);
    if (a.refs && Object.values(a.refs).some(r => typeof r === 'function')) ['ticket', 'deal', 'lead', 'contact'].forEach(e => set.add(e as EntityKey));
  }
  return [...set];
}

async function buildContext(env: NormalizeEnv, command: string, offered: AiActionDefinition[]): Promise<string> {
  const lines: string[] = [];
  const ents = entitiesFor(offered).filter(e => !ENTITIES[e].module || !env.blockedModules.includes(ENTITIES[e].module!));
  // Small fixed lists the model needs whole (choices, not records).
  const whole = new Set<EntityKey>(['leaveType', 'category', 'payrollCycle', 'department']);
  await Promise.all(ents.map(async e => {
    try {
      const def = ENTITIES[e];
      const [named, recent] = await Promise.all([def.search(env.user.orgId, env.perm, command), whole.has(e) ? Promise.resolve([] as Candidate[]) : def.search(env.user.orgId, env.perm, '')]);
      const merged = [...named, ...recent.filter(r => !named.some(n => n.id === r.id))];
      const picked = whole.has(e) ? named.slice(0, 15) : pickRelevant(merged, c => c.label, command, 3).slice(0, 8);
      if (picked.length) lines.push(`${e}: ${JSON.stringify(picked.map(c => ({ id: c.id, name: c.label, ...(c.hint ? { hint: c.hint } : {}) })))}`);
    } catch { /* a context list is a hint, never a requirement */ }
  }));
  if (offered.some(a => ['MOVE_DEAL_STAGE', 'UPDATE_DEAL', 'CREATE_DEAL', 'CONVERT_LEAD'].includes(a.name)) && !env.blockedModules.includes('crm')) {
    try { lines.push(`pipelineStages: ${JSON.stringify(normalizeStages((await ensureDefaultPipeline(env.user.orgId)).stages).map(s => s.label))}`); } catch { /* ignore */ }
  }
  if (offered.some(a => /CUSTOM_(MODULE|RECORD)/.test(a.name))) {
    const modules = await prisma.customModule.findMany({
      where: { orgId: env.user.orgId, isActive: true }, take: 15,
      select: { id: true, name: true, stages: true, fields: { select: { fieldKey: true, label: true, fieldType: true }, orderBy: { position: 'asc' } } },
    });
    if (modules.length) lines.push(`customModules: ${JSON.stringify(modules.map(m => ({ id: m.id, name: m.name, fields: m.fields, ...(Array.isArray(m.stages) && m.stages.length ? { stages: (m.stages as any[]).map(s => s.key) } : {}) })))}`);
  }
  return lines.sort().join('\n');
}

/* Words that point at an action even when the user doesn't use its name. */
const ACTION_HINTS: Array<[RegExp, string[]]> = [
  [/\b(ticket|issue|bug|broken|not working|outage|incident|projector|printer|vpn|laptop|wifi|password)\b/, ['CREATE_TICKET', 'UPDATE_TICKET', 'UPDATE_TICKET_STATUS', 'ASSIGN_TICKET']],
  [/\b(close|resolve|reopen)\b/, ['UPDATE_TICKET_STATUS']],
  [/\b(lead|prospect|enquiry|inquiry)\b/, ['CREATE_LEAD', 'UPDATE_LEAD', 'UPDATE_LEAD_STATUS', 'CONVERT_LEAD', 'SCORE_LEAD']],
  [/\b(deal|opportunity|pipeline|stage)\b/, ['CREATE_DEAL', 'UPDATE_DEAL', 'MOVE_DEAL_STAGE']],
  [/\b(contact|customer|client)\b/, ['CREATE_CONTACT', 'UPDATE_CONTACT']],
  [/\b(account|company)\b/, ['CREATE_ACCOUNT', 'UPDATE_ACCOUNT']],
  [/\b(call|meeting|follow[- ]?up|activity|schedule)\b/, ['LOG_ACTIVITY', 'CREATE_TASK']],
  [/\b(remind|reminder|whatsapp)\b/, ['SCHEDULE_WHATSAPP_REMINDER', 'SEND_WHATSAPP_NOW', 'CREATE_TASK']],
  [/\b(task|todo|to-do)\b/, ['CREATE_TASK']],
  [/\b(note|comment)\b/, ['ADD_NOTE']],
  [/\b(quote|quotation|proposal)\b/, ['CREATE_QUOTE', 'CHANGE_QUOTE_STATUS']],
  [/\b(invoice|bill|paid|payment)\b/, ['CREATE_INVOICE', 'CHANGE_INVOICE_STATUS']],
  [/\b(campaign|newsletter)\b/, ['CREATE_CAMPAIGN', 'SEND_CAMPAIGN']],
  [/\b(leave|vacation|holiday|sick|time off|day off)\b/, ['REQUEST_LEAVE', 'APPROVE_LEAVE', 'REJECT_LEAVE', 'APPLY_LEAVE_ON_BEHALF']],
  [/\b(wfh|work from home|remote)\b/, ['REQUEST_WFH', 'APPROVE_LEAVE', 'REJECT_LEAVE']],
  [/\b(attendance|absent|present|half day|check[- ]?in|mark)\b/, ['MARK_ATTENDANCE', 'BULK_MARK_ATTENDANCE', 'MANUAL_ATTENDANCE_ENTRY']],
  [/\b(payroll|salary|payslip)\b/, ['START_PAYROLL_RUN', 'CHANGE_SALARY']],
  [/\b(loan|advance|emi|repay)\b/, ['ADD_LOAN', 'RECORD_LOAN_REPAYMENT']],
  [/\b(employee|staff|hire|joiner|onboard|designation|department)\b/, ['ADD_EMPLOYEE', 'UPDATE_EMPLOYEE']],
  [/\b(invite|user|deactivate|disable)\b/, ['INVITE_USER', 'DEACTIVATE_USER']],
  [/\b(asset|device|equipment|check[- ]?out|check[- ]?in)\b/, ['CREATE_ASSET', 'CHECK_OUT_ASSET', 'CHECK_IN_ASSET', 'UPDATE_ASSET_STATUS']],
  [/\b(article|kb|knowledge)\b/, ['CREATE_KB_ARTICLE', 'LINK_KB_ARTICLE']],
  [/\b(change request|change)\b/, ['CREATE_CHANGE_REQUEST']],
  [/\b(category)\b/, ['CREATE_TICKET_CATEGORY']],
  [/\b(approv|reject)\w*\b/, ['DECIDE_APPROVAL', 'APPROVE_LEAVE', 'REJECT_LEAVE']],
  [/\b(module|record|field)\b/, ['CREATE_CUSTOM_MODULE', 'ADD_CUSTOM_MODULE_FIELD', 'CREATE_CUSTOM_MODULE_RECORD', 'UPDATE_CUSTOM_MODULE_RECORD', 'MOVE_CUSTOM_RECORD_STAGE']],
  [/\b(workflow|rule|automation)\b/, ['TOGGLE_WORKFLOW_RULE']],
];
/** Offered when nothing in the request points anywhere in particular. */
const COMMON_ACTIONS = ['CREATE_TICKET', 'CREATE_LEAD', 'CREATE_TASK', 'REQUEST_LEAVE', 'ADD_NOTE', 'LOG_ACTIVITY', 'CREATE_CONTACT', 'REQUEST_WFH'];

/**
 * The actions worth showing the model for this request. All 58 actions with
 * their params are ~7k tokens; Groq's free tier refuses any request over 8k
 * tokens (prompt + reply allowance), so the planner never worked there, and
 * on paid tiers the whole menu is slow and dear. The menu is narrowed to the
 * actions the request points at (by name, description and hint words), plus
 * a few common ones; execution still re-checks every step against the full
 * registry, so this only changes what the model reads.
 */
export function relevantActions<T extends { name: string; description: string }>(menu: T[], command: string, max = 12): T[] {
  const q = command.toLowerCase();
  const words = new Set(q.split(/[^a-z0-9]+/).filter(w => w.length >= 3));
  const score = new Map<string, number>();
  for (const a of menu) {
    let n = 0;
    for (const w of a.name.toLowerCase().split('_')) if (w.length >= 3 && words.has(w.replace(/s$/, '')) || words.has(w)) n += 3;
    for (const w of a.description.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 5 && words.has(w)) n += 1;
    score.set(a.name, n);
  }
  for (const [re, names] of ACTION_HINTS) if (re.test(q)) for (const nm of names) if (score.has(nm)) score.set(nm, (score.get(nm) ?? 0) + 4);
  const ranked = menu.filter(a => (score.get(a.name) ?? 0) > 0).sort((a, b) => (score.get(b.name) ?? 0) - (score.get(a.name) ?? 0));
  const picked = ranked.slice(0, max);
  for (const nm of COMMON_ACTIONS) {
    if (picked.length >= max + 3) break;
    const a = menu.find(m => m.name === nm);
    if (a && !picked.includes(a)) picked.push(a);
  }
  return picked.length ? picked : menu.slice(0, max);
}

function systemPrompt(menu: Array<{ name: string; description: string; params: string }>): string {
  const names = new Set(menu.map(m => m.name));
  const example = names.has('CREATE_LEAD') && names.has('LOG_ACTIVITY')
    ? `Example — "Create a lead for Ravi from Acme and schedule a call with him Friday 11am" →\n{"steps":[{"action":"CREATE_LEAD","params":{"contactName":"Ravi","company":"Acme"}},{"action":"LOG_ACTIVITY","params":{"type":"CALL","title":"Call Ravi","leadId":"$1.id","dueAt":"Friday 11am"}}],"confidence":85,"explanation":"Create Ravi's lead, then schedule a call on it for Friday 11am."}`
    : names.has('REQUEST_LEAVE')
      ? `Example — "I need leave tomorrow, I'm unwell" →\n{"steps":[{"action":"REQUEST_LEAVE","params":{"leaveTypeId":"Sick Leave","startDate":"tomorrow","reason":"Unwell"}}],"confidence":80,"explanation":"Request sick leave for tomorrow."}`
      : `Example → {"steps":[{"action":"${menu[0]?.name ?? 'ACTION'}","params":{}}],"confidence":70,"explanation":"…"}`;
  return [
    'You are the action planner of Zenkara 360, a business app with HR, CRM and IT Desk. Turn the user\'s request into an ordered plan of actions taken ONLY from this list:',
    menu.map(a => `- ${a.name}: ${a.description}\n  params: ${a.params}`).join('\n'),
    '',
    'Reply with JSON only: {"steps":[{"action":"NAME","params":{...}}],"confidence":0-100,"explanation":"one short sentence the user will read before confirming"}',
    'Rules:',
    `1. Fewest steps that do what was asked, in the order they must happen (at most ${MAX_STEPS}). If nothing in the list fits, or the user is only asking a question, return {"steps":[],"confidence":0,"explanation":"<what you can't do>"}.`,
    '2. To use a record an earlier step creates, write "$N.id" where N is that step\'s number (starting at 1), e.g. {"leadId":"$1.id"}.',
    '3. For an existing record, give its id from the context lists when it is there; otherwise write its name exactly as the user did (e.g. "Acme renewal", "Priya") — the server looks names up. Never invent an id.',
    '4. Dates and times: copy the user\'s own words ("Friday 11am", "tomorrow", "next Monday", "end of month", "October") or write YYYY-MM-DD. Do not calculate dates yourself.',
    '5. Only use params listed for the chosen action; leave out anything you don\'t know rather than guessing. Enumerated values must be one of the listed options.',
    '6. "me"/"myself" is the current user: leave assignee/owner params out, and use recipientType "ME" for "remind me" WhatsApp reminders.',
    example,
  ].join('\n');
}

function parseModelPlan(text: string): { steps: Array<{ action: string; params: Record<string, any> }>; confidence: number; explanation: string } | null {
  let j: any;
  try { j = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { j = JSON.parse(m[0]); } catch { return null; }
  }
  if (Array.isArray(j)) j = { steps: j };
  // Older single-action shape ({action, params}) still accepted.
  if (j && !j.steps && typeof j.action === 'string') j = { steps: [{ action: j.action, params: j.params ?? {} }], confidence: j.confidence, explanation: j.explanation };
  if (!j || !Array.isArray(j.steps)) return null;
  const steps = j.steps
    .filter((s: any) => s && typeof s.action === 'string')
    .slice(0, MAX_STEPS)
    .map((s: any) => ({ action: s.action, params: s.params && typeof s.params === 'object' && !Array.isArray(s.params) ? s.params : {} }));
  return { steps, confidence: typeof j.confidence === 'number' ? Math.max(0, Math.min(100, j.confidence)) : 50, explanation: typeof j.explanation === 'string' ? j.explanation.slice(0, 400) : '' };
}

async function callModel(user: PlanUser, system: string, prompt: string): Promise<{ text: string; logId: string | null }> {
  const res = await complete({ orgId: user.orgId, userId: user.id, feature: 'command.plan', task: tierFor('command.plan', ''), system, user: prompt, maxTokens: 700, temperature: 0.1, json: true });
  if (res.blocked) {
    const err: any = new Error(res.blockedBy === 'TOKEN_LIMIT' ? "Your plan's monthly AI allowance is used up." : 'Monthly AI budget reached. Raise the limit in AI Governance, or wait for the next billing period.');
    err.status = 402;
    throw err;
  }
  return { text: res.text, logId: res.logId ?? null };
}

export async function envFor(user: PlanUser, now = new Date()): Promise<NormalizeEnv> {
  const [{ blockedModules }, perm, org] = await Promise.all([
    getEffectiveLicense(user.orgId),
    getPermCtx(user),
    prisma.organization.findUnique({ where: { id: user.orgId }, select: { timezone: true } }),
  ]);
  return { user, perm, blockedModules: blockedModules as string[], timeZone: validTimeZone(org?.timezone), now };
}

/** Normalises a list of raw steps into plan steps (+ the errors worth a repair round). */
export async function normalizeSteps(env: NormalizeEnv, raw: Array<{ action: string; params?: Record<string, any> }>) {
  const steps: Array<PlanStep & { modelErrors: string[] }> = [];
  for (let i = 0; i < raw.length; i++) steps.push(await normalizeStep(env, raw[i], i + 1, raw));
  const refErrors = checkStepRefs(raw.map(r => ({ params: r.params ?? {} })));
  refErrors.forEach(e => {
    const n = Number(e.match(/^Step (\d+)/)?.[1] ?? 0);
    if (steps[n - 1]) { steps[n - 1].errors.push(e); steps[n - 1].modelErrors.push(e); }
  });
  return steps;
}

export function summarisePlan(steps: PlanStep[], meta: { planId: string; interactionLogId: string | null; explanation: string; confidence: number; repaired: boolean }): ActionPlan {
  const risk = steps.reduce<Risk>((m, s) => (RISK_ORDER.indexOf(s.risk) > RISK_ORDER.indexOf(m) ? s.risk : m), 'low');
  const ready = steps.length > 0 && steps.every(s => s.allowed && !s.errors.length && !s.needs.length);
  const first = steps[0];
  return {
    ...meta, steps, risk, ready,
    requiresSecondConfirmation: steps.some(s => s.risk === 'high'),
    action: first?.action ?? null, params: first?.params ?? {}, label: first?.label,
    allowed: steps.length > 0 && steps.every(s => s.allowed),
    requiresConfirmation: true,
  };
}

/**
 * The whole planning round: menu → model → normalise → (one repair) → plan.
 * Returns an empty plan with an explanation when nothing fits.
 */
export async function planCommand(user: PlanUser, command: string, opts: { now?: Date } = {}): Promise<ActionPlan> {
  const env = await envFor(user, opts.now);
  const planId = crypto.randomUUID();
  const menu = actionMenuForPrompt(user.role, env.blockedModules, env.perm);
  if (!menu.length) {
    return summarisePlan([], { planId, interactionLogId: null, explanation: 'There are no actions your role can run from the assistant in this organisation.', confidence: 0, repaired: false });
  }
  const shown = relevantActions(menu, command);
  const offered = AI_ACTIONS.filter(a => shown.some(m => m.name === a.name));
  const system = systemPrompt(shown);
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
  const context = await buildContext(env, command, offered);
  const prompt = [
    `Request: ${JSON.stringify(command)}`,
    `Current user: ${me?.name ?? 'unknown'} (${user.role.replace(/_/g, ' ').toLowerCase()})`,
    `Today: ${describeToday(env.now, env.timeZone)}, timezone ${env.timeZone}`,
    context ? `Context — existing records (use the id when one matches):\n${context}` : 'Context: (no matching records)',
  ].join('\n');

  let first: { text: string; logId: string | null };
  try { first = await callModel(user, system, prompt); }
  catch (err: any) {
    if (err?.status === 402) throw err;
    console.error('[planCommand] model call failed:', err?.status, err?.message || err);
    return summarisePlan([], { planId, interactionLogId: null, explanation: 'The AI request failed — try again in a moment.', confidence: 0, repaired: false });
  }
  let parsed = parseModelPlan(first.text);
  let logId = first.logId;
  let repaired = false;
  let steps = parsed ? await normalizeSteps(env, parsed.steps) : [];
  const modelErrors = parsed ? steps.flatMap(s => s.modelErrors) : ['The reply was not valid JSON in the required shape.'];

  // One repair round with the exact problems — never more (cost, latency).
  if (modelErrors.length) {
    try {
      const fix = await callModel(user, system, `${prompt}\n\nYour previous reply:\n${first.text.slice(0, 3000)}\n\nIt has these problems:\n${modelErrors.map(e => `- ${e}`).join('\n')}\n\nReturn the corrected JSON plan only.`);
      const p2 = parseModelPlan(fix.text);
      if (p2) {
        const s2 = await normalizeSteps(env, p2.steps);
        const errs2 = s2.flatMap(s => s.modelErrors).length;
        if (!parsed || errs2 < modelErrors.length) { parsed = p2; steps = s2; logId = fix.logId ?? logId; repaired = true; }
      }
    } catch (err: any) {
      if (err?.status === 402) throw err;
    }
  }
  // The model saw a narrowed menu. If it found nothing to do, try once more
  // with a wider one, so the narrowing can't hide the action the user meant.
  if (parsed && !parsed.steps.length && shown.length < menu.length) {
    try {
      const wider = [...shown, ...menu.filter(m => !shown.includes(m))].slice(0, 26);
      const widerOffered = AI_ACTIONS.filter(a => wider.some(m => m.name === a.name));
      const ctx2 = await buildContext(env, command, widerOffered);
      const prompt2 = prompt.replace(/Context[\s\S]*$/, ctx2 ? `Context — existing records (use the id when one matches):\n${ctx2}` : 'Context: (no matching records)');
      const again = await callModel(user, systemPrompt(wider), prompt2);
      const p3 = parseModelPlan(again.text);
      if (p3 && p3.steps.length) {
        const s3 = await normalizeSteps(env, p3.steps);
        if (!s3.some(x => x.modelErrors.length)) { parsed = p3; steps = s3; logId = again.logId ?? logId; }
      }
    } catch (err: any) {
      if (err?.status === 402) throw err;
    }
  }
  if (!parsed) return summarisePlan([], { planId, interactionLogId: logId, explanation: 'I couldn’t turn that into actions — try rephrasing with the specifics (who, what, when).', confidence: 0, repaired });

  const clean: PlanStep[] = steps.map(({ modelErrors: _m, ...s }) => s);
  return summarisePlan(clean, { planId, interactionLogId: logId, explanation: parsed.explanation, confidence: parsed.confidence, repaired });
}

/**
 * Re-normalises steps the client sends back after the user picked candidates
 * (no model call): fresh previews, resolved names, current permissions.
 */
export async function reviewPlan(user: PlanUser, raw: Array<{ action: string; params?: Record<string, any> }>, meta: { planId?: string; interactionLogId?: string | null; explanation?: string; confidence?: number }): Promise<ActionPlan> {
  const env = await envFor(user);
  const steps = (await normalizeSteps(env, raw.slice(0, MAX_STEPS))).map(({ modelErrors: _m, ...s }) => s);
  return summarisePlan(steps, { planId: meta.planId || crypto.randomUUID(), interactionLogId: meta.interactionLogId ?? null, explanation: meta.explanation ?? '', confidence: meta.confidence ?? 0, repaired: false });
}
