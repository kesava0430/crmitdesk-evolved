/**
 * The one place that decides HOW a payslip document becomes HTML or PDF:
 *
 *   built-in layout  → renderPayslipHtml / renderPayslipPdf (PDFKit) — unchanged
 *   CUSTOM_HTML      → renderCustomPayslipHtml (sanitized, isolated document)
 *                      and, for PDF, headless Chromium (utils/htmlPdf.ts)
 *
 * Every caller (print view, downloads, run bundles, e-mailed payslips,
 * template previews) goes through here, so a custom template is used
 * everywhere or — when Chromium is missing — fails loudly with a 503. It is
 * never quietly swapped for a built-in layout.
 */
import { PDFDocument } from 'pdf-lib';
import { renderPayslipHtml, renderPayslipPdf, renderPayslipBundlePdf, type PayslipDoc } from './payslipRender';
import { renderCustomPayslipHtml } from './payslipHtmlTemplate';
import { htmlToPdf, HTML_PDF_CONCURRENCY } from './htmlPdf';
import { loadImage } from './safeImageLoader';

export const isCustomDoc = (doc: PayslipDoc) => !!doc.custom;

/**
 * HTML for the in-app view. `isolated: true` means the string is a complete
 * document the client must show in a sandboxed iframe (srcdoc), never inject.
 */
export function renderDocHtml(doc: PayslipDoc, opts: { embed?: boolean } = {}): { html: string; isolated: boolean } {
  if (doc.custom) return { html: renderCustomPayslipHtml(doc, { target: 'browser' }), isolated: true };
  return { html: renderPayslipHtml(doc, opts), isolated: false };
}

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)(?:;[a-z0-9=.+-]+)*;base64,/i;

/**
 * Chromium renders with the network blocked, so the template's images are
 * fetched here first — through the SSRF-safe loader the PDFKit path uses —
 * and handed over as data: URIs. An image that can't be loaded is left out
 * ('' — so {{#if org.logo}} is false), exactly like the built-in PDF.
 */
async function inline(url: string | null | undefined): Promise<string> {
  if (!url) return '';
  if (DATA_IMAGE.test(url)) return url;
  const img = await loadImage(url);
  return img ? `data:image/${img.kind};base64,${img.data.toString('base64')}` : '';
}

export async function customPdfHtml(doc: PayslipDoc): Promise<string> {
  const [logo, signature, watermark] = await Promise.all([
    inline(doc.company.logoUrl), doc.brand.showSignature ? inline(doc.brand.signatureUrl) : Promise.resolve(''), doc.watermark ? inline(doc.watermark.url) : Promise.resolve(''),
  ]);
  return renderCustomPayslipHtml(doc, { target: 'pdf', images: { logo, signature, watermark } });
}

export async function renderDocPdf(doc: PayslipDoc): Promise<Buffer> {
  if (!doc.custom) return renderPayslipPdf(doc);
  return htmlToPdf(await customPdfHtml(doc));
}

/**
 * One PDF for a run. All built-in → the existing single PDFKit document
 * (byte-for-byte what it was). Any custom-HTML payslip in the run → each run
 * of consecutive built-in payslips is still one PDFKit document, each custom
 * payslip is a Chromium PDF, and the pieces are stitched in order with pdf-lib.
 */
export async function renderDocsBundlePdf(docs: PayslipDoc[]): Promise<Buffer> {
  if (!docs.some(isCustomDoc)) return renderPayslipBundlePdf(docs);
  // Custom pages render in a small worker pool (same width as htmlPdf's
  // concurrency limit) while PDFKit draws the rest; the first failure stops
  // the pool, so a missing Chromium fails a 300-payslip bundle once, not 300 times.
  const customs = docs.filter(isCustomDoc);
  const done = new Map<PayslipDoc, Buffer>();
  let failure: unknown = null; let next = 0;
  const worker = async () => {
    while (!failure && next < customs.length) {
      const d = customs[next++];
      try { done.set(d, await renderDocPdf(d)); } catch (e) { failure = failure ?? e; }
    }
  };
  const pool = Promise.all(Array.from({ length: Math.min(HTML_PDF_CONCURRENCY, customs.length) }, worker));
  const parts: Buffer[] = [];
  let builtIn: PayslipDoc[] = [];
  const builtInParts = new Map<number, Buffer>();
  // PDFKit groups first (cheap, in-process), then wait for the pool and stitch in order.
  const order: (PayslipDoc | number)[] = [];
  for (const d of docs) {
    if (!d.custom) { builtIn.push(d); continue; }
    if (builtIn.length) { const i = order.length; builtInParts.set(i, await renderPayslipBundlePdf(builtIn)); order.push(i); builtIn = []; }
    order.push(d);
  }
  if (builtIn.length) { const i = order.length; builtInParts.set(i, await renderPayslipBundlePdf(builtIn)); order.push(i); builtIn = []; }
  await pool;
  if (failure) throw failure;
  for (const o of order) parts.push(typeof o === 'number' ? builtInParts.get(o)! : done.get(o)!);
  const out = await PDFDocument.create();
  out.setTitle('Payslips');
  for (const p of parts) {
    const src = await PDFDocument.load(p);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return Buffer.from(await out.save());
}
