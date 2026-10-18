import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/authenticate';
import { getAnalyticsContext, publicCatalog, runQuery, runForecast } from '../../utils/analytics/executor';
import { QueryError } from '../../utils/analytics/compiler';

// ─── Semantic query layer endpoints (utils/analytics/README.md) ───────────────
//
// No AI here: these power dashboards on every plan. What a caller gets is
// decided per dataset by the org's enabled areas and the caller's own
// permissions (record scope + field rules), so the routes only require a
// signed-in member of an org.

function sendQueryError(err: unknown, res: Response): boolean {
  if (err instanceof QueryError) {
    res.status(400).json({ error: err.message, details: err.hints, code: 'ANALYTICS_QUERY_INVALID' });
    return true;
  }
  return false;
}

function userOf(req: AuthRequest) {
  const u = req.user!;
  if (!u.orgId) throw new QueryError('Analytics needs an organisation account.');
  return { id: u.id, orgId: u.orgId, role: u.role };
}

/** GET /api/analytics/catalog — the datasets and fields this caller may query. */
export async function catalog(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const actx = await getAnalyticsContext(userOf(req));
    res.json(publicCatalog(actx));
  } catch (err) { if (!sendQueryError(err, res)) next(err); }
}

/** POST /api/analytics/query — body: a query spec → { columns, rows, meta }. */
export async function query(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const actx = await getAnalyticsContext(userOf(req));
    res.json(await runQuery(actx, req.body?.spec ?? req.body));
  } catch (err) { if (!sendQueryError(err, res)) next(err); }
}

/** POST /api/analytics/forecast — body: { series, horizon, scenario?, cumulative?, derived? }. */
export async function forecast(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const actx = await getAnalyticsContext(userOf(req));
    res.json(await runForecast(actx, req.body));
  } catch (err) { if (!sendQueryError(err, res)) next(err); }
}
