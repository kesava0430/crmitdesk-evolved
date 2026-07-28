import { prisma } from './prisma';

// No billing decisions read from this yet — it exists purely to collect real
// usage data (AI calls, WhatsApp sends) per org so included-quota/overage
// numbers can be set from actual patterns instead of guessed. See
// server/prisma/schema.prisma's UsageEvent model for the storage shape.

export type UsageEventType = 'AI_CALL' | 'WHATSAPP_SEND';

/**
 * Fire-and-forget — usage logging must never be the reason a real request
 * (an AI call the user is waiting on, a WhatsApp send a workflow depends on)
 * fails. Errors are swallowed and logged, same pattern as sendMail().
 */
export function recordUsage(orgId: string, type: UsageEventType): void {
  prisma.usageEvent.create({ data: { orgId, type } }).catch((err: unknown) => {
    console.error('[Usage tracking error]', type, orgId, err);
  });
}

export interface UsageSummary {
  aiCalls: number;
  whatsappSends: number;
  periodStart: string;
  periodEnd: string;
}

/** Usage counts for the org's current calendar month — the natural period
 * to eventually line up with monthly billing cycles. */
export async function getUsageSummary(orgId: string): Promise<UsageSummary> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [aiCalls, whatsappSends] = await Promise.all([
    prisma.usageEvent.count({ where: { orgId, type: 'AI_CALL', createdAt: { gte: periodStart, lt: periodEnd } } }),
    prisma.usageEvent.count({ where: { orgId, type: 'WHATSAPP_SEND', createdAt: { gte: periodStart, lt: periodEnd } } }),
  ]);

  return { aiCalls, whatsappSends, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() };
}
