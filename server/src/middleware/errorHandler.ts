import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
// Only read inside the handler below, so the import cycle with uploadPolicy
// (which needs AppError from this file) resolves at call time, not load time.
import { MAX_UPLOAD_BYTES } from '../utils/uploadPolicy';

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  if ((err as any).status === 413 || (err as any).type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  // Multer throws its own error class, which carries no `status`, so an
  // oversized attachment used to fall through to the generic handler and come
  // back as a 500 "Internal server error" — the client had no way to tell a
  // too-big file from a broken server, and showed the wrong message.
  if ((err as any).name === 'MulterError') {
    const code = (err as any).code;
    if (code === 'LIMIT_FILE_SIZE') {
      const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
      return res.status(413).json({ error: `That file is larger than the ${mb}MB limit.` });
    }
    if (code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected file field. Upload one file at a time.' });
    }
    return res.status(400).json({ error: err.message || 'Upload rejected' });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation error', details: err.errors });
  }
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}
