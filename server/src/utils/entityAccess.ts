import { prisma } from './prisma';
import { AppError } from '../middleware/errorHandler';

// Shared by every polymorphic (entityType + entityId) feature — Comments and
// Attachments today. Single source of truth for which Prisma model backs
// each EntityType value, so adding a new entity type to one doesn't
// silently leave the other out of sync.
export const ENTITY_MODEL: Record<string, {
  findFirst: (args: any) => Promise<any>;
  /** Used by entityCleanup's orphan sweep to ask "which of these ids still exist?". */
  findMany: (args: any) => Promise<any>;
}> = {
  DEAL: prisma.deal,
  TICKET: prisma.ticket,
  CONTACT: prisma.contact,
  LEAD: prisma.lead,
  ACCOUNT: prisma.account,
  CHANGE_REQUEST: prisma.changeRequest,
  QUOTE: prisma.quote,
  ASSET: prisma.asset,
  CAMPAIGN: prisma.campaign,
  // Added with the people/task/approval platform. Every EntityType enum value
  // needs an entry here or polymorphic comments/attachments 404 for that type.
  EMPLOYEE: prisma.employee,
  TASK: prisma.task,
  APPROVAL_REQUEST: prisma.approvalRequest,
  DEPARTMENT: prisma.department,
  INVOICE: prisma.invoice,
};

/** Confirms the referenced Deal/Ticket/Contact/etc. actually belongs to the
 * caller's org before any polymorphic read/write touches it — a guessed
 * entityId from another tenant must never resolve to real data. */
export async function assertEntityInOrg(entityType: string, entityId: string, orgId: string): Promise<void> {
  const model = ENTITY_MODEL[entityType];
  const record = model && await model.findFirst({ where: { id: entityId, orgId }, select: { id: true } });
  if (!record) throw new AppError(404, 'Not found');
}

// Models a request body may reference by id, beyond the polymorphic ones.
// Prisma delegate names, resolved per call (kept out of the `TYPE: prisma.x`
// shape above, which the attachments/tags tests read as the entity list).
const EXTRA_REF_DELEGATE: Record<string, string> = { USER: 'user', CATEGORY: 'category', SLA_POLICY: 'slaPolicy', PAYROLL_CYCLE: 'payrollCycle' };
const refModel = (type: string): { findFirst: (args: any) => Promise<any> } | undefined =>
  EXTRA_REF_DELEGATE[type] ? (prisma as any)[EXTRA_REF_DELEGATE[type]] : ENTITY_MODEL[type];

const REF_LABEL: Record<string, string> = {
  USER: 'user', CATEGORY: 'category', SLA_POLICY: 'SLA policy', CONTACT: 'contact', ACCOUNT: 'account',
  DEAL: 'deal', LEAD: 'lead', TICKET: 'ticket', TASK: 'task', EMPLOYEE: 'employee', QUOTE: 'quote',
  DEPARTMENT: 'department', PAYROLL_CYCLE: 'pay cycle',
};

/**
 * Confirms every id a request body points at (contactId, accountId,
 * assignedTo, categoryId, …) belongs to the caller's org. Creating or
 * updating a record with another org's id used to store the cross-tenant
 * link, and the record's own `include` then served the other org's contact /
 * account / user details back on every read. Empty values are skipped.
 */
export async function assertRefsInOrg(orgId: string, refs: Array<[string, string | null | undefined]>): Promise<void> {
  for (const [type, id] of refs) {
    if (!id) continue;
    const model = refModel(type);
    const found = model && await model.findFirst({ where: { id, orgId }, select: { id: true } });
    if (!found) throw new AppError(400, `That ${REF_LABEL[type] ?? 'record'} was not found in this organization`);
  }
}
