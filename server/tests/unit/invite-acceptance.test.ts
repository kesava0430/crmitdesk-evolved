/**
 * HR-002 — accepting an invitation must not create a second person.
 *
 * People → Add person → Send an invite wrote two unrelated rows: an Employee
 * with no user_id, and an InviteToken that did not reference it. Acceptance
 * then called ensureEmployeeForUser, which looks an employee up BY user_id,
 * found none, and provisioned another. One invite, one human, two directory
 * records — and HR's designation, manager and joining date stranded on the
 * copy nobody was logged in as.
 *
 * The behavioural proof lives in tests/e2e/people-invite.spec.ts, which
 * counts actual rows against a live API. These are the cheap guards that run
 * on every commit: they pin the structure that makes the duplicate
 * impossible, so a future edit cannot quietly restore it.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function read(...p: string[]): string {
  return fs.readFileSync(path.join(...p), 'utf8');
}
/** Comments stripped, so prose about a rule never satisfies a test for it. */
function code(...p: string[]): string {
  return read(...p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const auth = () => code(SRC, 'modules/core/auth/auth.controller.ts');
const people = () => code(SRC, 'modules/people/people.controller.ts');
/** Just the acceptInvite body. */
const acceptInvite = () => auth().split('export async function acceptInvite')[1].split('\nexport ')[0];

test('an invite records the person it was raised for', () => {
  const schema = read(ROOT, 'prisma/schema.prisma');
  const model = schema.split('model InviteToken {')[1].split('\n}')[0];
  assert.match(model, /employeeId\s+String\?/, 'InviteToken cannot name its person');
  // A real relation, so a deleted person cannot leave a dangling id behind.
  assert.match(model, /employee\s+Employee\?\s+@relation\([^)]*onDelete:\s*SetNull/);

  const migration = fs.readdirSync(path.join(ROOT, 'prisma/migrations'))
    .filter(d => d.includes('invite_token_employee_link'))
    .map(d => read(ROOT, 'prisma/migrations', d, 'migration.sql'))
    .join('\n');
  assert.ok(migration, 'no migration adds invite_tokens.employee_id');
  assert.match(migration, /ALTER TABLE "invite_tokens" ADD COLUMN "employee_id"/);
  // Open invites already in flight are adopted where the match is unambiguous.
  assert.match(migration, /UPDATE "invite_tokens"/);
});

test('both People invite paths attach the person to the token', () => {
  const p = people();

  // Add person → Send an invite. The token row must be created after the
  // employee, because it has to carry that employee's id.
  const create = p.split('export async function create')[1].split('\nexport ')[0];
  assert.match(create, /inviteToken\.create/);
  assert.match(create, /employeeId:\s*employee\.id/, 'createPerson raises an invite with no person on it');
  assert.ok(
    create.indexOf('employee.create') < create.indexOf('inviteToken.create'),
    'the invite is created before the employee, so it cannot reference it',
  );

  // Grant login → invite, on a person who already exists: same defect.
  const grant = p.split('export async function grantLogin')[1].split('\nexport ')[0];
  assert.match(grant, /employeeId:\s*employee\.id/, 'grantLogin raises an invite with no person on it');
});

test('acceptance links the invited person instead of provisioning a new one', () => {
  const body = acceptInvite();
  assert.match(body, /employee\.update\(\{[\s\S]*userId:\s*u\.id/, 'acceptance never attaches the login to an existing person');
  // The fallback must remain for invites with no person behind them.
  assert.match(body, /ensureEmployeeForUser/);
  assert.ok(
    body.indexOf('employee.update') < body.indexOf('ensureEmployeeForUser'),
    'the link must happen before provisioning, or a duplicate is created first',
  );
});

test('the person is derived from the invite, never from the request body', () => {
  const body = acceptInvite();
  const lookup = body.split('const invited')[1].split(';')[0];
  assert.match(lookup, /invite\.employeeId/, 'the precise reference on the invite is unused');
  assert.match(lookup, /invite\.email/, 'the fallback must use the invite address, not a supplied one');
  // Anything the client sent arrives as `data` — it must not pick the record.
  assert.ok(!/data\.(email|employeeId|personId|userId)/.test(lookup), 'client input selects the employee record');
});

test('the fallback match cannot adopt an unrelated account', () => {
  const lookup = acceptInvite().split('const invited')[1].split(';')[0];
  // Scoped to the invite's org, and only to records that have no login yet,
  // so an already-linked person can never be re-pointed at a new account.
  assert.match(lookup, /orgId:\s*invite\.orgId/);
  assert.match(lookup, /userId:\s*null/);
});

test('an invite can be claimed exactly once, even concurrently', () => {
  const body = acceptInvite();
  // The pre-flight read is advisory; this is the one that decides.
  assert.match(body, /inviteToken\.updateMany\(\{[\s\S]*usedAt:\s*null/, 'usedAt is set without a compare-and-set');
  assert.match(body, /claimed\.count === 0/);
  assert.match(body, /\$transaction/);
  // The claim has to be inside the transaction with the account creation,
  // otherwise a failed insert leaves the invite burned.
  const tx = body.split('$transaction')[1];
  assert.ok(tx.indexOf('updateMany') < tx.indexOf('user.create'), 'the invite is not claimed before the account is created');
});

test('a losing race returns a conflict rather than a 500', () => {
  const a = auth();
  assert.match(a, /P2002/, 'a unique-constraint collision still reaches the client as an unhandled error');
  assert.match(acceptInvite(), /withUniqueGuard/);
});

test('passwords still go through the existing hashing, and are never logged', () => {
  const body = acceptInvite();
  assert.match(body, /bcrypt\.hash\(data\.password,\s*12\)/, 'acceptance no longer uses the standard hash cost');
  assert.ok(!/passwordHash:\s*data\.password/.test(body), 'a plaintext password is being stored');
  assert.ok(!/console\.(log|info|warn|error)[\s\S]{0,120}password/i.test(body), 'a password reaches the logs');
});
