/**
 * Small helpers the action definitions share: calling the UI's controller as
 * the confirming user, shaping step outputs and before → after previews.
 */
import { z } from 'zod';
import { AppError } from '../../middleware/errorHandler';
import { invokeHandler, type Handler, type InvokeInput, type Actor } from './invoke';
import { ENTITIES } from './entities';
import { formatInZone } from './dates';
import type { AiActionContext, ActionPreview, PreviewChange, PreviewInfo, StepOutput, EntityKey } from './types';

export function actorOf(ctx: AiActionContext): Actor {
  if (!ctx.role) throw new AppError(500, 'AI action context is missing the user role');
  return { id: ctx.userId, orgId: ctx.orgId, role: ctx.role, email: ctx.email ?? '' };
}

/** Runs the UI's own route handler as the confirming user (see invoke.ts). */
export function callUi<T = any>(handler: Handler, ctx: AiActionContext, input: InvokeInput = {}): Promise<T> {
  return invokeHandler<T>(handler, actorOf(ctx), input);
}

/** Output for later steps + the result card's link. */
export function out(entity: EntityKey, row: any, extra: Record<string, unknown> = {}): StepOutput {
  if (!row || typeof row !== 'object') return { type: entity, ...extra };
  const def = ENTITIES[entity];
  let label: string | undefined;
  try { label = def.title(row); } catch { label = undefined; }
  return { id: row.id, type: entity, label, link: def.link?.(row.id, row), ...extra };
}

// ─── Display ──────────────────────────────────────────────────────────────────

/** A stored instant as the org reads it. */
export function when(iso: string | Date | null | undefined, ctx: AiActionContext): string {
  return iso ? formatInZone(iso, ctx.timeZone ?? 'UTC') : '';
}

export function show(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (typeof v === 'object' && v && 'toNumber' in (v as any)) return Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (Array.isArray(v)) return v.map(x => show(x)).filter(Boolean).join(', ');
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 200);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 16).replace('T', ' ') + ' UTC';
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/** "assigneeUserId" → "Assignee user", "dueAt" → "Due at". */
export function humanize(key: string): string {
  const k = key.replace(/Ids?$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return k.charAt(0).toUpperCase() + k.slice(1).toLowerCase();
}

/** The value as the card should read it: resolved record name, resolved date, step reference, else the raw value. */
export function displayParam(key: string, value: unknown, info?: PreviewInfo): string | null {
  if (info?.refLabels[key]) return info.refLabels[key];
  if (info?.labels[key]) return info.labels[key];
  if (info?.dateLabels[key]) return info.dateLabels[key];
  return show(value);
}

/** Lists every param (create-style card: nothing existed before). */
export function listPreview(title: string, params: Record<string, unknown>, info?: PreviewInfo, hide: string[] = []): ActionPreview {
  const changes: PreviewChange[] = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    if (hide.includes(k)) continue;
    const after = displayParam(k, v, info);
    if (after === null) continue;
    changes.push({ field: humanize(k), after });
  }
  return { title, changes };
}

export interface FieldSpec { key: string; label: string; before: (row: any) => unknown }

/** Before → after for the params actually being changed on an existing row. */
export function diffPreview(row: any, params: Record<string, unknown>, info: PreviewInfo | undefined, spec: FieldSpec[]): PreviewChange[] {
  const changes: PreviewChange[] = [];
  const p = params ?? {};
  for (const f of spec) {
    if (p[f.key] === undefined) continue;
    changes.push({ field: f.label, before: row ? show(f.before(row)) : null, after: displayParam(f.key, p[f.key], info) });
  }
  return changes;
}

export function target(entity: EntityKey, row: any): ActionPreview['target'] | undefined {
  if (!row) return undefined;
  const def = ENTITIES[entity];
  return { type: entity, id: row.id, label: def.title(row), link: def.link?.(row.id, row) };
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

/** A resolved calendar date. */
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-10-23');
/** A resolved instant (the planner turns words into ISO before validation). */
export const zDateTime = z.string().refine(s => !Number.isNaN(new Date(s).getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(s), 'must be a date and time');
/** A resolved month "YYYY-MM". */
export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month like 2026-10');
/** An id the server resolved (or a "$1.id" reference to an earlier step). */
export const zId = z.string().min(1).max(80);
export const zMoney = z.coerce.number().finite().min(0).max(1e12);
