/**
 * Payslip logo watermark: option clamping/validation (utils/payslipWatermark.ts),
 * the SSRF-safe image loader (utils/safeImageLoader.ts — DNS and network are
 * mocked) and the HTML/PDF renderers with a watermark on.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import { z } from 'zod';
import {
  clampOpacity, clampSize, clampRotation, resolveWatermark, watermarkSchemaFields, imageUrlSchema, IMAGE_URL_MAX_CHARS,
} from '../../src/utils/payslipWatermark';
import {
  parseDataUrl, sniffImageKind, isPrivateAddress, fetchRemoteImage, loadImage, clearImageCache, ImageLoadError, type LoaderDeps,
} from '../../src/utils/safeImageLoader';
import { samplePayslipDoc, renderPayslipHtml, renderPayslipPdf, renderPayslipBundlePdf, LAYOUTS } from '../../src/utils/payslipRender';

// 1×1 PNG and a minimal JPEG header (sniffing only looks at magic bytes).
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_URL = `data:image/png;base64,${PNG_1PX.toString('base64')}`;
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

// ─── Option clamping / validation ────────────────────────────────────────────

test('opacity, size and rotation clamp into the allowed ranges', () => {
  assert.equal(clampOpacity(0.5), 0.3);
  assert.equal(clampOpacity(0), 0.03);
  assert.equal(clampOpacity('0.12'), 0.12);
  assert.equal(clampOpacity(undefined), 0.08);
  assert.equal(clampSize(5), 20);
  assert.equal(clampSize(120), 90);
  assert.equal(clampSize(55.6), 56);
  assert.equal(clampRotation(-90), -45);
  assert.equal(clampRotation(60), 45);
  assert.equal(clampRotation(-30), -30);
  assert.equal(clampRotation(NaN), 0);
});

const Schema = z.object({ logoUrl: imageUrlSchema.nullable().optional(), ...watermarkSchemaFields });

test('schema defaults keep the watermark off and use the documented defaults', () => {
  const v = Schema.parse({});
  assert.deepEqual(v, { watermarkEnabled: false, watermarkSource: 'LOGO', watermarkOpacity: 0.08, watermarkSize: 55, watermarkRotation: 0, watermarkRepeat: false });
});

test('schema clamps out-of-range numbers instead of failing, but rejects junk', () => {
  const v = Schema.parse({ watermarkEnabled: true, watermarkOpacity: 0.9, watermarkSize: 10, watermarkRotation: -60 });
  assert.equal(v.watermarkOpacity, 0.3); assert.equal(v.watermarkSize, 20); assert.equal(v.watermarkRotation, -45);
  assert.equal(Schema.safeParse({ watermarkOpacity: 'lots' }).success, false);
  assert.equal(Schema.safeParse({ watermarkSource: 'TEXT' }).success, false);
});

test('partial (update) schema leaves unspecified watermark fields untouched', () => {
  const v = Schema.partial().parse({ watermarkSize: 70 });
  assert.deepEqual(v, { watermarkSize: 70 });
});

test('image URL fields accept https, uploaded data URLs, and refuse oversize or odd schemes', () => {
  assert.ok(imageUrlSchema.safeParse('https://cdn.example.com/logo.png').success);
  assert.ok(imageUrlSchema.safeParse('http://legacy.example.com/logo.png').success, 'existing http logos keep working in HTML');
  assert.ok(imageUrlSchema.safeParse(PNG_URL).success);
  assert.ok(imageUrlSchema.safeParse(`data:image/png;base64,${'A'.repeat(500_000)}`).success, 'a few hundred KB upload is accepted');
  assert.equal(imageUrlSchema.safeParse(`data:image/png;base64,${'A'.repeat(IMAGE_URL_MAX_CHARS)}`).success, false);
  assert.equal(imageUrlSchema.safeParse('javascript:alert(1)').success, false);
  assert.equal(imageUrlSchema.safeParse('data:text/html;base64,PHNjcmlwdD4=').success, false);
  assert.equal(imageUrlSchema.safeParse('file:///etc/passwd').success, false);
});

test('resolveWatermark picks the logo or the separate image, and is null when there is nothing to draw', () => {
  assert.equal(resolveWatermark({ watermarkEnabled: false, logoUrl: PNG_URL }), null);
  assert.equal(resolveWatermark({ watermarkEnabled: true, watermarkSource: 'LOGO', logoUrl: null }), null);
  assert.equal(resolveWatermark({ watermarkEnabled: true, watermarkSource: 'IMAGE', logoUrl: PNG_URL, watermarkImageUrl: null }), null);
  const w = resolveWatermark({ watermarkEnabled: true, watermarkSource: 'IMAGE', logoUrl: 'https://a/logo.png', watermarkImageUrl: PNG_URL, watermarkOpacity: 2, watermarkSize: 55, watermarkRotation: -30, watermarkRepeat: true });
  assert.deepEqual(w, { url: PNG_URL, opacity: 0.3, size: 55, rotation: -30, repeat: true });
  assert.equal(resolveWatermark(null), null);
});

// ─── Data URLs ───────────────────────────────────────────────────────────────

test('parseDataUrl decodes PNG/JPEG data URLs and checks the bytes', () => {
  const png = parseDataUrl(PNG_URL);
  assert.equal(png.kind, 'png'); assert.equal(png.data.length, PNG_1PX.length);
  assert.equal(parseDataUrl(`data:image/jpeg;base64,${JPEG_HEAD.toString('base64')}`).kind, 'jpeg');
});

test('parseDataUrl rejects SVG/WebP, non-base64, mislabelled bytes and > 1 MB', () => {
  const bad = (u: string, re: RegExp) => assert.throws(() => parseDataUrl(u), (e: any) => e instanceof ImageLoadError && re.test(e.message));
  bad('data:image/svg+xml;base64,PHN2Zy8+', /Unsupported image type/);
  bad('data:image/webp;base64,UklGRg==', /Unsupported image type/);
  bad('data:image/png,%89PNG', /base64/);
  bad(`data:image/png;base64,${Buffer.from('hello world').toString('base64')}`, /not a PNG or JPEG/);
  bad(`data:image/png;base64,${Buffer.alloc(1024 * 1024 + 10).toString('base64')}`, /larger than 1 MB/);
  bad('data:image/png;base64,@@@@', /Invalid base64/);
  bad('nonsense', /Malformed/);
});

test('sniffImageKind recognises PNG and JPEG only', () => {
  assert.equal(sniffImageKind(PNG_1PX), 'png');
  assert.equal(sniffImageKind(JPEG_HEAD), 'jpeg');
  assert.equal(sniffImageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImageKind(Buffer.from('RIFF....WEBP')), null);
});

// ─── IP rules ────────────────────────────────────────────────────────────────

test('private, loopback, link-local and metadata addresses are blocked (v4, v6, mapped)', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::abcd', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
});

// ─── Remote fetch (mocked DNS + network) ─────────────────────────────────────

function response(status: number, headers: Record<string, string>, body: Buffer = Buffer.alloc(0)) {
  const r: any = Readable.from(body.length ? [body] : []);
  r.statusCode = status; r.headers = headers;
  return r;
}
function deps(dnsMap: Record<string, string[]>, handler: (url: URL, address: string) => any): LoaderDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lookup: async host => (dnsMap[host] ?? []).map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
    get: async (url, address) => { calls.push(`${url.href}@${address}`); return handler(url, address); },
  };
}

test('https PNG from a public host loads, pinned to the resolved address', async () => {
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, () => response(200, { 'content-type': 'image/png' }, PNG_1PX));
  const img = await fetchRemoteImage('https://cdn.example.com/logo.png', d);
  assert.equal(img.kind, 'png');
  assert.deepEqual(d.calls, ['https://cdn.example.com/logo.png@93.184.216.34']);
});

test('http, odd ports and credentials are refused without any network call', async () => {
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, () => response(200, { 'content-type': 'image/png' }, PNG_1PX));
  await assert.rejects(fetchRemoteImage('http://cdn.example.com/logo.png', d), /Only https/);
  await assert.rejects(fetchRemoteImage('https://cdn.example.com:8443/logo.png', d), /default https port/);
  await assert.rejects(fetchRemoteImage('https://u:p@cdn.example.com/logo.png', d), /Credentials/);
  assert.equal(d.calls.length, 0);
});

test('hosts resolving to private addresses (any record) are blocked — SSRF', async () => {
  const d = deps({ 'evil.example.com': ['93.184.216.34', '169.254.169.254'], 'intranet.example.com': ['10.0.0.5'] }, () => response(200, { 'content-type': 'image/png' }, PNG_1PX));
  await assert.rejects(fetchRemoteImage('https://evil.example.com/x.png', d), /Blocked address 169\.254\.169\.254/);
  await assert.rejects(fetchRemoteImage('https://intranet.example.com/x.png', d), /Blocked address 10\.0\.0\.5/);
  await assert.rejects(fetchRemoteImage('https://127.0.0.1/x.png', d), /Blocked address/);
  await assert.rejects(fetchRemoteImage('https://[::1]/x.png', d), /Blocked address/);
  await assert.rejects(fetchRemoteImage('https://localhost/x.png', d), /Blocked host/);
  assert.equal(d.calls.length, 0);
});

test('redirects are re-checked: a redirect to a private host or to http is refused', async () => {
  const d = deps({ 'cdn.example.com': ['93.184.216.34'], 'internal.example.com': ['192.168.0.10'] }, url =>
    url.pathname === '/a' ? response(302, { location: 'https://internal.example.com/secret.png' })
      : url.pathname === '/b' ? response(301, { location: 'http://cdn.example.com/x.png' })
        : url.pathname === '/c' ? response(302, { location: '/ok.png' })
          : response(200, { 'content-type': 'image/png' }, PNG_1PX));
  await assert.rejects(fetchRemoteImage('https://cdn.example.com/a', d), /Blocked address 192\.168\.0\.10/);
  await assert.rejects(fetchRemoteImage('https://cdn.example.com/b', d), /Only https/);
  assert.equal((await fetchRemoteImage('https://cdn.example.com/c', d)).kind, 'png');
});

test('content-type must be PNG/JPEG and the bytes must match; SVG/WebP are skipped', async () => {
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, url =>
    url.pathname === '/svg' ? response(200, { 'content-type': 'image/svg+xml' }, Buffer.from('<svg/>'))
      : url.pathname === '/webp' ? response(200, { 'content-type': 'image/webp' }, Buffer.from('RIFF'))
        : url.pathname === '/lie' ? response(200, { 'content-type': 'image/png' }, Buffer.from('<html>not an image</html>'))
          : url.pathname === '/404' ? response(404, { 'content-type': 'text/html' })
            : response(200, { 'content-type': 'image/jpeg; charset=binary' }, JPEG_HEAD));
  await assert.rejects(fetchRemoteImage('https://cdn.example.com/svg', d), /Unsupported content-type image\/svg\+xml/);
  await assert.rejects(fetchRemoteImage('https://cdn.example.com/webp', d), /Unsupported content-type image\/webp/);
  await assert.rejects(fetchRemoteImage('https://cdn.example.com/lie', d), /not a PNG or JPEG/);
  await assert.rejects(fetchRemoteImage('https://cdn.example.com/404', d), /HTTP 404/);
  assert.equal((await fetchRemoteImage('https://cdn.example.com/ok.jpg', d)).kind, 'jpeg');
});

test('bodies over 2 MB are cut off (declared or streamed)', async () => {
  const big = Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024)]);
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, url =>
    url.pathname === '/declared' ? response(200, { 'content-type': 'image/png', 'content-length': String(big.length) }, big)
      : response(200, { 'content-type': 'image/png' }, big));
  await assert.rejects(fetchRemoteImage('https://cdn.example.com/declared', d), /larger than 2 MB/);
  await assert.rejects(fetchRemoteImage('https://cdn.example.com/streamed', d), /larger than 2 MB/);
});

test('slow hosts time out', async () => {
  const d: LoaderDeps = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    get: (_u, _a, _f, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
  };
  await assert.rejects(fetchRemoteImage('https://slow.example.com/x.png', d, { timeoutMs: 50 }), /Timed out after 50 ms/);
});

test('loadImage never throws, returns null for bad images and caches by URL (failures too)', async () => {
  clearImageCache();
  let n = 0;
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, url => { n++; return url.pathname === '/bad' ? response(500, {}) : response(200, { 'content-type': 'image/png' }, PNG_1PX); });
  assert.equal(await loadImage(null, d), null);
  assert.equal(await loadImage('http://cdn.example.com/x.png', d), null);
  assert.equal((await loadImage('https://cdn.example.com/ok.png', d))?.kind, 'png');
  await loadImage('https://cdn.example.com/ok.png', d);
  assert.equal(await loadImage('https://cdn.example.com/bad', d), null);
  assert.equal(await loadImage('https://cdn.example.com/bad', d), null);
  assert.equal(n, 2, 'one network call per URL');
  assert.equal((await loadImage(PNG_URL, d))?.kind, 'png');
});

// ─── Renderers ───────────────────────────────────────────────────────────────

const org = { name: 'Zenkara Tech Service Pvt. Ltd.', currency: 'INR' };
const tpl = (extra: any = {}) => ({ layout: 'STANDARD', logoUrl: PNG_URL, watermarkEnabled: true, watermarkSource: 'LOGO', watermarkOpacity: 0.1, watermarkSize: 50, watermarkRotation: -30, watermarkRepeat: false, ...extra });

test('HTML: no watermark markup unless enabled; single mark is an <img> behind the content', () => {
  assert.ok(!renderPayslipHtml(samplePayslipDoc({ layout: 'STANDARD', logoUrl: PNG_URL }, org)).includes('class="wm'));
  const html = renderPayslipHtml(samplePayslipDoc(tpl(), org), { embed: true });
  assert.match(html, /<div class="wm" aria-hidden="true"><img src="data:image\/png;base64,[^"]+" alt="" style="width:50%;opacity:0.1;transform:translate\(-50%,-50%\) rotate\(-30deg\)">/);
  assert.match(html, /print-color-adjust:exact/);
  assert.match(html, /pointer-events:none/);
});

test('HTML: tiled mode uses one SVG pattern (URL appears once per pattern image), MINIMAL is greyscale', () => {
  const html = renderPayslipHtml(samplePayslipDoc(tpl({ watermarkRepeat: true, layout: 'MINIMAL' }), org), { embed: true });
  assert.match(html, /<div class="wm mono"/);
  assert.match(html, /patternTransform="rotate\(-30\)"/);
  assert.equal(html.split(PNG_URL).length - 1, 3, 'three <image> refs in the brick pattern, not one per tile');
});

test('HTML: the watermark URL is escaped', () => {
  const html = renderPayslipHtml(samplePayslipDoc(tpl({ logoUrl: 'https://x.example/a.png?"><script>' }), org));
  assert.ok(!html.includes('"><script>'));
});

test('PDF renders for every layout with a data-URL watermark, logo and signature (single + tiled)', async () => {
  for (const l of LAYOUTS) {
    for (const repeat of [false, true]) {
      const buf = await renderPayslipPdf(samplePayslipDoc(tpl({ layout: l.key, watermarkRepeat: repeat, signatureUrl: PNG_URL, signatoryName: 'Bharath' }), org));
      assert.equal(buf.subarray(0, 5).toString(), '%PDF-', l.key);
      assert.match(buf.toString('latin1'), /\/Subtype \/Image/, `${l.key} embeds an image`);
    }
  }
});

test('PDF still renders (without images) when the image cannot be loaded', async () => {
  const buf = await renderPayslipPdf(samplePayslipDoc(tpl({ logoUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }), org));
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.doesNotMatch(buf.toString('latin1'), /\/Subtype \/Image/);
});

test('bundle PDF embeds a shared watermark image once, not once per payslip', async () => {
  const images = async (count: number) => {
    const s = (await renderPayslipBundlePdf(Array.from({ length: count }, () => samplePayslipDoc(tpl({ watermarkRepeat: true }), org)))).toString('latin1');
    assert.equal((s.match(/\/Type \/Page\b/g) ?? []).length, count);
    return (s.match(/\/Subtype \/Image/g) ?? []).length; // image (+ its alpha SMask)
  };
  assert.equal(await images(3), await images(1));
});
