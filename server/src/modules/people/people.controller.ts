import { assertRoleAssignable } from '../../utils/licensing';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { emailField } from '../../utils/zodHelpers';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../utils/prisma';
import { AuthRequest, forgetSession } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { parsePagination, paginate } from '../../utils/pagination';
import { logAction } from '../../utils/auditLog';
import { assertSeatAvailable, assertSeatForTransition, withSeatLock } from '../../utils/licensing';
import { sendMail, escHtml } from '../../utils/mailer';
import {
  getPermCtx,
  assertCan,
  can,
  scopeFor,
  scopedWhere,
  canAccessRecord,
  canWriteField,
  redact,
  stripUnwritableFields,
  invalidatePermCtx,
  invalidateAllPermCtx,
  type PermCtx,
  assertNoFieldEscalation,
} from '../../utils/permissions';
import { ensureEmployeeForUser, syncUserToEmployee } from '../../utils/employeeProvisioning';
import { assertCanAssign, rankOf, toLegacyRole } from '../../utils/roleRank';
import { pickGroup } from '../../utils/attendanceEngine';
import { encryptSensitive, decryptSensitive, SENSITIVE_COLUMNS } from '../hr/employees/employees.controller';
import { assertOrgRefs, assertEmployeeCodeFree } from './personRefs';
import {
  PersonUpdateSchema,
  SelfUpdateSchema,
  SELF_EDITABLE_FIELDS,
  EMPLOYEE_COLUMNS,
  DATE_COLUMNS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_STATUSES,
  WORK_MODES,
  changedKeys,
  auditChanges,
  dropMaskedEchoes,
  checkRoleChange,
  explicitGroupFor,
  planPolicyGroupMembership,
  type PolicyGroupRow,
} from './personRules';

/**
 * One "People" surface over two tables.
 *
 * ── Why a facade rather than a merge ──────────────────────────────────────
 * User and Employee stay separate in the database for three concrete reasons:
 * a login consumes a metered seat (utils/licensing.ts), `User.email` is
 * globally unique so login-less staff would need fabricated addresses, and
 * bank/tax/national-ID columns have no business sitting on an auth record.
 *
 * But none of that is the admin's problem. From the outside there is one list
 * of people, some of whom can sign in. This module is what makes that true:
 * every read returns the union, and every write decides for itself which
 * table(s) to touch. The client never orchestrates two calls or reasons about
 * which entity it is looking at.
 *
 * The employee record is the spine — auto-provisioning (utils/
 * employeeProvisioning.ts) guarantees one exists for every user. Users without
 * one are surfaced too, because that state means provisioning failed and
 * hiding it would hide a bug.
 */

// ─── Shared shape ─────────────────────────────────────────────────────────────

export interface Person {
  /** Employee id when one exists, otherwise `user:<id>` for an unprovisioned login. */
  id: string;
  employeeId: string | null;
  userId: string | null;
  employeeCode: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  designation: string | null;
  department: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
  manager: { id: string; displayName: string } | null;
  employmentStatus: string | null;
  employmentType: string | null;
  joiningDate: Date | null;
  photoUrl: string | null;
  /** True when this person can sign in and the login is active. */
  hasLogin: boolean;
  loginActive: boolean;
  role: string | null;
  roleId: string | null;
  roleName: string | null;
}

const employeeInclude = {
  department: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  manager: { select: { id: true, displayName: true } },
  user: {
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      roleId: true,
      roleRef: { select: { id: true, name: true } },
    },
  },
};

function fromEmployee(e: any): Person {
  return {
    id: e.id,
    employeeId: e.id,
    userId: e.user?.id ?? null,
    employeeCode: e.employeeCode,
    displayName: e.displayName,
    email: e.user?.email ?? e.workEmail ?? null,
    phone: e.phone,
    designation: e.designation,
    department: e.department,
    location: e.location,
    manager: e.manager,
    employmentStatus: e.employmentStatus,
    employmentType: e.employmentType,
    joiningDate: e.joiningDate,
    photoUrl: e.photoUrl,
    hasLogin: !!e.user,
    loginActive: !!e.user?.isActive,
    role: e.user?.role ?? null,
    roleId: e.user?.roleId ?? null,
    roleName: e.user?.roleRef?.name ?? e.user?.role ?? null,
  };
}

