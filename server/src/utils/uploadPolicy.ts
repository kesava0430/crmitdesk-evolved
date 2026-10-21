import path from 'node:path';
import { AppError } from '../middleware/errorHandler';

/**
 * What may be uploaded, and under what name.
 *
 * The attachment route previously had no `fileFilter` at all and passed
 * `file.originalname` straight through — into the stored `fileName`, and into
 * the S3 object key. Two consequences worth naming:
 *
 * 1. The shared hosted bucket separates tenants ONLY by an `${orgId}/` key
 *    prefix. `S3_ENDPOINT` is explicitly supported for MinIO and self-hosted
 *    gateways, some of which normalise `..` in a key — so a filename like
 *    `../../other-org/x.pdf` could climb out of its own tenant's prefix.
 *    Real AWS and R2 treat `..` as a literal segment and are unaffected, but
 *    the separation should not depend on which vendor is behind the endpoint.
 *
 * 2. Anything at all could be stored — `.exe`, `.html`, `.svg`. Downloads are
 *    served with `Content-Disposition: attachment` and helmet's `nosniff`, so
 *    this is not stored XSS on the API origin, but hosting arbitrary
 *    executables for customers is not a thing to do by accident.
 */

/** Extensions customers actually attach to CRM and service-desk records. */
const ALLOWED_EXTENSIONS = new Set([
  // documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.txt', '.md', '.rtf', '.csv', '.tsv',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic',
  // archives
  '.zip', '.gz', '.tar', '.7z',
  // mail / calendar / logs
  '.eml', '.msg', '.ics', '.log', '.json', '.xml',
  // media (screen recordings on tickets are common)
  '.mp4', '.mov', '.webm', '.mp3', '.wav', '.m4a',
]);

/**
 * Blocked outright, whatever the extension says. Kept separate from the
 * allowlist because these are the ones worth an explicit message.
 */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif', '.cpl',
  '.jar', '.app', '.dmg', '.deb', '.rpm', '.sh', '.ps1', '.vbs', '.wsf',
  '.dll', '.so', '.jsp', '.php', '.asp', '.aspx', '.cgi',
  // SVG can carry script. It is an image people reasonably attach, but it is
  // also the one image format that is a document — excluded deliberately.
  '.svg', '.svgz', '.html', '.htm', '.xhtml', '.hta',
]);

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Strips every path component and anything that could be interpreted as one.
 * Returns a name safe to use as a storage key segment and as a download
 * filename.
 */
export function sanitiseFilename(original: string): string {
  // basename() on both separators — a Windows client sends `C:\Users\…\x.pdf`
  // and POSIX basename() would keep the whole thing as one "name".
  const base = path.basename(original.replace(/\\/g, '/')).trim();

  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')   // control chars, incl. NUL
    .replace(/[/\\:*?"<>|]/g, '_')            // path + Windows-reserved
    .replace(/^\.+/, '')                      // no leading dots: no `..`, no hidden files
    .replace(/\s+/g, ' ')
    .slice(0, 180);

  return cleaned || 'file';
}

/**
 * Throws unless this file may be stored. Called from the route's multer
 * fileFilter (so an oversized or forbidden file is rejected before the body
 * is fully buffered) and again in the controller as a belt-and-braces check.
 */
export function assertUploadAllowed(filename: string, sizeBytes?: number): void {
  const safe = sanitiseFilename(filename);
  const ext = path.extname(safe).toLowerCase();

  if (!ext) {
    throw new AppError(400, 'That file has no extension, so we cannot tell what it is. Rename it and try again.');
  }
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new AppError(400, `${ext} files cannot be attached for security reasons.`);
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new AppError(400, `${ext} files are not supported. Attach a document, image, archive or media file.`);
  }
  if (sizeBytes !== undefined && sizeBytes > MAX_UPLOAD_BYTES) {
    throw new AppError(413, 'That file is larger than the 25MB limit.');
  }
}

/**
 * The Content-Type an attachment is stored and served with — derived from its
 * (already allow-listed) extension, NEVER from the multipart part's
 * Content-Type, which the uploader chooses freely. Previously
 * `file.mimetype` was stored as-is, so `notes.txt` uploaded as `text/html`
 * came back with that type; the app's "view" button wraps the bytes in a
 * blob of the stored type and opens it in a tab, and a blob: URL runs with
 * the APP's origin — stored XSS with access to the viewer's session tokens.
 *
 * Document-like formats a browser would render as a page (xml, json, md,
 * eml, csv…) are typed as plain text or as their non-rendering MIME, so even
 * a hostile file can only ever display as text.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.rtf': 'application/rtf',
  '.json': 'application/json',
  // text/xml would let an XHTML-namespaced <script> run; plain text can't.
  '.xml': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
  '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook', '.ics': 'text/calendar',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

export function mimeTypeFor(filename: string): string {
  const ext = path.extname(sanitiseFilename(filename)).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** For the client, so the file picker and its error messages agree with the server. */
export const UPLOAD_POLICY = {
  maxBytes: MAX_UPLOAD_BYTES,
  allowedExtensions: [...ALLOWED_EXTENSIONS].sort(),
};
