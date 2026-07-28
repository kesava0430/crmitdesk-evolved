import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * "Hosted storage" — the alternative to bring-your-own Google Drive
 * (utils/googleDrive.ts) for orgs whose plan includes a storage quota (see
 * PLANS.storageQuotaGB in utils/stripe.ts, enforced in utils/licensing.ts's
 * assertHostedStorageAvailable). One shared bucket for every org, objects
 * keyed by orgId so there's no cross-tenant access even though it's the
 * same bucket — access is still governed entirely by our own org/entity
 * checks in attachments.controller.ts, same as the Drive path.
 *
 * Unlike the rest of this codebase's third-party integrations (Stripe,
 * Twilio, Google — all hand-rolled HTTPS calls, see those utils files),
 * this one uses the official @aws-sdk/client-s3 package rather than
 * hand-written requests. AWS's request-signing algorithm (SigV4) is
 * substantially more involved than a bearer token or OAuth header, and a
 * subtly wrong hand-rolled signature fails as a cryptic 403 rather than
 * something easy to spot in review — not a good tradeoff for the ~15KB
 * this pulls in. Works against any S3-compatible endpoint (Cloudflare R2,
 * MinIO, AWS S3 itself) via S3_ENDPOINT.
 */

export function isS3Configured(): boolean {
  return !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

function client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    // Path-style (bucket.region.host/bucket/key rather than
    // bucket.host/key) is what R2 and most non-AWS S3-compatible
    // providers expect; only skip it when talking to real AWS.
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
}

function bucket(): string {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error('S3_BUCKET not configured');
  return b;
}

/** Uploads the file under a per-org prefix and returns the object key
 * (stored as Attachment.providerFileId). */
export async function uploadObject(orgId: string, file: { buffer: Buffer; filename: string; mimeType: string }): Promise<string> {
  const key = `${orgId}/${Date.now()}-${crypto.randomUUID()}-${file.filename}`;
  await client().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: file.buffer,
    ContentType: file.mimeType,
  }));
  return key;
}

export async function downloadObject(key: string): Promise<Buffer> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const chunks: Buffer[] = [];
  // res.Body is a Node Readable stream in the Node runtime of this SDK.
  for await (const chunk of res.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err: any) {
    // Swallow "already gone" the same way googleDrive-backed deletes do —
    // the point of this call is making sure it's gone, and it is.
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return;
    throw err;
  }
}
