import { prisma } from './prisma';
import { encryptSecret, decryptSecretOrPlain } from './crypto';
import * as googleDrive from './googleDrive';
import { AppError } from '../middleware/errorHandler';

// Provider-agnostic layer on top of StorageConfig. Everything here dispatches
// on StorageConfig.provider — today only 'GOOGLE_DRIVE' exists, but the
// dispatch points (upload/download/delete/getValidAccessToken) are exactly
// where a second provider (e.g. Zoho WorkDrive) would plug in: same shape,
// new case in each switch, no changes needed to attachments.controller.ts
// or anything that calls into this file.

export interface UploadResult {
  provider: string;
  providerFileId: string;
  fileUrl: string;
}

async function getConfig(orgId: string) {
  const config = await prisma.storageConfig.findUnique({ where: { orgId } });
  if (!config) {
    throw new AppError(400, 'No storage connected for this organization. An admin needs to connect Google Drive in Settings → Storage first.');
  }
  return config;
}

/** Returns a definitely-valid access token, transparently refreshing and
 * persisting it first if the stored one has expired (or is about to). */
async function getValidAccessToken(orgId: string): Promise<{ accessToken: string; provider: string }> {
  const config = await getConfig(orgId);
  const accessToken = decryptSecretOrPlain(config.accessToken);

  // 60s buffer so a token that's valid-but-about-to-expire doesn't fail mid-request
  if (config.tokenExpiresAt.getTime() - Date.now() > 60_000) {
    return { accessToken, provider: config.provider };
  }

  if (config.provider === 'GOOGLE_DRIVE') {
    const refreshToken = decryptSecretOrPlain(config.refreshToken);
    const refreshed = await googleDrive.refreshAccessToken(refreshToken);
    const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);
    await prisma.storageConfig.update({
      where: { orgId },
      data: { accessToken: encryptSecret(refreshed.access_token), tokenExpiresAt: newExpiry },
    });
    return { accessToken: refreshed.access_token, provider: config.provider };
  }

  throw new AppError(500, `Unsupported storage provider: ${config.provider}`);
}

export async function hasStorageConnected(orgId: string): Promise<boolean> {
  return !!(await prisma.storageConfig.findUnique({ where: { orgId } }));
}

export async function uploadAttachment(orgId: string, file: { buffer: Buffer; filename: string; mimeType: string }): Promise<UploadResult> {
  const { accessToken, provider } = await getValidAccessToken(orgId);
  const config = await getConfig(orgId);

  if (provider === 'GOOGLE_DRIVE') {
    const uploaded = await googleDrive.uploadFile(accessToken, config.rootFolderId, file);
    return { provider, providerFileId: uploaded.id, fileUrl: uploaded.webViewLink };
  }
  throw new AppError(500, `Unsupported storage provider: ${provider}`);
}

export async function downloadAttachment(orgId: string, provider: string, providerFileId: string): Promise<Buffer> {
  const { accessToken } = await getValidAccessToken(orgId);
  if (provider === 'GOOGLE_DRIVE') {
    return googleDrive.downloadFile(accessToken, providerFileId);
  }
  throw new AppError(500, `Unsupported storage provider: ${provider}`);
}

export async function deleteAttachmentFile(orgId: string, provider: string, providerFileId: string): Promise<void> {
  const { accessToken } = await getValidAccessToken(orgId);
  if (provider === 'GOOGLE_DRIVE') {
    // Swallow a 404 (file already gone from Drive, e.g. someone deleted it
    // manually) — the point of this call is making sure it's gone, and it is.
    await googleDrive.deleteFile(accessToken, providerFileId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('404')) throw err;
    });
    return;
  }
  throw new AppError(500, `Unsupported storage provider: ${provider}`);
}
