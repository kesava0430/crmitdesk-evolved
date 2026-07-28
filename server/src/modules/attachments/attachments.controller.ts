import { Response, NextFunction } from 'express';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { AppError } from '../../middleware/errorHandler';
import { assertEntityInOrg } from '../../utils/entityAccess';
import * as storage from '../../utils/storage';

const include = { uploader: { select: { id: true, name: true, avatarUrl: true } } };

export async function list(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { entityType, entityId } = req.params;
    await assertEntityInOrg(entityType, entityId, req.user!.orgId);
    const attachments = await prisma.attachment.findMany({
      where: { entityType: entityType as any, entityId },
      include,
      orderBy: { createdAt: 'desc' },
    });
    res.json(attachments);
  } catch (err) { next(err); }
}

export async function upload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { entityType, entityId } = req.params;
    await assertEntityInOrg(entityType, entityId, req.user!.orgId);

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) throw new AppError(400, 'No file uploaded');

    // Uploads to wherever the org connected in Settings → Storage (Google
    // Drive today) — throws a clear 400 if nothing's connected yet, before
    // any DB row is written.
    const uploaded = await storage.uploadAttachment(req.user!.orgId, {
      buffer: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
    });

    const attachment = await prisma.attachment.create({
      data: {
        entityType: entityType as any,
        entityId,
        uploaderId: req.user!.id,
        fileName: file.originalname,
        fileUrl: uploaded.fileUrl,
        provider: uploaded.provider,
        providerFileId: uploaded.providerFileId,
        fileSize: file.size,
        mimeType: file.mimetype,
      },
      include,
    });
    res.status(201).json(attachment);
  } catch (err) { next(err); }
}

/** Streams the file's bytes back through our own backend rather than
 * redirecting to a Drive link — keeps access controlled by our own
 * entity/org check instead of Google Drive sharing permissions, and works
 * for staff regardless of whether they have any Google account at all. */
export async function download(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const attachment = await prisma.attachment.findUnique({ where: { id: req.params.id } });
    if (!attachment) throw new AppError(404, 'Attachment not found');
    await assertEntityInOrg(attachment.entityType, attachment.entityId, req.user!.orgId);

    const buffer = await storage.downloadAttachment(req.user!.orgId, attachment.provider, attachment.providerFileId);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
    res.send(buffer);
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const attachment = await prisma.attachment.findUnique({ where: { id: req.params.id } });
    if (!attachment) throw new AppError(404, 'Attachment not found');
    await assertEntityInOrg(attachment.entityType, attachment.entityId, req.user!.orgId);
    if (attachment.uploaderId !== req.user!.id && req.user!.role !== 'SUPER_ADMIN') {
      throw new AppError(403, 'Not allowed');
    }

    await storage.deleteAttachmentFile(req.user!.orgId, attachment.provider, attachment.providerFileId);
    await prisma.attachment.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
}
