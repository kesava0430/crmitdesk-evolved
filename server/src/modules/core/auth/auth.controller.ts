import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { optionalField, optionalText, emailField } from '../../../utils/zodHelpers';
import { prisma } from '../../../utils/prisma';
import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/errorHandler';
import { AuthRequest } from '../../../middleware/authenticate';
import { logAction } from '../../../utils/auditLog';
import { verifyTotpLogin } from '../../totp/totp.controller';
import { sendMail, emailTemplates } from '../../../utils/mailer';
// New logins become employees automatically — see utils/employeeProvisioning.ts.
import { ensureEmployeeForUser } from '../../../utils/employeeProvisioning';
import { assertSeatAvailable } from '../../../utils/licensing';
import { DEMO_LOGIN_EMAIL, DEMO_VERTICAL_SLUGS, DEFAULT_VERTICAL, loginEmailFor } from '../../../utils/seedDemoData';
import { verifyGoogleIdToken, isGoogleSsoConfigured } from '../../../utils/googleAuth';
import { decryptSecret } from '../../../utils/crypto';
import { buildEntraAuthUrl, exchangeEntraCode, fetchEntraProfile, fetchEntraGroups } from '../../../utils/entraAuth';
import { resolveRoleForGroups } from '../../directory/roleMapping';
import {
  ClientType, clientTypeFromHeader, decideRefresh, isValidProposedToken, refreshExpiry, rotatedRetentionMs,
  DEFAULT_GRACE_MS, DEFAULT_MAX_GRACE_USES,
} from './refreshPolicy';

const RegisterSchema = z.object({
  name: z.string().min(2),
  email: emailField(),
  password: z.string().min(8),
  organizationName: z.string().min(2),
});

const ApproveOrgSignupSchema = z.object({
  token: z.string(),
  action: z.enum(['approve', 'reject']).default('approve'),
});

// Every new-org signup is emailed here for review before anything is created —
// see register()/approveOrgSignup() below. Comes ONLY from the environment:
// a personal inbox hardcoded as a fallback meant every white-label deployment
// silently routed its customers' signup requests to the original developer.
// When unset, the request is still saved durably (an admin can approve it
// from the platform console); only the courtesy email is skipped.
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const LoginSchema = z.object({
  email: emailField(),
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

const ForgotPasswordSchema = z.object({
  email: emailField(),
});

const ResetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8),
});

const GoogleLoginSchema = z.object({
  // The ID token returned by Google's Sign-In JS SDK on the client — verified
  // server-side against Google's public keys before we trust the email/sub
  // claims inside it. See utils/googleAuth.ts.
  idToken: z.string(),
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

/** Which kind of client is asking — the Android app sends `X-Client: native-android` (api/client.ts). */
function reqClientType(req: Request): ClientType {
  return clientTypeFromHeader(req.headers['x-client']);
}

// Lifetime is per client type (web 7d / native 90d by default — see
// refreshPolicy.ts refreshTtlDays) instead of a hardcoded 7 days, and it is
// sliding: every rotation issues a fresh full window.
async function storeRefreshToken(userId: string, rawToken: string, clientType: ClientType = 'web') {
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(rawToken), expiresAt: refreshExpiry(clientType), clientType },
  });
}

const REFRESH_GRACE_MS = (() => {
  const n = Number(process.env.REFRESH_GRACE_SECONDS);
  return Number.isFinite(n) && n >= 0 && n <= 600 ? n * 1000 : DEFAULT_GRACE_MS;
})();

/**
 * Deletes the given refresh tokens AND every successor they were rotated
 * into. Logging out with a token that was rotated a moment ago (another tab
 * refreshed it, or the refresh response was still in flight) must not leave
 * the newer token alive.
 */
async function revokeTokenChain(tokenHashes: string[]) {
  let frontier = tokenHashes.filter(Boolean);
  for (let hop = 0; hop < 20 && frontier.length; hop++) {
    const rows = await prisma.refreshToken.findMany({
      where: { tokenHash: { in: frontier } },
      select: { id: true, replacedByHash: true },
    });
    if (!rows.length) break;
    await prisma.refreshToken.deleteMany({ where: { id: { in: rows.map(r => r.id) } } });
    frontier = rows.map(r => r.replacedByHash).filter((h): h is string => !!h);
  }
}

