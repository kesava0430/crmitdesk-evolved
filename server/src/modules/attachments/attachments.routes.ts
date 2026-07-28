import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireRole, ALL_STAFF } from '../../middleware/authenticate';
import * as c from './attachments.controller';

// Memory storage only — the buffer goes straight to storage.uploadAttachment()
// (the org's connected Drive), never touching this server's local disk,
// which Render wipes on every redeploy/restart.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
});

export const attachmentsRouter = Router();
attachmentsRouter.use(authenticate);

// Same access level as Comments (ALL_STAFF — everyone but plain EMPLOYEE).
// /:id/download must be registered before /:entityType/:entityId — both are
// 2-segment GET paths, and Express matches whichever pattern was registered
// first, so the more specific literal route has to come first or every
// download request would get swallowed by the list handler instead
// (entityType='<the id>', entityId='download').
attachmentsRouter.get('/:id/download',             requireRole(...ALL_STAFF), c.download);
attachmentsRouter.delete('/:id',                   requireRole(...ALL_STAFF), c.remove);
attachmentsRouter.get('/:entityType/:entityId',    requireRole(...ALL_STAFF), c.list);
attachmentsRouter.post('/:entityType/:entityId',   requireRole(...ALL_STAFF), upload.single('file'), c.upload);
