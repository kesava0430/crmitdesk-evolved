import { prisma } from './prisma';

/**
 * Postgres-backed retry queue for at-least-once background delivery. This
 * exists to close a specific reliability gap: mailer.ts / slack.ts /
 * teams.ts / webPush.ts all previously did `.catch(err => console.error(...))`
 * on delivery failure — a transient SMTP timeout, a rate-limited Slack
 * webhook, a flaky push endpoint meant the message was just gone, logged to
 * a console nobody watches, with no retry and no visibility. This gives
 * those failures a second (and third, and fourth...) chance, and a place
 * (the admin "Failed Jobs" panel) where a permanently-failed send is
 * actually visible instead of silently dropped.
 *
 * Deliberately a DB-polled queue, not Redis/BullMQ — see scheduler.ts's doc
 * comment for why this app sticks to plain setInterval + DB polling (single
 * Node process today, no infra beyond Postgres on the deploy target). This
 * poller follows the exact same shape as startSchedulePoller() etc.
 */

export type JobType = 'send_email' | 'slack_webhook' | 'teams_webhook' | 'web_push';

export type JobHandler = (payload: any) => Promise<void>;

const handlers = new Map<JobType, JobHandler>();

/** Registered once per job type, at module-load time, by the utility that owns that delivery channel (mailer.ts, slack.ts, teams.ts, webPush.ts). */
export function registerJobHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

const DEFAULT_MAX_ATTEMPTS = 6;

/** Exponential backoff, capped at 30 minutes: 30s, 60s, 2m, 4m, 8m, 16m, ... */
function backoffMs(attempt: number): number {
  return Math.min(30 * 60 * 1000, Math.pow(2, attempt) * 15 * 1000);
}

/** Enqueues a job for background delivery. Never throws — a failure to enqueue shouldn't take down the caller; it's logged and the send is simply lost, same as the old behavior it's replacing. */
export async function enqueueJob(
  type: JobType,
  payload: unknown,
  opts?: { orgId?: string | null; maxAttempts?: number },
): Promise<void> {
  try {
    await prisma.backgroundJob.create({
      data: {
        type,
        payload: payload as any,
        orgId: opts?.orgId ?? null,
        maxAttempts: opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        status: 'PENDING',
        nextAttemptAt: new Date(),
      },
    });
  } catch (err) {
    console.error(`[jobQueue] Failed to enqueue "${type}" job:`, err);
  }
}

/** Processes every due job (status PENDING, nextAttemptAt in the past), one at a time. Exported for the admin "Retry now" action to await a single pass after resetting a job. */
export async function processDueJobs(limit = 25): Promise<void> {
  const due = await prisma.backgroundJob.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
  });

  for (const job of due) {
    const handler = handlers.get(job.type as JobType);
    if (!handler) {
      // No handler registered for this type — nothing will ever process it.
      // Mark it failed immediately rather than leaving it stuck PENDING forever.
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', lastError: `No handler registered for job type "${job.type}"` },
      }).catch(() => {});
      continue;
    }

    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'PROCESSING' } }).catch(() => {});

    try {
      await handler(job.payload);
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    } catch (err: any) {
      const attempts = job.attempts + 1;
      const isFinal = attempts >= job.maxAttempts;
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
          attempts,
          status: isFinal ? 'FAILED' : 'PENDING',
          nextAttemptAt: isFinal ? job.nextAttemptAt : new Date(Date.now() + backoffMs(attempts)),
          lastError: String(err?.message || err).slice(0, 2000),
        },
      }).catch(() => {});
    }
  }
}

/** Resets a FAILED (or stuck) job back to PENDING for immediate reprocessing — used by the admin "Retry" button. */
export async function retryJob(jobId: string, orgId?: string): Promise<boolean> {
  const where: any = { id: jobId };
  if (orgId) where.orgId = orgId;
  const result = await prisma.backgroundJob.updateMany({
    where,
    data: { status: 'PENDING', nextAttemptAt: new Date(), lastError: null },
  });
  return result.count > 0;
}

/** Check for due jobs every 15 seconds — frequent enough that a retried send doesn't sit around for long, cheap enough that it's a non-issue for a single Postgres instance. */
export function startJobQueuePoller(): void {
  setInterval(() => {
    processDueJobs().catch(err => console.error('[jobQueue] Poll error:', err));
  }, 15 * 1000);
}