/**
 * Hourly housekeeping (scheduled from index.ts): drop expired tokens, and
 * rotated tokens once their replay window has passed — a rotated row is only
 * kept so a client that missed the rotation response can recover.
 */
export async function purgeRefreshTokens(): Promise<number> {
  const now = Date.now();
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now) } },
        { rotatedAt: { lt: new Date(now - rotatedRetentionMs()) } },
      ],
    },
  });
  return count;
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
    if (ADMIN_NOTIFY_EMAIL) {
      sendMail(emailTemplates.orgSignupRequest(ADMIN_NOTIFY_EMAIL, {
        organizationName: data.organizationName, name: data.name, email: data.email,
      }, approveLink)).catch(() => {});
    } else {
      console.warn('[auth] ADMIN_NOTIFY_EMAIL is not set — org signup request saved but no notification email sent');
    }

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

    // The founder is staff too — without this their own org has an employee
    // list that doesn't contain them.
    await ensureEmployeeForUser(user.id);

    // orgId included for consistency, though a just-created org will always
    // fall through to the platform mailer here (no EmailAccount yet).
    sendMail({ ...emailTemplates.orgSignupApproved(user.email, user.name, org.name, `${FRONTEND_URL}/login`), orgId: org.id }).catch(() => {});

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
    await storeRefreshToken(user.id, rawRefresh, reqClientType(req));

    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId });
    logAction(user.id, 'LOGIN', 'User', user.id, { email: user.email });
    res.json({ user: userPayload(user, user.org), access, refresh: rawRefresh });
  } catch (err) { next(err); }
}

/**
 * POST /auth/demo-login — public, no credentials required. Logs in as the
 * fixed showcase account (see utils/seedDemoData.ts) so a "Try Demo" button
 * on the public demo landing page can drop a visitor straight into a
 * populated workspace. Deliberately narrow: this only ever authenticates
 * that one hardcoded account — it cannot be used to log into anything else,
 * and skips the password/2FA checks entirely since there's no credential
 * being supplied by the caller in the first place.
 */
export async function demoLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const requested = String(req.query.vertical || '');
    const vertical = DEMO_VERTICAL_SLUGS.includes(requested) ? requested : DEFAULT_VERTICAL;
    const loginEmail = vertical === DEFAULT_VERTICAL ? DEMO_LOGIN_EMAIL : loginEmailFor(vertical);
    const user = await prisma.user.findUnique({
      where: { email: loginEmail },
      include: { org: { select: { id: true, name: true, slug: true } } },
    });
    if (!user || !user.isActive) {
      // "Try again shortly" is only honest if waiting could actually help. A
      // missing demo user means the seed has not run — waiting changes nothing,
      // so say what does. GET /demo/status reports which verticals exist.
      throw new AppError(
        503,
        `The "${vertical}" demo has not been set up on this server yet. Run \`npm run db:seed\` in the server directory to create it.`
      );
    }

    const orgId = user.orgId ?? '';
    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh, reqClientType(req));

    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId });
    logAction(user.id, 'LOGIN', 'User', user.id, { email: user.email, demo: true });
    res.json({ user: userPayload(user, user.org), access, refresh: rawRefresh });
  } catch (err) { next(err); }
}

/**
 * Turn a unique-constraint collision into the 409 the caller deserves.
 *
 * Acceptance checks for an existing account before it starts, but that read
 * and the insert are not one operation: two invites to the same address,
 * accepted at the same moment, both pass the check and one loses on
 * User.email. The same applies to Employee.userId when two requests try to
 * claim one person. Both mean "somebody got there first", which is a 409 —
 * without this they reach the client as an unexplained 500.
 */
