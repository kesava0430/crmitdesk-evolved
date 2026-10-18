/**
 * Conversation state per (channel, user), stored server-side
 * (assistant_sessions): the last few turns for the router, and the one plan
 * or question waiting for a reply (state.ts decides what a reply means).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { isExpired, type Pending } from './state';
import { MAX_TURNS } from './limits';
import type { Channel } from './format';

export interface Turn { role: 'user' | 'assistant'; content: string }
export interface Session { turns: Turn[]; pending: Pending | null }

export async function loadSession(channel: Channel, userId: string): Promise<Session> {
  const row = await prisma.assistantSession.findUnique({ where: { channel_userId: { channel, userId } }, select: { turns: true, pending: true } });
  const turns = Array.isArray(row?.turns) ? (row!.turns as unknown as Turn[]).filter(t => t && typeof t.content === 'string') : [];
  return { turns, pending: (row?.pending as unknown as Pending) ?? null };
}

/** Whether something is waiting for this person's reply right now (WhatsApp: lets "yes" through without the keyword). */
export async function hasLivePending(channel: Channel, userId: string, now = new Date()): Promise<boolean> {
  const s = await loadSession(channel, userId);
  return !!s.pending && !isExpired(s.pending, now);
}

export async function saveSession(channel: Channel, user: { id: string; orgId: string }, s: Session): Promise<void> {
  const turns = s.turns.slice(-MAX_TURNS).map(t => ({ role: t.role, content: t.content.slice(0, 600) }));
  const data = {
    turns: turns as any,
    pending: s.pending ? (s.pending as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    pendingExpiresAt: s.pending ? new Date(s.pending.expiresAt) : null,
  };
  await prisma.assistantSession.upsert({
    where: { channel_userId: { channel, userId: user.id } },
    create: { channel, userId: user.id, orgId: user.orgId, ...data },
    update: data,
  });
}

/**
 * Takes the waiting plan off the session if it is still the one with this
 * planId — exactly one concurrent "yes" (a duplicate delivery, a double
 * reply) gets to run it. Executor idempotency (same key per plan) backs this up.
 */
export async function claimPending(channel: Channel, userId: string, planId: string): Promise<boolean> {
  const r = await prisma.assistantSession.updateMany({
    where: { channel, userId, pending: { path: ['planId'], equals: planId } },
    data: { pending: Prisma.DbNull, pendingExpiresAt: null },
  });
  return r.count === 1;
}
