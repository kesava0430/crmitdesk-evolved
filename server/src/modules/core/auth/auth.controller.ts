import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../../utils/prisma';
import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/errorHandler';
import { AuthRequest } from '../../../middleware/authenticate';
import { logAction } from '../../../utils/auditLog';
import { verifyTotpLogin } from '../../totp/totp.controller';
import { sendMail, emailTemplates } from '../../../utils/mailer';
import { assertSeatAvailable } from '../../../utils/licensing';

const RegisterSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  organizationName: z.string().min(2),
});

const ApproveOrgSignupSchema = z.object({
  token: z.string(),
  action: z.enum(['approve', 'reject']).default('approve'),
});

// Every new-org signup is emailed here for review before anything is created —
// see register()/approveOrgSignup() below. Override via env if the platform
// owner's inbox changes; defaults to the account this app was built for.
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'kesava.harinath30@gmail.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  // 6-digit TOTP code, or an 8-char backup code — only required when the
  // account has 2FA enabled (see login() below).
  totpToken: z.string().optional(),
});

const AcceptInviteSchema = z.object({
  token: z.string(),
  name: z.string().min(2),
  password: z.string().min(8),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function uniqueSlug(base: string) {
  let slug = base;
  let i = 1;
  while (await prisma.organization.findUnique({ where: { slug } })) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user: { id: string; role: string; email: string; orgId: string }) {
  return jwt.sign(user, process.env.JWT_SECRET!, {
    expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as jwt.SignOptions['expiresIn'],
  });
}

function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

async function storeRefreshToken(userId: string, rawToken: string) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(rawToken), expiresAt },
  });
}

/** Build the full user response payload */
function userPayload(user: any, org: any) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    orgId: user.orgId || org?.id || '',
    avatarUrl: user.avatarUrl ?? null,
    org: org ? { id: org.id, name: org.name, slug: org.slug } : null,
  };
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /auth/register — no org/user is created here. The submission is held
 * as a pending OrgSignupRequest and emailed to ADMIN_NOTIFY_EMAIL for review;
 * the org + first SUPER_ADMIN user are only created once that request is
 * approved via approveOrgSignup() below (email link -> /approve-org page).
 */
export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const data = RegisterSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new AppError(409, 'Email already registered');

    const passwordHash = await bcrypt.hash(data.password, 12);
    const token = crypto.randomBytes(32).toString('hex');

    // Re-submitting while still pending (e.g. the admin hasn't gotten to the
    // first email, or the requester mistyped something) refreshes the same
    // request in place — new token, latest details, one more email — rather
    // than piling up duplicate requests or hard-rejecting a good-faith retry.
    const existingRequest = await prisma.orgSignupRequest.findFirst({
      where: { email: data.email, status: 'PENDING' },
    });
    if (existingRequest) {
      await prisma.orgSignupRequest.update({
        where: { id: existingRequest.id },
        data: { organizationName: data.organizationName, name: data.name, passwordHash, token },
      });
    } else {
      await prisma.orgSignupRequest.create({
        data: {
          organizationName: data.organizationName,
          name: data.name,
          email: data.email,
          passwordHash,
          token,
        },
      });
    }

    // Fire-and-forget — the request is already durably saved above; the
    // client shouldn't hang waiting on SMTP (same pattern as ticket/deal
    // notification emails elsewhere in this codebase).
    const approveLink = `${FRONTEND_URL}/approve-org?token=${token}`;
    sendMail(emailTemplates.orgSignupRequest(ADMIN_NOTIFY_EMAIL, {
      organizationName: data.organizationName, name: data.name, email: data.email,
    }, approveLink)).catch(() => {});

    res.status(202).json({
      pending: true,
      message: "Your request has been submitted for approval. You'll get an email once it's approved.",
    });
  } catch (err) { next(err); }
}

/** GET /auth/org-signup-info?token=... — validate token before the approval page renders */
export async function orgSignupInfo(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.query.token as string;
    if (!token) throw new AppError(400, 'Token required');
    const request = await prisma.orgSignupRequest.findUnique({ where: { token } });
    if (!request) throw new AppError(404, 'Signup request not found');
    res.json({
      organizationName: request.organizationName,
      name: request.name,
      email: request.email,
      status: request.status,
      createdAt: request.createdAt,
    });
  } catch (err) { next(err); }
}