async function withUniqueGuard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    if (err?.code === 'P2002') throw new AppError(409, 'That email address already has an account');
    throw err;
  }
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
    const user = await withUniqueGuard(() => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      /* Claim the invite before doing anything else. The check above is a
         plain read, so two submissions of the same link — a double-click,
         or a retry — both passed it and raced on to create accounts. This
         is a compare-and-set: whoever matches the row owns the acceptance,
         and the loser sees "already used" instead of a 500 from the email
         unique constraint further down. */
      const claimed = await tx.inviteToken.updateMany({
        where: { id: invite.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) throw new AppError(400, 'Invite already used');

      const u = await tx.user.create({
        data: {
          name: data.name,
          email: invite.email,
          passwordHash,
          role: invite.role,
          // Carries a custom role through the invite. Without this the new
          // user would land on `invite.role`'s enum value only — so someone
          // invited as "Regional Sales Head" would silently become whatever
          // base access level that role maps to, and lose every permission
          // the custom role actually grants.
          roleId: invite.roleId ?? undefined,
          orgId: invite.orgId,
        },
        select: { id: true, name: true, email: true, role: true, orgId: true, avatarUrl: true },
      });

      /* Attach the login to the person HR already created.

         Without this, ensureEmployeeForUser below looks the employee up by
         user_id, finds nothing (the invited record has none yet) and makes
         a second one — two directory rows for one human, from one invite.

         The record is identified from the invite row, never from anything
         the client sent. employeeId is set when HR raised the invite from
         People; the email fallback covers invites issued before that
         column existed, and is scoped to this org and to records with no
         login yet, so an unrelated person's account can never be adopted. */
      const invited = invite.employeeId
        ? await tx.employee.findFirst({
            where: { id: invite.employeeId, orgId: invite.orgId, userId: null },
            select: { id: true },
          })
        : await tx.employee.findFirst({
            where: {
              orgId: invite.orgId,
              userId: null,
              workEmail: { equals: invite.email, mode: 'insensitive' },
            },
            // Oldest first: if HR somehow created two, the original invite
            // belongs to the one that existed when it was sent.
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });

      /* Employee.userId is unique, so this is also the point where a
         concurrent link would fail rather than silently double-attach.
         HR's own fields (designation, manager, joining date, name) are
         left exactly as entered — this only supplies the missing login. */
      if (invited) await tx.employee.update({ where: { id: invited.id }, data: { userId: u.id } });

      return u;
    }));

    // Falls through to provisioning only when the invite had no person
    // behind it — Admin → Users invites, which have never had one.
    await ensureEmployeeForUser(user.id);

    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh, reqClientType(req));

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

/**
 * POST /auth/refresh — exchange a refresh token for a new pair (rotation).
 *
 * Body: { refresh, next? }. `next` is the successor the client generated and
 * already persisted before sending (see api/client.ts performRefresh); a
 * retry with the same pair is answered idempotently even if the first
 * response was lost. Older clients omit it and get a server-generated
 * successor plus the short grace window. Decision rules: refreshPolicy.ts.
 *
 * Every failure that means "this session is over" is a 401 with one of the
 * messages the client treats as final; anything else (5xx) leaves the
 * client signed in to try again.
 */
