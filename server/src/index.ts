import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { authRouter } from './modules/core/auth/auth.routes';
import { usersRouter } from './modules/core/users/users.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { contactsRouter } from './modules/crm/contacts/contacts.routes';
import { accountsRouter } from './modules/crm/accounts/accounts.routes';
import { leadsRouter } from './modules/crm/leads/leads.routes';
import { dealsRouter } from './modules/crm/deals/deals.routes';
import { activitiesRouter } from './modules/crm/activities/activities.routes';
import { ticketsRouter } from './modules/itdesk/tickets/tickets.routes';
import { categoriesRouter } from './modules/itdesk/categories/categories.routes';
import { slaRouter } from './modules/itdesk/sla/sla.routes';
import { articlesRouter } from './modules/itdesk/articles/articles.routes';
import { commentsRouter } from './modules/core/comments/comments.routes';
import { searchRouter } from './modules/core/search/search.routes';
import { usersAdminRouter } from './modules/core/users/usersAdmin.routes';
import { reportsRouter } from './modules/core/reports/reports.routes';
import { orgRouter } from './modules/core/org/org.routes';
import { aiRouter } from './modules/ai/ai.routes';
import { inboxRouter } from './modules/inbox/inbox.routes';
import { workflowsRouter } from './modules/workflows/workflows.routes';
import { portalRouter } from './modules/portal/portal.routes';
import { portalUsersRouter } from './modules/portal/portalUsers.routes';
import { billingRouter } from './modules/billing/billing.routes';
import { analyticsRouter } from './modules/analytics/analytics.routes';
import { eventsRouter } from './modules/events/events.routes';
import { slackRouter } from './modules/slack/slack.routes';
import { assetsRouter } from './modules/itdesk/assets/assets.routes';
import { csatRouter } from './modules/csat/csat.routes';
import { campaignsRouter } from './modules/campaigns/campaigns.routes';
import { changeRequestsRouter } from './modules/changemanagement/changeRequests.routes';
import { apiKeysRouter } from './modules/apikeys/apikeys.routes';
import { customFieldsRouter } from './modules/customfields/customfields.routes';
import { auditLogRouter } from './modules/core/auditlog/auditlog.routes';
import { brandingRouter } from './modules/branding/branding.routes';
import { teamsRouter } from './modules/teams/teams.routes';
import { timeTrackingRouter } from './modules/timetracking/timetracking.routes';
import { quotesRouter } from './modules/quotes/quotes.routes';
import { totpRouter } from './modules/totp/totp.routes';
import { importRouter } from './modules/import/import.routes';
import { recordTemplatesRouter } from './modules/templates/recordTemplates.routes';
import { replyTemplatesRouter } from './modules/templates/replyTemplates.routes';
import { emailTemplatesRouter } from './modules/templates/emailTemplates.routes';
import { quoteTemplatesRouter } from './modules/templates/quoteTemplates.routes';
import { schedulesRouter } from './modules/schedules/schedules.routes';
import { startSchedulePoller } from './utils/scheduler';
import { syncAllEmailAccounts } from './utils/email-sync';
import { errorHandler } from './middleware/errorHandler';
import { prisma } from './utils/prisma';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const isProd = process.env.NODE_ENV === 'production';

// Render (like most PaaS) sits the app behind a reverse proxy, which sets
// X-Forwarded-For. Without telling Express to trust it, express-rate-limit
// refuses to use that header at all — every request gets rate-limited as if
// it came from the same IP (Render's proxy), and it throws/logs
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every single request. `1` trusts
// exactly one hop (Render's own proxy), which is correct here — trusting
// unlimited hops would let a client spoof X-Forwarded-For to dodge rate
// limits entirely.
app.set('trust proxy', 1);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow avatar/file access from frontend
}));

// ─── Compression ─────────────────────────────────────────────────────────────
app.use(compression());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

// ─── Body limits (prevent payload attacks) ───────────────────────────────────
// Twilio webhook sends URL-encoded form data — must parse before JSON middleware
app.use('/api/inbox/whatsapp/webhook', express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in 15 minutes' },
  skip: () => !isProd,       // disabled in dev/test
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 300,                  // generous for normal SaaS usage
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
  skip: () => !isProd,
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/accept-invite', authLimiter);
app.use('/api/auth/approve-org-signup', authLimiter);
app.use('/api/admin/users/invite', authLimiter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable', timestamp: new Date().toISOString() });
  }
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/crm/contacts', contactsRouter);
app.use('/api/crm/accounts', accountsRouter);
app.use('/api/crm/leads', leadsRouter);
app.use('/api/crm/deals', dealsRouter);
app.use('/api/crm/activities', activitiesRouter);
app.use('/api/itdesk/tickets', ticketsRouter);
app.use('/api/itdesk/categories', categoriesRouter);
app.use('/api/itdesk/sla-policies', slaRouter);
app.use('/api/itdesk/articles', articlesRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/search', searchRouter);
app.use('/api/admin/users', usersAdminRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/org', orgRouter);
app.use('/api/ai', aiRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/workflows', workflowsRouter);
app.use('/api/portal', portalRouter);
app.use('/api/portal-users', portalUsersRouter);
app.use('/api/billing', billingRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/slack', slackRouter);
app.use('/api/itdesk/assets', assetsRouter);
app.use('/api/csat', csatRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/change-requests', changeRequestsRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/custom-fields', customFieldsRouter);
app.use('/api/audit-logs', auditLogRouter);
app.use('/api/branding', brandingRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/itdesk/time-tracking', timeTrackingRouter);
app.use('/api/quotes', quotesRouter);
app.use('/api/2fa', totpRouter);
app.use('/api/import', importRouter);
app.use('/api/templates/records', recordTemplatesRouter);
app.use('/api/templates/replies', replyTemplatesRouter);
app.use('/api/templates/emails', emailTemplatesRouter);
app.use('/api/templates/quotes', quoteTemplatesRouter);
app.use('/api/schedules', schedulesRouter);

// ─── Error handler ───────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT} (${isProd ? 'production' : 'development'})`);
});

// Purge expired refresh tokens once per hour
setInterval(async () => {
  const { count } = await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  if (count > 0) console.log(`[cleanup] Deleted ${count} expired refresh tokens`);
}, 60 * 60 * 1000);

// Email sync: run immediately on startup, then every 5 minutes
syncAllEmailAccounts().catch(() => {});
setInterval(() => syncAllEmailAccounts().catch(() => {}), 5 * 60 * 1000);

// Schedule reminders: check for due WhatsApp notifications every minute
startSchedulePoller();

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`[server] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    await prisma.$disconnect();
    console.log('[server] Closed');
    process.exit(0);
  });

  // Force exit if shutdown takes too long
  setTimeout(() => {
    console.error('[server] Forced exit after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
