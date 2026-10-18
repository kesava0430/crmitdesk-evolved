/**
 * HR actions — people, leave & WFH, attendance, payroll, loans, salary.
 *
 * Every handler calls the very controller the HR screens call (callUi), so
 * leave balance/overlap rules, WFH policy limits, frozen payroll periods,
 * role-rank checks, audit rows and notifications are the UI's own.
 * allowedRoles mirror each route's requireRole; `modules` mirror the
 * /api/hr/* mount gates.
 */
import { z } from 'zod';
import { prisma } from '../../prisma';
import { AppError } from '../../../middleware/errorHandler';
import { ALL_USERS } from '../../../middleware/authenticate';
import { HR_MANAGERS } from '../../hrAccess';
import { periodFor } from '../../payrollEngine';
import * as people from '../../../modules/people/people.controller';
import * as leave from '../../../modules/hr/leave/leave.controller';
import * as wfh from '../../../modules/hr/leave/wfh.controller';
import * as attendanceAdmin from '../../../modules/hr/attendance/attendanceAdmin.controller';
import * as payroll from '../../../modules/hr/payroll/payroll.controller';
import * as payrollConfig from '../../../modules/hr/payroll/payrollConfig.controller';
import * as loans from '../../../modules/hr/payroll/loans.controller';
import { EMPLOYMENT_TYPES, EMPLOYMENT_STATUSES, WORK_MODES } from '../../../modules/people/personRules';
import { callUi, out, listPreview, diffPreview, target, show, zDate, zMonth, zId, zMoney } from '../helpers';
import type { AiActionDefinition } from '../types';

/** A Role row by key (built-in roles like HR_MANAGER/FINANCE or a legacy role name), for logins. */
async function roleIdFor(orgId: string, key: string | undefined): Promise<string | undefined> {
  if (!key) return undefined;
  const k = key.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const role = await prisma.role.findFirst({
    where: { OR: [{ orgId }, { orgId: null }], AND: [{ OR: [{ key: k }, { name: { equals: key.trim(), mode: 'insensitive' } }] }] },
    select: { id: true }, orderBy: { orgId: 'desc' },
  });
  if (!role) throw new AppError(400, `There's no "${key}" role in this organisation — pick one from Administration → Roles.`);
  return role.id;
}

const STATUS = ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'UNPAID_LEAVE', 'WFH', 'HOLIDAY', 'WEEK_OFF', 'LOP'] as const;

