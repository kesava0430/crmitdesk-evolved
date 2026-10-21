/**
 * Custom HTML payslip templates: the placeholder language, the sanitizer
 * (every blocked vector), size limits, the final document and — when a
 * Chromium binary is available — the PDF path with JS off and the network
 * blocked (utils/payslipHtmlTemplate.ts, utils/htmlPdf.ts, utils/payslipOutput.ts).
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { PDFDocument } from 'pdf-lib';
import {
  renderTemplate, validateTemplate, buildTemplateContext, sanitizeTemplateHtml, sanitizeCss, checkTemplateSource, renderCustomPayslipHtml,
  Money, escapeCssValue, TemplateRenderError, PLACEHOLDERS, STARTER_HTML, STARTER_CSS, HTML_TEMPLATE_MAX_BYTES,
} from '../../src/utils/payslipHtmlTemplate';
import { samplePayslipDoc, buildPayslipDoc, renderPayslipHtml, renderPayslipPdf, LAYOUTS, PAYSLIP_FIELDS, type PayslipDoc } from '../../src/utils/payslipRender';
import { renderDocHtml, renderDocPdf, renderDocsBundlePdf, customPdfHtml, renderDocHtmlForClient, UPDATE_APP_NOTICE_HTML } from '../../src/utils/payslipOutput';
import { findChromium, htmlToPdf, closeHtmlPdfBrowser, htmlPdfStatus } from '../../src/utils/htmlPdf';

const org = { name: 'Zenkara Tech', currency: 'INR' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const tpl = (htmlBody: string, extra: Record<string, unknown> = {}) => ({ layout: 'CUSTOM_HTML', htmlBody, htmlCss: null, ...extra });
const doc = (htmlBody: string, extra: Record<string, unknown> = {}) => samplePayslipDoc(tpl(htmlBody, extra), org);
const save = { mode: 'save' as const };
const render = (allowedImageUrls: string[] = []) => ({ mode: 'render' as const, allowedImageUrls });

// ─── Placeholder renderer ────────────────────────────────────────────────────

test('values are HTML-escaped by default', () => {
  const out = renderTemplate('<p>{{employee.name}}</p>', { employee: { name: '<img src=x onerror=alert(1)> & "q" \'s`' } });
  assert.equal(out, '<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot; &#39;s&#96;</p>');
});

test('nested paths, missing values print blank, numbers and flags print', () => {
  assert.equal(renderTemplate('{{employee.name}}|{{employee.pan}}|{{attendance.paid}}', { employee: { name: 'A' }, attendance: null }), 'A||');
  assert.equal(renderTemplate('{{payslip.isPaid}}', { payslip: { isPaid: true } }), 'true');
  assert.equal(renderTemplate('{{payslip.isPaid}}', { payslip: { isPaid: false } }), '');
});

test('loops: item fields, loop variables, outer values, else branch', () => {
  const ctx = { employee: { name: 'Priya' }, earnings: [{ name: 'Basic', amount: new Money(30000, '30,000.00') }, { name: 'HRA', amount: new Money(12000, '12,000.00') }], deductions: [] };
  assert.equal(renderTemplate('{{#each earnings}}{{@number}}.{{name}}={{amount}}({{employee.name}}){{#if @last}}!{{else}}, {{/if}}{{/each}}', ctx), '1.Basic=30,000.00(Priya), 2.HRA=12,000.00(Priya)!');
  assert.equal(renderTemplate('{{#each deductions}}x{{else}}none{{/each}}', ctx), 'none');
  assert.equal(renderTemplate('{{#each revisionLines}}[{{this}}]{{/each}}', { revisionLines: ['a', 'b'] }), '[a][b]');
  assert.equal(renderTemplate('{{#each earnings}}{{@index}}{{#if @first}}F{{/if}}{{/each}}', ctx), '0F1');
});

test('conditionals: lists, money (non-zero), text, objects, unless, else', () => {
  const ctx = { loans: [], earnings: [1], totals: { unrecovered: new Money(0, '₹0.00'), net: new Money(5, '₹5.00') }, brand: { headerNote: '' }, revision: null };
  assert.equal(renderTemplate('{{#if loans}}L{{else}}noL{{/if}}{{#if earnings}}E{{/if}}', ctx), 'noLE');
  assert.equal(renderTemplate('{{#if totals.unrecovered}}U{{/if}}{{#if totals.net}}N{{/if}}', ctx), 'N');
  assert.equal(renderTemplate('{{#unless brand.headerNote}}no-note{{/unless}}{{#if revision}}R{{else}}orig{{/if}}', ctx), 'no-noteorig');
});

test('unknown placeholders are validation errors with line numbers — never silently blank', () => {
  const v = validateTemplate('<p>{{employee.name}}</p>\n<p>{{employee.salary}}</p>\n{{#each earnings}}{{nme}}{{/each}}\n{{name}}');
  assert.deepEqual(v.unknown.sort(), ['employee.salary', 'name', 'nme']);
  assert.equal(v.errors.find(e => e.message.includes('employee.salary'))!.line, 2);
  assert.match(v.errors.find(e => e.message.includes('{{name}}'))!.message, /inside \{\{#each/);
  assert.throws(() => renderTemplate('{{employee.salary}}', {}), TemplateRenderError);
});

test('structural errors: unclosed / mismatched blocks, triple braces, expressions, misuse of lists', () => {
  const msg = (s: string) => validateTemplate(s).errors.map(e => e.message).join(' | ');
  assert.match(msg('{{#each earnings}}x'), /never closed/);
  assert.match(msg('{{#if loans}}x{{/each}}'), /closes \{\{#if loans\}\}/);
  assert.match(msg('{{/if}}'), /no matching/);
  assert.match(msg('{{{employee.name}}}'), /Triple braces/);
  assert.match(msg('{{employee.name | upper}}'), /not a placeholder/);
  assert.match(msg('{{#with employee}}{{/with}}'), /Unknown block/);
  assert.match(msg('{{earnings}}'), /is a list/);
  assert.match(msg('{{#each employee.name}}{{/each}}'), /not a list/);
  assert.match(msg('{{#if a}}{{else}}{{else}}{{/if}}'), /Two \{\{else\}\}/);
  assert.match(msg('{{@index}}'), /only inside/);
  assert.equal(validateTemplate('{{! a comment }}{{employee.name}}').errors.length, 0);
});

test('minified CSS with a placeholder right before a closing brace is fine', () => {
  assert.equal(renderTemplate('.t{color:{{brand.primaryColor}}}', { brand: { primaryColor: '#ff0000' } }, escapeCssValue), '.t{color:#ff0000}');
});

test('lenient (preview) mode marks unknown placeholders instead of throwing', () => {
  assert.equal(renderTemplate('{{employee.salary}}-{{employee.name}}', { employee: { name: 'A' } }, undefined, { lenient: true }), '⟦employee.salary?⟧-A');
});

test('context covers the PayslipDoc: money formatting, words, unrecovered, bank/PAN, loans, employer, attendance', () => {
  const d = doc('x');
  const c: any = buildTemplateContext(d);
  assert.equal(String(c.totals.net), '₹40,727.27');
  assert.equal(String(c.totals.netAmount), '40,727.27');
  assert.match(c.totals.netInWords, /^Rupees Forty Thousand Seven Hundred Twenty Seven and Twenty Seven Paise Only$/);
  assert.equal(String(c.earnings[0].amount), '30,000.00');
  assert.equal(String(c.earnings[0].amountWithCurrency), '₹30,000.00');
  assert.equal(c.employee.bankAccount, 'XXXXXXXXXX6789');
  assert.equal(c.employee.pan, 'ABCDE1234F');
  assert.equal(String(c.loans[0].outstanding), '35,000.00');
  assert.equal(c.employerContributions.length, 1);
  assert.ok(c.attendanceTiles.some((t: any) => t.label === 'LOP days' && t.negative));
  assert.equal(c.payslip.isPaid, true);
  // Unrecovered amount (net floored at 0)
  const p = { payslipNumber: 'P1', month: 9, year: 2026, status: 'GENERATED', netPay: 0, totalEarnings: 1000, totalDeductions: 1000, unrecoveredDeductions: 250, lines: [{ code: 'B', name: 'Basic', category: 'EARNING', amount: 1000, displayOrder: 1 }] };
  const c2: any = buildTemplateContext(buildPayslipDoc({ payslip: p, template: tpl('x'), employee: null, org }));
  assert.equal(String(c2.totals.unrecovered), '₹250.00');
  assert.match(c2.totals.equation, /Unrecovered ₹250\.00/);
  assert.equal(renderTemplate('{{#if totals.unrecovered}}U{{/if}}', c2), 'U');
});

test('Fields tab acts as redaction: switched-off fields render blank', () => {
  const c: any = buildTemplateContext(doc('x', { showFields: { statutoryIds: false, bankDetails: false, ctc: false, amountInWords: false, employerContributions: false, daysSummary: false, lineBasis: false } }));
  assert.equal(c.employee.pan, ''); assert.equal(c.employee.uan, ''); assert.equal(c.employee.bankAccount, ''); assert.equal(c.employee.ctcAnnual, '');
  assert.equal(c.totals.netInWords, ''); assert.deepEqual(c.employerContributions, []); assert.equal(c.attendance, null); assert.deepEqual(c.attendanceTiles, []);
  assert.equal(c.earnings[1].basis, '');
  assert.equal(c.show.statutoryIds, false); assert.equal(c.show.employeeCode, true);
  assert.ok(!c.paymentDetails.some((r: any) => r.label === 'PAN'));
});

test('every catalogue placeholder validates (in its scope) and the starter template is clean', () => {
  for (const p of PLACEHOLDERS) {
    if (p.type === 'list' || p.type === 'object') continue;
    const src = p.list === '*' ? `{{#each earnings}}{{${p.path}}}{{/each}}` : p.list ? `{{#each ${p.list}}}{{${p.path}}}{{/each}}` : `{{${p.path}}}`;
    assert.deepEqual(validateTemplate(src).errors, [], p.path);
  }
  for (const f of PAYSLIP_FIELDS) assert.ok(PLACEHOLDERS.some(p => p.path === `show.${f.key}`));
  const r = checkTemplateSource(STARTER_HTML, STARTER_CSS);
  assert.deepEqual(r.errors, []); assert.deepEqual(r.removed, []);
  assert.equal(r.htmlBody, STARTER_HTML, 'clean source is stored exactly as typed');
});

// ─── Sanitizer ───────────────────────────────────────────────────────────────

const clean = (html: string, p: any = render()) => sanitizeTemplateHtml(html, p).html;

test('sanitizer blocks scripts, event handlers and active content', () => {
  const vectors: [string, RegExp][] = [
    ['<script>alert(1)</script><p>ok</p>', /<script|alert/i],
    ['<img src=x onerror="alert(1)">', /onerror|src=/i],
    ['<svg onload="alert(1)"><circle/></svg>', /svg|onload/i],
    ['<svg><script>alert(1)</script></svg>', /svg|script|alert/i],
    ['<a href="javascript:alert(1)">x</a>', /javascript/i],
    ['<a href="JaVaScRiPt&colon;alert(1)">x</a>', /javascript|alert/i],
    ['<iframe src="https://evil.example"></iframe>', /iframe|evil/i],
    ['<object data="x.swf"></object><embed src="x.swf">', /object|embed|swf/i],
    ['<form action="https://evil.example"><input name=p></form>', /form|input|evil/i],
    ['<meta http-equiv="refresh" content="0;url=https://evil.example">', /meta|refresh|evil/i],
    ['<base href="https://evil.example/">', /base|evil/i],
    ['<link rel="stylesheet" href="https://evil.example/x.css">', /link|evil/i],
    ['<div onclick="x()" onmouseover="y()">t</div>', /onclick|onmouseover/i],
    ['<math><mtext><img src=x onerror=alert(1)></mtext></math>', /onerror|math/i],
    ['<template><img src=x onerror=1></template>', /onerror|template/i],
    ['<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', /onerror/i],
    ['<button formaction="javascript:1">b</button>', /button|javascript/i],
  ];
  for (const [input, bad] of vectors) {
    const out = clean(input);
    assert.doesNotMatch(out, bad, `${input} → ${out}`);
    assert.doesNotMatch(clean(input, save), bad, `save: ${input}`);
  }
  assert.match(clean('<script>x</script><p>ok</p>'), /<p>ok<\/p>/);
});

test('sanitizer keeps layout, tables, inline styles and classes', () => {
  const html = '<div class="a" style="color:#111;padding:4px"><table border="1" cellpadding="2"><tr><td colspan="2" class="am">1</td></tr></table><h1>T</h1><strong>b</strong><img src="' + PNG + '" alt="l" width="40"></div>';
  const out = clean(html);
  for (const s of ['class="a"', 'style="color:#111;padding:4px"', 'colspan="2"', 'cellpadding="2"', '<h1>T</h1>', '<strong>b</strong>', 'src="data:image/png;base64,', 'width="40"']) assert.ok(out.includes(s), s);
});

test('images: data: URIs and the template\'s own assets only — no external fetches', () => {
  assert.doesNotMatch(clean('<img src="https://evil.example/t.png">'), /evil/);
  assert.doesNotMatch(clean('<img src="http://169.254.169.254/latest">'), /169\.254/);
  assert.doesNotMatch(clean('<img src="//evil.example/t.png">'), /evil/);
  assert.match(clean('<img src="https://cdn.acme.in/logo.png">', render(['https://cdn.acme.in/logo.png'])), /cdn\.acme\.in/);
  // Save mode: an image placeholder is allowed as src (value unknown until render); arbitrary URLs are not.
  assert.match(clean('<img src="{{org.logo}}">', save), /src="\{\{org\.logo\}\}"/);
  assert.doesNotMatch(clean('<img src="{{employee.name}}">', save), /src=/);
  assert.doesNotMatch(clean('<img src="https://evil.example/{{org.logo}}">', save), /evil/);
  assert.doesNotMatch(clean('<img src="data:text/html;base64,PHNjcmlwdD4=">'), /data:text/);
});

test('CSS: external url(), @import, image-set, expression, behavior and escapes are removed', () => {
  const cases = [
    'body{background:url(http://evil.example/x.png)}', 'body{background:url("https://evil.example/x.png")}', "body{background:URL( 'https://evil.example' )}",
    '@import url(https://evil.example/x.css);', '@import "https://evil.example/x.css";', 'div{background-image:image-set("https://evil.example/a.png" 1x)}',
    'div{width:expression(alert(1))}', 'div{behavior:url(x.htc)}', 'div{-moz-binding:url(https://evil.example/x.xml#x)}',
    'div{background:u\\72l(https://evil.example)}', 'div{background:/**/url(https://evil.example)}', 'div{background:url(https://evil.example/a.png',
    '@font-face{font-family:x;src:url(https://evil.example/f.woff)}', 'div{background:src("https://evil.example")}',
  ];
  for (const c of cases) {
    const out = sanitizeCss(c, render()).css;
    // Nothing that can fetch survives: no url()/image-set()/src()/@import with an external target, no active CSS.
    assert.doesNotMatch(out, /(?:url|image-set|src)\s*\([^)]*evil|@import|expression\(|behavior:|-moz-binding:|\\/i, `${c} → ${out}`);
  }
  assert.match(sanitizeCss(`div{background:url(${PNG})}`, render()).css, /url\("data:image\/png;base64,/);
  assert.match(sanitizeCss('.a > .b { color: red }', render()).css, /\.a > \.b/);
  // In <style> blocks and style="" attributes too; "</style>" can't break out.
  const out = clean('<style>body{background:url(https://evil.example/x)} p{color:red}</style></style><script>alert(1)</script><p style="background:url(https://evil.example/y);color:blue">x</p>');
  assert.doesNotMatch(out, /evil|script/);
  assert.match(out, /p\{color:red\}/); assert.match(out, /color:blue/);
  assert.doesNotMatch(clean('<style>p{}</style x><style>a{content:"</style><script>alert(1)</script>"}</style>'), /<script/);
  // entity-encoded url in a style attribute is decoded before checking
  assert.doesNotMatch(clean('<p style="background:u&#114;l(https://evil.example)">x</p>'), /evil/);
});

test('save reports what was removed and stores the cleaned source; clean source is stored verbatim', () => {
  const r = checkTemplateSource('<p onclick="x()">{{employee.name}}</p><script>1</script>&nbsp;<br>', null);
  assert.deepEqual(r.errors, []);
  assert.ok(r.removed.some(x => /onclick/.test(x)) && r.removed.some(x => /<script>/.test(x)));
  assert.doesNotMatch(r.htmlBody, /onclick|script/);
  const ok = checkTemplateSource('<p>{{employee.name}}&nbsp;<br></p>', 'p{color:{{brand.primaryColor}}}');
  assert.equal(ok.htmlBody, '<p>{{employee.name}}&nbsp;<br></p>');
  assert.equal(ok.htmlCss, 'p{color:{{brand.primaryColor}}}');
});

test('size limit: HTML + CSS over 200 KB is rejected', () => {
  const big = '<p>' + 'x'.repeat(HTML_TEMPLATE_MAX_BYTES) + '</p>';
  assert.match(checkTemplateSource(big, null).errors[0].message, /limit is 200 KB/);
  assert.match(checkTemplateSource('<p>a</p>', 'p{}' + ' '.repeat(HTML_TEMPLATE_MAX_BYTES)).errors[0].message, /limit is 200 KB/);
  assert.match(checkTemplateSource('   ', null).errors[0].message, /empty/);
});

test('render-time sanitizing catches markup that reached the DB around the API', () => {
  // e.g. a row written by SQL: the stored source contains a script and an external image.
  const d = doc('<p>{{employee.name}}</p><script>alert(1)</script><img src="https://evil.example/p.png"><img src="{{org.logo}}">', { logoUrl: 'https://cdn.acme.in/logo.png' });
  const html = renderCustomPayslipHtml(d, { target: 'browser' });
  assert.doesNotMatch(html, /alert|evil/);
  assert.match(html, /src="https:\/\/cdn\.acme\.in\/logo\.png"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  // Values that look like markup are escaped, and a value can't smuggle an image URL in.
  const d2 = buildPayslipDoc({ payslip: { payslipNumber: 'P', month: 1, year: 2026, status: 'GENERATED', lines: [], user: { name: '<script>alert(1)</script>' } }, template: tpl('<b>{{employee.name}}</b>'), employee: null, org });
  assert.match(renderCustomPayslipHtml(d2, { target: 'browser' }), /<b>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/b>/);
  // PDF target: only data: images survive (the logo is inlined by payslipOutput before this point).
  assert.doesNotMatch(renderCustomPayslipHtml(d, { target: 'pdf' }), /cdn\.acme\.in/);
  assert.match(renderCustomPayslipHtml(d, { target: 'pdf', images: { logo: PNG } }), /src="data:image\/png/);
  assert.match(renderCustomPayslipHtml(d, { target: 'pdf' }), /img-src data:;/);
});

test('watermark renders behind custom HTML when enabled', () => {
  const html = renderCustomPayslipHtml(doc('<p>x</p>', { logoUrl: PNG, watermarkEnabled: true }), { target: 'browser' });
  assert.match(html, /class="wm"/);
  assert.doesNotMatch(renderCustomPayslipHtml(doc('<p>x</p>', { logoUrl: PNG }), { target: 'browser' }), /class="wm"/);
});

test('built-in renderers refuse a custom doc (no silent fallback) and built-in layouts are untouched', async () => {
  const d = doc('<p>x</p>');
  assert.throws(() => renderPayslipHtml(d), /built-in renderer/);
  await assert.rejects(() => renderPayslipPdf(d), /built-in renderer/);
  for (const l of LAYOUTS) {
    const b = samplePayslipDoc({ layout: l.key }, org);
    assert.equal(b.custom, null);
    assert.deepEqual(renderDocHtml(b, { embed: true }), { html: renderPayslipHtml(b, { embed: true }), isolated: false });
  }
  assert.equal(renderDocHtml(d).isolated, true);
});

// ─── PDF through Chromium (skipped when no browser is installed) ─────────────

const chromium = findChromium();
// The two real-render tests launch a browser. They run locally and wherever
// HTML_PDF_TESTS=1 is set, but not on CI runners by default: a runner's
// Chrome/sandbox setup is outside our control, and a flaky browser launch
// there would block every deploy.
const runBrowser = !!chromium && (!process.env.CI || process.env.HTML_PDF_TESTS === '1');
const pdfText = (b: Buffer) => b.toString('latin1');

test('htmlPdfStatus reports availability', () => {
  assert.equal(htmlPdfStatus().available, !!chromium);
});

test('Chromium PDF: JS disabled and every network request blocked', { skip: !runBrowser && 'no Chromium binary (or CI without HTML_PDF_TESTS=1)' }, async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('x'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  try {
    // Raw, UNSANITIZED HTML — this tests the browser-level isolation on its own.
    const html = `<!doctype html><html><head><link rel="stylesheet" href="http://127.0.0.1:${port}/a.css"><style>@import url(http://127.0.0.1:${port}/b.css); body{background:url(http://127.0.0.1:${port}/c.png)}</style></head>
      <body><img src="http://127.0.0.1:${port}/d.png"><iframe src="http://127.0.0.1:${port}/e"></iframe><script>document.body.innerHTML='JS-RAN';fetch('http://127.0.0.1:${port}/f')</script><p>STATIC-TEXT</p></body></html>`;
    const pdf = await htmlToPdf(html);
    assert.equal(pdfText(pdf).slice(0, 5), '%PDF-');
    assert.equal(hits, 0, 'no request may leave the renderer');
  } finally { server.close(); }
});

test('Chromium PDF: custom payslip, bundle mixing built-in + custom, render is A4', { skip: !runBrowser && 'no Chromium binary (or CI without HTML_PDF_TESTS=1)' }, async () => {
  const d = doc(STARTER_HTML, { htmlCss: STARTER_CSS, logoUrl: PNG, signatureUrl: PNG });
  const html = await customPdfHtml(d);
  assert.match(html, /src="data:image\/png/);
  const pdf = await renderDocPdf(d);
  assert.match(pdfText(pdf), /\/MediaBox \[0 0 59[45]\.\d+ 841\.\d+\]/);
  const std = samplePayslipDoc({ layout: 'STANDARD' }, org);
  const bundle = await renderDocsBundlePdf([std, d, std] as PayslipDoc[]);
  const pages = (await PDFDocument.load(bundle)).getPageCount();
  const customPages = (await PDFDocument.load(pdf)).getPageCount();
  assert.equal(pages, 2 + customPages);
});

test('no Chromium: a custom-HTML PDF fails with a clear 503 — never a built-in layout instead', async () => {
  assert.equal(findChromium({ CHROMIUM_PATH: '/nonexistent/chrome' } as any), null);
  await closeHtmlPdfBrowser();
  const prev = process.env.CHROMIUM_PATH;
  process.env.CHROMIUM_PATH = '/nonexistent/chrome';
  try {
    assert.equal(htmlPdfStatus().available, false);
    assert.match(htmlPdfStatus().detail, /playwright-core install --with-deps chromium-headless-shell/);
    await assert.rejects(() => renderDocPdf(doc('<p>{{employee.name}}</p>')), (e: any) => e.statusCode === 503 && /PDF engine isn't available/.test(e.message));
    await assert.rejects(() => renderDocsBundlePdf([samplePayslipDoc({ layout: 'STANDARD' }, org), doc('<p>x</p>')]), (e: any) => e.statusCode === 503);
    // Built-in layouts are unaffected.
    assert.equal((await renderDocPdf(samplePayslipDoc({ layout: 'STANDARD' }, org))).subarray(0, 5).toString(), '%PDF-');
  } finally { if (prev === undefined) delete process.env.CHROMIUM_PATH; else process.env.CHROMIUM_PATH = prev; }
});

test.after(() => closeHtmlPdfBrowser());

// ─── SEC-HTML: the template language must not block the API's event loop ────
// Before the fix each of these took 5–35 s (or effectively forever) on the
// single Node thread every tenant shares; an HR manager could trigger them from
// the live editor preview. Each must now finish well under a second.
const fast = (label: string, f: () => unknown, ms = 1500) => {
  const t0 = Date.now(); try { f(); } catch { /* a clean rejection is fine */ }
  const took = Date.now() - t0;
  assert.ok(took < ms, `${label} took ${took} ms`);
};

test('SEC-HTML: 200 KB of unclosed "{{" is linear (was ~21 s)', () => {
  fast('unclosed braces', () => checkTemplateSource('{{'.repeat(100_000), null));
});

test('SEC-HTML: tens of thousands of placeholders validate quickly (line numbers were O(n²), ~5 s)', () => {
  fast('many placeholders', () => validateTemplate('{{org.name}}\n'.repeat(15_000)));
  const r = validateTemplate('a\nb\n{{nope}}\n{{org.name}}');
  assert.equal(r.errors[0].line, 3);
});

test('SEC-HTML: "<style" without ">" repeated is linear (was ~8 s), and <style> extraction is unchanged', () => {
  fast('style scan', () => sanitizeTemplateHtml('<style'.repeat(33_000), { mode: 'save' }));
  const r = sanitizeTemplateHtml('<p>a</p><STYLE media="print">.x{color:red}</style ><p>b</p><style>.y{color:blue}', { mode: 'save' });
  assert.match(r.html, /^<style>\.x\{color:red\}\n\.y\{color:blue\}<\/style><p>a<\/p><p>b<\/p>$/);
});

test('SEC-HTML: deeply nested loops hit a work budget instead of running for minutes', () => {
  const ctx = { employeeDetails: Array.from({ length: 12 }, (_, i) => ({ label: 'l' + i, value: 'v' })) };
  const src = '{{#each employeeDetails}}'.repeat(12) + '{{/each}}'.repeat(12);
  fast('nested each', () => assert.throws(() => renderTemplate(src, ctx), TemplateRenderError), 3000);
  // ordinary nesting still renders
  assert.equal(renderTemplate('{{#each employeeDetails}}{{#if label}}.{{/if}}{{/each}}', ctx), '.'.repeat(12));
});

test('SEC-HTML: tokenizer keeps the old semantics (triple braces, CSS "}}}", unclosed tail is text)', () => {
  assert.throws(() => renderTemplate('{{{org.name}}}', { org: { name: 'x' } }), TemplateRenderError);
  assert.equal(renderTemplate('.t{color:{{brand.primaryColor}}}', { brand: { primaryColor: '#f00' } }, escapeCssValue), '.t{color:#f00}');
  assert.equal(renderTemplate('a {{org.name}} b {{ tail', { org: { name: 'N' } }), 'a N b {{ tail');
});

test('SEC-HTML: custom-template embed HTML only goes to clients that sandbox it; old clients get an update notice', () => {
  const custom = doc('<p class="mine">{{employee.name}}</p><style>body{display:none}</style>');
  const old = renderDocHtmlForClient(custom, { embed: true, clientSandboxes: false });
  assert.equal(old.updateRequired, true);
  assert.equal(old.isolated, false);
  assert.equal(old.html, UPDATE_APP_NOTICE_HTML);
  assert.doesNotMatch(old.html, /mine|<style|display:none/);
  assert.match(old.html, /update the app/i);
  const fresh = renderDocHtmlForClient(custom, { embed: true, clientSandboxes: true });
  assert.equal(fresh.isolated, true); assert.equal(fresh.updateRequired, undefined); assert.match(fresh.html, /class="mine"/);
  // Built-in layouts: exactly what old and new clients always got.
  const std = samplePayslipDoc({ layout: 'STANDARD' }, org);
  for (const clientSandboxes of [false, true]) {
    const r = renderDocHtmlForClient(std, { embed: true, clientSandboxes });
    assert.deepEqual(r, { html: renderPayslipHtml(std, { embed: true }), isolated: false });
  }
});
