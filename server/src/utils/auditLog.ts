import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN';

/**
 * Write an audit log entry asynchronously (fire-and-forget).
 * Never throws — a logging failure must never break the main request.
 */
export function logAction(
  userId: string,
  action: AuditAction,
  entityType: string,
  entityId: string,
  changes?: Record<string, unknown>
): void {
  prisma.auditLog.create({
    data: {
      userId,
      action,
      entityType,
      entityId,
      ...(changes !== undefined && { changes: changes as Prisma.InputJsonValue }),
    },
  }).catch(err => {
    console.error('[audit-log] Failed to write entry:', err);
  });
}