export async function refreshToken(req: Request, res: Response, next: NextFunction) {
  try {
    const { refresh, next: proposed } = req.body ?? {};
    if (!refresh || typeof refresh !== 'string') throw new AppError(400, 'Refresh token required');

    const headerType = reqClientType(req);
    const nextRaw = isValidProposedToken(proposed) ? proposed : null;
    const tokenHash = hashToken(refresh);
    const nextHash = nextRaw ? hashToken(nextRaw) : null;

    const run = () => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Two passes at most: a concurrent request for the same token can win
      // the compare-and-set below, in which case we re-read its result and
      // decide again (usually a 'replay' of the same proposal).
      for (let pass = 0; pass < 2; pass++) {
        const now = new Date();
        const stored = await tx.refreshToken.findUnique({ where: { tokenHash } });
        const successor = stored?.rotatedAt && nextHash && stored.replacedByHash === nextHash
          ? await tx.refreshToken.findUnique({ where: { tokenHash: nextHash }, select: { expiresAt: true, rotatedAt: true } })
          : null;

        const decision = decideRefresh(stored, {
          now, nextHash, successor, graceMs: REFRESH_GRACE_MS, maxGraceUses: DEFAULT_MAX_GRACE_USES,
        });
        if (decision.action === 'reject') {
          if (decision.deleteRow && stored) await tx.refreshToken.deleteMany({ where: { id: stored.id } });
          if (stored && decision.reason === 'Invalid refresh token') {
            // Presented long after rotation: either a client bug or a copied
            // token. Logged (not acted on) so it can be investigated.
            console.warn(`[auth] rotated refresh token reused outside the grace window (user ${stored.userId})`);
          }
          return { error: decision.reason } as const;
        }
        const s = stored!;

        const user = await tx.user.findUnique({
          where: { id: s.userId },
          select: { id: true, role: true, email: true, orgId: true, isActive: true },
        });
        if (!user || !user.isActive) return { error: 'User not found or inactive' } as const;

        if (decision.action === 'replay') return { user, refresh: nextRaw! } as const;

        // The app upgrading an existing web-typed row (sessions created by
        // builds that didn't send X-Client) gets the native lifetime from now on.
        const clientType: ClientType = headerType === 'native' ? 'native' : (s.clientType === 'native' ? 'native' : 'web');

        // Use the client's proposal unless it is somehow already taken (e.g.
        // a stale tab re-sending a proposal that was redeemed before).
        const proposalTaken = nextHash
          ? !!(await tx.refreshToken.findUnique({ where: { tokenHash: nextHash }, select: { id: true } }))
          : true;
        const raw = nextRaw && !proposalTaken ? nextRaw : generateRefreshToken();

        const claimed = decision.action === 'rotate'
          ? await tx.refreshToken.updateMany({
              where: { id: s.id, rotatedAt: null },
              data: { rotatedAt: now, replacedByHash: hashToken(raw) },
            })
          : await tx.refreshToken.updateMany({
              where: { id: s.id, graceUses: { lt: DEFAULT_MAX_GRACE_USES } },
              data: { graceUses: { increment: 1 } },
            });
        if (claimed.count === 0) continue; // lost the race — decide again on fresh state

        await tx.refreshToken.create({
          data: { userId: user.id, tokenHash: hashToken(raw), expiresAt: refreshExpiry(clientType, now), clientType },
        });
        return { user, refresh: raw } as const;
      }
      return { error: 'Invalid refresh token' } as const;
    });

    let result;
    try {
      result = await run();
    } catch (err: any) {
      // Unique collision on the new token hash from two simultaneous
      // requests carrying the same proposal — the second attempt sees the
      // first one's committed state and replays it.
      if (err?.code !== 'P2002') throw err;
      result = await run();
    }

    if ('error' in result) throw new AppError(401, result.error as string);
    const { user } = result;
    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId: user.orgId ?? '' });
    res.json({ access, refresh: result.refresh });
  } catch (err) { next(err); }
}

/**
 * POST /auth/logout — revoke the caller's refresh token (and anything it was
 * rotated into). `pending` is the client's not-yet-confirmed proposed
 * successor, revoked too in case that rotation did land server-side.
 */
export async function logout(req: Request, res: Response) {
  const { refresh, pending } = req.body ?? {};
  const hashes = [refresh, pending].filter((t): t is string => typeof t === 'string' && t.length > 0).map(hashToken);
  if (hashes.length) await revokeTokenChain(hashes).catch(() => {});
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

// Same round-trip hazard as the admin Update schema above: department and
// avatarUrl are both String? on User, so a profile that has never set them
// sends null back on save.
const UpdateProfileSchema = z.object({
  name:       z.string().min(2).optional(),
  email:      emailField().optional(),
  department: optionalText(),
  avatarUrl:  optionalField(z.string().url()),
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
    // Revoke every refresh token so OTHER sessions are signed out, then
    // issue a fresh pair for this device. Previously this device was revoked
    // too, without a replacement, so the person who just changed their
    // password was thrown to the login screen at the next token refresh
    // while the UI told them only "other sessions" had been signed out.
    await prisma.refreshToken.deleteMany({ where: { userId: req.user!.id } });
    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh, reqClientType(req));
    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId: user.orgId ?? '' });
    logAction(req.user!.id, 'UPDATE', 'User', req.user!.id, { action: 'password_change' });
    sendMail({ ...emailTemplates.passwordChanged(user.email, user.name), orgId: user.orgId ?? undefined }).catch(() => {});
    res.json({ message: 'Password changed successfully', access, refresh: rawRefresh });
  } catch (err) { next(err); }
}

