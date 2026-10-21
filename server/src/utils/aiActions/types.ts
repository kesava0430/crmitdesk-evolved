/**
 * Shapes shared by the AI action registry (utils/ai-actions.ts), the planner
 * and the executor. Kept free of runtime imports so every file can use them
 * without creating import cycles.
 */
import type { ZodSchema } from 'zod';
import type { PermCtx } from '../permissions';
import type { DateKind } from './dates';

export type Risk = 'low' | 'medium' | 'high';
export type ActionCategory = 'HR' | 'CRM' | 'IT Desk' | 'Shared' | 'Admin';

export type EntityKey =
  | 'deal' | 'lead' | 'contact' | 'account' | 'ticket' | 'quote' | 'invoice' | 'campaign' | 'asset' | 'article'
  | 'change' | 'category' | 'user' | 'staffUser' | 'employee' | 'department' | 'leaveType' | 'leaveRequest' | 'approval'
  | 'loan' | 'rule' | 'module' | 'task' | 'payrollCycle';

export interface AiActionContext {
  orgId: string;
  userId: string;
  /** The confirming user's legacy role (JWT), email and permission context. Always set by the executor. */
  role?: string;
  email?: string;
  perm?: PermCtx;
  /** Org timezone, for anything that has to talk about "today". */
  timeZone?: string;
  /** The AiInteractionLog row of the plan this step came from, for the audit trail. */
  interactionLogId?: string | null;
}

export interface AiActionResult {
  summary: string;
  data?: unknown;
}

export interface PreviewChange {
  field: string;
  before?: string | null;
  after: string | null;
}

export interface ActionPreview {
  /** One line saying exactly what will happen ("Move “Acme renewal” to Proposal"). */
  title: string;
  changes: PreviewChange[];
  /** Extra facts the person should see before confirming (skipped days, emails that will go out…). */
  notes?: string[];
  /** The record being changed, when it already exists. */
  target?: { type: string; id: string; label: string; link?: string };
}

/** What a finished step hands to later steps and to the result card. */
export interface StepOutput {
  id?: string;
  type?: string;
  label?: string;
  link?: string;
  [k: string]: unknown;
}

export interface AiActionDefinition<TParams = any> {
  name: string;
  label: string;
  /** Shown to the LLM as part of its menu of choices — keep this precise. */
  description: string;
  /** A realistic command a person could type — the "what can I say" panel. */
  example: string;
  /** Shown to the LLM so it knows what shape to fill `params` with. */
  paramsHint: string;
  /** Legacy role names allowed to invoke this action — checked server-side, always. Mirrors the UI route's requireRole. */
  allowedRoles: readonly string[];
  /** HR actions: also allowed for users who manage this HR area (utils/hrAccess.ts). */
  hrArea?: import('../hrAccess').HrArea;
  requiresConfirmation: boolean;
  schema: ZodSchema<TParams>;
  handler: (params: TParams, ctx: AiActionContext) => Promise<AiActionResult>;

  // ── Added for the multi-step assistant (all optional so older entries keep working) ──
  category?: ActionCategory;
  /** low: a note or a task; medium: ordinary creates/updates; high: money, payroll, access. High needs a second confirmation. */
  risk?: Risk | ((params: TParams) => Risk);
  /** Licence modules (utils/modules.ts) the action works on; offered while ANY of them is on. */
  modules?: string[];
  /** Permission-engine key the user must hold (utils/permissions.ts), on top of allowedRoles. */
  permission?: string;
  /** The existing record this action changes: resolved by name, scope-checked with canAccessRecord, shown as the card's target. */
  record?: { entity: EntityKey; param: string; permission?: string };
  /** Params that name other records (resolved name → id server-side). A function picks the type from the other params (polymorphic links). */
  refs?: Record<string, EntityKey | ((params: any) => EntityKey | undefined)>;
  /** Params holding dates/times in words or ISO — resolved in the org timezone before validation. */
  dates?: Record<string, DateKind>;
  /** Builds the before → after card. Defaults to listing the params. */
  preview?: (params: TParams, ctx: AiActionContext, info: PreviewInfo) => Promise<ActionPreview>;
  /** Maps the handler result to what later steps and the result card use. Defaults to result.data.id. */
  output?: (result: AiActionResult, params: TParams) => StepOutput;
  /** Valid params for the unit tests (and a worked example for the docs). */
  sample?: Record<string, unknown>;
}

/** Display data the planner collected while normalising a step. */
export interface PreviewInfo {
  /** param → human label of the record it was resolved to ("Acme renewal"). */
  labels: Record<string, string>;
  /** param → human reading of a resolved date ("Fri 23 Oct 2026, 11:00"). */
  dateLabels: Record<string, string>;
  /** param → "the lead from step 1" for values that come from an earlier step. */
  refLabels: Record<string, string>;
  /** The target row when `record` is set and the id is already known. */
  row?: Record<string, any> | null;
}
