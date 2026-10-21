/**
 * Outbound HTTP to TENANT-SUPPLIED URLs: workflow webhooks, custom-module
 * external sync, Slack/Teams incoming webhooks, an org's own AI provider
 * base URL. Each of these is a URL a manager types in and this server then
 * requests — a server-side request forgery primitive unless every request is
 * refused for loopback / private / link-local (169.254.169.254 = EC2 instance
 * metadata) / CGNAT / multicast / reserved addresses.
 *
 * The earlier guards were hostname-only (a public DNS name pointing at
 * 10.0.0.5 walked straight through) and the custom-module sync had none at
 * all — while importing the response body into records, i.e. a readable
 * channel into the VPC. This module closes it properly:
 *
 *  - IP literals are checked before connecting (Node skips `lookup` for
 *    them). WHATWG URL parsing has already normalised decimal / octal / hex
 *    IPv4 forms (http://2130706433/ → 127.0.0.1), and IPv4-mapped / NAT64
 *    IPv6 forms are unwrapped by isPrivateAddress().
 *  - Names are resolved by the agent's own `lookup` at CONNECT time, and the
 *    connection fails if ANY answer is private — so there is no gap between
 *    "checked" and "connected" for a DNS-rebinding answer to slip through.
 *  - Redirects are followed manually (max 3), each hop re-checked.
 *  - Timeout and response-size caps, so a slow or huge target can't tie up
 *    the API.
 */
import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';
import type { IncomingHttpHeaders } from 'http';
import { isPrivateAddress } from './safeImageLoader';

export class OutboundUrlError extends Error {
  constructor(message: string) { super(message); this.name = 'OutboundUrlError'; }
}

export interface OutboundUrlOptions {
  /** Allow plain http:// (default true; webhooks to http receivers exist). */
  allowHttp?: boolean;
}

/**
 * Synchronous checks that need no DNS: scheme, credentials, internal
 * hostnames and IP literals. Returns the parsed URL.
 */
export function checkOutboundUrl(raw: string, opts: OutboundUrlOptions = {}): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OutboundUrlError('Not a valid URL'); }
  const allowHttp = opts.allowHttp ?? true;
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new OutboundUrlError(`Only ${allowHttp ? 'http(s)' : 'https'} URLs are allowed`);
  }
  if (url.username || url.password) throw new OutboundUrlError('URLs with a username or password are not allowed');
  // Node keeps the brackets on IPv6 hostnames ("[::1]").
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) throw new OutboundUrlError('URL has no host');
  if (host === 'localhost' || /\.(localhost|local|internal|localdomain)$/.test(host)) {
    throw new OutboundUrlError('URLs pointing at internal hosts are not allowed');
  }
  if (net.isIP(host) && isPrivateAddress(host)) {
    throw new OutboundUrlError('URLs pointing at private or internal IP addresses are not allowed');
  }
  return url;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * dns.lookup replacement for http(s) agents: resolves every address and
 * refuses the connection when any of them is private. Used at connect time,
 * so the address that is checked is the address that is used.
 */
export function publicOnlyLookup(hostname: string, options: any, callback: LookupCb): void {
  const cb: LookupCb = typeof options === 'function' ? options : callback;
  const wantAll = typeof options === 'object' && options !== null && options.all === true;
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err, wantAll ? [] : '', 0);
    const list = addrs as dns.LookupAddress[];
    if (!list.length) return cb(Object.assign(new Error(`Could not resolve ${hostname}`), { code: 'ENOTFOUND' }), wantAll ? [] : '', 0);
    const bad = list.find(a => isPrivateAddress(a.address));
    if (bad) {
      return cb(Object.assign(new OutboundUrlError(`${hostname} resolves to a private or internal address`), { code: 'EBLOCKED' }) as any, wantAll ? [] : '', 0);
    }
    if (wantAll) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/** Agents that can only reach public addresses. Safe to hand to SDKs (OpenAI's httpAgent). */
export const publicHttpAgent = new http.Agent({ lookup: publicOnlyLookup as any, keepAlive: true });
export const publicHttpsAgent = new https.Agent({ lookup: publicOnlyLookup as any, keepAlive: true });

/** Full pre-flight (sync checks + DNS) — for validating a URL when an admin SAVES it. */
export async function assertPublicUrl(raw: string, opts: OutboundUrlOptions = {}): Promise<URL> {
  const url = checkOutboundUrl(raw, opts);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return url;
  await new Promise<void>((resolve, reject) => {
    publicOnlyLookup(host, { all: true }, err => (err ? reject(err instanceof OutboundUrlError ? err : new OutboundUrlError(`Could not resolve ${host}`)) : resolve()));
  });
  return url;
}

export interface SafeRequestOptions extends OutboundUrlOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Response bodies above this are cut off with an error (default 5 MB). */
  maxBytes?: number;
  /** Redirect hops to follow, each re-checked (default 3). */
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text(): string;
  json(): any;
}

function once(url: URL, opts: SafeRequestOptions, signal: AbortSignal, maxBytes: number): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { 'User-Agent': 'Zenkara360/1.0', ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const req = lib.request(url, {
      method: opts.method ?? 'GET',
      headers,
      signal,
      agent: url.protocol === 'https:' ? publicHttpsAgent : publicHttpAgent,
    }, res => {
      const status = res.statusCode ?? 0;
      // Redirect bodies are never read.
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, headers: res.headers, body: Buffer.alloc(0) }); }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) { res.destroy(); return reject(new OutboundUrlError('Response is too large')); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); reject(new OutboundUrlError('Response is too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * fetch()-like request that can only reach public addresses. Throws
 * OutboundUrlError for a refused target, an Error for network failures, and
 * resolves (ok=false) for HTTP error statuses.
 */
export async function safeRequest(raw: string, opts: SafeRequestOptions = {}): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let current: SafeRequestOptions = { ...opts };
  try {
    let url = checkOutboundUrl(raw, opts);
    for (let hop = 0; ; hop++) {
      const r = await once(url, current, ac.signal, maxBytes);
      const loc = r.headers.location;
      if (r.status >= 300 && r.status < 400 && loc) {
        if (hop >= maxRedirects) throw new OutboundUrlError('Too many redirects');
        url = checkOutboundUrl(new URL(loc, url).toString(), opts);
        // Same rules as fetch(): 303 (and 301/302 after a POST) become a body-less GET.
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && (current.method ?? 'GET').toUpperCase() === 'POST')) {
          const { body: _b, ...rest } = current;
          const h = { ...(rest.headers ?? {}) };
          delete h['Content-Type']; delete h['content-type'];
          current = { ...rest, method: 'GET', headers: h };
        }
        continue;
      }
      const body = r.body;
      return {
        status: r.status, ok: r.status >= 200 && r.status < 300, headers: r.headers, body,
        text: () => body.toString('utf8'),
        json: () => JSON.parse(body.toString('utf8')),
      };
    }
  } catch (err: any) {
    if (ac.signal.aborted) throw new Error(`Timed out after ${timeoutMs} ms`);
    if (err?.code === 'EBLOCKED' || err instanceof OutboundUrlError) throw new OutboundUrlError(err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save-time validation: the reason a URL would be refused, or null. Lets a
 * settings form say "that points at a private address" up front instead of
 * the integration failing silently later. (Requests are re-checked at send
 * time regardless — DNS can change after saving.)
 */
export async function publicUrlProblem(raw: string, opts: OutboundUrlOptions = {}): Promise<string | null> {
  try { await assertPublicUrl(raw, opts); return null; }
  catch (e: any) { return e instanceof OutboundUrlError ? e.message : String(e?.message ?? e); }
}
