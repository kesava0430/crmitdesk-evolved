import { prisma } from './prisma';
import { encryptSecret, decryptSecretOrPlain } from './crypto';
import * as googleDrive from './googleDrive';
import * as s3Storage from './s3Storage';
import { assertHostedStorageAvailable } from './licensing';
import { AppError } from '../middleware/errorHandler';

// Provider-agnostic layer on top of StorageConfig. Everything here dispatches
// on StorageConfig.provider: 'GOOGLE_DRIVE' (bring-your-own, OAuth) or
// 'HOSTED_S3' (we host it, plan-gated — see assertHostedStorageAvailable).
// A third provider (e.g. Zoho WorkDrive) would plug in the same way: a new
// case in each function below, no changes needed to
// attachments.controller.ts or anything else that calls into this file.

export interface UploadResult {
  provider: string;
  providerFileId: string;
  fileUrl: string;
}

async function getConfig(orgId: string) {
  const config = await prisma.storageConfig.findUnique({ where: { orgId } });
  if (!config) {
    throw new AppError(400, 'No storage connected for this organization. An admin needs to connect a storage provider in Settings → Storage first.');
  }
  return config;
}

/** Returns a definitely-valid Google Drive access token, transparently
 * refreshing and persisting it first if the stored one has expired (or is
 * about to). Only meaningful for provider === 'GOOGLE_DRIVE' — callers must
 * already know that's the config's provider before calling this. */
async function getValidGoogleAccessToken(orgId: string, config: { accessToken: string | null; refreshToken: string | null; tokenExpiresAt: Date | null }): Promise<string> {
  const accessToken = decryptSecretOrPlain(config.accessToken!);

  // 60s buffer so a token that's valid-but-about-to-expire doesn't fail mid-request
  if (config.tokenExpiresAt!.getTime() - Date.now() > 60_000) {
    return accessToken;
  }

  const refreshToken = decryptSecretOrPlain(config.refreshToken!);
  const refreshed = await googleDrive.refreshAccessToken(refreshToken);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);
  await prisma.storageConfig.update({
    where: { orgId },
    data: { accessToken: encryptSecret(refreshed.access_token), tokenExpiresAt: newExpiry },
  });
  return refreshed.access_token;
}

export async function hasStorageConnected(orgId: string): Promise<boolean> {
  return !!(await prisma.storageConfig.findUnique({ where: { orgId } }));
}

/** Like getConfig, but also asserts the org's *current* connection is still
 * Google Drive with live credentials. A StorageConfig row can exist while
 * holding no usable Drive credentials — the org may have since switched to
 * hosted storage (connectHosted nulls the Drive fields) or reconnected a
 * different Drive account (googleCallback overwrites the tokens). Older
 * attachments still have provider === 'GOOGLE_DRIVE' recorded on them but
 * can no longer be reached through the current config, so this throws a
 * clean, explanatory error instead of letting decryptSecretOrPlain blow up
 * on a null accessToken or Drive reject a token that belongs to someone
 * else's account. Callers that create controller-level guards to prevent
 * this situation (storage.controller.ts) still need this as a backstop for
 * attachments that were orphaned before those guards existed. */
async function getGoogleDriveConfig(orgId: string) {
  const config = await getConfig(orgId);
  if (config.provider !== 'GOOGLE_DRIVE' || !config.accessToken || !config.refreshToken || !config.tokenExpiresAt) {
    throw new AppError(
      400,
      "This organization's Google Drive connection has changed since this file was uploaded, so it can no longer be reached here. It may still exist in the previously connected Google Drive account.",
    );
  }
  return config as typeof config & { accessToken: string; refreshToken: string; tokenExpiresAt: Date };
}

/** Number of attachments currently stored in this org's connected Google
 * Drive. Used by storage.controller.ts to block actions that would
 * silently orphan them — switching to hosted storage, disconnecting, or
 * reconnecting a different Drive account all overwrite or remove the
 * credentials those attachments need to stay reachable. */
export async function countGoogleDriveAttachments(orgId: string): Promise<number> {
  return prisma.attachment.count({
    where: { provider: 'GOOGLE_DRIVE', uploader: { orgId } },
  });
}

export async function uploadAttachment(orgId: string, file: { buffer: Buffer; filename: string; mimeType: string }): Promise<UploadResult> {
  const config = await prisma.storageConfig.findUnique({ where: { orgId } });

  // Platform fallback (White-Label Sending & Licensing Plan, "attachments"):
  // an org that never explicitly connected Google Drive or hosted storage no
  // longer hard-blocks on upload — it transparently uses OUR hosted S3
  // bucket instead, still gated by the org's plan quota below (a FREE org
  // gets a clear upgrade-or-connect-your-own-Drive message, same as before;
  // Pro/Enterprise orgs just start uploading with no connect step at all).
  if (!config) {
    await assertHostedStorageAvailable(orgId, file.buffer.length);
    const key = await s3Storage.uploadObject(orgId, file);
    return { provider: 'HOSTED_S3', providerFileId: key, fileUrl: '' };
  }

  if (config.provider === 'GOOGLE_DRIVE') {
    const accessToken = await getValidGoogleAccessToken(orgId, config);
    const uploaded = await googleDrive.uploadFile(accessToken, config.rootFolderId!, file);
    return { provider: config.provider, providerFileId: uploaded.id, fileUrl: uploaded.webViewLink };
  }
  if (config.provider === 'HOSTED_S3') {
    await assertHostedStorageAvailable(orgId, file.buffer.length);
    const key = await s3Storage.uploadObject(orgId, file);
    return { provider: config.provider, providerFileId: key, fileUrl: '' };
  }
  throw new AppError(500, `Unsupported storage provider: ${config.provider}`);
}

export async function downloadAttachment(orgId: string, provider: string, providerFileId: string): Promise<Buffer> {
  if (provider === 'GOOGLE_DRIVE') {
    const config = await getGoogleDriveConfig(orgId);
    const accessToken = await getValidGoogleAccessToken(orgId, config);
    return googleDrive.downloadFile(accessToken, providerFileId);
  }
  if (provider === 'HOSTED_S3') {
    return s3Storage.downloadObject(providerFileId);
  }
  throw new AppError(500, `Unsupported storage provider: ${provider}`);
}

export async function deleteAttachmentFile(orgId: string, provider: string, providerFileId: string): Promise<void> {
  if (provider === 'GOOGLE_DRIVE') {
    const config = await getGoogleDriveConfig(orgId);
    const accessToken = await getValidGoogleAccessToken(orgId, config);
    // Swallow a 404 (file already gone from Drive, e.g. someone deleted it
    // manually) — the point of this call is making sure it's gone, and it is.
    await googleDrive.deleteFile(accessToken, providerFileId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('404')) throw err;
    });
    return;
  }
  if (provider === 'HOSTED_S3') {
    await s3Storage.deleteObject(providerFileId);
    return;
  }
  throw new AppError(500, `Unsupported storage provider: ${provider}`);
}
