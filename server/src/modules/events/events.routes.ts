import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { sseManager, SSEEvent } from '../../utils/sse';
import { sessionStillValid } from '../../middleware/authenticate';

const router = Router();

// GET /api/events/stream?_t=<jwt>
// EventSource cannot send headers, so we accept the JWT via query param.
router.get('/stream', async (req: Request, res: Response) => {
  const token = (req.query._t as string) || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });

  let payload: { id: string; orgId: string; role: string };
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    // Same rule as middleware/authenticate.ts: only a staff access token
    // (id + role) may open the org's event stream — not a portal session or
    // an OAuth state value signed with the same secret.
    if (!payload?.id || !payload?.role || (payload as any).iss === 'portal') throw new Error('not an access token');
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Same live check as authenticate(): no stream for a deactivated user or a
  // token whose role is out of date.
  try {
    if (!(await sessionStillValid(payload))) return res.status(401).json({ error: 'Invalid token' });
  } catch {
    return res.status(503).json({ error: 'Try again shortly' });
  }

  const { id: userId, orgId } = payload;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseManager.add(orgId, userId, res);

  // Initial ping
  res.write(`event: ${SSEEvent.PING}\ndata: {"ts":${Date.now()},"orgId":"${orgId}"}\n\n`);

  // Keep-alive every 25s
  const keepAlive = setInterval(() => {
    try {
      res.write(`event: ${SSEEvent.PING}\ndata: {"ts":${Date.now()}}\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);

  req.on('close', () => clearInterval(keepAlive));
});

export { router as eventsRouter };
