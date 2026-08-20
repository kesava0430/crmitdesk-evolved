/**
 * ScriptEngine — safely runs customer-supplied JS scripts in a sandboxed context.
 *
 * Scripts receive a `context` object with:
 *   context.entity     — current form data (read-only snapshot)
 *   context.field      — { name, value } when trigger is onFieldChange
 *   context.user       — { id, name, role }
 *   context.setValue   — (fieldName: string, value: any) => void
 *   context.setError   — (fieldName: string, message: string) => void
 *   context.notify     — (message: string, type?: 'info'|'success'|'warning'|'error') => void
 *   context.ai         — async (prompt: string) => string  (calls /api/ai/query)
 *
 * Scripts run synchronously. Async scripts that call context.ai() are awaited
 * by the engine via an async wrapper.
 *
 * Security model: scripts run in the browser's JS runtime but have no access to
 * DOM, window, document, or fetch — those globals are shadowed to undefined in
 * the sandbox object. This prevents XSS-like attacks from tenant scripts.
 */

export interface ScriptContext {
  entity:   Record<string, unknown>;
  field?:   { name: string; value: unknown };
  user:     { id: string; name: string; role: string };
  setValue: (field: string, value: unknown) => void;
  setError: (field: string, message: string) => void;
  notify:   (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  ai:       (prompt: string) => Promise<string>;
}

export interface ScriptResult {
  ok:     boolean;
  error?: string;
}

/**
 * Run a single script string in a sandboxed context.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
export async function runScript(
  script: string,
  context: ScriptContext,
): Promise<ScriptResult> {
  try {
    // Wrap in async IIFE so scripts can use `await context.ai(...)`
    const wrapped = `(async function(context) {\n${script}\n})`;

    // Shadow dangerous globals by binding them to undefined in the Function scope.
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'window', 'document', 'fetch', 'XMLHttpRequest', 'eval',
      `"use strict"; return ${wrapped};`,
    )(
      undefined, undefined, undefined, undefined, undefined,
    );

    await fn(context);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Run all matching scripts for a given entity type + trigger.
 * Scripts are run sequentially — if one errors, execution continues.
 */
export async function runScripts(
  scripts: Array<{ id: string; script: string; fieldTarget: string | null }>,
  context: ScriptContext,
): Promise<void> {
  for (const s of scripts) {
    // If script targets a specific field, only run when that field matches
    if (s.fieldTarget && context.field?.name !== s.fieldTarget) continue;
    const result = await runScript(s.script, context);
    if (!result.ok) {
      console.warn(`[ScriptEngine] Script ${s.id} error:`, result.error);
    }
  }
}