export const HR_ACTIONS: AiActionDefinition[] = [
  // ── Add a person (same server logic as People → Add person) ──────────────
  {
    name: 'ADD_EMPLOYEE', label: 'Add an employee', category: 'HR',
    description: 'Adds a new person to People (HR), optionally inviting them to sign in (e.g. "add Ravi Kumar as a Sales Executive in Sales joining 1 Nov, reporting to Priya").',
    example: 'Add Ravi Kumar as a Sales Executive in the Sales department, joining 1 November',
    paramsHint: '{ firstName: string, lastName?: string, designation?: string, departmentId?: department name, managerId?: manager\'s name, joiningDate: date words or YYYY-MM-DD, employmentType?: "FULL_TIME"|"PART_TIME"|"CONTRACT"|"INTERN"|"CONSULTANT"|"TEMPORARY", phone?: string, email?: string, invite?: boolean (send a sign-in invite to email), role?: role name for the login e.g. "EMPLOYEE" }',
    allowedRoles: ALL_USERS, permission: 'hr.employee.create', modules: ['hr_core'], requiresConfirmation: true,
    risk: p => (p.invite ? 'high' : 'medium'),
    refs: { departmentId: 'department', managerId: 'employee' }, dates: { joiningDate: 'date' },
    schema: z.object({
      firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().max(100).optional(),
      designation: z.string().trim().max(120).optional(), departmentId: zId.optional(), managerId: zId.optional(),
      joiningDate: zDate, employmentType: z.enum(EMPLOYMENT_TYPES).optional(), phone: z.string().max(40).optional(),
      email: z.string().email().optional(), invite: z.boolean().optional(), role: z.string().max(60).optional(),
    }).refine(p => !p.invite || !!p.email, { message: 'An email address is needed to send a sign-in invite', path: ['email'] }),
    sample: { firstName: 'Ravi', lastName: 'Kumar', designation: 'Sales Executive', joiningDate: '2026-11-02' },
    preview: async (p, _ctx, info) => {
      const pv = listPreview(`Add ${[p.firstName, p.lastName].filter(Boolean).join(' ')} to People`, p, info, ['invite', 'role']);
      pv.changes.push({ field: 'Sign-in', after: p.invite ? `Invite ${p.email} as ${p.role ?? 'Employee'}` : 'No login (HR record only)' });
      if (p.invite) pv.notes = ['An invitation email will be sent, and a login uses a paid seat unless the role is Employee.'];
      return pv;
    },
    handler: async (p, ctx) => {
      const roleId = p.invite ? await roleIdFor(ctx.orgId, p.role ?? 'EMPLOYEE') : undefined;
      const r = await callUi(people.create, ctx, { body: {
        firstName: p.firstName, lastName: p.lastName, designation: p.designation, departmentId: p.departmentId, managerId: p.managerId,
        joiningDate: p.joiningDate, employmentType: p.employmentType, phone: p.phone, email: p.email,
        loginMode: p.invite ? 'invite' : 'none', ...(roleId ? { roleId } : {}),
      } });
      return { summary: `Added ${r.person.displayName} (${r.person.employeeCode})${p.invite ? ` and sent an invite to ${p.email}` : ''}.`, data: r.person };
    },
    output: r => ({ ...out('employee', r.data), label: (r.data as any)?.displayName }),
  },

  // ── Update a person (PATCH /people/:id — permission engine + role-rank inside) ──
  {
    name: 'UPDATE_EMPLOYEE', label: 'Update an employee', category: 'HR',
    description: 'Changes a person\'s HR details — designation, department, manager, phone, work mode, employment type or status, joining/probation/confirmation dates, city/state/country (e.g. "move Priya to the Marketing department and make her a Team Lead"). Not for salary (CHANGE_SALARY) or bank/tax details.',
    example: 'Change Priya Sharma\'s designation to Team Lead and her manager to Arjun',
    paramsHint: '{ employeeId: person\'s name, designation?: string, departmentId?: department name, managerId?: manager\'s name, phone?: string, workMode?: "ONSITE"|"REMOTE"|"HYBRID", employmentType?: "FULL_TIME"|"PART_TIME"|"CONTRACT"|"INTERN"|"CONSULTANT"|"TEMPORARY", employmentStatus?: "PROBATION"|"ACTIVE"|"ON_LEAVE"|"NOTICE_PERIOD"|"SUSPENDED"|"EXITED", joiningDate?: date, probationEndDate?: date, confirmationDate?: date, firstName?: string, lastName?: string, city?: string, state?: string, country?: string }',
    allowedRoles: ALL_USERS, permission: 'hr.employee.update', modules: ['hr_core'], requiresConfirmation: true,
    risk: p => (p.employmentStatus === 'EXITED' || p.employmentStatus === 'SUSPENDED' ? 'high' : 'medium'),
    record: { entity: 'employee', param: 'employeeId', permission: 'hr.employee.update' },
    refs: { departmentId: 'department', managerId: 'employee' },
    dates: { joiningDate: 'date', probationEndDate: 'date', confirmationDate: 'date' },
    schema: z.object({
      employeeId: zId, designation: z.string().trim().max(120).optional(), departmentId: zId.optional(), managerId: zId.optional(),
      phone: z.string().max(40).optional(), workMode: z.enum(WORK_MODES).optional(), employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
      employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(), joiningDate: zDate.optional(), probationEndDate: zDate.optional(), confirmationDate: zDate.optional(),
      firstName: z.string().trim().min(1).max(100).optional(), lastName: z.string().trim().max(100).optional(),
      city: z.string().max(100).optional(), state: z.string().max(100).optional(), country: z.string().max(100).optional(),
    }).refine(p => Object.keys(p).some(k => k !== 'employeeId'), { message: 'Nothing to change' }),
    sample: { employeeId: 'emp1', designation: 'Team Lead' },
    preview: async (p, _ctx, info) => ({
      title: `Update ${info.row?.displayName ?? 'person'}`, target: target('employee', info.row),
      changes: diffPreview(info.row, p, info, [
        { key: 'firstName', label: 'First name', before: r => r.firstName }, { key: 'lastName', label: 'Last name', before: r => r.lastName },
        { key: 'designation', label: 'Designation', before: r => r.designation }, { key: 'departmentId', label: 'Department', before: r => r.department?.name },
        { key: 'managerId', label: 'Manager', before: r => r.manager?.displayName }, { key: 'phone', label: 'Phone', before: r => r.phone },
        { key: 'workMode', label: 'Work mode', before: r => r.workMode }, { key: 'employmentType', label: 'Employment type', before: r => r.employmentType },
        { key: 'employmentStatus', label: 'Status', before: r => r.employmentStatus }, { key: 'joiningDate', label: 'Joining date', before: r => r.joiningDate },
        { key: 'probationEndDate', label: 'Probation ends', before: r => r.probationEndDate }, { key: 'confirmationDate', label: 'Confirmation date', before: r => r.confirmationDate },
        { key: 'city', label: 'City', before: r => r.city }, { key: 'state', label: 'State', before: r => r.state }, { key: 'country', label: 'Country', before: r => r.country },
      ]),
    }),
    handler: async (p, ctx) => {
      const { employeeId, ...fields } = p;
      const r = await callUi(people.update, ctx, { params: { id: employeeId }, body: fields });
      const ignored: string[] = r.ignoredFields ?? [];
      return { summary: `Updated ${r.displayName ?? r.person?.displayName ?? 'the person'}${ignored.length ? ` (not allowed to change: ${ignored.join(', ')})` : ''}.`, data: { id: employeeId, displayName: r.displayName ?? r.person?.displayName } };
    },
    output: r => out('employee', r.data),
  },

  // ── Leave: own request (existing action, now through the Leave page's handler) ──
  {
    name: 'REQUEST_LEAVE', label: 'Request leave', category: 'HR',
    description: 'Submits a leave request for yourself (e.g. "request annual leave from Sept 1 to Sept 5"). For work from home use REQUEST_WFH.',
    example: 'Request 2 days of annual leave from next Monday',
    paramsHint: '{ leaveTypeId: leave type name, startDate: date words or YYYY-MM-DD, endDate: date, halfDay?: boolean, halfDayPeriod?: "AM"|"PM", reason?: string }',
    allowedRoles: ALL_USERS, modules: ['hr_core'], requiresConfirmation: true, risk: 'low',
    refs: { leaveTypeId: 'leaveType' }, dates: { startDate: 'date', endDate: 'date' },
    schema: z.object({
      leaveTypeId: zId, startDate: zDate, endDate: zDate.optional(), halfDay: z.boolean().optional(),
      halfDayPeriod: z.enum(['AM', 'PM']).optional(), reason: z.string().max(500).optional(),
    }),
    sample: { leaveTypeId: 'lt1', startDate: '2026-10-26', endDate: '2026-10-27' },
    preview: async (p, _ctx, info) => listPreview(`Request ${info.labels.leaveTypeId ?? 'leave'} for yourself`, p, info),
    handler: async (p, ctx) => {
      const r = await callUi(leave.createRequest, ctx, { body: { ...p, endDate: p.halfDay ? p.startDate : (p.endDate ?? p.startDate) } });
      const d = Number(r.days);
      return { summary: `Requested ${d} day${d === 1 ? '' : 's'} of ${r.leaveType?.name ?? 'leave'} (${p.startDate}${p.endDate && p.endDate !== p.startDate ? ` → ${p.endDate}` : ''})${r.status === 'APPROVED' ? ' — approved automatically by policy' : ' — waiting for approval'}.`, data: r };
    },
    output: r => ({ id: (r.data as any)?.id, type: 'leaveRequest', label: 'Leave request', link: '/hr/leave' }),
  },

  // ── WFH: own request ────────────────────────────────────────────────────
  {
    name: 'REQUEST_WFH', label: 'Request work from home', category: 'HR',
    description: 'Requests work from home for yourself on one or more days (e.g. "work from home tomorrow", "WFH Thursday afternoon"). The org\'s WFH rules and auto-approval apply.',
    example: 'Request work from home this Friday',
    paramsHint: '{ startDate: date words or YYYY-MM-DD, endDate?: date, halfDay?: boolean, halfDayPeriod?: "AM"|"PM", reason?: string }',
    allowedRoles: ALL_USERS, modules: ['hr_core'], requiresConfirmation: true, risk: 'low',
    dates: { startDate: 'date', endDate: 'date' },
    schema: z.object({ startDate: zDate, endDate: zDate.optional(), halfDay: z.boolean().optional(), halfDayPeriod: z.enum(['AM', 'PM']).optional(), reason: z.string().max(500).optional() }),
    sample: { startDate: '2026-10-23' },
    preview: async (p, _ctx, info) => listPreview('Request work from home for yourself', p, info),
    handler: async (p, ctx) => {
      const r = await callUi(wfh.requestWfh, ctx, { body: p });
      return { summary: `Requested work from home (${p.startDate}${p.endDate && p.endDate !== p.startDate ? ` → ${p.endDate}` : ''})${r.status === 'APPROVED' ? ' — approved automatically by policy' : ' — waiting for approval'}.`, data: r };
    },
    output: r => ({ id: (r.data as any)?.id, type: 'leaveRequest', label: 'WFH request', link: '/hr/attendance' }),
  },

  // ── Apply leave for someone (managers; Leave → Apply on behalf) ──────────
  {
    name: 'APPLY_LEAVE_ON_BEHALF', label: 'Apply leave for an employee', category: 'HR',
    description: 'A manager records leave (or WFH, using a WFH leave type) for another employee, approved immediately unless approve is false (e.g. "mark 2 days sick leave for Ravi from yesterday").',
    example: 'Apply 1 day of sick leave for Ravi Kumar today',
    paramsHint: '{ userId: employee\'s name, leaveTypeId: leave type name, startDate: date, endDate?: date, halfDay?: boolean, halfDayPeriod?: "AM"|"PM", reason?: string, approve?: boolean (default true) }',
    allowedRoles: HR_MANAGERS, modules: ['hr_core'], requiresConfirmation: true, risk: 'medium',
    refs: { userId: 'user', leaveTypeId: 'leaveType' }, dates: { startDate: 'date', endDate: 'date' },
    schema: z.object({
      userId: zId, leaveTypeId: zId, startDate: zDate, endDate: zDate.optional(), halfDay: z.boolean().optional(),
      halfDayPeriod: z.enum(['AM', 'PM']).optional(), reason: z.string().max(500).optional(), approve: z.boolean().default(true),
    }),
    sample: { userId: 'u1', leaveTypeId: 'lt1', startDate: '2026-10-19' },
    preview: async (p, _ctx, info) => {
      const pv = listPreview(`Apply ${info.labels.leaveTypeId ?? 'leave'} for ${info.labels.userId ?? 'the employee'}`, p, info, ['approve']);
      pv.changes.push({ field: 'Status', after: p.approve === false ? 'Pending approval' : 'Approved immediately' });
      return pv;
    },
    handler: async (p, ctx) => {
      const { approve, ...rest } = p;
      const r = await callUi(leave.applyOnBehalf, ctx, { body: { ...rest, endDate: rest.halfDay ? rest.startDate : (rest.endDate ?? rest.startDate), autoApprove: approve !== false } });
      return { summary: `Recorded ${Number(r.days)} day(s) of ${r.leaveType?.name ?? 'leave'} for ${r.user?.name ?? 'the employee'} (${r.status.toLowerCase()}).`, data: r };
    },
    output: r => ({ id: (r.data as any)?.id, type: 'leaveRequest', label: 'Leave request', link: '/hr/leave' }),
  },

  // ── Approve / reject leave or WFH (existing actions, now via the Leave handler) ──
  {
    name: 'APPROVE_LEAVE', label: 'Approve a leave / WFH request', category: 'HR',
    description: 'Approves a pending leave or work-from-home request (e.g. "approve Priya\'s leave request", "approve Ravi\'s WFH"). Name the requester.',
    example: "Approve Priya's leave request",
    paramsHint: '{ leaveRequestId: the requester\'s name }',
    allowedRoles: HR_MANAGERS, modules: ['hr_core'], requiresConfirmation: true, risk: 'medium',
    record: { entity: 'leaveRequest', param: 'leaveRequestId' },
    schema: z.object({ leaveRequestId: zId }),
    sample: { leaveRequestId: 'lr1' },
    preview: async (_p, _ctx, info) => ({
      title: `Approve ${info.row?.user?.name ?? 'this'}'s ${info.row?.leaveType?.isWfh ? 'work-from-home' : info.row?.leaveType?.name ?? 'leave'} request`,
      target: target('leaveRequest', info.row),
      changes: [{ field: 'Status', before: info.row?.status ?? 'PENDING', after: 'APPROVED' }, ...(info.row ? [{ field: 'Dates', after: `${show(info.row.startDate)} → ${show(info.row.endDate)} (${Number(info.row.days)} day(s))` }] : [])],
      notes: ['The employee is notified in the app and by email.'],
    }),
    handler: async (p, ctx) => {
      const r = await callUi(leave.approveRequest, ctx, { params: { id: p.leaveRequestId } });
      return { summary: `Approved ${r.user?.name ?? 'the'}'s ${r.leaveType?.name ?? 'leave'} request.`, data: r };
    },
    output: r => ({ id: (r.data as any)?.id, type: 'leaveRequest', label: 'Leave request', link: '/hr/leave' }),
  },
  {
    name: 'REJECT_LEAVE', label: 'Reject a leave / WFH request', category: 'HR',
    description: 'Rejects a pending leave or work-from-home request with a reason (e.g. "reject Priya\'s leave request, we\'re short-staffed that week").',
    example: "Reject Priya's leave request due to coverage",
    paramsHint: '{ leaveRequestId: the requester\'s name, reason: string }',
    allowedRoles: HR_MANAGERS, modules: ['hr_core'], requiresConfirmation: true, risk: 'medium',
    record: { entity: 'leaveRequest', param: 'leaveRequestId' },
    schema: z.object({ leaveRequestId: zId, reason: z.string().min(1).max(500) }),
    sample: { leaveRequestId: 'lr1', reason: 'Short-staffed that week' },
    preview: async (p, _ctx, info) => ({
      title: `Reject ${info.row?.user?.name ?? 'this'}'s ${info.row?.leaveType?.isWfh ? 'work-from-home' : info.row?.leaveType?.name ?? 'leave'} request`,
      target: target('leaveRequest', info.row),
      changes: [{ field: 'Status', before: info.row?.status ?? 'PENDING', after: 'REJECTED' }, { field: 'Reason', after: p.reason }],
    }),
    handler: async (p, ctx) => {
      const r = await callUi(leave.rejectRequest, ctx, { params: { id: p.leaveRequestId }, body: { reason: p.reason } });
      return { summary: `Rejected ${r.user?.name ?? 'the'}'s ${r.leaveType?.name ?? 'leave'} request.`, data: r };
    },
    output: r => ({ id: (r.data as any)?.id, type: 'leaveRequest', label: 'Leave request', link: '/hr/leave' }),
  },

  // ── Attendance: one day ─────────────────────────────────────────────────
  {
    name: 'MARK_ATTENDANCE', label: 'Mark attendance for a day', category: 'HR',
    description: 'Sets an employee\'s attendance status for one day as a manual, audited correction (e.g. "mark Ravi present yesterday — forgot to check in"). For many people or days use BULK_MARK_ATTENDANCE.',
    example: 'Mark Ravi Kumar as present yesterday, he forgot to check in',
    paramsHint: `{ userId: employee's name, date: date words or YYYY-MM-DD, status: ${STATUS.map(s => `"${s}"`).join('|')}, reason: string }`,
    allowedRoles: HR_MANAGERS, modules: ['attendance'], requiresConfirmation: true, risk: 'medium',
    refs: { userId: 'user' }, dates: { date: 'date' },
    schema: z.object({ userId: zId, date: zDate, status: z.enum(STATUS), reason: z.string().trim().min(1).max(500) }),
    sample: { userId: 'u1', date: '2026-10-16', status: 'PRESENT', reason: 'Forgot to check in' },
    preview: async (p, ctx, info) => {
      const day = /^\$/.test(p.userId) ? null : await prisma.attendanceDay.findFirst({ where: { orgId: ctx.orgId, userId: p.userId, date: new Date(`${p.date}T00:00:00Z`) }, select: { status: true, source: true } });
      return {
        title: `Mark ${info.labels.userId ?? 'the employee'} ${p.status.replace(/_/g, ' ').toLowerCase()} on ${info.dateLabels.date ?? p.date}`,
        changes: [{ field: 'Status', before: day ? `${day.status}${day.source === 'MANUAL' ? ' (manual)' : ''}` : 'not computed yet', after: `${p.status} (manual)` }, { field: 'Reason', after: p.reason }],
        notes: ['Saved as a manual correction with an audit entry; refused if the day is in a finalised payroll period.'],
      };
    },
    handler: async (p, ctx) => {
      await callUi(attendanceAdmin.markDay, ctx, { body: { userId: p.userId, date: p.date, status: p.status, reason: `${p.reason} (via AI assistant)` } });
      const u = await prisma.user.findFirst({ where: { id: p.userId, orgId: ctx.orgId }, select: { name: true } });
      return { summary: `Marked ${u?.name ?? 'the employee'} ${p.status} on ${p.date}.`, data: { userId: p.userId, date: p.date } };
    },
    output: () => ({ type: 'attendance', label: 'Attendance register', link: '/hr/attendance' }),
  },

  // ── Attendance: bulk (Register → Bulk edit, with its dry-run preview) ───
  {
    name: 'BULK_MARK_ATTENDANCE', label: 'Bulk mark attendance', category: 'HR',
    description: 'Marks attendance for several employees over a date range in one audited batch, skipping weekly offs, holidays and existing manual corrections by default (e.g. "mark Ravi and Priya present from Monday to Wednesday — biometric outage").',
    example: 'Mark Ravi and Priya present for Monday to Wednesday this week — the biometric device was down',
    paramsHint: `{ userIds: employee names[], from: date, to: date, status: ${STATUS.map(s => `"${s}"`).join('|')}, reason: string, skipWeeklyOffs?: boolean (default true), skipHolidays?: boolean (default true), overwriteManual?: boolean (default false) }`,
    allowedRoles: HR_MANAGERS, modules: ['attendance'], requiresConfirmation: true,
    risk: p => (p.overwriteManual ? 'high' : 'medium'),
    refs: { userIds: 'user' }, dates: { from: 'date', to: 'date' },
    schema: z.object({
      userIds: z.array(zId).min(1).max(200), from: zDate, to: zDate, status: z.enum(STATUS), reason: z.string().trim().min(1).max(500),
      skipWeeklyOffs: z.boolean().default(true), skipHolidays: z.boolean().default(true), overwriteManual: z.boolean().default(false),
    }).refine(p => p.from <= p.to, { message: '"from" must be on or before "to"', path: ['to'] }),
    sample: { userIds: ['u1', 'u2'], from: '2026-10-12', to: '2026-10-14', status: 'PRESENT', reason: 'Biometric outage' },
    preview: async (p, ctx, info) => {
      const pv = listPreview(`Mark ${p.userIds.length} employee(s) ${p.status.replace(/_/g, ' ').toLowerCase()} from ${info.dateLabels.from ?? p.from} to ${info.dateLabels.to ?? p.to}`, p, info);
      if (!p.userIds.some((id: string) => /^\$/.test(id))) {
        try {
          // The register's own dry run: classifies every cell, writes nothing.
          const dry = await callUi(attendanceAdmin.bulkDays, ctx, { body: { userIds: p.userIds, range: { from: p.from, to: p.to }, action: 'mark', status: p.status, reason: p.reason, skipWeeklyOffs: p.skipWeeklyOffs, skipHolidays: p.skipHolidays, overwriteManual: p.overwriteManual, dryRun: true } });
          const skipped: Record<string, number> = {};
          for (const k of dry.skipped ?? []) skipped[k.reason ?? k.code] = (skipped[k.reason ?? k.code] ?? 0) + 1;
          const skipText = Object.entries(skipped).map(([r, n]) => `${n} ${r.toLowerCase()}`).join(', ');
          pv.notes = [`Dry run: ${dry.changed} of ${dry.total} day(s) will change${skipText ? `; skipped — ${skipText}` : ''}.`];
        } catch (e: any) { pv.notes = [`Dry run failed: ${e?.message ?? e}`]; }
      }
      return pv;
    },
    handler: async (p, ctx) => {
      const r = await callUi(attendanceAdmin.bulkDays, ctx, { body: { userIds: p.userIds, range: { from: p.from, to: p.to }, action: 'mark', status: p.status, reason: `${p.reason} (via AI assistant)`, skipWeeklyOffs: p.skipWeeklyOffs, skipHolidays: p.skipHolidays, overwriteManual: p.overwriteManual } });
      return { summary: `Bulk-marked attendance: ${r.changed} of ${r.total} day(s) changed, ${r.skipped?.length ?? 0} skipped.`, data: r };
    },
    output: () => ({ type: 'attendance', label: 'Attendance register', link: '/hr/attendance' }),
  },

  // ── Payroll: start a DRAFT run (never finalised or paid from chat) ──────
  {
    name: 'START_PAYROLL_RUN', label: 'Start a payroll run (draft)', category: 'HR',
    description: 'Creates a DRAFT payroll run for a month so HR can review payslips (e.g. "run payroll for October"). It is never finalised or marked paid by the assistant — that stays on the Payroll page.',
    example: 'Start the payroll run for October 2026',
    paramsHint: '{ month: month words like "October 2026" or "last month" or YYYY-MM, payrollCycleId?: cycle name (default cycle when omitted), attendanceMode?: "ATTENDANCE"|"CALENDAR" }',
    allowedRoles: HR_MANAGERS, modules: ['payroll'], requiresConfirmation: true, risk: 'high',
    refs: { payrollCycleId: 'payrollCycle' }, dates: { month: 'month' },
    schema: z.object({ month: zMonth, payrollCycleId: zId.optional(), attendanceMode: z.enum(['ATTENDANCE', 'CALENDAR']).optional() }),
    sample: { month: '2026-10' },
    preview: async (p, ctx, info) => {
      const cycle = p.payrollCycleId
        ? await prisma.payrollCycle.findFirst({ where: { id: p.payrollCycleId, orgId: ctx.orgId } })
        : (await prisma.payrollCycle.findFirst({ where: { orgId: ctx.orgId, isDefault: true } })) ?? (await prisma.payrollCycle.findFirst({ where: { orgId: ctx.orgId } }));
      const on = new Date(`${p.month}-01T00:00:00Z`);
      const period = cycle ? periodFor(cycle as any, on) : null;
      const count = cycle ? await prisma.employeeSalary.count({ where: { orgId: ctx.orgId, isActive: true, payrollCycleId: cycle.id, user: { isActive: true } } }) : 0;
      return {
        title: `Create a DRAFT payroll run for ${info.dateLabels.month ?? p.month}`,
        changes: [
          { field: 'Cycle', after: cycle?.name ?? 'Monthly (created on first run)' },
          { field: 'Period', after: period ? `${show(period.start)} → ${show(period.end)}` : (info.dateLabels.month ?? p.month) },
          { field: 'Payslips', after: `${count} employee(s) with a salary on this cycle` },
          { field: 'Attendance', after: p.attendanceMode === 'CALENDAR' ? 'Pay every calendar day' : 'From the attendance register' },
          { field: 'Status', after: 'DRAFT — not finalised, nothing paid' },
        ],
        notes: ['Review the draft, then finalise and mark it paid yourself on the Payroll page.'],
      };
    },
    handler: async (p, ctx) => {
      const r = await callUi(payroll.runPayroll, ctx, { body: { on: `${p.month}-01`, payrollCycleId: p.payrollCycleId, attendanceMode: p.attendanceMode } });
      const n = r.payslips?.length ?? r._count?.payslips;
      return { summary: `Created a DRAFT payroll run for ${p.month}${typeof n === 'number' ? ` with ${n} payslip(s)` : ''}. Review and finalise it on the Payroll page.`, data: r };
    },
    output: r => ({ id: (r.data as any)?.id, type: 'payrollRun', label: 'Payroll run (draft)', link: '/hr/payroll' }),
  },

  // ── Loans & advances ────────────────────────────────────────────────────
  {
    name: 'ADD_LOAN', label: 'Add a loan or salary advance', category: 'HR',
    description: 'Records a loan or salary advance for an employee, recovered from payroll in EMIs (e.g. "give Ravi a 50,000 advance recovered over 5 months from November").',
    example: 'Add a ₹50,000 salary advance for Ravi Kumar recovered over 5 months starting November',
    paramsHint: '{ userId: employee\'s name, name: short label e.g. "Salary advance", type?: "LOAN"|"ADVANCE", principal: number, instalments?: number of months, emiAmount?: number, interestRate?: annual %, disbursedOn?: date (default today), startMonth: month words or YYYY-MM (first EMI), notes?: string }',
    allowedRoles: HR_MANAGERS, modules: ['payroll'], requiresConfirmation: true, risk: 'high',
    refs: { userId: 'user' }, dates: { disbursedOn: 'date', startMonth: 'month' },
    schema: z.object({
      userId: zId, name: z.string().trim().min(2).max(80), type: z.enum(['LOAN', 'ADVANCE']).default('LOAN'), principal: zMoney.refine(v => v > 0, 'must be more than 0'),
      instalments: z.coerce.number().int().min(1).max(360).optional(), emiAmount: zMoney.optional(), interestRate: z.coerce.number().min(0).max(60).optional(),
      disbursedOn: zDate.optional(), startMonth: zMonth, notes: z.string().max(1000).optional(),
    }).refine(p => p.instalments || p.emiAmount, { message: 'Say how many months (instalments) or the EMI amount', path: ['instalments'] }),
    sample: { userId: 'u1', name: 'Salary advance', type: 'ADVANCE', principal: 50000, instalments: 5, startMonth: '2026-11' },
    preview: async (p, _ctx, info) => {
      const pv = listPreview(`Add a ${p.type === 'ADVANCE' ? 'salary advance' : 'loan'} for ${info.labels.userId ?? 'the employee'}`, p, info);
      pv.notes = ['EMIs are deducted automatically in payroll runs from the start month.'];
      return pv;
    },
    handler: async (p, ctx) => {
      const [y, m] = p.startMonth.split('-').map(Number);
      const today = new Date().toISOString().slice(0, 10);
      const r = await callUi(loans.createLoan, ctx, { body: {
        userId: p.userId, name: p.name, type: p.type, principal: p.principal, instalments: p.instalments ?? null, emiAmount: p.emiAmount ?? null,
        interestRate: p.interestRate ?? null, disbursedOn: p.disbursedOn ?? today, startMonth: m, startYear: y, notes: p.notes ?? null,
      } });
      return { summary: `Added ${p.type === 'ADVANCE' ? 'an advance' : 'a loan'} of ${show(p.principal)} for ${r.user?.name ?? 'the employee'} — EMI ${show(r.emiAmount)} × ${r.instalments}.`, data: r };
    },
    output: r => out('loan', r.data),
  },
  {
    name: 'RECORD_LOAN_REPAYMENT', label: 'Record a loan repayment', category: 'HR',
    description: 'Records a direct repayment (outside payroll) against an employee\'s active loan or advance (e.g. "Ravi paid back 10,000 of his advance today").',
    example: 'Ravi Kumar repaid ₹10,000 of his salary advance today',
    paramsHint: '{ loanId: employee\'s name (or loan name), amount: number, date?: date (default today), note?: string }',
    allowedRoles: HR_MANAGERS, modules: ['payroll'], requiresConfirmation: true, risk: 'high',
    record: { entity: 'loan', param: 'loanId' }, dates: { date: 'date' },
    schema: z.object({ loanId: zId, amount: zMoney.refine(v => v > 0, 'must be more than 0'), date: zDate.optional(), note: z.string().max(300).optional() }),
    sample: { loanId: 'loan1', amount: 10000 },
    preview: async (p, _ctx, info) => ({
      title: `Record a repayment of ${show(p.amount)} on ${info.row ? `${info.row.user?.name}'s ${info.row.name}` : 'the loan'}`,
      target: target('loan', info.row),
      changes: [{ field: 'Repayment', after: show(p.amount) }, { field: 'Date', after: info.dateLabels.date ?? p.date ?? 'today' }, ...(p.note ? [{ field: 'Note', after: p.note }] : [])],
      notes: ['Refused if it is more than the outstanding balance; the loan closes when fully repaid.'],
    }),
    handler: async (p, ctx) => {
      const r = await callUi(loans.recordRepayment, ctx, { params: { id: p.loanId }, body: { amount: p.amount, date: p.date ?? new Date().toISOString().slice(0, 10), note: p.note } });
      return { summary: `Recorded a repayment of ${show(p.amount)} on ${r.name}${r.status === 'CLOSED' ? ' — the loan is now fully repaid' : ''}.`, data: r };
    },
    output: r => out('loan', r.data),
  },

  // ── Salary revision (new EmployeeSalary row via the salary API) ─────────
  {
    name: 'CHANGE_SALARY', label: 'Change an employee\'s salary', category: 'HR',
    description: 'Creates a new salary revision with a new annual CTC from an effective date, keeping the rest of the salary set-up (e.g. "raise Ravi\'s CTC to 9 lakh from 1 November").',
    example: "Revise Ravi Kumar's annual CTC to 900000 effective 1 November",
    paramsHint: '{ userId: employee\'s name, ctcAnnual: number (annual CTC), effectiveFrom: date, notes?: string }',
    allowedRoles: HR_MANAGERS, modules: ['payroll'], requiresConfirmation: true, risk: 'high',
    refs: { userId: 'user' }, dates: { effectiveFrom: 'date' },
    schema: z.object({ userId: zId, ctcAnnual: zMoney.refine(v => v > 0, 'must be more than 0'), effectiveFrom: zDate, notes: z.string().max(500).optional() }),
    sample: { userId: 'u1', ctcAnnual: 900000, effectiveFrom: '2026-11-01' },
    preview: async (p, ctx, info) => {
      const cur = /^\$/.test(p.userId) ? null : await prisma.employeeSalary.findFirst({ where: { orgId: ctx.orgId, userId: p.userId, isActive: true }, select: { ctcAnnual: true, currency: true, effectiveFrom: true } });
      return {
        title: `Revise ${info.labels.userId ?? 'the employee'}'s salary`,
        changes: [
          { field: 'Annual CTC', before: cur ? `${show(cur.ctcAnnual) ?? 'not set'} ${cur.currency}` : 'no salary set up yet', after: `${show(p.ctcAnnual)} ${cur?.currency ?? 'INR'}` },
          { field: 'Effective from', before: cur ? show(cur.effectiveFrom) : null, after: info.dateLabels.effectiveFrom ?? p.effectiveFrom },
        ],
        notes: ['The current salary row is kept as history; components and overrides carry over.'],
      };
    },
    handler: async (p, ctx) => {
      const cur = await prisma.employeeSalary.findFirst({ where: { orgId: ctx.orgId, userId: p.userId, isActive: true } });
      const r = await callUi(payrollConfig.upsertEmployeeSalary, ctx, { body: {
        userId: p.userId, ctcAnnual: p.ctcAnnual, effectiveFrom: p.effectiveFrom, notes: p.notes ?? 'Salary revision (via AI assistant)',
        ...(cur ? { payrollCycleId: cur.payrollCycleId, currency: cur.currency, overrides: cur.overrides ?? {} } : {}),
      } });
      return { summary: `Revised ${r.user?.name ?? 'the employee'}'s annual CTC to ${show(p.ctcAnnual)} from ${p.effectiveFrom}.`, data: r };
    },
    output: r => ({ id: (r.data as any)?.id, type: 'salary', label: 'Salary revision', link: '/hr/payroll' }),
  },
];

// Not exported as actions on purpose (see the AI actions report): finalising or
// paying a payroll run, payslip emails, bank/tax detail edits and face
// enrolment — each either moves money, is irreversible for employees, or needs
// the person's own device.