// ─── Forgot / Reset Password ────────────────────────────────────────────────

/**
 * POST /auth/forgot-password — public. Always returns the same generic
 * success message whether or not the email exists (same email-enumeration
 * protection as the customer portal's request-access flow), and only
 * proceeds to actually send an email for an active, password-based account
 * (a Google-only account with no usable password still gets the generic
 * response, since telling the caller "use Google instead" would leak which
 * emails are registered).
 */
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = ForgotPasswordSchema.parse(req.body);
    const GENERIC = { message: "If that email is registered, we've sent a password reset link." };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return res.json(GENERIC);

    // Invalidate any earlier outstanding reset requests for this user before
    // issuing a new one, so only the most recently requested link works.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
      },
    });

    const resetLink = `${FRONTEND_URL}/reset-password?token=${rawToken}`;
    sendMail({ ...emailTemplates.passwordReset(user.email, user.name, resetLink), orgId: user.orgId ?? undefined }).catch(() => {});

    res.json(GENERIC);
  } catch (err) { next(err); }
}

/** POST /auth/reset-password — consumes a forgot-password token, sets a new password */
export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, password } = ResetPasswordSchema.parse(req.body);
    const tokenHash = hashToken(token);
    const stored = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.usedAt) throw new AppError(400, 'Reset link is invalid or has already been used');
    if (stored.expiresAt < new Date()) throw new AppError(400, 'Reset link has expired — request a new one');

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      // Revoke every existing session — a password reset is a strong signal
      // the old credential shouldn't keep working anywhere.
      prisma.refreshToken.deleteMany({ where: { userId: stored.userId } }),
    ]);

    logAction(stored.userId, 'UPDATE', 'User', stored.userId, { action: 'password_reset' });
    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (user) sendMail({ ...emailTemplates.passwordChanged(user.email, user.name), orgId: user.orgId ?? undefined }).catch(() => {});

    res.json({ message: 'Password reset — you can log in with your new password now.' });
  } catch (err) { next(err); }
}

// ─── Google SSO ──────────────────────────────────────────────────────────────

/**
 * POST /auth/google — logs in a staff user who has already linked a Google
 * account from their Profile page (see linkGoogleAccount below). Deliberately
 * does NOT create new users or organizations — SSO is an alternate login
 * method for an existing account, not a second signup path, so it can't be
 * used to route around the admin-approval-gated org creation flow.
 */
export async function googleLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { idToken } = GoogleLoginSchema.parse(req.body);
    const claims = await verifyGoogleIdToken(idToken).catch((e: Error) => { throw new AppError(401, e.message); });

    const user = await prisma.user.findUnique({
      where: { googleId: claims.sub },
      include: { org: { select: { id: true, name: true, slug: true } } },
    });
    if (!user || !user.isActive) {
      throw new AppError(404, 'No account is linked to this Google account yet. Log in with your password and link Google from your Profile page first.');
    }

    const orgId = user.orgId ?? '';
    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh, reqClientType(req));

    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId });
    logAction(user.id, 'LOGIN', 'User', user.id, { email: user.email, method: 'google' });
    res.json({ user: userPayload(user, user.org), access, refresh: rawRefresh });
  } catch (err) { next(err); }
}