/**
 * POST /auth/approve-org-signup — the only place that actually creates the
 * org + SUPER_ADMIN user for a signup request. Secured by the random token
 * (mirrors accept-invite/portal-verify), not a login, since the person
 * clicking it is reviewing an email, not authenticated in the app.
 */
export async function approveOrgSignup(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, action } = ApproveOrgSignupSchema.parse(req.body);

    const request = await prisma.orgSignupRequest.findUnique({ where: { token } });
    if (!request) throw new AppError(404, 'Signup request not found');
    if (request.status !== 'PENDING') throw new AppError(400, `Request already ${request.status.toLowerCase()}`);

    if (action === 'reject') {
      await prisma.orgSignupRequest.update({
        where: { id: request.id },
        data: { status: 'REJECTED', decidedAt: new Date() },
      });
      return res.json({ status: 'REJECTED' });
    }

    // Re-check — email could've been registered by another route since the request was submitted
    const existing = await prisma.user.findUnique({ where: { email: request.email } });
    if (existing) {
      await prisma.orgSignupRequest.update({
        where: { id: request.id },
        data: { status: 'REJECTED', decidedAt: new Date() },
      });
      throw new AppError(409, 'Email was already registered elsewhere — request auto-rejected');
    }

    const slug = await uniqueSlug(slugify(request.organizationName));
    const { user, org } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const org = await tx.organization.create({
        data: { name: request.organizationName, slug },
      });
      const user = await tx.user.create({
        data: { name: request.name, email: request.email, passwordHash: request.passwordHash, role: 'SUPER_ADMIN', orgId: org.id },
        select: { id: true, name: true, email: true, role: true, orgId: true, avatarUrl: true },
      });
      return { user, org };
    });

    await prisma.orgSignupRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED', decidedAt: new Date() },
    });

    sendMail(emailTemplates.orgSignupApproved(user.email, user.name, org.name, `${FRONTEND_URL}/login`)).catch(() => {});

    res.json({ status: 'APPROVED', org: { id: org.id, name: org.name, slug: org.slug } });
  } catch (err) { next(err); }
}

/** POST /auth/login */
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const data = LoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: data.email },
      include: { org: { select: { id: true, name: true, slug: true } } },
    });
    if (!user || !user.isActive) throw new AppError(401, 'Invalid credentials');
    const valid = await bcrypt.compare(data.password, user.passwordHash);
    if (!valid) throw new AppError(401, 'Invalid credentials');

    // 2FA gate — previously verifyTotpLogin() was implemented but never
    // invoked here, so enabling 2FA had no effect on the login flow at all.
    // If the account has TOTP enabled, require a valid code (or backup code)
    // before issuing any tokens. A password-only request from a 2FA-enabled
    // account gets a `requires2FA` flag back instead of a 401, so the client
    // can prompt for the code and resubmit — it isn't a failed login.
    const totpRecord = await prisma.tOTPSecret.findUnique({
      where: { userId: user.id },
      select: { enabled: true },
    });
    if (totpRecord?.enabled) {
      if (!data.totpToken) {
        return res.json({ requires2FA: true });
      }
      const totpValid = await verifyTotpLogin(user.id, data.totpToken);
      if (!totpValid) throw new AppError(401, 'Invalid or expired 2FA code');
    }

    const orgId = user.orgId ?? '';
    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh);

    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId });
    logAction(user.id, 'LOGIN', 'User', user.id, { email: user.email });
    res.json({ user: userPayload(user, user.org), access, refresh: rawRefresh });
  } catch (err) { next(err); }
}

/** POST /auth/accept-invite — invited user sets name + password */
export async function acceptInvite(req: Request, res: Response, next: NextFunction) {
  try {
    const data = AcceptInviteSchema.parse(req.body);

    const invite = await prisma.inviteToken.findUnique({
      where: { token: data.token },
      include: { org: { select: { id: true, name: true, slug: true } } },
    });
    if (!invite) throw new AppError(404, 'Invite not found');
    if (invite.usedAt) throw new AppError(400, 'Invite already used');
    if (invite.expiresAt < new Date()) throw new AppError(400, 'Invite expired');

    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    if (existing) throw new AppError(409, 'Email already registered');

    // Re-check the seat limit here too — seats can fill up in the gap between
    // an invite being sent and it being accepted (e.g. several invites sent
    // concurrently, or the org's plan got downgraded in the meantime).
    await assertSeatAvailable(invite.orgId, invite.role);

    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const u = await tx.user.create({
        data: { name: data.name, email: invite.email, passwordHash, role: invite.role, orgId: invite.orgId },
        select: { id: true, name: true, email: true, role: true, orgId: true, avatarUrl: true },
      });
      await tx.inviteToken.update({ where: { id: invite.id }, data: { usedAt: new Date() } });
      return u;
    });

    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh);

    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId: invite.orgId });
    res.status(201).json({ user: userPayload(user, invite.org), access, refresh: rawRefresh });
  } catch (err) { next(err); }
}