/** A login with no employee record — provisioning failed, or it predates HR. */
function fromOrphanUser(u: any): Person {
  return {
    id: `user:${u.id}`,
    employeeId: null,
    userId: u.id,
    employeeCode: null,
    displayName: u.name,
    email: u.email,
    phone: u.phone,
    designation: null,
    department: null,
    location: null,
    manager: null,
    employmentStatus: null,
    employmentType: null,
    joiningDate: null,
    photoUrl: u.avatarUrl,
    hasLogin: true,
    loginActive: u.isActive,
    role: u.role,
    roleId: u.roleId ?? null,
    roleName: u.roleRef?.name ?? u.role,
  };
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'hr.employee.read');

    const orgId = req.user!.orgId;
    const { search, departmentId, employmentStatus, login } = req.query as Record<string, string>;

    const where: any = { orgId, ...scopedWhere(ctx, 'employee', 'hr.employee.read') };
    if (departmentId) where.departmentId = departmentId;
    if (employmentStatus) where.employmentStatus = employmentStatus;
    // `login=yes|no` is the filter that makes the two-table reality visible
    // exactly where it is useful, and invisible everywhere else.
    if (login === 'yes') where.userId = { not: null };
    if (login === 'no') where.userId = null;
    if (search) {
      where.OR = [
        { displayName: { contains: search, mode: 'insensitive' } },
        { employeeCode: { contains: search, mode: 'insensitive' } },
        { workEmail: { contains: search, mode: 'insensitive' } },
        { designation: { contains: search, mode: 'insensitive' } },
      ];
    }

    const pag = parsePagination(req);
    const [employees, employeeTotal] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: employeeInclude,
        orderBy: { displayName: 'asc' },
        take: pag.limit,
        skip: pag.skip,
      }),
      prisma.employee.count({ where }),
    ]);

    // Orphan logins only belong in the "all" and "can sign in" views — a user
    // with no employee record is by definition not a person without a login.
    let orphans: Person[] = [];
    if (login !== 'no') {
      const rows = await prisma.user.findMany({
        where: {
          orgId,
          employee: { is: null },
          role: { not: 'PLATFORM_ADMIN' },
          ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}),
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          avatarUrl: true,
          isActive: true,
          role: true,
          roleId: true,
          roleRef: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      });
      orphans = rows.map(fromOrphanUser);
    }

    const people = [...employees.map(e => redact(ctx, 'employee', fromEmployee(e))), ...orphans];

    // What the caller may do from this list, decided by the permission
    // engine rather than guessed from the role name on the client — an HR
    // Manager custom role rides on the EMPLOYEE enum but can add and edit.
    res.json({ ...paginate(people, employeeTotal + orphans.length, pag), access: listAccess(ctx) });
  } catch (err) {
    next(err);
  }
}

export async function stats(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'hr.employee.read');
    const orgId = req.user!.orgId;

    const [total, withLogin, withoutLogin, onNotice, orphanLogins, activeLogins] = await Promise.all([
      prisma.employee.count({ where: { orgId } }),
      prisma.employee.count({ where: { orgId, userId: { not: null } } }),
      prisma.employee.count({ where: { orgId, userId: null } }),
      prisma.employee.count({ where: { orgId, employmentStatus: 'NOTICE_PERIOD' } }),
      prisma.user.count({ where: { orgId, employee: { is: null }, role: { not: 'PLATFORM_ADMIN' } } }),
      prisma.user.count({ where: { orgId, isActive: true, role: { not: 'PLATFORM_ADMIN' } } }),
    ]);

    res.json({
      total: total + orphanLogins,
      canSignIn: withLogin + orphanLogins,
      noLogin: withoutLogin,
      onNotice,
      activeLogins,
      // Surfaced so the UI can offer the one-click repair rather than leaving
      // these people quietly missing from HR.
      unlinkedLogins: orphanLogins,
      // Lets any screen that offers "Add person" (People, Org Chart, Org
      // Structure, Users) decide whether to show it without a second call.
      access: listAccess(ctx),
    });
  } catch (err) {
    next(err);
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

const CreateSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().optional().nullable(),
  designation: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  managerId: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  joiningDate: z.string(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  // Added with the shared Add-person form; all optional so existing callers
  // (and the Android app's older bundle) keep sending what they always sent.
  employeeCode: z.preprocess(v => (v === '' ? undefined : v), z.string().trim().min(1).max(40).optional()),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  workMode: z.enum(WORK_MODES).optional(),

  /**
   * How this person gets access.
   *   none     — staff who never sign in. No seat consumed, no email needed.
   *   password — admin sets one now.
   *   invite   — they set their own via an emailed link.
   */
  loginMode: z.enum(['none', 'password', 'invite']).default('none'),
  email: emailField().optional(),
  password: z.string().min(8).optional(),
  roleId: z.string().optional(),
});

/**
 * Adds a person, with or without a login, in one call.
 *
 * The whole point of this endpoint: an admin says "new starter, here are their
 * details, yes they need access" once — rather than creating a user in one
 * screen and an employee in another and hoping the two agree.
 */
