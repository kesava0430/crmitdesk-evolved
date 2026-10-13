/**
 * Guards for the Face ID re-enrolment approval workflow.
 *
 * The property worth protecting here is not "the feature renders" — it is
 * that approval cannot be skipped. A re-enrolment workflow whose UI hides the
 * Re-enrol button while one POST still replaces the face is theatre, and the
 * original enrolment route was exactly that: an upsert any enrolled employee
 * could call again. So these tests pin the closures rather than the happy
 * path:
 *
 *   - no self-delete route (deleting your face was a way back onto the
 *     unreviewed first-enrolment path),
 *   - the enrolment route refuses when a face already exists,
 *   - review is SUPER_ADMIN only, not the MANAGERS group used elsewhere in
 *     this router,
 *   - a decision is a compare-and-set, so two reviewers cannot both apply one,
 *   - approval is transactional, so the swap and the status move together,
 *   - the pending slot is a database constraint, not a read-then-write.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const CLIENT = path.join(ROOT, '../client/src');

function read(...p: string[]): string {
  return fs.readFileSync(path.join(...p), 'utf8');
}
/** Source with comments stripped, so prose about a rule never satisfies a test for it. */
function code(...p: string[]): string {
  return read(...p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const routes = () => code(SRC, 'modules/hr/attendance/attendance.routes.ts');
const controller = () => code(SRC, 'modules/hr/attendance/attendance.controller.ts');

test('the model keeps request status separate from the active enrolment', () => {
  const schema = read(ROOT, 'prisma/schema.prisma');
  assert.match(schema, /model FaceReenrollmentRequest \{/);
  // Proposed descriptors live on the request, never on FaceEnrollment, which
  // is what lets the old face keep serving attendance during review.
  const model = schema.split('model FaceReenrollmentRequest {')[1].split('\n}')[0];
  for (const field of ['descriptors', 'sampleImages', 'status', 'decidedBy', 'rejectionReason', 'previousSelfie']) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(model), `FaceReenrollmentRequest is missing ${field}`);
  }
});

test('at most one pending request per user is a database constraint', () => {
  const schema = read(ROOT, 'prisma/schema.prisma');
  const model = schema.split('model FaceReenrollmentRequest {')[1].split('\n}')[0];
  // A nullable unique column: Postgres permits unlimited NULLs, so holding
  // the user id only while PENDING means two concurrent submissions cannot
  // both succeed — which a findFirst-then-create check would allow.
  assert.match(model, /activePendingUserId\s+String\?\s+@unique/);

  const migration = fs.readdirSync(path.join(ROOT, 'prisma/migrations'))
    .filter(d => d.includes('face_reenrollment'))
    .map(d => read(ROOT, 'prisma/migrations', d, 'migration.sql'))
    .join('\n');
  assert.ok(migration, 'no migration was written for face_reenrollment_requests');
  assert.match(migration, /CREATE UNIQUE INDEX[\s\S]*active_pending_user_id/);
});

test('there is no self-service delete, and re-enrolment is its own route', () => {
  const r = routes();
  assert.ok(!/face\/me/.test(r), 'DELETE /face/me still exists — employees could reset their way past approval');
  assert.ok(!/deleteMyFace/.test(r));
  assert.ok(!/deleteMyFace/.test(controller()), 'deleteMyFace handler is still exported');
  assert.match(r, /post\('\/face\/reenrol'/);
});

test('enrolling over an existing face is refused rather than upserted', () => {
  const c = controller();
  const enrol = c.split('export async function enrolFace')[1].split('export async function')[0];
  assert.ok(!/faceEnrollment\.upsert/.test(enrol), 'enrolFace still upserts — an enrolled user can replace their face directly');
  assert.match(enrol, /findUnique/);
  assert.match(enrol, /409/);
});

test('review endpoints are SUPER_ADMIN only', () => {
  const r = routes();
  for (const line of r.split('\n').filter(l => l.includes('/face/requests'))) {
    assert.match(line, /requireRole\(\.\.\.ADMIN\)/, `not admin-gated: ${line.trim()}`);
  }
  // The employee-facing side must stay open to every role, EMPLOYEE included.
  assert.match(r, /post\('\/face\/reenrol',\s*requireRole\(\.\.\.ALL_USERS\)/);
});

test('a decision is atomic and cannot be applied twice', () => {
  const decide = controller().split('async function decideFaceRequest')[1];
  assert.match(decide, /\$transaction/, 'the swap and the status change must commit together');
  // Compare-and-set: matching zero rows means someone else decided first.
  assert.match(decide, /updateMany\(\{[\s\S]*status:\s*'PENDING'/);
  assert.match(decide, /count === 0/);
  // The slot is released on both outcomes, so the employee can submit again.
  assert.match(decide, /activePendingUserId:\s*null/);
});

test('every query is scoped to the caller organisation', () => {
  const c = controller();
  for (const fn of ['listFaceRequests', 'getFaceRequest', 'decideFaceRequest', 'requestFaceReenrolment']) {
    const after = c.split(`async function ${fn}`)[1];
    assert.ok(after, `${fn} not found`);
    const body = after.split(/\n(?:export )?(?:async )?function |\nexport const /)[0];
    assert.match(body, /orgId/, `${fn} does not scope by orgId — cross-tenant read`);
  }
});

test('the employee UI reflects server state, not its own', () => {
  const page = code(CLIENT, 'modules/hr/AttendancePage.tsx');
  // Pending state comes from the policy payload, so it survives a refresh.
  assert.match(page, /myFaceRequest/);
  assert.match(page, /Pending Verification/);
  assert.match(page, /Submit for Verification/);
  assert.ok(!/attendance\/face\/me/.test(page), 'the client still calls the removed self-delete route');
  assert.ok(!/icon=\{<Trash2/.test(page), 'the Remove Face ID button is still rendered');
});

test('the approvals queue is mounted on the People page behind a Super Admin check', () => {
  const people = code(CLIENT, 'modules/people/PeoplePage.tsx');
  assert.match(people, /FaceApprovals/);
  assert.match(people, /'face', label: 'Face Approvals'/);
  // Immediately after "No login", as specified. Read from the TABS array
  // itself — LOGIN_MODES above it has a 'No login' entry of its own.
  const tabs = people.split('const TABS = [')[1].split('] as const')[0];
  const order = (tabs.match(/label: '([^']+)'/g) ?? []).map(s => s.split("'")[1]);
  assert.deepEqual(order, ['Everyone', 'Can sign in', 'No login', 'Face Approvals']);
  assert.match(people, /isSuperAdmin/);

  // The reviewer compares images served by the API, not anything cached locally.
  const panel = code(CLIENT, 'modules/people/FaceApprovals.tsx');
  assert.match(panel, /sampleImages/);
  assert.match(panel, /useFaceRequest/);
  assert.ok(!/localStorage|sessionStorage/.test(panel), 'review state must not live in browser storage');
});