/** GET /auth/invite-info?token=... — validate invite before the accept page renders */
export async function inviteInfo(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.query.token as string;
    if (!token) throw new AppError(400, 'Token required');
    const invite = await prisma.inviteToken.findUnique({
      where: { token },
      include: { org: { select: { name: true } } },
    });
    if (!invite) throw new AppError(404, 'Invite not found');
    if (invite.usedAt) throw new AppError(400, 'Invite already used');
    if (invite.expiresAt < new Date()) throw new AppError(400, 'Invite expired');
    res.json({ email: invite.email, orgName: invite.org.name, role: invite.role });
  } catch (err) { next(err); }
}

/** POST /auth/refresh — validate stored token, issue new pair (rotation) */
export async function refreshToken(req: Request, res: Response, next: NextFunction) {
  try {
    const { refresh } = req.body;
    if (!refresh) throw new AppError(400, 'Refresh token required');

    const tokenHash = hashToken(refresh);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored) throw new AppError(401, 'Invalid refresh token');
    if (stored.expiresAt < new Date()) {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
      throw new AppError(401, 'Refresh token expired');
    }

    const user = await prisma.user.findUnique({
      where: { id: stored.userId },
      include: { org: { select: { id: true, name: true, slug: true } } },
    });
    if (!user || !user.isActive) throw new AppError(401, 'User not found or inactive');

    // Rotate: delete old token, issue new pair (deleteMany avoids P2025 on race conditions)
    await prisma.refreshToken.deleteMany({ where: { id: stored.id } });
    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh);

    const orgId = user.orgId ?? '';
    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId });
    res.json({ access, refresh: rawRefresh });
  } catch (err) { next(err); }
}

/** POST /auth/logout — revoke refresh token */
export async function logout(req: Request, res: Response) {
  const { refresh } = req.body;
  if (refresh) {
    const tokenHash = hashToken(refresh);
    await prisma.refreshToken.deleteMany({ where: { tokenHash } }).catch(() => {});
  }
  res.json({ message: 'Logged out' });
}

/** GET /auth/me */
export async function me(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true, name: true, email: true, role: true, orgId: true,
        department: true, avatarUrl: true, createdAt: true,
        org: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!user) throw new AppError(404, 'User not found');
    res.json(user);
  } catch (err) { next(err); }
}

const UpdateProfileSchema = z.object({
  name:       z.string().min(2).optional(),
  email:      z.string().email().optional(),
  department: z.string().optional(),
  avatarUrl:  z.string().url().optional().or(z.literal('')),
});

/** PUT /auth/me — update own profile */
export async function updateMe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = UpdateProfileSchema.parse(req.body);
    if (body.email) {
      const existing = await prisma.user.findFirst({
        where: { email: body.email, NOT: { id: req.user!.id } },
      });
      if (existing) throw new AppError(409, 'Email already in use');
    }
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: body,
      select: {
        id: true, name: true, email: true, role: true, orgId: true,
        department: true, avatarUrl: true, createdAt: true,
        org: { select: { id: true, name: true, slug: true } },
      },
    });
    logAction(req.user!.id, 'UPDATE', 'User', req.user!.id);
    res.json(updated);
  } catch (err) { next(err); }
}

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8),
});

/** PUT /auth/me/password — change own password */
export async function changePassword(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new AppError(400, 'Current password is incorrect');
    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user!.id }, data: { passwordHash: hash } });
    // Revoke all refresh tokens so other sessions are invalidated
    await prisma.refreshToken.deleteMany({ where: { userId: req.user!.id } });
    logAction(req.user!.id, 'UPDATE', 'User', req.user!.id, { action: 'password_change' });
    res.json({ message: 'Password changed successfully' });
  } catch (err) { next(err); }
}
