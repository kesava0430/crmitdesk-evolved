import { prisma } from './prisma';
import { runWorkflows, WorkflowContext } from './workflow-engine';

// Date-driven follow-ups (birthday wishes, appointment reminders,
// service-due reminders, thank-you-after-visit) — the piece the workflow
// engine was missing, since every other trigger fires off a live event
// (ticket created, deal stage changed, ...) rather than "N days before/after
// a date field, or every year on this date". Same in-process setInterval
// poller shape as scheduler.ts / customModuleSync.ts (see their comments —
// this app runs as a single Node process, so a periodic DB scan is enough).
const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for a day-granularity trigger

interface DateConfig {
  entityType: 'CONTACT' | 'CUSTOM_MODULE';
  moduleId?: string;   // required when entityType === 'CUSTOM_MODULE'
  dateField: string;   // 'dateOfBirth' for CONTACT, a module field's fieldKey for CUSTOM_MODULE
  offsetDays: number;  // negative = before the date, positive = after, 0 = on the day
  recurrence: 'ONCE' | 'YEARLY';
}

/** Date-only (calendar day) comparison — ignores time-of-day entirely. */
function sameDay(a: Date, b: Date, ignoreYear: boolean): boolean {
  if (a.getUTCDate() !== b.getUTCDate() || a.getUTCMonth() !== b.getUTCMonth()) return false;
  return ignoreYear || a.getUTCFullYear() === b.getUTCFullYear();
}

/** The calendar date a record's date field must fall on for the rule to be due today. */
function targetDate(offsetDays: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offsetDays); // see DateConfig.offsetDays doc above
  return d;
}

/**
 * Has this rule already fired (or been logged as skipped) for this entity
 * within the current eligibility window? Without this, an hourly poll would
 * re-send the same birthday message 24 times on the birthday itself.
 * ONCE rules dedupe per calendar day; YEARLY rules dedupe for ~11 months so
 * the same rule can fire again next year.
 */
async function alreadyProcessedToday(ruleId: string, entityId: string, recurrence: 'ONCE' | 'YEARLY'): Promise<boolean> {
  const cutoff = new Date();
  if (recurrence === 'YEARLY') {
    cutoff.setUTCDate(cutoff.getUTCDate() - 330);
  } else {
    cutoff.setUTCHours(0, 0, 0, 0);
  }
  const existing = await prisma.workflowLog.findFirst({
    where: { ruleId, entityId, createdAt: { gte: cutoff } },
    select: { id: true },
  });
  return !!existing;
}

async function processContactRules(orgId: string, ruleId: string, config: DateConfig, skipDedupe: boolean): Promise<number> {
  const target = targetDate(config.offsetDays);
  const contacts = await prisma.contact.findMany({
    where: { orgId, dateOfBirth: { not: null } },
  });

  let fired = 0;
  for (const contact of contacts) {
    if (!contact.dateOfBirth) continue;
    if (!sameDay(contact.dateOfBirth, target, config.recurrence === 'YEARLY')) continue;
    if (!skipDedupe && await alreadyProcessedToday(ruleId, contact.id, config.recurrence)) continue;

    const ctx: WorkflowContext = {
      trigger: 'DATE_FIELD_REACHED',
      orgId,
      entityType: 'CONTACT',
      entityId: contact.id,
      entity: contact as unknown as Record<string, any>,
    };
    await runWorkflows(ctx);
    fired += 1;
  }
  return fired;
}

async function processCustomModuleRules(orgId: string, ruleId: string, config: DateConfig, skipDedupe: boolean): Promise<number> {
  if (!config.moduleId) return 0;
  const target = targetDate(config.offsetDays);
  const records = await prisma.customModuleRecord.findMany({
    where: { orgId, moduleId: config.moduleId },
  });

  let fired = 0;
  for (const record of records) {
    const raw = (record.data as Record<string, unknown> | null)?.[config.dateField];
    if (!raw || typeof raw !== 'string') continue;
    const fieldDate = new Date(raw);
    if (Number.isNaN(fieldDate.getTime())) continue;
    if (!sameDay(fieldDate, target, config.recurrence === 'YEARLY')) continue;
    if (!skipDedupe && await alreadyProcessedToday(ruleId, record.id, config.recurrence)) continue;

    const ctx: WorkflowContext = {
      trigger: 'DATE_FIELD_REACHED',
      orgId,
      entityType: 'CUSTOM_MODULE_RECORD',
      entityId: record.id,
      // Flatten record.data alongside id/moduleId so {{fieldKey}} template
      // substitution in SEND_EMAIL/SEND_WHATSAPP/CREATE_NOTIFICATION works
      // exactly like it does for every other entity type.
      entity: { id: record.id, moduleId: record.moduleId, ...(record.data as object) },
    };
    await runWorkflows(ctx);
    fired += 1;
  }
  return fired;
}

async function evaluateRule(rule: { id: string; orgId: string; dateConfig: unknown }, skipDedupe: boolean): Promise<number> {
  const config = rule.dateConfig as unknown as DateConfig;
  if (!config?.entityType || !config?.dateField || typeof config.offsetDays !== 'number') return 0;

  if (config.entityType === 'CONTACT') return processContactRules(rule.orgId, rule.id, config, skipDedupe);
  if (config.entityType === 'CUSTOM_MODULE') return processCustomModuleRules(rule.orgId, rule.id, config, skipDedupe);
  return 0;
}

/** Evaluates every active DATE_FIELD_REACHED rule across every org — the hourly poller. */
export async function checkDateAutomations(): Promise<void> {
  // Filtering dateConfig != null in the query itself needs Prisma.DbNull /
  // Prisma.JsonNull (easy to get backwards for a nullable Json column) —
  // simpler and just as cheap at this scale to filter in JS via the
  // config?.entityType guard inside evaluateRule().
  const rules = await prisma.workflowRule.findMany({
    where: { trigger: 'DATE_FIELD_REACHED', isActive: true },
  });

  for (const rule of rules) {
    try {
      await evaluateRule(rule, false);
    } catch (err: any) {
      console.error(`[date-automation] Rule ${rule.id} failed:`, err?.message || err);
    }
  }
}

/**
 * Manual "Run now" test trigger for a single rule, scoped to the calling
 * org (never touches other orgs' data, unlike the global poller). Bypasses
 * the dedupe guard on purpose — an admin clicking "test this rule" wants to
 * see it fire immediately, even if it already ran today.
 */
export async function runDateRuleNow(ruleId: string, orgId: string): Promise<number> {
  const rule = await prisma.workflowRule.findFirst({
    where: { id: ruleId, orgId, trigger: 'DATE_FIELD_REACHED' },
  });
  if (!rule) throw new Error('Rule not found, not yours, or not a DATE_FIELD_REACHED rule');
  return evaluateRule(rule, true);
}

export function startDateAutomationPoller() {
  checkDateAutomations().catch(() => {});
  setInterval(() => checkDateAutomations().catch(() => {}), POLL_INTERVAL_MS);
}