/** GET /auth/google/status — whether Google SSO is configured + whether the caller has linked it */
export async function googleStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { googleId: true } });
    res.json({ configured: isGoogleSsoConfigured(), linked: !!user?.googleId, clientId: process.env.GOOGLE_CLIENT_ID || null });
  } catch (err) { next(err); }
}

/** POST /auth/google/link — authenticated user links their Google account for future SSO login */
export async function linkGoogleAccount(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { idToken } = GoogleLoginSchema.parse(req.body);
    const claims = await verifyGoogleIdToken(idToken).catch((e: Error) => { throw new AppError(401, e.message); });

    const existing = await prisma.user.findUnique({ where: { googleId: claims.sub } });
    if (existing && existing.id !== req.user!.id) {
      throw new AppError(409, 'This Google account is already linked to a different user');
    }
    if (claims.email.toLowerCase() !== req.user!.email.toLowerCase()) {
      throw new AppError(400, `This Google account's email (${claims.email}) doesn't match your account email (${req.user!.email})`);
    }

    await prisma.user.update({ where: { id: req.user!.id }, data: { googleId: claims.sub } });
    logAction(req.user!.id, 'UPDATE', 'User', req.user!.id, { action: 'google_linked' });
    res.json({ linked: true });
  } catch (err) { next(err); }
}

/** DELETE /auth/google/link — unlink Google, falling back to password-only login */
export async function unlinkGoogleAccount(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.user.update({ where: { id: req.user!.id }, data: { googleId: null } });
    logAction(req.user!.id, 'UPDATE', 'User', req.user!.id, { action: 'google_unlinked' });
    res.json({ linked: false });
  } catch (err) { next(err); }
}

// ─── Microsoft Entra ID SSO ──────────────────────────────────────────────────
//
// Phase 1: SSO login only, for an existing (already invited/created) user —
// same "alternate login method for an existing account" boundary as Google
// above, not a second signup path. Org resolution happens via a per-org
// login URL (DirectoryConfig.loginSlug, e.g. /login/acme) rather than a
// shared login page, since — unlike Google — each org configures its own
// Entra tenant, so we have to know which org before redirecting to Microsoft.
//
// The OAuth round trip carries state the same way modules/calendar's Google
// Calendar connection flow does: a short-lived JWT signed with JWT_SECRET
// (see calendar.controller.ts getOAuthUrl/oauthCallback), not a DB row or
// cookie — Microsoft's redirect back to /callback has no session of its own,
// so this is how we know which org's config to use when it lands.

// ── Native app (Android) variant ────────────────────────────────────────────
// Inside the app, Microsoft's page opens in a Custom Tab (the system browser)
// — Microsoft, like Google, refuses to sign in inside an embedded WebView,
// and the WebView's own storage is not the browser's anyway. The round trip
// then has to land back IN the app, via the com.zenkara.app:// deep link
// (AndroidManifest intent-filter). Any app can claim a custom scheme, so
// tokens never travel in that link: it carries a 2-minute one-time code,
// redeemable only together with the PKCE-style verifier that never left the
// app (`app_challenge` = base64url(sha256(verifier))) at POST /auth/sso/exchange.
const APP_SSO_REDIRECT_URL = process.env.APP_SSO_REDIRECT_URL || 'com.zenkara.app://sso-callback';
const APP_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
// Entra `state` values and app exchange codes are signed with a key DERIVED
// from JWT_SECRET, never JWT_SECRET itself: both appear in public redirect
// URLs, and anything signed with JWT_SECRET would also verify as a staff
// access token in middleware/authenticate.ts.
// Computed per call, not at import time, so it can never be derived from a
// JWT_SECRET that wasn't loaded yet.
const ssoSigningKey = () => crypto.createHash('sha256').update(`${process.env.JWT_SECRET!}:entra-sso`).digest('hex');
// One-time use for exchange codes. In-memory is enough: codes live 2 minutes
// and are also bound to the verifier, so this only stops a replay by the
// same holder within that window on this process.
const redeemedSsoCodes = new Map<string, number>();

