/**
 * Regression tests for the injection / SSRF / unsafe-content review
 * (SEC-INJ). Each block names the hole it pins shut.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { checkOutboundUrl, publicOnlyLookup, safeRequest, publicUrlProblem, OutboundUrlError } from '../../src/utils/safeHttp';
import { parseQueryString } from '../../src/utils/queryParser';
import { mimeTypeFor } from '../../src/utils/uploadPolicy';
import { emailTemplates, escHtml } from '../../src/utils/mailer';

const SRC = path.join(__dirname, '../../src');
const code = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─── SSRF: tenant-supplied outbound URLs ─────────────────────────────────────

test('checkOutboundUrl refuses loopback / private / metadata targets in every spelling', () => {
  const bad = [
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/', 'http://10.1.2.3/', 'http://172.16.0.9/',
    'http://192.168.1.1/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[::]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[fe80::1]/',
    'http://localhost/', 'http://LOCALHOST./', 'http://api.localhost/', 'http://metadata.google.internal/',
    'http://printer.local/', 'https://user:pw@example.com/', 'ftp://example.com/', 'file:///etc/passwd',
    'gopher://example.com/', 'not a url',
  ];
  for (const u of bad) assert.throws(() => checkOutboundUrl(u), OutboundUrlError, u);
});

test('checkOutboundUrl allows ordinary public URLs, and https-only when asked', () => {
  assert.equal(checkOutboundUrl('https://hooks.slack.com/services/T/B/x').hostname, 'hooks.slack.com');
  assert.equal(checkOutboundUrl('http://93.184.216.34:8080/x').port, '8080');
  assert.throws(() => checkOutboundUrl('http://example.com/', { allowHttp: false }), OutboundUrlError);
});

test('publicOnlyLookup refuses a NAME that resolves to a private address (connect-time check)', async () => {
  const err = await new Promise<any>(resolve => publicOnlyLookup('localhost', { all: true }, e => resolve(e)));
  assert.ok(err, 'localhost must not resolve through the public-only lookup');
  assert.equal(err.code, 'EBLOCKED');
});

test('safeRequest never connects to a private address, even one with a listener', async () => {
  let hits = 0;
  const srv = http.createServer((_q, r) => { hits++; r.end('secret'); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const { port } = srv.address() as AddressInfo;
  try {
    await assert.rejects(safeRequest(`http://127.0.0.1:${port}/`), OutboundUrlError);
    await assert.rejects(safeRequest(`http://2130706433:${port}/`), OutboundUrlError);
    assert.equal(hits, 0);
  } finally { srv.close(); }
});

test('publicUrlProblem explains a refused URL for settings forms', async () => {
  assert.match((await publicUrlProblem('http://169.254.169.254/'))!, /private|internal/);
  assert.match((await publicUrlProblem('http://example.com/', { allowHttp: false }))!, /https/);
});

test('every tenant-URL request path goes through safeHttp (no bare fetch / https.request)', () => {
  for (const f of ['utils/customModuleSync.ts', 'utils/slack.ts', 'utils/teams.ts']) {
    const c = code(f);
    assert.ok(/safeRequest\(/.test(c), `${f} must use safeRequest`);
    assert.ok(!/\bfetch\(|https\.request\(/.test(c), `${f} must not call fetch/https.request directly`);
  }
  const wf = code('utils/workflow-engine.ts');
  assert.ok(/safeRequest\(url/.test(wf) && !/await fetch\(url/.test(wf), 'workflow webhooks must use safeRequest');
  // Org-supplied AI base URLs go through the pinned agent.
  assert.ok(/tenantSupplied: p\.orgId !== null/.test(code('utils/aiGateway.ts')));
  assert.ok(/openAiTarget\(m\)/.test(code('utils/aiStatus.ts')));
});

// ─── Prisma operator injection through the query string ─────────────────────

test('parseQueryString drops nested objects (no ?status[not]=X operator injection)', () => {
  assert.deepEqual(parseQueryString('status[not]=CLOSED&search=vpn'), { search: 'vpn' });
  assert.deepEqual(parseQueryString('token[startsWith]=a'), {});
  assert.deepEqual(parseQueryString('a[b][c]=1'), {});
  assert.deepEqual(parseQueryString('__proto__[x]=1&constructor[prototype][y]=2'), {});
  assert.equal(({} as any).x, undefined);
});

test('parseQueryString keeps flat values and string arrays', () => {
  assert.deepEqual(parseQueryString('page=2&limit=20&q=a%20b'), { page: '2', limit: '20', q: 'a b' });
  assert.deepEqual(parseQueryString('ids=a&ids=b'), { ids: ['a', 'b'] });
  assert.deepEqual(parseQueryString('ids[]=a&ids[]=b'), { ids: ['a', 'b'] });
});

test('index.ts installs the flat query parser', () => {
  assert.match(code('index.ts'), /app\.set\('query parser', parseQueryString\)/);
});

// ─── Stored XSS via attachment MIME type ─────────────────────────────────────

test('attachment Content-Type comes from the extension, never the uploader', () => {
  assert.equal(mimeTypeFor('notes.txt'), 'text/plain');
  assert.equal(mimeTypeFor('feed.xml'), 'text/plain'); // text/xml could run XHTML <script>
  assert.equal(mimeTypeFor('photo.JPG'), 'image/jpeg');
  assert.equal(mimeTypeFor('report.pdf'), 'application/pdf');
  assert.equal(mimeTypeFor('weird.unknownext'), 'application/octet-stream');
  const c = code('modules/attachments/attachments.controller.ts');
  assert.ok(!/file\.mimetype/.test(c), 'the multipart Content-Type must not be stored');
  assert.ok(/setHeader\('Content-Type', mimeTypeFor\(attachment\.fileName\)\)/.test(c), 'downloads re-derive the type');
  assert.ok(/Content-Security-Policy/.test(c));
});

// ─── HTML injection into emails ──────────────────────────────────────────────

test('email templates escape outsider-controlled values', () => {
  const evil = '<a href="https://evil.example/login">Reset your password</a><img src=x>';
  const mails = [
    emailTemplates.ticketCreated({ title: evil }, evil, 'a@x.io'),
    emailTemplates.ticketAssigned({ title: evil }, evil, 'a@x.io'),
    emailTemplates.ticketResolved({ title: evil }, evil, 'a@x.io'),
    emailTemplates.ticketStatusChanged({ title: evil }, 'OPEN', evil, 'a@x.io'),
    emailTemplates.csatSurvey({ id: 't1', title: evil }, evil, 'a@x.io'),
    emailTemplates.orgSignupRequest('ops@x.io', { organizationName: evil, name: evil, email: 'e@x.io' }, 'https://app/approve?t=1'),
    emailTemplates.leaveRequested('m@x.io', evil, evil, evil, '2026-01-01', '2026-01-02', 1),
    emailTemplates.leaveDecision('m@x.io', evil, evil, '2026-01-01', '2026-01-02', false, evil),
    emailTemplates.dealStageChanged({ title: evil, stage: evil }, evil, 'a@x.io'),
    emailTemplates.invite('a@x.io', evil, 'IT_AGENT', 'https://app/accept?t=1'),
  ];
  for (const m of mails) {
    assert.ok(!m.html.includes('href="https://evil.example'), m.subject);
    assert.ok(!m.html.includes('<img src=x>'), m.subject);
    assert.ok(m.html.includes('&lt;a href=&quot;https://evil.example/login&quot;&gt;'), m.subject);
  }
  assert.equal(escHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
});

test('workflow SEND_EMAIL escapes record values substituted into the body', () => {
  const c = code('utils/workflow-engine.ts');
  assert.match(c, /html: resolveHtml\(body \|\| ''\)/);
  assert.match(c, /escHtml\(String\(entity\[k\] \?\? k\)\)/);
});

// ─── Team chat @ai confirm ───────────────────────────────────────────────────

test('team chat: only the requester can confirm a pending @ai plan', () => {
  const c = code('modules/chat/chat.controller.ts');
  assert.match(c, /current\.pendingPlanBy !== user\.id/);
  // The check sits before executePlan in the confirm branch.
  assert.ok(c.indexOf('current.pendingPlanBy !== user.id') < c.indexOf('await executePlan('));
});
