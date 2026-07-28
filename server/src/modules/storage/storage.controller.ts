import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { encryptSecret } from '../../utils/crypto';
import * as googleDrive from '../../utils/googleDrive';

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
    const config = await prisma.storageConfig.findUnique({ where: { orgId: req.user!.orgId } });
    res.json({
      configured: googleDrive.isGoogleDriveConfigured(),
      connected: !!config,
      provider: config?.provider || null,
      connectedEmail: config?.connectedEmail || null,
      connectedAt: config?.createdAt || null,
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

// DELETE /api/storage
export async function disconnect(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.storageConfig.deleteMany({ where: { orgId: req.user!.orgId } });
    res.json({ message: 'Storage disconnected. Existing attachments already uploaded are unaffected until deleted individually.' });
  } catch (err) { next(err); }
}
