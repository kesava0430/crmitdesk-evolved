import { z } from 'zod';
import { emailField } from '../../utils/zodHelpers';
import { AppError } from '../../middleware/errorHandler';
import { assertCanAssign, assertCanManage } from '../../utils/roleRank';

/**
 * The validation and decision rules behind People → Add / Edit, kept free of
 * Prisma so they can be unit-tested (tests/unit/people-edit.test.ts) and so
 * the controller reads as "load, decide, write".
 *
 * ── Why the edit schema is strict and nullable ────────────────────────────
 * The shared edit form sends ONLY the fields the person actually changed. So
 * in this schema `undefined` means "not touched" and `null` means "cleared" —
 * the opposite trade-off from utils/zodHelpers.optionalField(), which exists
 * for forms that echo a whole record back. Without that, HR could never remove
 * a manager or a stale phone number. `.strict()` turns a misspelt or
 * HR-only key into a 400 instead of a silent no-op, which matters most on the
 * self-service schema: an employee sending `designation` must be refused, not
 * quietly ignored in a way that looks like it worked.
 */

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT', 'TEMPORARY'] as const;
export const EMPLOYMENT_STATUSES = ['PROBATION', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'SUSPENDED', 'EXITED'] as const;
export const WORK_MODES = ['ONSITE', 'REMOTE', 'HYBRID'] as const;

/** '' from an emptied input means "clear it", same as null. */
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const text = (max = 200) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const id = () => z.preprocess(emptyToNull, z.string().min(1).max(64).nullable().optional());

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const isValidDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(new Date(s).getTime());
const date = () =>
  z.preprocess(emptyToNull, z.string().refine(isValidDate, 'must be a date (YYYY-MM-DD)').nullable().optional());

export const EmergencyContactSchema = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(120),
    relationship: z.string().trim().min(1, 'relationship is required').max(60),
    phone: z.string().trim().min(3, 'phone is required').max(40),
  })
  .strict();

/**
 * Fields an employee may change on their own record from My Profile. Contact
 * and address details only — job, reporting line, pay and identity data stay
 * with HR.
 */
export const SELF_EDITABLE_FIELDS = [
  'phone',
  'alternatePhone',
  'personalEmail',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'country',
  'postalCode',
] as const;

export const SelfUpdateSchema = z
  .object({
    phone: text(40),
    alternatePhone: text(40),
    personalEmail: z.preprocess(emptyToNull, z.string().trim().email().max(200).nullable().optional()),
    addressLine1: text(200),
    addressLine2: text(200),
    city: text(100),
    state: text(100),
    country: text(100),
    postalCode: text(20),
    emergencyContact: z.preprocess(emptyToNull, EmergencyContactSchema.nullable().optional()),
  })
  .strict();

export const PersonUpdateSchema = z
  .object({
    firstName: z.string().trim().min(1, 'first name is required').max(100).optional(),
    lastName: text(100),
    /** Login email when they can sign in, otherwise the work email on file. */
    email: z.preprocess(emptyToNull, emailField().nullable().optional()),
    personalEmail: z.preprocess(emptyToNull, z.string().trim().email().max(200).nullable().optional()),
    phone: text(40),
    alternatePhone: text(40),
    dateOfBirth: date(),
    gender: text(30),
    maritalStatus: text(30),
    bloodGroup: text(10),
    addressLine1: text(200),
    addressLine2: text(200),
    city: text(100),
    state: text(100),
    country: text(100),
    postalCode: text(20),

    employeeCode: z.string().trim().min(1, 'employee ID cannot be empty').max(40).optional(),
    designation: text(120),
    departmentId: id(),
    locationId: id(),
    managerId: id(),
    dottedLineManagerId: id(),
    costCenter: text(60),
    workMode: z.enum(WORK_MODES).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
    joiningDate: z.string().refine(isValidDate, 'joining date must be a date (YYYY-MM-DD)').optional(),
    probationEndDate: date(),
    confirmationDate: date(),

    bankAccountName: text(120),
    bankAccountNumber: text(40),
    bankName: text(120),
    bankIfsc: text(20),
    taxId: text(40),
    nationalId: text(40),
    socialSecurityId: text(40),

    /** Changes the login's role — admins only, see checkRoleChange(). */
    roleId: z.string().min(1).optional(),
    /** Explicit attendance policy group; null = automatic (location/department/type/default). */
    policyGroupId: id(),
    emergencyContact: z.preprocess(emptyToNull, EmergencyContactSchema.nullable().optional()),
  })
  .strict();

export type PersonUpdate = z.infer<typeof PersonUpdateSchema>;
export type SelfUpdate = z.infer<typeof SelfUpdateSchema>;

/** Columns that live on the Employee row itself (everything else is routed elsewhere). */
export const EMPLOYEE_COLUMNS = [
  'firstName', 'lastName', 'personalEmail', 'phone', 'alternatePhone', 'dateOfBirth', 'gender',
  'maritalStatus', 'bloodGroup', 'addressLine1', 'addressLine2', 'city', 'state', 'country', 'postalCode',
  'employeeCode', 'designation', 'departmentId', 'locationId', 'managerId', 'dottedLineManagerId',
  'costCenter', 'workMode', 'employmentType', 'employmentStatus', 'joiningDate', 'probationEndDate',
  'confirmationDate', 'bankAccountName', 'bankAccountNumber', 'bankName', 'bankIfsc', 'taxId',
  'nationalId', 'socialSecurityId',
] as const;

