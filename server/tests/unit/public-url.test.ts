/**
 * PORTAL — "Customer Portal link is not working".
 *
 * The web app moved from a domain root (Render) to app.zenkara.in/zenkara.
 * The portal link was still built as `${origin}/portal…` on the client and
 * `${FRONTEND_URL}/portal…` on the server, so it pointed at
 * app.zenkara.in/portal (not routed to the app: 404) and, in the Android
 * app, at http://localhost/portal. These pin the URL builders that replaced
 * both.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frontendBase, frontendLink, resolveAppBase, portalEntryLink, portalVerifyLink,
} from '../../src/utils/frontendUrl';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// client/src/shared/publicUrl.ts is a pure module (no import.meta / window),
// but client/ is "type": "module", so require() can't load it. Transpile it
// to CommonJS and evaluate it — the bytes under test are the shipped ones.
type PublicUrlModule = typeof import('../../../client/src/shared/publicUrl');
function loadClientModule(): PublicUrlModule {
  const file = path.join(__dirname, '../../../client/src/shared/publicUrl.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} as any };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}
const { publicAppRoot, buildPublicUrl } = loadClientModule();

// ─── client: publicAppRoot / buildPublicUrl ─────────────────────────────────

test('web build under /zenkara/: link keeps the base path', () => {
  const env = { baseUrl: '/zenkara/', origin: 'https://app.zenkara.in', isNative: false, apiUrl: '/zenkara/api' };
  assert.equal(publicAppRoot(env), 'https://app.zenkara.in/zenkara');
  assert.equal(buildPublicUrl('/portal?org=abc', env), 'https://app.zenkara.in/zenkara/portal?org=abc');
  assert.equal(buildPublicUrl('form/1', env), 'https://app.zenkara.in/zenkara/form/1');
});

test('second hostname gets its own links', () => {
  const env = { baseUrl: '/zenkara/', origin: 'https://360.zenkara.in', isNative: false, apiUrl: '/zenkara/api' };
  assert.equal(buildPublicUrl('/portal?org=abc', env), 'https://360.zenkara.in/zenkara/portal?org=abc');
});

test('root build (dev, old Render deploy) has no extra slash', () => {
  const env = { baseUrl: '/', origin: 'http://localhost:5173', isNative: false };
  assert.equal(publicAppRoot(env), 'http://localhost:5173');
  assert.equal(buildPublicUrl('/portal?org=abc', env), 'http://localhost:5173/portal?org=abc');
});

test('Android app: public web URL derived from the API URL, never http://localhost', () => {
  const env = { baseUrl: '/', origin: 'http://localhost', isNative: true, apiUrl: 'https://app.zenkara.in/zenkara/api' };
  assert.equal(buildPublicUrl('/portal?org=abc', env), 'https://app.zenkara.in/zenkara/portal?org=abc');
  assert.equal(publicAppRoot({ ...env, apiUrl: 'https://app.zenkara.in/zenkara/api/' }), 'https://app.zenkara.in/zenkara');
});

test('VITE_PUBLIC_APP_URL overrides derivation', () => {
  const env = { baseUrl: '/', origin: 'http://localhost', isNative: true, apiUrl: 'https://api.example.com/api', publicAppUrl: 'https://desk.example.com/' };
  assert.equal(buildPublicUrl('/portal', env), 'https://desk.example.com/portal');
  // A relative override is ignored rather than producing a broken link.
  assert.equal(publicAppRoot({ ...env, publicAppUrl: '/zenkara' }), 'https://api.example.com');
});

// ─── server: frontendBase / frontendLink ────────────────────────────────────

test('FRONTEND_URL with or without trailing slash gives one slash', () => {
  assert.equal(frontendLink('/portal', { FRONTEND_URL: 'https://app.zenkara.in/zenkara/' }), 'https://app.zenkara.in/zenkara/portal');
  assert.equal(frontendLink('portal', { FRONTEND_URL: 'https://app.zenkara.in/zenkara' }), 'https://app.zenkara.in/zenkara/portal');
  assert.equal(frontendBase({}), 'http://localhost:5173');
});

test('portal links encode their parameters', () => {
  const env = { FRONTEND_URL: 'https://app.zenkara.in/zenkara' };
  assert.equal(portalEntryLink('org 1', undefined, env), 'https://app.zenkara.in/zenkara/portal?org=org%201');
  assert.equal(portalVerifyLink('tok', 'o&x', undefined, env), 'https://app.zenkara.in/zenkara/portal/verify?token=tok&org=o%26x');
});

// ─── server: resolveAppBase ─────────────────────────────────────────────────

// Production as the docs told operators to configure it: no /zenkara.
const PROD = { FRONTEND_URL: 'https://app.zenkara.in', CORS_ORIGIN: 'https://app.zenkara.in,https://360.zenkara.in' };

test('page-reported base on our own origin wins over a bare FRONTEND_URL', () => {
  assert.equal(resolveAppBase('https://app.zenkara.in/zenkara', PROD), 'https://app.zenkara.in/zenkara');
  assert.equal(resolveAppBase('https://app.zenkara.in/zenkara/', PROD), 'https://app.zenkara.in/zenkara');
  assert.equal(resolveAppBase('https://360.zenkara.in/zenkara', PROD), 'https://360.zenkara.in/zenkara');
  assert.equal(
    portalVerifyLink('t', 'o', resolveAppBase('https://app.zenkara.in/zenkara', PROD), PROD),
    'https://app.zenkara.in/zenkara/portal/verify?token=t&org=o',
  );
});

test('a foreign origin can never receive a magic link', () => {
  for (const evil of [
    'https://evil.example/zenkara',
    'https://app.zenkara.in.evil.example/zenkara',
    'http://app.zenkara.in/zenkara',            // scheme is part of the origin
    'http://localhost',                          // the Android WebView
    'javascript:alert(1)',
    '//evil.example/zenkara',
  ]) {
    assert.equal(resolveAppBase(evil, PROD), 'https://app.zenkara.in', evil);
  }
});

test('only plain paths are accepted', () => {
  for (const bad of [
    'https://app.zenkara.in/zenkara?next=https://evil.example',
    'https://app.zenkara.in/zenkara#x',
    'https://user:pw@app.zenkara.in/zenkara',
    'https://app.zenkara.in/zen%2Fkara',
  ]) {
    assert.equal(resolveAppBase(bad, PROD), 'https://app.zenkara.in', bad);
  }
});

test('missing or junk candidates fall back to FRONTEND_URL', () => {
  const env = { FRONTEND_URL: 'https://app.zenkara.in/zenkara/', CORS_ORIGIN: 'https://app.zenkara.in' };
  for (const c of [undefined, null, '', 42, 'not a url', 'x'.repeat(400)]) {
    assert.equal(resolveAppBase(c, env), 'https://app.zenkara.in/zenkara');
  }
});

test("CORS_ORIGIN '*' does not make every origin trusted", () => {
  assert.equal(resolveAppBase('https://evil.example/zenkara', { FRONTEND_URL: 'https://app.zenkara.in/zenkara', CORS_ORIGIN: '*' }), 'https://app.zenkara.in/zenkara');
});
