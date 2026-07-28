import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { encryptSecret } from '../../utils/crypto';
import * as googleDrive from '../../utils/googleDrive';
import * as s3Storage from '../../utils/s3Storage';
import { getStorageQuotaBytes, getHostedStorageUsageBytes } from '../../utils/licensing';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
// The backend's own public URL — Google redirects the browser straight back
// here after consent, so this has to be reachable from the internet, not
// localhost. Reuses APP_URL, the same env var mailer.ts already relies on
// for CSAT survey links (the other place this codebase builds a link back
// to itself rather than to the frontend).
const APP_URL = process.env.APP_URL || 'http://localhost:4000';
const REDIRECT_URI = `${APP_URL}/api/storage/google/callback`;

interface OAuthState {
  orgId: string;
  userId: string;
}

// GET /api/storage/status
export async function getStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.user!.orgId;
    const config = await prisma.storageConfig.findUnique({ where: { orgId } });
    const quotaBytes = await getStorageQuotaBytes(orgId);
    const usedBytes = quotaBytes > 0 ? await getHostedStorageUsageBytes(orgId) : 0;

    res.json({
      configured: googleDrive.isGoogleDriveConfigured(),
      connected: !!config,
      provider: config?.provider || null,
      connectedEmail: config?.connectedEmail || null,
      connectedAt: config?.createdAt || null,
      hosted: {
        // Whether THIS deployment has S3 credentials set at all (an admin
        // hasn't configured GOOGLE_CLIENT_ID-equivalent env vars yet).
        available: s3Storage.isS3Configured(),
        // Whether the org's PLAN includes any hosted storage at all — 0 on
        // Free, so those orgs only ever see the BYO-Drive option.
        quotaBytes,
        usedBytes,
      },
    });
  } catch (err) { next(err); }
}

// GET /api/storage/google/connect
export async function connectGoogleDrive(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!googleDrive.isGoogleDriveConfigured()) {
      throw new AppError(400, 'Google Drive isn’t configured on this deployment yet (missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET).');
    }
    const state = jwt.sign(
      { orgId: req.user!.orgId, userId: req.user!.id } as OAuthState,
      process.env.JWT_SECRET!,
      { expiresIn: '10m' },
    );
    const url = googleDrive.getGoogleAuthUrl(REDIRECT_URI, state);
    res.json({ url });
  } catch (err) { next(err); }
}

// GET /api/storage/google/callback — Google redirects the user's browser
// here directly, so there's no Authorization header to authenticate with;
// the signed `state` param (minted in connectGoogleDrive above) is what
// proves which org/user initiated this and prevents CSRF.
export async function googleCallback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { code, state, error: oauthError } = req.query as { code?: string; state?: string; error?: string };

    if (oauthError) {
      return res.redirect(`${FRONTEND_URL}/storage?error=${encodeURIComponent(oauthError)}`);
    }
    if (!code || !state) throw new AppError(400, 'Missing code or state from Google');

    let payload: OAuthState;
    try {
      payload = jwt.verify(state, process.env.JWT_SECRET!) as OAuthState;
    } catch {
      throw new AppError(400, 'This connection link has expired or is invalid — try connecting again from Settings.');
    }

    const tokens = await googleDrive.exchangeCodeForTokens(code, REDIRECT_URI);
    if (!tokens.refresh_token) {
      // Happens if the org already granted consent before and Google didn't
      // re-issue a refresh_token (prompt=consent above should prevent this,
      // but fail with a clear message rather than silently storing nothing).
      throw new AppError(400, 'Google did not return a long-lived connection. Revoke this app’s access at myaccount.google.com/permissions and try connecting again.');
    }

    const connectedEmail = await googleDrive.getConnectedEmail(tokens.access_token);
    const rootFolderId = await googleDrive.createAppFolder(tokens.access_token, 'CRMITdesk Evolved Attachments');

    await prisma.storageConfig.upsert({
      where: { orgId: payload.orgId },
      create: {
        orgId: payload.orgId,
        provider: 'GOOGLE_DRIVE',
        accessToken: encryptSecret(tokens.access_token),
        refreshToken: encryptSecret(tokens.refresh_token),
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        rootFolderId,
        connectedEmail,
        connectedByUserId: payload.userId,
      },
      update: {
        provider: 'GOOGLE_DRIVE',
        accessToken: encryptSecret(tokens.access_token),
        refreshToken: encryptSecret(tokens.refresh_token),
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        rootFolderId,
        connectedEmail,
        connectedByUserId: payload.userId,
      },
    });

    res.redirect(`${FRONTEND_URL}/storage?connected=1`);
  } catch (err: any) {
    res.redirect(`${FRONTEND_URL}/storage?error=${encodeURIComponent(err.message || 'Connection failed')}`);
  }
}

// POST /api/storage/hosted/connect — switches the org to our hosted (S3)
// storage instead of Google Drive. No OAuth involved: just checks the
// plan's quota is non-zero and this deployment has S3 credentials set, then
// upserts a StorageConfig row with every Drive-only field left null. Any
// files already uploaded under a previous provider are unaffected — this
// only changes where NEW uploads go.
export async function connectHosted(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!s3Storage.isS3Configured()) {
      throw new AppError(400, 'Hosted storage isn’t configured on this deployment yet (missing S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY).');
    }
    const orgId = req.user!.orgId;
    const quotaBytes = await getStorageQuotaBytes(orgId);
    if (quotaBytes === 0) {
      throw new AppError(402, 'Hosted storage isn’t included in your current plan. Upgrade to Pro or Enterprise, or connect your own Google Drive instead.');
    }

    await prisma.storageConfig.upsert({
      where: { orgId },
      create: {
        orgId,
        provider: 'HOSTED_S3',
        connectedByUserId: req.user!.id,
      },
      update: {
        provider: 'HOSTED_S3',
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
        rootFolderId: null,
        connectedEmail: null,
        connectedByUserId: req.user!.id,
      },
    });

    res.json({ message: 'Hosted storage connected. New attachments will upload here.' });
  } catch (err) { next(err); }
}

// DELETE /api/storage
export async function disconnect(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.storageConfig.deleteMany({ where: { orgId: req.user!.orgId } });
    res.json({ message: 'Storage disconnected. Existing attachments already uploaded are unaffected until deleted individually.' });
  } catch (err) { next(err); }
}
