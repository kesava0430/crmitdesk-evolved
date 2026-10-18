/**
 * Runs an existing Express route handler in-process, as the confirming user.
 *
 * This is how AI actions execute "through the same code the UI uses": an
 * action names the exact controller function its screen calls (e.g.
 * leave.approveRequest, deals.moveStage) and this adapter calls it with a
 * request carrying the real logged-in user, params and body. Every rule that
 * lives in the handler — validation, role-rank checks, the permission engine,
 * balance/overlap checks, audit rows, workflows, notifications and emails —
 * therefore applies identically, and can never drift between the two paths.
 *
 * Route-level middleware (requireRole, the module/area mount gate) is not run
 * here; the action registry re-applies those checks itself before calling
 * (allowedRoles mirrors the route's role list, modules mirrors the mount).
 *
 * Handlers in this codebase only touch req.user/params/body/query (plus
 * req.ip/socket on one public endpoint, which no action uses) and answer with
 * res.json / res.status().json / res.send / res.end — that is the surface
 * implemented below.
 */
import { ZodError } from 'zod';
import { AppError } from '../../middleware/errorHandler';

export interface Actor { id: string; orgId: string; role: string; email: string }

export type Handler = (req: any, res: any, next: (err?: unknown) => void) => unknown;

export interface InvokeInput {
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
}

/** Turns a ZodError into the same short message the API's error handler would give. */
export function zodMessage(err: ZodError): string {
  return err.issues
    .map(i => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
    .slice(0, 4)
    .join('; ');
}

export async function invokeHandler<T = any>(handler: Handler, actor: Actor, input: InvokeInput = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let status = 200;
    let settled = false;
    const finish = (body: unknown) => {
      if (settled) return;
      settled = true;
      if (status >= 400) {
        const msg = (body && typeof body === 'object' && ((body as any).error || (body as any).message)) || `Request failed (${status})`;
        reject(new AppError(status, String(msg)));
      } else resolve(body as T);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      if (err instanceof ZodError) reject(new AppError(400, zodMessage(err)));
      else reject(err);
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { status = code; this.statusCode = code; return this; },
      json(body: unknown) { finish(body); return this; },
      send(body: unknown) { finish(body); return this; },
      end() { finish(undefined); return this; },
      setHeader() { return this; },
      set() { return this; },
      type() { return this; },
    };
    const req: any = {
      user: { id: actor.id, orgId: actor.orgId, role: actor.role, email: actor.email },
      params: input.params ?? {},
      body: input.body ?? {},
      query: input.query ?? {},
      headers: { 'x-zenkara-ai-action': '1' },
      method: 'POST',
      ip: '',
      socket: { remoteAddress: '' },
    };
    try {
      const r = handler(req, res, (err?: unknown) => (err ? fail(err) : finish(undefined)));
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(fail);
    } catch (err) {
      fail(err);
    }
  });
}