export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'hr.employee.create');

    const orgId = req.user!.orgId;
    const data = CreateSchema.parse(req.body);
    const displayName = [data.firstName, data.lastName].filter(Boolean).join(' ');

    if (data.loginMode !== 'none' && !data.email) {
      throw new AppError(400, 'An email address is required to give someone a login');
    }
    if (data.loginMode === 'password' && !data.password) {
      throw new AppError(400, 'Set a password, or choose to send an invite instead');
    }
    await assertOrgRefs(orgId, data);
    if (data.employeeCode) await assertEmployeeCodeFree(orgId, data.employeeCode);

    let userId: string | null = null;
    let inviteLink: string | null = null;
    let pendingInvite: { token: string; legacyRole: any; roleId: string | null } | null = null;

    if (data.loginMode !== 'none') {
      assertCan(ctx, 'core.user.create');
      const clash = await prisma.user.findUnique({ where: { email: data.email! } });
      if (clash) throw new AppError(409, 'That email address already has an account');

      const role = data.roleId
        ? await prisma.role.findFirst({
            where: { id: data.roleId, OR: [{ orgId }, { orgId: null }] },
            select: { id: true, key: true, legacyRole: true },
          })
        : null;
      if (data.roleId && !role) throw new AppError(404, 'That role was not found in this organization');
      if (role) { await assertRoleAssignable(orgId, role); await assertNoFieldEscalation(req.user!, role.id); }
      const legacyRole = toLegacyRole(role?.legacyRole) as any;
      // Same rank rule as Administration → Users: nobody hands out a role
      // above their own (an IT Manager cannot add a Super Admin here either).
      assertCanAssign(req.user!.role, legacyRole);
      await assertSeatAvailable(orgId, legacyRole);

      if (data.loginMode === 'password') {
        const user = await prisma.user.create({
          data: {
            orgId,
            name: displayName,
            email: data.email!,
            passwordHash: await bcrypt.hash(data.password!, 12),
            role: legacyRole,
            roleId: role?.id ?? null,
            phone: data.phone ?? null,
            department: await departmentName(orgId, data.departmentId),
          },
          select: { id: true },
        });
        userId = user.id;
      } else {
        /* The token row is created after the employee below, so it can
           record which person it belongs to. Without that link, accepting
           the invite provisioned a second employee for the same human. */
        pendingInvite = { token: crypto.randomBytes(32).toString('hex'), legacyRole, roleId: role?.id ?? null };
        inviteLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/accept-invite?token=${pendingInvite.token}`;
      }
    }

    // The employee record is created directly rather than via
    // ensureEmployeeForUser, because we hold richer details here (designation,
    // manager, joining date) than that helper can infer from a user row.
    let employeeCode = data.employeeCode;
    if (!employeeCode) {
      const codeRows = await prisma.employee.findMany({
        where: { orgId, employeeCode: { startsWith: 'EMP-' } },
        select: { employeeCode: true },
        orderBy: { employeeCode: 'desc' },
        take: 1,
      });
      const lastNum = codeRows[0] ? parseInt(codeRows[0].employeeCode.replace('EMP-', ''), 10) : 0;
      employeeCode = `EMP-${String((Number.isFinite(lastNum) ? lastNum : 0) + 1).padStart(4, '0')}`;
    }

    const employee = await prisma.employee.create({
      data: {
        orgId,
        userId,
        employeeCode,
        firstName: data.firstName,
        lastName: data.lastName ?? null,
        displayName,
        workEmail: data.email ?? null,
        phone: data.phone ?? null,
        designation: data.designation ?? null,
        departmentId: data.departmentId ?? null,
        locationId: data.locationId ?? null,
        managerId: data.managerId ?? null,
        joiningDate: new Date(data.joiningDate),
        employmentType: data.employmentType ?? 'FULL_TIME',
        employmentStatus: data.employmentStatus ?? 'ACTIVE',
        ...(data.workMode ? { workMode: data.workMode } : {}),
      },
      include: employeeInclude,
    });

    /* Now that the person exists, the invite can name them — acceptance
       links the login to this record rather than creating another. */
    if (pendingInvite) {
      await prisma.inviteToken.create({
        data: {
          orgId,
          email: data.email!,
          role: pendingInvite.legacyRole,
          roleId: pendingInvite.roleId,
          employeeId: employee.id,
          token: pendingInvite.token,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
      sendMail({
        orgId,
        essential: true, // account access — never held back by the platform send quota
        to: data.email!,
        subject: `You've been invited to join ${org?.name ?? 'the team'}`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#4f46e5">You're invited</h2>
          <p>You've been added to <strong>${escHtml(org?.name ?? 'the team')}</strong>. Set up your account below — this link expires in 7 days.</p>
          <a href="${escHtml(inviteLink)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">Accept Invitation</a>
          <p style="color:#6b7280;font-size:13px">Or copy this link: ${escHtml(inviteLink)}</p>
        </div>`,
      }).catch(() => {});
    }

    logAction(req.user!.id, 'CREATE', 'EMPLOYEE', employee.id, { displayName, loginMode: data.loginMode });
    if (userId) invalidatePermCtx(userId);

    res.status(201).json({ person: fromEmployee(employee), inviteLink });
  } catch (err) {
    next(err);
  }
}

// ─── Login lifecycle ──────────────────────────────────────────────────────────

const GrantLoginSchema = z.object({
  email: emailField(),
  roleId: z.string().optional(),
  mode: z.enum(['password', 'invite']).default('invite'),
  password: z.string().min(8).optional(),
});

/**
 * Gives an existing employee a login.
 *
 * This is the transition the old two-screen model handled worst: a contractor
 * who has been on the books for six months now needs system access, and
 * nothing connected the employee record already on file to the new user.
 */
export async function grantLogin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.user.create');

    const orgId = req.user!.orgId;
    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, orgId },
      select: { id: true, userId: true, displayName: true, phone: true },
    });
    if (!employee) throw new AppError(404, 'Person not found');
    if (employee.userId) throw new AppError(400, 'This person already has a login');

    const data = GrantLoginSchema.parse(req.body);
    const clash = await prisma.user.findUnique({ where: { email: data.email } });
    if (clash) throw new AppError(409, 'That email address already has an account');

    const role = data.roleId
      ? await prisma.role.findFirst({
          where: { id: data.roleId, OR: [{ orgId }, { orgId: null }] },
          select: { id: true, key: true, legacyRole: true },
        })
      : null;
    if (data.roleId && !role) throw new AppError(404, 'That role was not found in this organization');
    if (role) { await assertRoleAssignable(orgId, role); await assertNoFieldEscalation(req.user!, role.id); }
    const legacyRole = toLegacyRole(role?.legacyRole) as any;
    assertCanAssign(req.user!.role, legacyRole);
    await assertSeatAvailable(orgId, legacyRole);

    if (data.mode === 'password') {
      if (!data.password) throw new AppError(400, 'Set a password, or send an invite instead');
      const user = await prisma.user.create({
        data: {
          orgId,
          name: employee.displayName,
          email: data.email,
          passwordHash: await bcrypt.hash(data.password, 12),
          role: legacyRole,
          roleId: role?.id ?? null,
          phone: employee.phone,
        },
        select: { id: true },
      });
      await prisma.employee.update({ where: { id: employee.id }, data: { userId: user.id, workEmail: data.email } });
      logAction(req.user!.id, 'UPDATE', 'EMPLOYEE', employee.id, { action: 'GRANT_LOGIN' });
      res.json({ message: 'Login created', userId: user.id, inviteLink: null });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    await prisma.inviteToken.create({
      data: {
        orgId,
        email: data.email,
        role: legacyRole,
        roleId: role?.id ?? null,
        // This person already exists — acceptance attaches the login to
        // them instead of provisioning a duplicate.
        employeeId: employee.id,
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.employee.update({ where: { id: employee.id }, data: { workEmail: data.email } });

    const link = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/accept-invite?token=${token}`;
    logAction(req.user!.id, 'UPDATE', 'EMPLOYEE', employee.id, { action: 'INVITE_LOGIN' });
    res.json({ message: 'Invite sent', userId: null, inviteLink: link });
  } catch (err) {
    next(err);
  }
}