function base64UrlSha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** GET /auth/entra/:slug/login — public; redirects to the org's Microsoft sign-in */
export async function entraLoginRedirect(req: Request, res: Response) {
  const appChallenge = typeof req.query.app_challenge === 'string' && APP_CHALLENGE_RE.test(req.query.app_challenge)
    ? req.query.app_challenge : undefined;
  // Errors before Microsoft go back to where the user came from: the app's
  // deep link for the native flow, the web login page otherwise.
  const failTo = (code: string) => res.redirect(appChallenge
    ? `${APP_SSO_REDIRECT_URL}#error=${encodeURIComponent(code)}`
    : `${FRONTEND_URL}/login?error=${code}`);
  try {
    const config = await prisma.directoryConfig.findUnique({ where: { loginSlug: req.params.slug } });
    if (!config) return failTo('sso_not_found');
    if (!config.isEnabled) return failTo('sso_disabled');

    const state = jwt.sign(appChallenge ? { orgId: config.orgId, ac: appChallenge } : { orgId: config.orgId }, ssoSigningKey(), { expiresIn: '10m' });
    res.redirect(buildEntraAuthUrl({ tenantId: config.tenantId, clientId: config.clientId, state }));
  } catch (err) {
    console.error('[entra] login redirect failed:', err);
    failTo('sso_error');
  }
}

/** GET /auth/entra/callback — public; Microsoft redirects the browser here after sign-in */
export async function entraCallback(req: Request, res: Response) {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  // Decide where to send the browser before anything can fail. An unverified
  // decode is fine for that: the worst a forged state can do is route an
  // error message to the app instead of the web page.
  const decoded = state ? (jwt.decode(state) as { ac?: string } | null) : null;
  const toApp = !!(decoded?.ac && APP_CHALLENGE_RE.test(decoded.ac));
  const fail = (reason: string) => res.redirect(`${toApp ? APP_SSO_REDIRECT_URL : `${FRONTEND_URL}/sso-callback`}#error=${encodeURIComponent(reason)}`);
  try {
    if (error) return fail(error_description || error);
    if (!code || !state) return fail('Missing sign-in response from Microsoft.');

    let orgId: string;
    let appChallenge: string | undefined;
    try {
      ({ orgId, ac: appChallenge } = jwt.verify(state, ssoSigningKey()) as { orgId: string; ac?: string });
    } catch {
      return fail('Your sign-in link expired — please try again.');
    }
    const config = await prisma.directoryConfig.findUnique({ where: { orgId } });
    if (!config || !config.isEnabled) return fail('Single sign-on is not available for this organization.');

    const { accessToken } = await exchangeEntraCode({
      tenantId: config.tenantId, clientId: config.clientId,
      clientSecret: decryptSecret(config.clientSecretEnc), code,
    }).catch((e: Error) => { throw new AppError(401, e.message); });

    const profile = await fetchEntraProfile(accessToken);
    const email = (profile.mail || profile.userPrincipalName || '').toLowerCase();

    let user = await prisma.user.findFirst({
      where: { entraObjectId: profile.id, orgId },
      include: { org: { select: { id: true, name: true, slug: true } } },
    });

    // First SSO login for this person — link by matching email within the
    // same org instead of creating a new account (phase 1 has no
    // auto-provisioning; see entraObjectId's schema comment).
    if (!user && email) {
      const byEmail = await prisma.user.findFirst({
        where: { email, orgId },
        include: { org: { select: { id: true, name: true, slug: true } } },
      });
      if (byEmail) {
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: { entraObjectId: profile.id },
          include: { org: { select: { id: true, name: true, slug: true } } },
        });
      }
    }

    // Phase 2: still no match — create an account if the org has opted into
    // auto-provisioning, using group membership to pick a role (falling back
    // to the org's default role). Off by default; see DirectoryConfig's
    // schema comment.
    if (!user && config.autoProvisioningEnabled) {
      if (!email) return fail('Microsoft did not provide an email address for your account.');

      const groupIds = await fetchEntraGroups(accessToken).catch(() => [] as string[]);
      const role = await resolveRoleForGroups(orgId, groupIds, config.defaultRole);

      try {
        await assertSeatAvailable(orgId, role);
      } catch {
        return fail('Your organization has reached its user limit. Contact your admin.');
      }

      // Directory-provisioned accounts never use a password — a random,
      // never-surfaced hash keeps User.passwordHash satisfied (it's a
      // required column) without anyone being able to guess or brute-force
      // their way in through the password form. If password login is ever
      // wanted for this account, the existing "forgot password" flow works
      // regardless of how the account was created.
      const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      user = await prisma.user.create({
        data: {
          name: profile.displayName, email, passwordHash, role, orgId,
          entraObjectId: profile.id, provisionedVia: 'DIRECTORY',
        },
        include: { org: { select: { id: true, name: true, slug: true } } },
      });
      logAction(user.id, 'CREATE', 'User', user.id, { method: 'entra_jit', role });
      // Directory-provisioned staff are still staff.
      await ensureEmployeeForUser(user.id);
    }

    if (!user) return fail('No CRMITdesk account was found for you. Ask your admin to invite you first.');
    if (!user.isActive) return fail('Your account is deactivated. Contact your admin.');

    if (appChallenge) {
      // Native: hand the app a one-time code, not tokens (see above).
      const exchangeCode = jwt.sign(
        { uid: user.id, ac: appChallenge, typ: 'entra-app', jti: crypto.randomBytes(12).toString('hex') },
        ssoSigningKey(), { expiresIn: '2m' },
      );
      return res.redirect(`${APP_SSO_REDIRECT_URL}#code=${encodeURIComponent(exchangeCode)}`);
    }

    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh);
    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId: user.orgId ?? '' });
    logAction(user.id, 'LOGIN', 'User', user.id, { email: user.email, method: 'entra' });

    res.redirect(`${FRONTEND_URL}/sso-callback#access=${encodeURIComponent(access)}&refresh=${encodeURIComponent(rawRefresh)}`);
  } catch (err: any) {
    console.error('[entra] callback failed:', err);
    fail(err?.message || 'Sign-in failed — please try again.');
  }
}

