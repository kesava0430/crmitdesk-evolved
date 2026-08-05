import { Response } from 'express';

// ─── SSE Manager ─────────────────────────────────────────────────────────────
// Tracks open SSE connections per org. Lets any controller broadcast an event
// to all connected clients in the same org without any external dependency.

interface SSEClient {
  res: Response;
  userId: string;
}

class SSEManager {
  private clients = new Map<string, Set<SSEClient>>(); // orgId → clients

  /** Register a new SSE response stream for an org member */
  add(orgId: string, userId: string, res: Response) {
    if (!this.clients.has(orgId)) this.clients.set(orgId, new Set());
    const client: SSEClient = { res, userId };
    this.clients.get(orgId)!.add(client);

    // Remove when connection closes
    res.on('close', () => {
      this.clients.get(orgId)?.delete(client);
      if (this.clients.get(orgId)?.size === 0) this.clients.delete(orgId);
    });

    return client;
  }

  /** Broadcast an event to all clients in an org (optionally skip the sender) */
  broadcast(orgId: string, event: string, data: any, skipUserId?: string) {
    const org = this.clients.get(orgId);
    if (!org) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of org) {
      if (skipUserId && client.userId === skipUserId) continue;
      try {
        client.res.write(payload);
      } catch {
        org.delete(client);
      }
    }
  }

  /** Broadcast to ALL clients in org including sender */
  broadcastAll(orgId: string, event: string, data: any) {
    this.broadcast(orgId, event, data);
  }

  connectedCount(orgId: string) {
    return this.clients.get(orgId)?.size ?? 0;
  }
}

export const sseManager = new SSEManager();

// ─── Event type helpers ───────────────────────────────────────────────────────

export const SSEEvent = {
  TICKET_CREATED:     'ticket:created',
  TICKET_UPDATED:     'ticket:updated',
  TICKET_STATUS:      'ticket:status',
  INBOX_MESSAGE:      'inbox:message',
  INBOX_CONVERSATION: 'inbox:conversation',
  LEAD_CREATED:       'lead:created',
  DEAL_UPDATED:       'deal:updated',
  NOTIFICATION:       'notification',
  ATTENDANCE_UPDATED: 'attendance:updated',
  LEAVE_UPDATED:      'leave:updated',
  PING:               'ping',
} as const;