/**
 * Removes system access while keeping the person on the books.
 *
 * Deliberately deactivates rather than deletes: the login is referenced by
 * audit logs, assigned tickets and owned deals, and destroying it would take
 * that history with it.
 */
export async function revokeLogin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.user.update');

    const orgId = req.user!.orgId;
    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, orgId },
      select: { id: true, userId: true },
    });
    if (!employee?.userId) throw new AppError(400, 'This person does not have a login');
    if (employee.userId === req.user!.id) throw new AppError(400, 'You cannot revoke your own access');

    await prisma.user.update({ where: { id: employee.userId }, data: { isActive: false } });
    forgetSession(employee.userId);
    invalidatePermCtx(employee.userId);
    logAction(req.user!.id, 'UPDATE', 'EMPLOYEE', employee.id, { action: 'REVOKE_LOGIN' });

    res.json({ message: 'Access revoked. The person remains on the employee list.' });
  } catch (err) {
    next(err);
  }
}

const AssignRoleSchema = z.object({ roleId: z.string().min(1) });

/** Changes the role on a person's login, addressed by employee id. */
export async function assignRole(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'core.user.update');

    const orgId = req.user!.orgId;
    const { roleId } = AssignRoleSchema.parse(req.body);

    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, orgId },
      select: { id: true, userId: true, user: { select: { isActive: true, role: true } } },
    });
    if (!employee) throw new AppError(404, 'Person not found');

    await changeRole(req, employee, roleId);

    res.json({ message: 'Role updated' });
  } catch (err) {
    next(err);
  }
}

