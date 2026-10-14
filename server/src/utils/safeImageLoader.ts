/**
 * Loads a template image (logo, signature, watermark) server-side so PDFKit
 * can embed it. The URL is tenant-controlled, which makes this an SSRF
 * surface: an HR admin could otherwise point "logo URL" at
 * http://169.254.169.254/ (EC2 instance metadata) or an internal service and
 * have the API fetch it. So:
 *
 *  - only `data:` URLs (PNG/JPEG, ≤ 1 MB decoded) and `https:` URLs;
 *  - the hostname is resolved first and EVERY address must be public — the
 *    request is then pinned to the vetted address (custom `lookup`), so a DNS
 *    answer that changes between check and connect (rebinding) can't slip
 *    through;
 *  - redirects are followed (max 3) only through the same checks;
 *  - 5 s overall timeout, ≤ 2 MB body, and the bytes must actually be PNG or
 *    JPEG (magic number) — PDFKit can't draw SVG/WebP, so those are skipped
 *    with a warning rather than crashing the render.
 *
 * Failures never throw: callers get `null` and render without the image —
 * a payslip must never fail because a logo host is down.
 */
import dns from 'dns';
import net from 'net';
import https from 'https';
import crypto from 'crypto';
import type { IncomingMessage } from 'http';

export type ImageKind = 'png' | 'jpeg';
export interface LoadedImage { kind: ImageKind; data: Buffer }

export const DATA_URL_MAX_BYTES = 1024 * 1024;
export const REMOTE_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** PNG / JPEG by magic number — the content-type header alone is not trusted. */
export function sniffImageKind(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

export class ImageLoadError extends Error {}

/** data:image/png;base64,… → bytes. Throws ImageLoadError with a reason. */
export function parseDataUrl(url: string, maxBytes = DATA_URL_MAX_BYTES): LoadedImage {
  const m = /^data:([a-z0-9.+\/-]+)?((?:;[a-z0-9-]+=[^;,]*)*)(;base64)?,(.*)$/is.exec(url);
  if (!m) throw new ImageLoadError('Malformed data URL');
  const mime = (m[1] || '').toLowerCase();
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/jpg') throw new ImageLoadError(`Unsupported image type ${mime || '(none)'} — use PNG or JPEG`);
  if (!m[3]) throw new ImageLoadError('Only base64 data URLs are supported');
  const b64 = m[4].replace(/\s+/g, '');
  // Reject before decoding a huge string (base64 is 4 chars per 3 bytes).
  if (Math.floor(b64.length * 3 / 4) > maxBytes + 2) throw new ImageLoadError('Image is larger than 1 MB');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new ImageLoadError('Invalid base64 data');
  const data = Buffer.from(b64, 'base64');
  if (data.length > maxBytes) throw new ImageLoadError('Image is larger than 1 MB');
  const kind = sniffImageKind(data);
  if (!kind) throw new ImageLoadError('Data is not a PNG or JPEG image');
  return { kind, data };
}

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
  ['2001::', 32], // Teredo — tunnels to an embedded IPv4
  ['2002::', 16], // 6to4 — ditto
] as const) blocked.addSubnet(a, p, 'ipv6');

/** IPv4 embedded in an IPv6 address (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96 NAT64), else null. */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const m = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(.+)$/.exec(lower);
  if (!m) return null;
  const tail = m[1];
  if (net.isIPv4(tail)) return tail;
  const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (hx) { const hi = parseInt(hx[1], 16), lo = parseInt(hx[2], 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  return null;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and documentation ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (net.isIPv6(ip)) {
    const v4 = embeddedV4(ip);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all → refuse
}

// ─── Remote fetch ────────────────────────────────────────────────────────────

export interface LoaderDeps {
  /** dns.lookup(host, { all: true }) */
  lookup: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Performs a GET pinned to `address`; resolves with the response stream. */
  get: (url: URL, address: string, family: number, signal: AbortSignal) => Promise<IncomingMessage>;
}

const defaultDeps: LoaderDeps = {
  lookup: host => dns.promises.lookup(host, { all: true, verbatim: true }),
  get: (url, address, family, signal) => new Promise((resolve, reject) => {
    const req = https.get(url, {
      signal,
      headers: { 'User-Agent': 'Zenkara360-Payslip/1.0', Accept: 'image/png,image/jpeg;q=0.9' },
      // Pin the connection to the address we vetted — TLS still verifies the hostname.
      lookup: (_h: string, opts: any, cb: any) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
    }, resolve);
    req.on('error', reject);
  }),
};

async function resolvePublic(host: string, deps: LoaderDeps) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw new ImageLoadError(`Blocked address ${bare}`);
    return { address: bare, family: net.isIPv6(bare) ? 6 : 4 };
  }
  if (/^localhost$/i.test(bare) || /\.(localhost|local|internal)$/i.test(bare)) throw new ImageLoadError(`Blocked host ${bare}`);
  const addrs = await deps.lookup(bare);
  if (!addrs.length) throw new ImageLoadError(`Could not resolve ${bare}`);
  // Every answer must be public: otherwise a host with one public and one
  // private A record could still land on the private one.
  const bad = addrs.find(a => isPrivateAddress(a.address));
  if (bad) throw new ImageLoadError(`Blocked address ${bad.address} for ${bare}`);
  return addrs[0];
}

