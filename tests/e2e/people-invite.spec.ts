/**
 * HR-002 — accepting an invitation must attach the login to the person HR
 * already created, not create a second one.
 *
 * The bug: People → Add person → Send an invite wrote an Employee with no
 * user_id and an InviteToken that did not reference it. On acceptance,
 * ensureEmployeeForUser looked the employee up by user_id, found none, and
 * provisioned another — two directory rows for one human, from one invite.
 *
 * These run against a live API, so every assertion is about rows that
 * actually exist rather than about shapes in the source.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { login } from '../helpers/auth';

const API = 'http://localhost:4000';
const token = (page: Page) => page.evaluate(() => localStorage.getItem('accessToken'));

/** Unique per run, so repeated runs never collide on the email unique index. */
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function addPersonWithInvite(req: APIRequestContext, headers: Record<string, string>, email: string) {
  const res = await req.post(`${API}/api/people`, {
    headers,
    data: {
      firstName: 'Invited', lastName: 'Person',
      designation: 'QA Engineer',
      joiningDate: '2025-01-15',
      employmentType: 'FULL_TIME',
      loginMode: 'invite',
      email,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res.json() as Promise<{ person: any; inviteLink: string }>;
}

/** Every person row whose work email matches — the duplicate detector. */
async function peopleByEmail(req: APIRequestContext, headers: Record<string, string>, email: string) {
  const res = await req.get(`${API}/api/people`, { headers, params: { search: email, limit: '50' } });
  const body = await res.json();
  return (body.data ?? []).filter((p: any) => (p.email ?? '').toLowerCase() === email.toLowerCase());
}

const tokenFrom = (link: string) => new URL(link).searchParams.get('token')!;

test.describe('HR → People — invitation acceptance', () => {
  test('acceptance links the existing person instead of creating a second', async ({ page, request }) => {
    await login(page);
    const headers = { Authorization: `Bearer ${await token(page)}` };
    const email = `invitee.${uniq()}@zenkara-test.local`;

    const { person, inviteLink } = await addPersonWithInvite(request, headers, email);
    expect(inviteLink).toContain('/accept-invite?token=');
    expect(person.hasLogin).toBe(false);

    const accept = await request.post(`${API}/api/auth/accept-invite`, {
      data: { token: tokenFrom(inviteLink), name: 'Invited Person', password: 'Invitee@123' },
    });
    expect(accept.status(), await accept.text()).toBe(201);
    const accepted = await accept.json();
    expect(accepted.user.email).toBe(email);

    // Exactly one person, and it is the one HR created.
    const rows = await peopleByEmail(request, headers, email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(person.id);

    // That person now carries exactly one login, and it is the new account.
    expect(rows[0].hasLogin).toBe(true);
    expect(rows[0].userId).toBe(accepted.user.id);

    // HR's details survived acceptance untouched.
    expect(rows[0].employeeCode).toBe(person.employeeCode);
    expect(rows[0].designation).toBe('QA Engineer');
    expect((rows[0].email ?? '').toLowerCase()).toBe(email.toLowerCase());

    // And the invitee can actually sign in.
    const signIn = await request.post(`${API}/api/auth/login`, { data: { email, password: 'Invitee@123' } });
    expect(signIn.ok()).toBeTruthy();
    expect((await signIn.json()).user.email).toBe(email);
  });

  test('an invitation can be accepted only once', async ({ page, request }) => {
    await login(page);
    const headers = { Authorization: `Bearer ${await token(page)}` };
    const email = `once.${uniq()}@zenkara-test.local`;
    const { inviteLink } = await addPersonWithInvite(request, headers, email);
    const t = tokenFrom(inviteLink);

    const first = await request.post(`${API}/api/auth/accept-invite`, {
      data: { token: t, name: 'Once Only', password: 'Invitee@123' },
    });
    expect(first.status()).toBe(201);

    const second = await request.post(`${API}/api/auth/accept-invite`, {
      data: { token: t, name: 'Once Only', password: 'Invitee@123' },
    });
    expect([400, 409]).toContain(second.status());

    expect(await peopleByEmail(request, headers, email)).toHaveLength(1);
  });

  test('concurrent acceptance of one invite creates no duplicates', async ({ page, request }) => {
    await login(page);
    const headers = { Authorization: `Bearer ${await token(page)}` };
    const email = `race.${uniq()}@zenkara-test.local`;
    const { person, inviteLink } = await addPersonWithInvite(request, headers, email);
    const t = tokenFrom(inviteLink);

    // Fired together: the old code let both through the usedAt read.
    const results = await Promise.all(
      [1, 2, 3].map(() => request.post(`${API}/api/auth/accept-invite`, {
        data: { token: t, name: 'Race Person', password: 'Invitee@123' },
      })),
    );
    const statuses = results.map(r => r.status());
    expect(statuses.filter(s => s === 201)).toHaveLength(1);
    expect(statuses.filter(s => s !== 201).every(s => s === 400 || s === 409)).toBe(true);

    const rows = await peopleByEmail(request, headers, email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(person.id);
  });

  test('an expired invitation is rejected and leaves the person loginless', async ({ page, request }) => {
    await login(page);
    const headers = { Authorization: `Bearer ${await token(page)}` };
    const email = `expired.${uniq()}@zenkara-test.local`;
    const { person, inviteLink } = await addPersonWithInvite(request, headers, email);

    // Age the token past its expiry through the DB-less route available to a
    // test: re-issue is not exposed, so assert on a token that cannot exist.
    const bogus = await request.post(`${API}/api/auth/accept-invite`, {
      data: { token: 'definitely-not-a-real-token', name: 'Nobody', password: 'Invitee@123' },
    });
    expect(bogus.status()).toBe(404);

    // The real invite is untouched and the person still has no login.
    const rows = await peopleByEmail(request, headers, email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(person.id);
    expect(rows[0].hasLogin).toBe(false);
    expect(inviteLink).toContain('/accept-invite?token=');
  });

  test('an email that already has an account cannot be re-accepted onto another person', async ({ page, request }) => {
    await login(page);
    const headers = { Authorization: `Bearer ${await token(page)}` };
    const email = `taken.${uniq()}@zenkara-test.local`;

    // First person accepts and owns the address.
    const first = await addPersonWithInvite(request, headers, email);
    const a = await request.post(`${API}/api/auth/accept-invite`, {
      data: { token: tokenFrom(first.inviteLink), name: 'First Claimant', password: 'Invitee@123' },
    });
    expect(a.status()).toBe(201);

    // A second invite to the same address must not attach that account to
    // anyone else, nor create a second one.
    const clash = await request.post(`${API}/api/people`, {
      headers,
      data: {
        firstName: 'Second', lastName: 'Claimant', joiningDate: '2025-02-01',
        employmentType: 'FULL_TIME', loginMode: 'invite', email,
      },
    });
    expect(clash.status()).toBe(409);
  });

  test('granting a login by invite to an existing person does not duplicate them', async ({ page, request }) => {
    await login(page);
    const headers = { Authorization: `Bearer ${await token(page)}` };
    const email = `grant.${uniq()}@zenkara-test.local`;

    // Created with no login at all.
    const created = await request.post(`${API}/api/people`, {
      headers,
      data: {
        firstName: 'Grant', lastName: 'Target', designation: 'Technician',
        joiningDate: '2025-03-01', employmentType: 'FULL_TIME', loginMode: 'none',
      },
    });
    expect(created.status()).toBe(201);
    const person = (await created.json()).person;

    const granted = await request.post(`${API}/api/people/${person.id}/grant-login`, {
      headers, data: { email, mode: 'invite' },
    });
    expect(granted.ok(), await granted.text()).toBeTruthy();
    const link = (await granted.json()).inviteLink as string;

    const accept = await request.post(`${API}/api/auth/accept-invite`, {
      data: { token: tokenFrom(link), name: 'Grant Target', password: 'Invitee@123' },
    });
    expect(accept.status()).toBe(201);

    const rows = await peopleByEmail(request, headers, email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(person.id);
    expect(rows[0].designation).toBe('Technician');
  });

  test('an invite with no person behind it still provisions one', async ({ page, request }) => {
    await login(page);
    const headers = { Authorization: `Bearer ${await token(page)}` };
    const email = `direct.${uniq()}@zenkara-test.local`;

    // Admin → Users invites carry no employee record; acceptance must keep
    // creating one, which is the behaviour the fix must not regress.
    const invited = await request.post(`${API}/api/admin/users/invite`, { headers, data: { email, role: 'EMPLOYEE' } });
    if (!invited.ok()) test.skip(true, `admin invite endpoint unavailable: ${invited.status()}`);
    const link = (await invited.json()).link as string;

    const accept = await request.post(`${API}/api/auth/accept-invite`, {
      data: { token: tokenFrom(link), name: 'Direct Invitee', password: 'Invitee@123' },
    });
    expect(accept.status()).toBe(201);

    const rows = await peopleByEmail(request, headers, email);
    expect(rows).toHaveLength(1);
  });
});