/** Creates the missing employee records for logins that never got one. */
export async function repairUnlinked(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'hr.employee.create');

    const orphans = await prisma.user.findMany({
      where: { orgId: req.user!.orgId, employee: { is: null }, role: { not: 'PLATFORM_ADMIN' } },
      select: { id: true },
    });

    let created = 0;
    for (const u of orphans) {
      if (await ensureEmployeeForUser(u.id)) created++;
    }

    res.json({ created, message: `Created ${created} employee record(s).` });
  } catch (err) {
    next(err);
  }
}

/** Keeps the login's name/phone in step when the person record is edited. */
export async function syncFromEmployee(userId: string, changes: { name?: string; phone?: string | null }) {
  await syncUserToEmployee(userId, changes);
}

// ─── Shared helpers for add / edit ───────────────────────────────────────────

/** List-level capabilities, so the client shows Add / Edit only to people who can use them. */
function listAccess(ctx: PermCtx) {
  return {
    canCreate: can(ctx, 'hr.employee.create'),
    canEdit: scopeFor(ctx, 'hr.employee.update') !== 'NONE',
    canCreateLogin: can(ctx, 'core.user.create'),
  };
}

/**
 * `User.department` is a legacy free-text column that several screens still
 * read (Administration → Users, assignee pickers). The Department table is the
 * source of truth; this keeps the string in step whenever HR changes it.
 */
async function departmentName(orgId: string, departmentId?: string | null): Promise<string | null> {
  if (!departmentId) return null;
  const d = await prisma.department.findFirst({ where: { id: departmentId, orgId }, select: { name: true } });
  return d?.name ?? null;
}

/**
 * Changes the role on a person's login. The single implementation behind the
 * People list's role selector and the Edit form, with the same rank rules as
 * Administration → Users (utils/roleRank.ts).
 */
async function changeRole(
  req: AuthRequest,
  employee: { id: string; userId: string | null; user: { isActive: boolean; role: string } | null },
  roleId: string
) {
  const orgId = req.user!.orgId;
  const role = await prisma.role.findFirst({
    where: { id: roleId, OR: [{ orgId }, { orgId: null }] },
    select: { id: true, key: true, legacyRole: true, isActive: true },
  });
  if (!role) throw new AppError(404, 'Role not found');
  if (!role.isActive) throw new AppError(400, 'That role is deactivated');
  await assertRoleAssignable(orgId, role);
  await assertNoFieldEscalation(req.user!, role.id);

  const legacyRole = toLegacyRole(role.legacyRole);
  checkRoleChange({
    callerUserId: req.user!.id,
    callerRole: req.user!.role,
    targetUserId: employee.userId,
    targetRole: employee.user?.role ?? null,
    newRole: legacyRole,
  });

  // Promoting an EMPLOYEE into a billable role takes a seat (LIC-2).
  await withSeatLock(orgId, async tx => {
    await assertSeatForTransition(orgId, {
      wasActive: !!employee.user?.isActive, wasRole: employee.user?.role ?? null,
      willBeActive: !!employee.user?.isActive, willBeRole: legacyRole,
    }, tx);
    await tx.user.update({
      where: { id: employee.userId! },
      data: { roleId: role.id, role: legacyRole as any },
    });
  });
  invalidatePermCtx(employee.userId!);
  forgetSession(employee.userId!);
  logAction(req.user!.id, 'UPDATE', 'EMPLOYEE', employee.id, { action: 'ROLE_CHANGE', roleId: role.id, role: legacyRole });
}

const profileInclude = {
  department: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  manager: { select: { id: true, displayName: true, employeeCode: true } },
  dottedLineManager: { select: { id: true, displayName: true } },
  user: {
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      roleId: true,
      roleRef: { select: { id: true, name: true } },
    },
  },
  reports: { select: { id: true, displayName: true, designation: true, employeeCode: true }, orderBy: { displayName: 'asc' as const } },
  contacts: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
  skills: { include: { skill: { select: { id: true, name: true, category: true } } } },
  certifications: true,
};

/** The contact the edit form shows as "Emergency contact": the primary emergency one, else the first. */
function primaryEmergency<T extends { isEmergency: boolean; isPrimary: boolean }>(contacts: T[]): T | null {
  return contacts.find(c => c.isEmergency && c.isPrimary) ?? contacts.find(c => c.isEmergency) ?? null;
}

