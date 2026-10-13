/**
 * APP-1/2/3 — session refresh rules (modules/core/auth/refreshPolicy.ts).
 *
 * Users of the Android app were being signed out at random: a refresh whose
 * response never arrived left the client holding a token the server had
 * already deleted. These pin the recovery rules — idempotent replay of a
 * client-proposed successor, a bounded grace window, per-client lifetimes —
 * plus the CORS origin list that stops the SSE refresh loop in the first place.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decideRefresh, clientTypeFromHeader, refreshTtlDays, refreshExpiry, isValidProposedToken,
  rotatedRetentionMs, DEFAULT_GRACE_MS, DEFAULT_MAX_GRACE_USES,
} from '../../src/modules/core/auth/refreshPolicy';
import { resolveCorsOrigins } from '../../src/utils/corsOrigins';
import {
  parseServiceAccount, buildServiceAccountAssertion, classifyFcmFailure, buildFcmMessage,
} from '../../src/utils/fcm';

const NOW = new Date('2026-10-13T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const live = { expiresAt: later(86_400_000), rotatedAt: null, replacedByHash: null, graceUses: 0 };

test('unknown token is rejected as invalid', () => {
  assert.deepEqual(decideRefresh(null, { now: NOW }), { action: 'reject', reason: 'Invalid refresh token' });
});

test('live token rotates; expired live token is rejected and deleted', () => {
  assert.equal(decideRefresh(live, { now: NOW }).action, 'rotate');
  assert.deepEqual(
    decideRefresh({ ...live, expiresAt: later(-1) }, { now: NOW }),
    { action: 'reject', reason: 'Refresh token expired', deleteRow: true },
  );
});

test('retry with the same proposed successor replays — even long after rotation', () => {
  const rotated = { ...live, rotatedAt: later(-3 * 86_400_000 + 1000), replacedByHash: 'h-next' };
  const successor = { expiresAt: later(86_400_000), rotatedAt: null };
  assert.equal(decideRefresh(rotated, { now: NOW, nextHash: 'h-next', successor }).action, 'replay');
});

test('replay is refused once the successor itself moved on (falls back to grace rules)', () => {
  const rotatedOld = { ...live, rotatedAt: later(-10 * 60_000), replacedByHash: 'h-next' };
  const movedOn = { expiresAt: later(86_400_000), rotatedAt: later(-60_000) };
  assert.equal(decideRefresh(rotatedOld, { now: NOW, nextHash: 'h-next', successor: movedOn }).action, 'reject');
  const rotatedRecent = { ...rotatedOld, rotatedAt: later(-30_000) };
  assert.equal(decideRefresh(rotatedRecent, { now: NOW, nextHash: 'h-next', successor: movedOn }).action, 'grace');
});

test('replay needs a matching proposal and a live successor', () => {
  const rotated = { ...live, rotatedAt: later(-10 * 60_000), replacedByHash: 'h-next' };
  assert.equal(decideRefresh(rotated, { now: NOW, nextHash: 'h-other', successor: { expiresAt: later(1000), rotatedAt: null } }).action, 'reject');
  assert.equal(decideRefresh(rotated, { now: NOW, nextHash: 'h-next', successor: null }).action, 'reject');
  assert.equal(decideRefresh(rotated, { now: NOW, nextHash: 'h-next', successor: { expiresAt: later(-1), rotatedAt: null } }).action, 'reject');
});

test('grace window: rotated token works briefly and a bounded number of times', () => {
  const justRotated = { ...live, rotatedAt: later(-5_000), replacedByHash: 'h-x' };
  assert.equal(decideRefresh(justRotated, { now: NOW }).action, 'grace');
  assert.equal(decideRefresh({ ...justRotated, rotatedAt: later(-DEFAULT_GRACE_MS) }, { now: NOW }).action, 'grace');
  assert.equal(decideRefresh({ ...justRotated, rotatedAt: later(-DEFAULT_GRACE_MS - 1) }, { now: NOW }).action, 'reject');
  assert.equal(decideRefresh({ ...justRotated, graceUses: DEFAULT_MAX_GRACE_USES }, { now: NOW }).action, 'reject');
  assert.equal(decideRefresh(justRotated, { now: NOW, graceMs: 0 }).action, 'reject');
});

test('X-Client header → client type', () => {
  assert.equal(clientTypeFromHeader('native-android'), 'native');
  assert.equal(clientTypeFromHeader('NATIVE-ios'), 'native');
  assert.equal(clientTypeFromHeader(['native-android']), 'native');
  assert.equal(clientTypeFromHeader('web'), 'web');
  assert.equal(clientTypeFromHeader(undefined), 'web');
  assert.equal(clientTypeFromHeader(''), 'web');
});

test('refresh TTL: 7d web / 90d native by default, env-overridable, junk ignored', () => {
  assert.equal(refreshTtlDays('web', {}), 7);
  assert.equal(refreshTtlDays('native', {}), 90);
  assert.equal(refreshTtlDays('web', { REFRESH_TTL_DAYS: '14' }), 14);
  assert.equal(refreshTtlDays('native', { REFRESH_TTL_DAYS_NATIVE: '180' }), 180);
  assert.equal(refreshTtlDays('web', { REFRESH_TTL_DAYS: 'abc' }), 7);
  assert.equal(refreshTtlDays('native', { REFRESH_TTL_DAYS_NATIVE: '-3' }), 90);
  assert.equal(refreshExpiry('native', NOW, {}).getTime(), NOW.getTime() + 90 * 86_400_000);
});

test('proposed successors must be long hex strings', () => {
  assert.ok(isValidProposedToken(crypto.randomBytes(32).toString('hex')));
  assert.ok(isValidProposedToken(crypto.randomBytes(64).toString('hex')));
  assert.ok(!isValidProposedToken('abc'));
  assert.ok(!isValidProposedToken('z'.repeat(64)));
  assert.ok(!isValidProposedToken(undefined));
  assert.ok(!isValidProposedToken({}));
});

test('rotated-row retention defaults to 72h', () => {
  assert.equal(rotatedRetentionMs({}), 72 * 3_600_000);
  assert.equal(rotatedRetentionMs({ REFRESH_ROTATED_RETENTION_HOURS: '24' }), 24 * 3_600_000);
});

test('CORS: comma-separated origins plus the Capacitor WebView origins', () => {
  const o = resolveCorsOrigins({ CORS_ORIGIN: 'https://app.zenkara.in, https://other.example/' });
  assert.ok(o.includes('https://app.zenkara.in'));
  assert.ok(o.includes('https://other.example'));
  assert.ok(o.includes('http://localhost'));
  assert.ok(o.includes('capacitor://localhost'));
  const off = resolveCorsOrigins({ CORS_ORIGIN: 'https://app.zenkara.in', CORS_ALLOW_APP_ORIGINS: 'false' });
  assert.deepEqual(off, ['https://app.zenkara.in']);
  assert.ok(resolveCorsOrigins({}).includes('http://localhost:5173'));
});

test('FCM: service account parsing (raw / base64 / absent / junk)', () => {
  const sa = { client_email: 'svc@p.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n', project_id: 'p' };
  const raw = parseServiceAccount({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) });
  assert.equal(raw?.project_id, 'p');
  assert.ok(raw?.private_key.includes('\nabc\n'), 'literal \\n sequences are unescaped');
  const b64 = parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(sa)).toString('base64') });
  assert.equal(b64?.client_email, sa.client_email);
  assert.equal(parseServiceAccount({}), null);
  assert.equal(parseServiceAccount({ FCM_SERVICE_ACCOUNT_JSON: 'not json' }), null);
});

test('FCM: service-account assertion is a verifiable RS256 JWT', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwtStr = buildServiceAccountAssertion({ client_email: 'svc@x', private_key: pem }, 1_000_000);
  const [h, c, sig] = jwtStr.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'RS256');
  assert.equal(claims.iss, 'svc@x');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(claims.exp - claims.iat, 3600);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'));
  assert.ok(ok);
});

test('FCM: failure classification and message shape', () => {
  assert.equal(classifyFcmFailure(404, { error: { status: 'NOT_FOUND' } }), 'prune');
  assert.equal(classifyFcmFailure(400, { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } }), 'prune');
  assert.equal(classifyFcmFailure(400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' } }), 'drop');
  assert.equal(classifyFcmFailure(503, {}), 'retry');
  assert.equal(classifyFcmFailure(429, {}), 'retry');
  assert.equal(classifyFcmFailure(401, {}), 'retry');
  assert.equal(classifyFcmFailure(403, {}), 'drop');
  const m = buildFcmMessage('tok', { title: 'T', url: '/hr/attendance', type: 'attendance:locate' });
  assert.equal(m.message.token, 'tok');
  assert.deepEqual(m.message.data, { url: '/hr/attendance', type: 'attendance:locate' });
  assert.equal(m.message.notification.body, '');
});

test('authenticate() accepts only staff access tokens, not other JWTs signed with JWT_SECRET', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
  const jwt = (await import('jsonwebtoken')).default;
  const { authenticate } = await import('../../src/middleware/authenticate');
  const run = (token: string) => {
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    let passed = false;
    try { authenticate(req, {} as any, () => { passed = true; }); } catch { /* rejected */ }
    return { passed, user: req.user };
  };
  const secret = process.env.JWT_SECRET!;
  const staff = run(jwt.sign({ id: 'u1', role: 'EMPLOYEE', email: 'a@b.c', orgId: 'o1' }, secret));
  assert.ok(staff.passed);
  assert.equal(staff.user.id, 'u1');
  assert.equal(run(jwt.sign({ sub: 'p1', orgId: 'o1', iss: 'portal' }, secret)).passed, false, 'portal session');
  assert.equal(run(jwt.sign({ orgId: 'o1' }, secret)).passed, false, 'OAuth state');
  assert.equal(run(jwt.sign({ userId: 'u1' }, secret)).passed, false, 'calendar state');
});
