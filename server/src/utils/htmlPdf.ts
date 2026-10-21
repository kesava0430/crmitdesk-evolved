/**
 * HTML → PDF for custom-HTML payslip templates, through headless Chromium
 * (playwright-core drives it; no browser is bundled with the npm package).
 *
 * Why Chromium and not a pure-JS HTML→PDF library: an HR manager's template
 * is arbitrary HTML/CSS (grid, flex, @page, web-safe fonts, ₹). The pure-JS
 * options (pdfmake/html-to-pdfmake, jsPDF.html, …) implement a small subset
 * of CSS, so the PDF would quietly differ from the preview — the exact
 * "it only works in the browser" illusion we must not ship. Chromium prints
 * what the preview shows.
 *
 * Hardening (the HTML is admin-entered, and also already sanitized —
 * utils/payslipHtmlTemplate.ts):
 *  - JavaScript disabled in the context; the document also carries a CSP meta;
 *  - the context is offline AND every request is routed to abort, so nothing
 *    is fetched — images arrive inlined as data: URIs (utils/payslipOutput.ts);
 *  - a fresh context per document (no shared cookies/storage between tenants);
 *  - a render timeout, and a concurrency limit so a 300-payslip bundle can't
 *    open 300 pages on a 2 GB instance;
 *  - one browser process, started on first use and closed after a minute idle
 *    (headless Chromium is ~100–150 MB resident — not something to keep
 *    around on a t3.small when nobody is printing payslips).
 *
 * Finding the binary (first hit wins):
 *   CHROMIUM_PATH                                   explicit path
 *   $PLAYWRIGHT_BROWSERS_PATH, /opt/zenkara-pw,     `npx playwright-core install chromium-headless-shell`
 *   ~/.cache/ms-playwright, /opt/pw-browsers           (deploy/zenkara-pull-deploy.sh installs into /opt/zenkara-pw)
 *   /usr/bin/chromium, chromium-browser, google-chrome(-stable), /snap/bin/chromium
 * If none is found, rendering a custom template to PDF fails with a clear
 * 503 — it never falls back to a built-in layout.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppError } from '../middleware/errorHandler';

export const HTML_PDF_TIMEOUT_MS = Math.max(2000, Number(process.env.HTML_PDF_TIMEOUT_MS) || 20_000);
export const HTML_PDF_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.HTML_PDF_CONCURRENCY) || 2));
const IDLE_CLOSE_MS = 60_000;

export const CHROMIUM_INSTALL_COMMAND = 'cd /opt/zenkara-crm && sudo PLAYWRIGHT_BROWSERS_PATH=/opt/zenkara-pw npx --no-install playwright-core install --with-deps chromium-headless-shell';

/** What employees and HR see; the admin detail (and the install command) goes to the log and the template editor. */
export class HtmlPdfUnavailableError extends AppError {
  constructor(detail: string) {
    super(503, "This payslip uses an HTML template and the server's PDF engine isn't available right now, so the PDF can't be made. The on-screen payslip still works — please let your administrator know.");
    console.warn(`[htmlPdf] ${detail} — install with: ${CHROMIUM_INSTALL_COMMAND} (or set CHROMIUM_PATH)`);
  }
}

// ─── Locating Chromium ───────────────────────────────────────────────────────

const exists = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };

/** Playwright's browser cache layout: <root>/chromium_headless_shell-<rev>/<platform dir>/<binary>, newest revision first. */
function fromPlaywrightCache(root: string): string | null {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  const rev = (d: string) => Number(d.split('-').pop()) || 0;
  const pick = (prefix: string) => dirs.filter(d => d.startsWith(prefix)).sort((a, b) => rev(b) - rev(a));
  for (const d of pick('chromium_headless_shell-')) {
    for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-linux-arm64/chrome-headless-shell', 'chrome-linux/headless_shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell']) {
      const p = path.join(root, d, rel); if (exists(p)) return p;
    }
  }
  for (const d of pick('chromium-')) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) { const p = path.join(root, d, rel); if (exists(p)) return p; }
  }
  return null;
}

export function findChromium(env: NodeJS.ProcessEnv = process.env): { path: string; source: string } | null {
  if (env.CHROMIUM_PATH) return exists(env.CHROMIUM_PATH) ? { path: env.CHROMIUM_PATH, source: 'CHROMIUM_PATH' } : null;
  const caches = [env.PLAYWRIGHT_BROWSERS_PATH, '/opt/zenkara-pw', path.join(os.homedir(), '.cache', 'ms-playwright'), '/opt/pw-browsers'].filter((x): x is string => !!x && x !== '0');
  for (const c of caches) { const p = fromPlaywrightCache(c); if (p) return { path: p, source: c }; }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/snap/bin/chromium']) if (exists(p)) return { path: p, source: 'system' };
  return null;
}

let lastLaunchError: string | null = null;