const FIELD_RULE_FIELDS = [...SENSITIVE_COLUMNS, 'dateOfBirth', 'personalEmail'];

function personAccess(ctx: PermCtx, callerRole: string, employee: any) {
  const canEdit = can(ctx, 'hr.employee.update') && canAccessRecord(ctx, 'employee', 'hr.employee.update', employee);
  const isSelf = !!employee.userId && employee.userId === ctx.userId;
  const outranked = !!employee.user && rankOf(employee.user.role) > rankOf(callerRole);
  return {
    canEdit,
    isSelf,
    canEditRole: canEdit && can(ctx, 'core.user.update') && !!employee.userId && !isSelf && !outranked,
    // A login email is the person's sign-in identity — only user admins who
    // may manage that login can change it. A no-login person's work email is
    // ordinary HR data.
    canEditEmail: canEdit && (!employee.userId || (can(ctx, 'core.user.update') && !outranked)),
    canSetPolicyGroup: canEdit && !!employee.userId && scopeFor(ctx, 'hr.attendance.update') === 'ALL',
    canManageLogin: can(ctx, 'core.user.create'),
    /** Fields the caller's field permissions won't let them write (rendered read-only). */
    readOnlyFields: FIELD_RULE_FIELDS.filter(f => !canWriteField(ctx, 'employee', f)),
  };
}

