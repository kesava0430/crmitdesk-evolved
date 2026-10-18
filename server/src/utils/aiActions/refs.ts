/**
 * Step references in multi-step AI plans — pure and unit-tested.
 *
 * "Create a lead for Ravi, then schedule a follow-up call on it" needs the
 * second step to point at a record that doesn't exist yet. The planner writes
 * "$1.id" (step numbers start at 1) wherever an earlier step's output belongs;
 * the executor swaps in the real value once that step has run. Only earlier
 * steps can be referenced, so a plan is always a straight line — no cycles,
 * nothing that can run in an unexpected order.
 */

/** "$1", "$1.id", "$step1.id", "{{step1.id}}", "{{1.id}}" → { step: 1, field: 'id' }. */
export function parseRef(v: unknown): { step: number; field: string } | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m = s.match(/^\$(?:step)?(\d+)(?:\.([A-Za-z_]\w*))?$/) || s.match(/^\{\{\s*(?:step)?(\d+)(?:\.([A-Za-z_]\w*))?\s*\}\}$/);
  if (!m) return null;
  return { step: Number(m[1]), field: m[2] || 'id' };
}

/** Every step number referenced anywhere in `params` (deep). */
export function collectRefs(params: unknown, out: Set<number> = new Set()): Set<number> {
  const r = parseRef(params);
  if (r) { out.add(r.step); return out; }
  if (Array.isArray(params)) params.forEach(p => collectRefs(p, out));
  else if (params && typeof params === 'object') Object.values(params).forEach(p => collectRefs(p, out));
  return out;
}

/** Param keys (top level) whose value is a step reference. */
export function refKeys(params: Record<string, unknown>): string[] {
  return Object.entries(params ?? {}).filter(([, v]) => parseRef(v)).map(([k]) => k);
}

/**
 * Problems with the references of a plan: a step may only use steps that
 * come before it (1-based). Returns one message per bad reference.
 */
export function checkStepRefs(steps: Array<{ params: Record<string, unknown> }>): string[] {
  const errors: string[] = [];
  steps.forEach((s, i) => {
    for (const n of collectRefs(s.params)) {
      if (n < 1 || n > steps.length) errors.push(`Step ${i + 1} refers to step ${n}, which doesn't exist.`);
      else if (n >= i + 1) errors.push(`Step ${i + 1} refers to step ${n}, which hasn't run yet — a step can only use earlier steps.`);
    }
  });
  return errors;
}

export interface StepOutput { id?: string; [k: string]: unknown }

/**
 * Replaces every reference in `params` with the referenced step's output.
 * Throws when a referenced step produced no such value, so a broken chain
 * stops the plan instead of writing "$1.id" into a record.
 */
export function substituteRefs<T>(params: T, outputs: Array<StepOutput | undefined>): T {
  const walk = (v: unknown): unknown => {
    const r = parseRef(v);
    if (r) {
      const out = outputs[r.step - 1];
      const val = out?.[r.field];
      if (val === undefined || val === null || val === '') {
        throw new Error(`Step ${r.step} didn't produce a "${r.field}" to use here.`);
      }
      return val;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(params) as T;
}