/** For the template editor: can custom-HTML templates be turned into PDFs here? */
export function htmlPdfStatus(): { available: boolean; detail: string } {
  let hasLib = true;
  try { require.resolve('playwright-core'); } catch { hasLib = false; }
  if (!hasLib) return { available: false, detail: 'the playwright-core package is not installed' };
  const c = findChromium();
  if (!c) return { available: false, detail: `no Chromium found — install it on the server with: ${CHROMIUM_INSTALL_COMMAND} (or set CHROMIUM_PATH)` };
  if (lastLaunchError) return { available: false, detail: `Chromium at ${c.path} failed to start: ${lastLaunchError}` };
  return { available: true, detail: `Chromium: ${c.path}` };
}

// ─── Browser lifecycle ───────────────────────────────────────────────────────

let browserPromise: Promise<any> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let active = 0;
const waiters: (() => void)[] = [];

async function launch(): Promise<any> {
  let chromium: any;
  try { chromium = require('playwright-core').chromium; } catch { throw new HtmlPdfUnavailableError('the playwright-core package is not installed'); }
  const found = findChromium();
  if (!found) throw new HtmlPdfUnavailableError('no Chromium binary found');
  const args = ['--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--no-first-run', '--mute-audio', '--disable-features=Translate,MediaRouter'];
  // Chromium refuses to run as root with its sandbox; elsewhere keep the
  // sandbox, but fall back without it when the kernel/AppArmor forbids the
  // user namespaces it needs (common on Ubuntu 24.04). JS is off and the
  // network is blocked either way.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const tryLaunch = (sandbox: boolean) => chromium.launch({ executablePath: found.path, headless: true, chromiumSandbox: sandbox, args, timeout: 30_000 });
  try {
    const b = await (isRoot || process.env.CHROMIUM_NO_SANDBOX === '1' ? tryLaunch(false) : tryLaunch(true).catch((err: any) => {
      console.warn(`[htmlPdf] Chromium sandbox unavailable (${String(err?.message ?? err).split('\n')[0]}) — retrying without it`);
      return tryLaunch(false);
    }));
    lastLaunchError = null;
    b.on('disconnected', () => { browserPromise = null; });
    return b;
  } catch (err: any) {
    lastLaunchError = String(err?.message ?? err).split('\n')[0].slice(0, 300);
    throw new HtmlPdfUnavailableError(`Chromium failed to start (${lastLaunchError})`);
  }
}

function browser(): Promise<any> {
  if (!browserPromise) browserPromise = launch().catch(err => { browserPromise = null; throw err; });
  return browserPromise;
}

/**
 * The slots are shared by every tenant on this instance. Without a bound, one
 * org's HR manager firing hundreds of sample-PDF requests (each up to the
 * render timeout) would queue every other org's payslip PDFs behind them for
 * as long as they liked. So the queue is capped and a waiter gives up after a
 * while with a "busy, try again" 503 instead of hanging.
 */
export const HTML_PDF_MAX_QUEUE = Math.max(1, Number(process.env.HTML_PDF_MAX_QUEUE) || 40);
const QUEUE_WAIT_MS = HTML_PDF_TIMEOUT_MS * 3;
const busy = () => new AppError(503, 'The PDF engine is busy right now — please try again in a minute.');

async function acquire() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (active >= HTML_PDF_CONCURRENCY) {
    if (waiters.length >= HTML_PDF_MAX_QUEUE) throw busy();
    await new Promise<void>((resolve, reject) => {
      const w = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(busy()); }, QUEUE_WAIT_MS);
      t.unref?.();
      waiters.push(w);
    });
  }
  active++;
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) { next(); return; }
  if (active === 0 && !idleTimer) { idleTimer = setTimeout(() => { idleTimer = null; void closeHtmlPdfBrowser(); }, IDLE_CLOSE_MS); idleTimer.unref(); }
}

export async function closeHtmlPdfBrowser() {
  const p = browserPromise; browserPromise = null;
  if (p) { try { await (await p).close(); } catch { /* already gone */ } }
}

// ─── Render ──────────────────────────────────────────────────────────────────

/**
 * Print one self-contained HTML document to an A4 PDF. The document's own
 * @page rule wins (preferCSSPageSize); the base CSS sets A4 / 12 mm.
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  await acquire();
  let context: any = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    const b = await browser();
    context = await b.newContext({ javaScriptEnabled: false, offline: true, acceptDownloads: false, serviceWorkers: 'block', bypassCSP: false });
    // Belt and braces with `offline`: nothing leaves the box (data: URIs are not requests).
    await context.route('**/*', (route: any) => route.abort('blockedbyclient'));
    const page = await context.newPage();
    const work = (async () => {
      await page.setContent(html, { waitUntil: 'load', timeout: HTML_PDF_TIMEOUT_MS });
      return page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: HTML_PDF_TIMEOUT_MS } as any) as Promise<Buffer>;
    })();
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new AppError(504, `Rendering the payslip PDF took longer than ${Math.round(HTML_PDF_TIMEOUT_MS / 1000)} s — simplify the template`)), HTML_PDF_TIMEOUT_MS); });
    const buf = await Promise.race([work, timeout]);
    return Buffer.from(buf);
  } finally {
    if (timer) clearTimeout(timer);
    if (context) { try { await context.close(); } catch { /* browser may have died */ } }
    release();
  }
}