async function loadProfile(ctx: PermCtx, req: AuthRequest, employeeId: string) {
  const orgId = req.user!.orgId;
  const employee: any = await prisma.employee.findFirst({ where: { id: employeeId, orgId }, include: profileInclude });
  if (!employee) throw new AppError(404, 'Person not found');
  if (!canAccessRecord(ctx, 'employee', 'hr.employee.read', employee)) {
    throw new AppError(403, 'Insufficient permissions');
  }

  const access = personAccess(ctx, req.user!.role, employee);

  // Attendance applies to logins only — the engine keys days by user id.
  let attendancePolicy: any = null;
  if (employee.userId) {
    const groups = await prisma.attendancePolicyGroup.findMany({
      where: { orgId },
      select: { id: true, name: true, isDefault: true, isActive: true, applicability: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const explicit = explicitGroupFor(groups as PolicyGroupRow[], employee.userId);
    const effective = pickGroup(groups as any[], {
      userId: employee.userId,
      departmentId: employee.departmentId,
      locationId: employee.locationId,
      employmentType: employee.employmentType,
    }) as any;
    attendancePolicy = {
      explicitId: explicit?.id ?? null,
      effective: effective ? { id: effective.id, name: effective.name } : null,
      options: access.canSetPolicyGroup
        ? groups.filter(g => g.isActive).map(g => ({ id: g.id, name: g.name, isDefault: g.isDefault }))
        : undefined,
    };
  }

  const ec = primaryEmergency(employee.contacts as any[]);
  return {
    ...redact(ctx, 'employee', decryptSensitive(employee)),
    person: fromEmployee(employee),
    emergencyContact: ec ? { id: ec.id, name: ec.name, relationship: ec.relationship, phone: ec.phone } : null,
    attendancePolicy,
    access,
  };
}

/** Creates, replaces or removes the primary emergency contact. */
async function writeEmergencyContact(
  tx: any,
  employeeId: string,
  value: { name: string; relationship: string; phone: string } | null
) {
  const contacts = await tx.employeeContact.findMany({
    where: { employeeId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  const current = primaryEmergency(contacts as any[]) as any;
  if (value === null) {
    if (current) await tx.employeeContact.delete({ where: { id: current.id } });
    return;
  }
  if (current) {
    await tx.employeeContact.update({ where: { id: current.id }, data: { ...value, isEmergency: true } });
  } else {
    await tx.employeeContact.create({ data: { ...value, employeeId, isEmergency: true, isPrimary: true } });
  }
}

// ─── Read one / Edit ─────────────────────────────────────────────────────────

/** GET /people/:id — the full person profile behind the detail view and Edit form. */
export async function getOne(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'hr.employee.read');
    res.json(await loadProfile(ctx, req, req.params.id));
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /people/:id — the one edit path for a person.
 *
 * Writes whichever tables the change touches — the employee record, the login
 * (name, phone, department, email, role), the attendance policy membership and
 * the emergency contact — so the client never orchestrates several calls or
 * leaves the User and Employee rows disagreeing. Everything is validated
 * before anything is written.
 */
export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ctx = await getPermCtx(req.user!);
    assertCan(ctx, 'hr.employee.update');

    const orgId = req.user!.orgId;
    const existing: any = await prisma.employee.findFirst({
      where: { id: req.params.id, orgId },
      include: { user: { select: { id: true, email: true, role: true, roleId: true, isActive: true } } },
    });
    if (!existing) throw new AppError(404, 'Person not found');
    if (!canAccessRecord(ctx, 'employee', 'hr.employee.update', existing)) {
      throw new AppError(403, 'Insufficient permissions');
    }

    const input = PersonUpdateSchema.parse(req.body);
    const { email, roleId, policyGroupId, emergencyContact, ...rest } = input;

    // Masked echoes and fields this role may not write are dropped, never saved.
    const writable = stripUnwritableFields(ctx, 'employee', dropMaskedEchoes(rest as Record<string, unknown>));
    const before = decryptSensitive(existing);
    const changed = changedKeys(before, writable).filter(k => (EMPLOYEE_COLUMNS as readonly string[]).includes(k));
    const empData: Record<string, any> = {};
    for (const k of changed) empData[k] = writable[k];

    await assertOrgRefs(
      orgId,
      {
        departmentId: empData.departmentId,
        locationId: empData.locationId,
        managerId: empData.managerId,
        dottedLineManagerId: empData.dottedLineManagerId,
      },
      existing.id
    );
    if (empData.employeeCode) await assertEmployeeCodeFree(orgId, empData.employeeCode, existing.id);

    // ── Email ──
    let newEmail: string | null | undefined;
    const currentEmail: string | null = (existing.user?.email ?? existing.workEmail ?? null)?.toLowerCase() ?? null;
    if (email !== undefined && (email ?? null) !== currentEmail) {
      if (existing.user) {
        if (!email) throw new AppError(400, 'A person who can sign in needs an email address');
        if (!can(ctx, 'core.user.update')) throw new AppError(403, 'Only user administrators can change a sign-in email');
        if (rankOf(existing.user.role) > rankOf(req.user!.role)) {
          throw new AppError(403, 'You cannot manage a user with a higher role than your own');
        }
        const clash = await prisma.user.findFirst({ where: { email, NOT: { id: existing.user.id } }, select: { id: true } });
        if (clash) throw new AppError(409, 'That email address already has an account');
      } else if (email) {
        const [userClash, empClash] = await Promise.all([
          prisma.user.findFirst({ where: { email }, select: { id: true } }),
          prisma.employee.findFirst({
            where: { orgId, workEmail: { equals: email, mode: 'insensitive' }, id: { not: existing.id } },
            select: { displayName: true },
          }),
        ]);
        if (userClash) throw new AppError(409, 'That email address already belongs to another account');
        if (empClash) throw new AppError(409, `That email address is already used by ${empClash.displayName}`);
      }
      newEmail = email;
    }

    // ── Role ── (validated now, written first because it takes the seat lock)
    const roleChanging = roleId !== undefined && roleId !== existing.user?.roleId;
    if (roleChanging) assertCan(ctx, 'core.user.update');

    // ── Attendance policy ──
    let groupUpdates: Array<{ id: string; applicability: Record<string, unknown> }> = [];
    if (policyGroupId !== undefined) {
      if (!existing.userId) throw new AppError(400, 'Attendance policies apply to people who can sign in');
      if (scopeFor(ctx, 'hr.attendance.update') !== 'ALL') {
        throw new AppError(403, 'You cannot change attendance policy assignments');
      }
      const groups = await prisma.attendancePolicyGroup.findMany({
        where: { orgId },
        select: { id: true, name: true, isDefault: true, isActive: true, applicability: true },
      });
      groupUpdates = planPolicyGroupMembership(groups as PolicyGroupRow[], existing.userId, policyGroupId ?? null);
    }

    // ── Derived columns ──
    let displayName: string | undefined;
    if ('firstName' in empData || 'lastName' in empData) {
      const first = empData.firstName ?? existing.firstName;
      const last = 'lastName' in empData ? empData.lastName : existing.lastName;
      displayName = [first, last].filter(Boolean).join(' ');
      empData.displayName = displayName;
    }
    for (const k of DATE_COLUMNS) {
      if (k in empData) empData[k] = empData[k] ? new Date(empData[k]) : null;
    }
    if (newEmail !== undefined) empData.workEmail = newEmail;

    if (roleChanging) await changeRole(req, existing, roleId!);

    await prisma.$transaction(async tx => {
      if (Object.keys(empData).length) {
        await tx.employee.update({ where: { id: existing.id }, data: encryptSensitive(empData) });
      }
      if (existing.user) {
        const userData: Record<string, unknown> = {};
        if (displayName !== undefined) userData.name = displayName;
        if ('phone' in empData) userData.phone = empData.phone;
        if ('departmentId' in empData) userData.department = await departmentName(orgId, empData.departmentId);
        if (newEmail) userData.email = newEmail;
        if (Object.keys(userData).length) await tx.user.update({ where: { id: existing.user.id }, data: userData });
      } else if (newEmail) {
        // An invite already on its way should go to the corrected address.
        await tx.inviteToken.updateMany({ where: { employeeId: existing.id, usedAt: null }, data: { email: newEmail } });
      }
      for (const g of groupUpdates) {
        await tx.attendancePolicyGroup.update({ where: { id: g.id }, data: { applicability: g.applicability as any } });
      }
      if (emergencyContact !== undefined) await writeEmergencyContact(tx, existing.id, emergencyContact);
    });

    const auditKeys = [
      ...changed,
      ...(newEmail !== undefined ? ['email'] : []),
      ...(groupUpdates.length ? ['policyGroupId'] : []),
      ...(emergencyContact !== undefined ? ['emergencyContact'] : []),
    ];
    if (auditKeys.length) {
      logAction(req.user!.id, 'UPDATE', 'EMPLOYEE', existing.id, auditChanges(
        { ...before, email: currentEmail },
        { ...writable, email: newEmail },
        auditKeys
      ));
    }

    // A new manager or department changes who can see whom (TEAM/DEPARTMENT
    // scopes are cached per user for a minute) — for the person, their old
    // manager and their new one. Clearing the cache is cheaper than working
    // out exactly whose entries are stale.
    if ('managerId' in empData || 'departmentId' in empData) invalidateAllPermCtx();
    else if (existing.userId) invalidatePermCtx(existing.userId);

    const ignored = Object.keys(rest).filter(k => !(k in writable));
    res.json({ ...(await loadProfile(ctx, req, existing.id)), ignoredFields: ignored });
  } catch (err) {
    next(err);
  }
}

// ─── Self-service ────────────────────────────────────────────────────────────

async function loadSelf(req: AuthRequest) {
  const employee: any = await prisma.employee.findFirst({
    where: { orgId: req.user!.orgId, userId: req.user!.id },
    include: {
      department: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      manager: { select: { id: true, displayName: true } },
      contacts: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
    },
  });
  if (!employee) return null;
  const ec = primaryEmergency(employee.contacts as any[]);
  // The person's own contact details come back unmasked — masking exists to
  // protect them from colleagues, not from themselves. Nothing else on the
  // record is returned here.
  const own: Record<string, unknown> = {};
  for (const f of SELF_EDITABLE_FIELDS) own[f] = employee[f] ?? null;
  return {
    id: employee.id,
    employeeCode: employee.employeeCode,
    displayName: employee.displayName,
    workEmail: employee.workEmail,
    designation: employee.designation,
    department: employee.department,
    location: employee.location,
    manager: employee.manager,
    employmentType: employee.employmentType,
    employmentStatus: employee.employmentStatus,
    joiningDate: employee.joiningDate,
    ...own,
    emergencyContact: ec ? { id: ec.id, name: ec.name, relationship: ec.relationship, phone: ec.phone } : null,
  };
}

/** GET /people/me — the caller's own HR details for My Profile. */
export async function getSelf(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.json({ data: await loadSelf(req) });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /people/me — an employee updating their own contact details.
 * Strictly the SELF_EDITABLE_FIELDS plus the emergency contact; anything else
 * (designation, department, manager, pay) is a 400, because it is HR's to set.
 */
export async function updateSelf(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const input = SelfUpdateSchema.parse(req.body);
    const employee: any = await prisma.employee.findFirst({
      where: { orgId: req.user!.orgId, userId: req.user!.id },
    });
    if (!employee) throw new AppError(404, 'No employee record is linked to your login — ask HR to add you');

    const { emergencyContact, ...fields } = input;
    const changed = changedKeys(employee, fields);
    const data: Record<string, unknown> = {};
    for (const k of changed) data[k] = (fields as any)[k];

    await prisma.$transaction(async tx => {
      if (changed.length) await tx.employee.update({ where: { id: employee.id }, data });
      if ('phone' in data) await tx.user.update({ where: { id: req.user!.id }, data: { phone: data.phone as string | null } });
      if (emergencyContact !== undefined) await writeEmergencyContact(tx, employee.id, emergencyContact);
    });

    const keys = [...changed, ...(emergencyContact !== undefined ? ['emergencyContact'] : [])];
    if (keys.length) {
      logAction(req.user!.id, 'UPDATE', 'EMPLOYEE', employee.id, { ...auditChanges(employee, fields, keys), self: true });
    }
    res.json({ data: await loadSelf(req) });
  } catch (err) {
    next(err);
  }
}
