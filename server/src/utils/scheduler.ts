import { prisma } from './prisma';
import { sendWhatsApp } from './whatsapp';
import { resolveRecipientPhone } from './notification-recipient';

const POLL_INTERVAL_MS = 60 * 1000;

/** Resolves {{title}} in a reminder message against the linked ticket/deal. */
async function resolveMessage(entityType: string, entityId: string, message: string): Promise<string> {
  if (!message.includes('{{')) return message;
  const record = entityType === 'TICKET'
    ? await prisma.ticket.findUnique({ where: { id: entityId }, select: { title: true } })
    : await prisma.deal.findUnique({ where: { id: entityId }, select: { title: true } });
  return message.replace(/\{\{title\}\}/g, record?.title ?? '');
}

function nextOccurrence(dueAt: Date, recurrence: string): Date | null {
  const next = new Date(dueAt);
  if (recurrence === 'DAILY') { next.setDate(next.getDate() + 1); return next; }
  if (recurrence === 'WEEKLY') { next.setDate(next.getDate() + 7); return next; }
  return null; // 'NONE'
}

/**
 * Checks for due Schedule rows and sends their WhatsApp reminder. Run on a
 * plain setInterval rather than a job queue (BullMQ/Redis etc.) — this app
 * runs as a single Node process today, so a periodic DB poll is the
 * pragmatic fit; swap this out if the app ever needs multi-instance
 * reliability guarantees.
 */
export async function checkDueSchedules(): Promise<void> {
  const due = await prisma.schedule.findMany({
    where: { status: 'PENDING', dueAt: { lte: new Date() } },
  });

  for (const schedule of due) {
    try {
      const phone = await resolveRecipientPhone({
        orgId: schedule.orgId,
        entityType: schedule.entityType as 'TICKET' | 'DEAL',
        entityId: schedule.entityId,
        recipientType: schedule.recipientType as any,
        customNumber: schedule.customNumber,
      });
      const message = await resolveMessage(schedule.entityType, schedule.entityId, schedule.message);
      await sendWhatsApp(schedule.orgId, phone, message);

      const next = nextOccurrence(schedule.dueAt, schedule.recurrence);
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: next
          ? { dueAt: next, sentAt: new Date(), lastError: null } // stays PENDING for its next occurrence
          : { status: 'SENT', sentAt: new Date(), lastError: null },
      });
    } catch (err: any) {
      // Marked FAILED (not left PENDING) so a persistently broken config
      // (no WhatsApp connected, assignee has no phone, etc.) doesn't retry
      // every single minute forever — the error is visible on the record
      // for someone to fix and re-schedule.
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: { status: 'FAILED', lastError: String(err?.message || err) },
      }).catch(() => {});
      console.error(`[scheduler] Failed to send reminder ${schedule.id}:`, err?.message || err);
    }
  }
}

export function startSchedulePoller() {
  checkDueSchedules().catch(() => {});
  setInterval(() => checkDueSchedules().catch(() => {}), POLL_INTERVAL_MS);
}
