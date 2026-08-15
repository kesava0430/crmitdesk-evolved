import { Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { parsePagination, paginate } from '../../../utils/pagination';
import { sendMail } from '../../../utils/mailer';
import { AuthRequest } from '../../../middleware/authenticate';
import { AppError } from '../../../middleware/errorHandler';
import { assertSeatAvailable, isMeteredRole } from '../../../utils/licensing';
import { emailTemplates } from '../../../utils/mailer';
// Keeps User and Employee in step so an admin never adds the same person
// twice — see utils/employeeProvisioning.ts for why the split is invisible
// in day-to-day use.
import { ensureEmployeeForUser, syncUserToEmployee, reconcileOrphans, linkUserToEmployee } from '../../../utils/employeeProvisioning';

// phone is preprocessed so an empty string (the form's untouched default)
// doesn't get stored as '' — the WhatsApp "assignee" recipient resolver
// treats a falsy phone as "not set", which '' would defeat.
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const CreateSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['SUPER_ADMIN','CRM_MANAGER','SALES_REP','IT_MANAGER','IT_AGENT','EMPLOYEE']),
  department: z.string().optional(),
  phone: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Set false for service/integration accounts that are not real people. */
  createEmployee: z.boolean().optional(),
});

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['SUPER_ADMIN','CRM_MANAGER','SALES_REP','IT_MANAGER','IT_AGENT','EMPLOYEE']).default('EMPLOYEE'),
});

const UpdateSchema = z.object({
  name: z.string().min(2).optional(),
  role: z.enum(['SUPER_ADMIN','CRM_MANAGER','SALES_REP','IT_MANAGER','IT_AGENT','EMPLOYEE']).optional(),
  department: z.string().optional(),
  phone: z.preprocess(emptyToUndefined, z.string().optional()),
  isActive: z.boolean().optional(),
});

const select = { id: true, name: true, email: true, role: true, department: true, phone: true, isActive: true, createdAt: true, avatarUrl: true, orgId: true };

// Included on the list so the admin UI can flag a user with no employee record
// — the one state where the User/Employee split leaks into the interface.
const selectWithEmployee = {
  ...select,
  employee: { select: { id: true, employeeCode: true, designation: true } },
  roleRef: { select: { id: true, key: true, name: true } },
};

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { search } = req.query as Record<string, string>;
    const pag = parsePagination(req);
    const where: any = { orgId: req.user!.orgId };
    if (search) where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, select: selectWithEmployee, orderBy: { name: 'asc' }, take: pag.limit, skip: pag.skip }),
      prisma.user.count({ where }),
    ]);
    res.json(paginate(users, total, pag));
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = CreateSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new AppError(409, 'Email already registered');
    await assertSeatAvailable(req.user!.orgId, data.role);
    // Destructure password out so it is not spread into the Prisma create call
    // (the User model has `passwordHash`, not `password`)
    const { password, createEmployee, ...rest } = data;
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { ...rest, passwordHash, orgId: req.user!.orgId }, select });

    // Adding someone in Administration → Users also makes them an employee, so
    // HR isn't a second data-entry step. Non-throwing: a failure here leaves a
    // user with no employee record, which the Users list flags and
    // POST /admin/users/reconcile-employees can repair.
    const employeeId = await ensureEmployeeForUser(user.id, { skip: createEmployee === false });

    res.status(201).json({ ...user, employeeId });
  } catch (err) { next(err); }
}

