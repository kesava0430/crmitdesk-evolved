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
      prisma.user.findMany({ where, select, orderBy: { name: 'asc' }, take: pag.limit, skip: pag.skip }),
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
    const { password, ...rest } = data;
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { ...rest, passwordHash, orgId: req.user!.orgId }, select });
    res.status(201).json(user);
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
    res.json(user);
  } catch (err) { next(err); }
}

export async function deactivate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (req.params.id === req.user!.id) throw new AppError(400, 'Cannot deactivate yourself');
    const target = await prisma.user.findFirst({ where: { id: req.params.id, orgId: req.user!.orgId } });
    if (!target) throw new AppError(404, 'User not found');
    await prisma.user.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ message: 'User deactivated' });
  } catch (err) { next(err); }
}