export async function fetchRemoteImage(rawUrl: string, deps: LoaderDeps = defaultDeps, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<LoadedImage> {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS, maxBytes = opts.maxBytes ?? REMOTE_MAX_BYTES;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:') throw new ImageLoadError(`Only https image URLs are allowed (got ${url.protocol})`);
      if (url.username || url.password) throw new ImageLoadError('Credentials in image URLs are not allowed');
      if (url.port && url.port !== '443') throw new ImageLoadError('Only the default https port is allowed');
      const { address, family } = await resolvePublic(url.hostname, deps);
      const res = await deps.get(url, address, family, ac.signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new ImageLoadError('Too many redirects');
        url = new URL(res.headers.location, url);
        continue;
      }
      if (status !== 200) { res.resume(); throw new ImageLoadError(`HTTP ${status}`); }
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/jpg') {
        res.resume();
        throw new ImageLoadError(`Unsupported content-type ${type || '(none)'} — PDF images must be PNG or JPEG`);
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) { res.resume(); throw new ImageLoadError('Image is larger than 2 MB'); }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of res) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) { res.destroy(); throw new ImageLoadError('Image is larger than 2 MB'); }
        chunks.push(chunk as Buffer);
      }
      const data = Buffer.concat(chunks);
      const kind = sniffImageKind(data);
      if (!kind) throw new ImageLoadError('Response is not a PNG or JPEG image');
      return { kind, data };
    }
  } catch (err: any) {
    if (err instanceof ImageLoadError) throw err;
    if (ac.signal.aborted) throw new ImageLoadError(`Timed out after ${timeoutMs} ms`);
    throw new ImageLoadError(err?.message || 'Fetch failed');
  } finally {
    clearTimeout(timer);
  }
}

// ─── Cached entry point ──────────────────────────────────────────────────────

interface CacheEntry { at: number; value: LoadedImage | null }
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 64;
const OK_TTL_MS = 10 * 60 * 1000;
// Failures are cached briefly too, so a run of 300 payslips with a dead logo
// host costs one 5 s timeout, not 300.
const FAIL_TTL_MS = 60 * 1000;

const keyFor = (url: string) => (url.length > 256 ? 'sha1:' + crypto.createHash('sha1').update(url).digest('hex') : url);

export function clearImageCache() { cache.clear(); }

/**
 * Load an image for PDF embedding. Returns null (and logs a warning) when the
 * URL is empty, disallowed, unreachable or not PNG/JPEG.
 */
export async function loadImage(url: string | null | undefined, deps: LoaderDeps = defaultDeps): Promise<LoadedImage | null> {
  if (!url) return null;
  const key = keyFor(url);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? OK_TTL_MS : FAIL_TTL_MS)) {
    cache.delete(key); cache.set(key, hit); // LRU touch
    return hit.value;
  }
  let value: LoadedImage | null = null;
  try {
    value = /^data:/i.test(url) ? parseDataUrl(url) : await fetchRemoteImage(url, deps);
  } catch (err: any) {
    console.warn(`[payslip] image skipped (${url.slice(0, 60)}${url.length > 60 ? '…' : ''}): ${err?.message ?? err}`);
  }
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return value;
}