export const DATE_COLUMNS = new Set(['dateOfBirth', 'joiningDate', 'probationEndDate', 'confirmationDate']);

/** Sensitive values are logged by name only — the audit log is readable by managers. */
export const SENSITIVE_AUDIT_FIELDS = new Set([
  'bankAccountName', 'bankAccountNumber', 'bankName', 'bankIfsc', 'taxId', 'nationalId', 'socialSecurityId',
  'dateOfBirth', 'personalEmail', 'emergencyContact',
]);

const MASK_MARK = '••••';

/**
 * Drops values that are the API's own masking echoed back ('••••••1234').
 *
 * stripUnwritableFields() already refuses fields a role may not write, but a
 * role that CAN write a sensitive field still receives it masked in some
 * views; saving that string would replace a real account number with dots.
 */
export function dropMaskedEchoes<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.includes(MASK_MARK)) continue;
    out[k] = v;
  }
  return out as T;
}

function norm(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && DATE_RE.test(v) && v.length >= 10 && !Number.isNaN(new Date(v).getTime())) {
    return v.slice(0, 10);
  }
  return v;
}

/**
 * The keys in `patch` whose value actually differs from `before`.
 * Dates compare by calendar day, and null / '' / undefined are all "empty",
 * so re-saving an untouched form records no change.
 */
export function changedKeys(before: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter(k => patch[k] !== undefined && norm(before[k]) !== norm(patch[k]));
}

/** Audit payload: field names always, before/after values only for non-sensitive fields. */
export function auditChanges(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> {
  const values: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (SENSITIVE_AUDIT_FIELDS.has(k)) continue;
    values[k] = { from: norm(before[k]), to: norm(patch[k]) };
  }
  return { fields: keys, values };
}

/**
 * Whether making `managerId` the manager of `employeeId` would close a loop.
 * `managerOf` resolves an employee's current manager (null at the top). Bounded
 * so bad existing data (an old cycle) can't spin forever.
 */
export async function createsReportingLoop(
  employeeId: string,
  managerId: string,
  managerOf: (id: string) => Promise<string | null>
): Promise<boolean> {
  if (managerId === employeeId) return true;
  let cursor: string | null = managerId;
  for (let i = 0; i < 50 && cursor; i++) {
    if (cursor === employeeId) return true;
    cursor = await managerOf(cursor);
  }
  return false;
}

/**
 * Who may change whose role. Throws the AppError the endpoint returns.
 * Same rules as Administration → Users: never your own role, never someone
 * who outranks you, never a role above your own.
 */
export function checkRoleChange(p: {
  callerUserId: string;
  callerRole: string;
  targetUserId: string | null;
  targetRole: string | null;
  newRole: string;
}): void {
  if (!p.targetUserId) throw new AppError(400, 'This person does not have a login to assign a role to');
  if (p.targetUserId === p.callerUserId) throw new AppError(403, 'You cannot change your own role');
  assertCanManage(p.callerRole, p.targetRole ?? 'EMPLOYEE');
  assertCanAssign(p.callerRole, p.newRole);
}

// ─── Attendance policy groups ────────────────────────────────────────────────

export interface PolicyGroupRow {
  id: string;
  name?: string;
  isDefault: boolean;
  isActive: boolean;
  applicability: any;
}

const userIdsOf = (g: PolicyGroupRow): string[] =>
  Array.isArray(g.applicability?.userIds) ? (g.applicability.userIds as string[]) : [];

/** The group this login is pinned to by name (applicability.userIds), if any. */
export function explicitGroupFor(groups: PolicyGroupRow[], userId: string): PolicyGroupRow | null {
  return groups.find(g => g.isActive && userIdsOf(g).includes(userId)) ?? null;
}

/**
 * The applicability updates that pin `userId` to `targetGroupId` — or, with
 * null, unpin them so the automatic rules (location > department > type >
 * default) decide.
 *
 * Membership is stored on the group (applicability.userIds), not the person,
 * because that is what utils/attendanceEngine.pickGroup() reads. Editing it
 * here rather than adding a column keeps one source of truth with HR Settings
 * → Attendance Policies. The default group is refused as an explicit target:
 * it must stay unscoped (ATT-16), and "Automatic" already falls through to it.
 */
export function planPolicyGroupMembership(
  groups: PolicyGroupRow[],
  userId: string,
  targetGroupId: string | null
): Array<{ id: string; applicability: Record<string, unknown> }> {
  if (targetGroupId) {
    const target = groups.find(g => g.id === targetGroupId);
    if (!target) throw new AppError(404, 'Attendance policy not found');
    if (target.isDefault) {
      throw new AppError(400, 'The default policy applies automatically — choose "Automatic" instead');
    }
    if (!target.isActive) throw new AppError(400, 'That attendance policy is inactive');
  }

  const updates: Array<{ id: string; applicability: Record<string, unknown> }> = [];
  for (const g of groups) {
    const ids = userIdsOf(g);
    const has = ids.includes(userId);
    const want = g.id === targetGroupId;
    if (has === want) continue;
    const next = want ? [...ids, userId] : ids.filter(x => x !== userId);
    updates.push({ id: g.id, applicability: { ...(g.applicability ?? {}), userIds: next } });
  }
  return updates;
}
