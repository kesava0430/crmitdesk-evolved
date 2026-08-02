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

// The four "default modules" this also supports, in addition to CUSTOM_MODULE
// (an org's own no-code object). Matches exactly the set of entity types the
// CustomField system already supports (see api/customFields.ts's
// CustomFieldDef['entityType']) — that's what makes "any custom date field"
// meaningful here, not just the couple of hardcoded built-ins.
type StandardEntityType = 'CONTACT' | 'DEAL' | 'TICKET' | 'LEAD';

interface DateConfig {
  entityType: StandardEntityType | 'CUSTOM_MODULE';
  moduleId?: string;   // required when entityType === 'CUSTOM_MODULE'
  // Either a built-in column (see BUILTIN_DATE_FIELDS) or a custom DATE
  // field's fieldKey (standard entities) / a module field's fieldKey
  // (CUSTOM_MODULE) — resolved dynamically, see processStandardEntityRule.
  dateField: string;
  offsetDays: number;  // negative = before the date, positive = after, 0 = on the day
  recurrence: 'ONCE' | 'YEARLY';
}

// Built-in date columns every standard entity exposes without needing a
// custom field. createdAt/updatedAt are universal; dateOfBirth is
// Contact-specific (see schema.prisma's comment on that column). Anything
// selected that ISN'T in this list is assumed to be a custom DATE field's
// fieldKey and is looked up via CustomField/CustomFieldValue instead — see
// WorkflowsPage.tsx's DateConfigEditor for where these two lists get merged
// into one dropdown.
const BUILTIN_DATE_FIELDS: Record<StandardEntityType, string[]> = {
  CONTACT: ['createdAt', 'updatedAt', 'dateOfBirth'],
  DEAL: ['createdAt', 'updatedAt'],
  TICKET: ['createdAt', 'updatedAt'],
  LEAD: ['createdAt', 'updatedAt'],
};

// Same relations each entity's own controller already includes when it
// fires other triggers (TICKET_CREATED, DEAL_STAGE_CHANGED, ...) — kept
// matching here so an action like SEND_CSAT_SURVEY (needs entity.requester)
// or CREATE_NOTIFICATION's ASSIGNEE fallback works identically no matter
// which trigger fired the rule.
const ENTITY_INCLUDE: Record<StandardEntityType, Record<string, unknown> | undefined> = {
  CONTACT: undefined,
  DEAL: {
    contact: { select: { id: true, name: true, email: true } },
    account: { select: { id: true, name: true } },
    assignee: { select: { id: true, name: true, email: true } },
  },
  TICKET: {
    requester: { select: { id: true, name: true, email: true } },
    assignee: { select: { id: true, name: true, email: true } },
  },
  LEAD: {
    contact: { select: { id: true, name: true, email: true } },
    assignee: { select: { id: true, name: true } },
  },
};

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

async function fetchStandardEntities(entityType: StandardEntityType, orgId: string): Promise<Record<string, any>[]> {
  const include = ENTITY_INCLUDE[entityType];
  switch (entityType) {
    case 'CONTACT': return prisma.contact.findMany({ where: { orgId } });
    case 'DEAL': return prisma.deal.findMany({ where: { orgId }, include: include as any });
    case 'TICKET': return prisma.ticket.findMany({ where: { orgId }, include: include as any });
    case 'LEAD': return prisma.lead.findMany({ where: { orgId }, include: include as any });
  }
}

/**
 * Handles all four "default module" entity types (Contact, Deal, Ticket,
 * Lead) against either a built-in date column or a custom DATE field —
 * replaces the old Contact-only processContactRules with something that
 * covers "created time, last updated time, and any custom date field",
 * for every standard entity, not just Contact's birthday.
 */
async function processStandardEntityRule(orgId: string, ruleId: string, entityType: StandardEntityType, config: DateConfig, skipDedupe: boolean): Promise<number> {
  const target = targetDate(config.offsetDays);
  const isBuiltin = BUILTIN_DATE_FIELDS[entityType].includes(config.dateField);

  // Custom DATE field: batch-fetch every saved value for it once (keyed by
  // entityId) rather than a per-record query — same values.findMany +
  // in-memory Map pattern the custom-module path already used for its own
  // records, just against CustomFieldValue instead of CustomModuleRecord.data.
  let valueByEntityId: Map<string, string> | null = null;
  if (!isBuiltin) {
    const field = await prisma.customField.findFirst({
      where: { orgId, entityType, fieldKey: config.dateField, fieldType: 'DATE' },
    });
    if (!field) return 0; // field was renamed/deleted since the rule was configured — nothing to evaluate
    const values = await prisma.customFieldValue.findMany({ where: { customFieldId: field.id } });
    valueByEntityId = new Map(values.filter(v => v.value).map(v => [v.entityId, v.value as string]));
  }

  const records = await fetchStandardEntities(entityType, orgId);

  let fired = 0;
  for (const record of records) {
    const raw = isBuiltin ? record[config.dateField] : valueByEntityId?.get(record.id);
    if (!raw) continue;
    const fieldDate = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(fieldDate.getTime())) continue;
    if (!sameDay(fieldDate, target, config.recurrence === 'YEARLY')) continue;
    if (!skipDedupe && await alreadyProcessedToday(ruleId, record.id, config.recurrence)) continue;

    const ctx: WorkflowContext = {
      trigger: 'DATE_FIELD_REACHED',
      orgId,
      entityType,
      entityId: record.id,
      entity: record,
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

  if (config.entityType === 'CUSTOM_MODULE') return processCustomModuleRules(rule.orgId, rule.id, config, skipDedupe);
  return processStandardEntityRule(rule.orgId, rule.id, config.entityType, config, skipDedupe);
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
