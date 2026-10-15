import { AppError } from '../../../middleware/errorHandler';

/** Longest subject a ticket may be given (create, or an edit that changes it). */
export const TICKET_TITLE_MAX = 200;

/**
 * Normalise a ticket subject: trimmed, 1–200 characters.
 *
 * `previous` is the ticket's current title on an update. Tickets created
 * before this limit existed (or by email/portal paths that never had one)
 * may already be longer; re-saving one unchanged — the Edit form always
 * sends the title along with the other fields — must keep working, so the
 * length limit applies only when the subject actually changes.
 *
 * Returns undefined when no title was sent (a partial update leaves it alone).
 */
export function normalizeTicketTitle(next: unknown, previous?: string): string | undefined {
  if (next === undefined) return undefined;
  if (typeof next !== 'string') throw new AppError(400, 'Subject must be text');
  const title = next.trim();
  if (!title) throw new AppError(400, 'Subject cannot be empty');
  if (title.length > TICKET_TITLE_MAX && title !== previous?.trim()) {
    throw new AppError(400, `Subject must be ${TICKET_TITLE_MAX} characters or fewer`);
  }
  return title;
}