const SsoExchangeSchema = z.object({
  code: z.string().min(1),
  verifier: z.string().min(43).max(128),
});

/**
 * POST /auth/sso/exchange — public; the app redeems the one-time code from
 * the com.zenkara.app://sso-callback deep link, proving with the verifier
 * that it is the same app instance that started the sign-in.
 */
export async function ssoExchange(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, verifier } = SsoExchangeSchema.parse(req.body);
    let claims: { uid: string; ac: string; typ: string; jti: string; exp: number };
    try {
      claims = jwt.verify(code, ssoSigningKey()) as any;
    } catch {
      throw new AppError(401, 'Sign-in code expired — please try again.');
    }
    if (claims.typ !== 'entra-app' || !claims.jti) throw new AppError(401, 'Invalid sign-in code.');
    if (base64UrlSha256(verifier) !== claims.ac) throw new AppError(401, 'Invalid sign-in code.');

    const now = Date.now();
    for (const [jti, exp] of redeemedSsoCodes) if (exp < now) redeemedSsoCodes.delete(jti);
    if (redeemedSsoCodes.has(claims.jti)) throw new AppError(401, 'This sign-in code was already used.');
    redeemedSsoCodes.set(claims.jti, claims.exp * 1000);

    const user = await prisma.user.findUnique({
      where: { id: claims.uid },
      include: { org: { select: { id: true, name: true, slug: true } } },
    });
    if (!user || !user.isActive) throw new AppError(401, 'Your account is deactivated. Contact your admin.');

    const rawRefresh = generateRefreshToken();
    await storeRefreshToken(user.id, rawRefresh, 'native');
    const access = signAccessToken({ id: user.id, role: user.role, email: user.email, orgId: user.orgId ?? '' });
    logAction(user.id, 'LOGIN', 'User', user.id, { email: user.email, method: 'entra', client: 'native' });
    res.json({ user: userPayload(user, user.org), access, refresh: rawRefresh });
  } catch (err) { next(err); }
}