/** Send an invite link — user sets their own password */
export async function invite(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { email, role } = InviteSchema.parse(req.body);
    await assertSeatAvailable(req.user!.orgId, role);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const org = await prisma.organization.findUnique({ where: { id: req.user!.orgId }, select: { name: true } });
    const invite = await prisma.inviteToken.create({
      data: { orgId: req.user!.orgId, email, role, token, expiresAt },
    });

    const link = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/accept-invite?token=${token}`;

    // Send invite email (silently skipped if SMTP is not configured)
    await sendMail({
      orgId: req.user!.orgId,
      to: email,
      subject: `You've been invited to join ${org?.name || 'CRM & IT Desk'}`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#4f46e5">You're invited!</h2>
          <p>You've been invited to join <strong>${org?.name || 'CRM & IT Desk'}</strong> as a <strong>${role.replace(/_/g,' ')}</strong>.</p>
          <p>Click the button below to set up your account. This link expires in 7 days.</p>
          <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">Accept Invitation</a>
          <p style="color:#6b7280;font-size:13px">Or copy this link: ${link}</p>
        </div>
      `,
    }).catch(() => {}); // Don't fail the request if email sending fails

    res.status(201).json({ invite, link });
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = UpdateSchema.parse(req.body);
    // Ensure target user is in same org
    const target = await prisma.user.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!target) throw new AppError(404, 'User not found');
    // Only re-check the seat limit if this update actually turns someone INTO
    // a billable role (anything but EMPLOYEE) who wasn't one already. A
    // lateral move between two billable roles (e.g. SALES_REP -> CRM_MANAGER)
    // doesn't change the billable headcount, so it must NOT be re-checked
    // here — the target's own existing seat would otherwise cause a false
    // "at limit" block.
    if (data.role && data.role !== target.role && !isMeteredRole(target.role)) {
      await assertSeatAvailable(req.user!.orgId, data.role);
    }
    const user = await prisma.user.update({ where: { id: req.params.id }, data, select });

    // Mirror the fields that exist on both records. If this user has no
    // employee (a service account, or one created before HR was set up), the
    // sync is a no-op rather than an error.
    await syncUserToEmployee(user.id, {
      name: data.name,
      phone: data.phone as string | undefined,
      department: data.department,
      isActive: data.isActive,
    });

    res.json(user);
  } catch (err) { next(err); }
}

export async function deactivate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (req.params.id === req.user!.id) throw new AppError(400, 'Cannot deactivate yourself');
    const target = await prisma.user.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!target) throw new AppError(404, 'User not found');
    await prisma.user.update({ where: { id: req.params.id }, data: { isActive: false } });
    // Losing the login means the person has left. Reactivating deliberately
    // does not un-exit them — rehiring has its own dates and is an HR decision.
    await syncUserToEmployee(req.params.id, { isActive: false });
    res.json({ message: 'User deactivated' });
  } catch (err) { next(err); }
}

/**
 * POST /admin/users/:id/reset-password — a manager-triggered escape hatch for
 * a locked-out coworker (there's no other recovery path for a staff account
 * besides the self-service /auth/forgot-password email, which requires the
 * user to still have access to their own inbox). Sends the same reset-link
 * email as the self-service flow rather than setting a password directly, so
 * the manager never sees or chooses the new password.
 */
export async function resetUserPassword(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const target = await prisma.user.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!target) throw new AppError(404, 'User not found');
    if (!target.isActive) throw new AppError(400, 'Cannot reset the password of a deactivated user');

    await prisma.passwordResetToken.updateMany({
      where: { userId: target.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        userId: target.id,
        tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${rawToken}`;
    await sendMail({ ...emailTemplates.passwordReset(target.email, target.name, resetLink), orgId: req.user!.orgId }).catch(() => {});

    res.json({ message: `Password reset link sent to ${target.email}` });
  } catch (err) { next(err); }
}

/**
 * Reports users who have no employee record, and optionally creates them.
 *
 * Needed because employee provisioning is deliberately non-throwing (a failure
 * there must never break a login), and because a database that upgraded without
 * running the backfill would otherwise leave HR permanently blind to some
 * staff. `POST /admin/users/reconcile-employees?fix=true` repairs them.
 *
 * Employees without a login are reported but never "repaired" — staff who don't
 * sign in are a legitimate state, and the reason the two models are separate.
 */
export async function reconcileEmployees(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const fix = req.query.fix === 'true';
    const report = await reconcileOrphans(req.user!.orgId, fix);
    res.json({
      ...report,
      message: fix
        ? `Created ${report.created} employee record(s).`
        : `${report.usersWithoutEmployee} user(s) have no employee record. Re-run with ?fix=true to create them.`,
    });
  } catch (err) { next(err); }
}

/** Links an existing login to an existing employee, for records created separately. */
export async function linkEmployee(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { employeeId } = z.object({ employeeId: z.string().min(1) }).parse(req.body);
    await linkUserToEmployee(req.user!.orgId, employeeId, req.params.id);
    res.json({ message: 'Login linked to the employee record' });
  } catch (err: any) {
    if (err?.message && !err.status) return next(new AppError(400, err.message));
    next(err);
  }
}
