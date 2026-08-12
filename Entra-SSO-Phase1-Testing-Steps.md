# Entra ID SSO — Phase 1 Testing Steps

Before moving on to phases 2-3 (auto-provisioning, group-to-role mapping), this walks through verifying phase 1 — SSO login for existing users — end to end against a real Microsoft Entra ID tenant. This can't be tested in a sandbox without network access, so it needs to run against your actual dev/staging deployment.

---

## 0. Prerequisites

Confirm these are set in the server's environment before anything else — a few are genuinely new for this feature:

- `JWT_SECRET` — already required, unchanged.
- `ENCRYPTION_KEY` — required for storing the Entra client secret at rest. If this was never set before (it's only used for connected-mailbox passwords currently), set it now — any long random string works. I've added it to `.env.example`.
- `APP_URL` — the server's own public URL, used to build the redirect URI (`<APP_URL>/api/auth/entra/callback`). Already used for Google Drive/Calendar; if those work today, this is already correct.
- `FRONTEND_URL` — the client's public URL, used for post-login/error redirects. Already required.

Then:

1. Run the migration: `npx prisma migrate dev` (or `db push` if that's your workflow) — adds `directory_configs` and `users.entra_object_id`.
2. Run `npx prisma generate` if it doesn't happen automatically.
3. Rebuild/restart both server and client.

---

## 1. Create a test app registration in Entra ID

Do this in the Azure/Entra portal, in a tenant you control for testing (not a production customer tenant).

1. **Microsoft Entra ID → App registrations → New registration.** Name it something like "CRMITdesk SSO (test)". Leave "Supported account types" as single-tenant for a first test.
2. Skip the redirect URI for now — you'll get the exact value from CRMITdesk's admin page in step 2 and add it after.
3. From the app's **Overview** page, copy the **Application (client) ID** and **Directory (tenant) ID**.
4. **Certificates & secrets → New client secret.** Copy the secret's **Value** immediately — it's only shown once.
5. **API permissions** — confirm `User.Read` (Microsoft Graph, delegated) is listed; it's added by default on a new registration. Grant admin consent if your tenant requires it for delegated permissions.

## 2. Configure the integration in CRMITdesk

1. Log in as a `SUPER_ADMIN` or `IT_MANAGER`.
2. Go to **Integrations → Single Sign-On** (`/directory-sso`).
3. Enter the Tenant ID, Client ID, and Client Secret from step 1. Pick a login slug (e.g. `test`).
4. Save.
5. Copy the **Redirect URI** now shown on the page, and go back to Entra: **Authentication → Add a platform → Web**, paste it in as a Redirect URI, and save. It must match exactly (scheme, host, path — no trailing slash mismatch).
6. Click **Test** on the CRMITdesk page — should return "Tenant found...". If this fails, it's almost always a typo'd tenant ID or the server can't reach `login.microsoftonline.com` (check outbound network/firewall rules on your server).

## 3. Happy path: first-time sign-in

1. Make sure at least one existing CRMITdesk user's email matches a real account in that Entra tenant (invite one with that email, or use an account you already control there).
2. Open an incognito/private window (avoids stale localStorage tokens from your admin session interfering).
3. Go to `https://<your-app>/login/<slug>`.
4. Should immediately redirect to `login.microsoftonline.com`.
5. Sign in with the matching Microsoft account. First time, Microsoft may show a consent screen ("CRMITdesk wants to: sign you in, read your profile") — accept it.
6. Should land back on `/sso-callback` (brief "Finishing sign-in..." spinner), then `/dashboard`, fully logged in.
7. Verify: correct name/role showing in the app; refresh the page and confirm you're still logged in (session persisted).
8. Check the audit log for a `LOGIN` entry with `method: entra` on that user.
9. In the database, confirm that user's `entra_object_id` column is now populated.

## 4. Second sign-in (already linked)

Log out, repeat step 3. This time Microsoft should skip the consent screen and you should land straight back in the app — confirms the lookup-by-`entraObjectId` path works, not just the one-time email-linking path.

## 5. Edge cases

Each of these should fail *gracefully* with a clear message, not a blank page or raw error:

- **Wrong slug** — visit `/login/not-a-real-slug` → redirects to `/login` with "That sign-in link isn't recognized."
- **SSO disabled** — toggle Enabled off on the settings page, try the login link → "Single sign-on is currently turned off..."
- **No matching account** — sign in with a Microsoft account whose email doesn't match any user in that org → lands on `/sso-callback` with "No CRMITdesk account was found for you" and a link back to `/login`.
- **Deactivated user** — deactivate a user who's already linked their Entra account, try signing in again → "Your account is deactivated."
- **Password login still works** — confirm normal email/password login is unaffected (this feature shouldn't touch that path at all, but worth a regression check).
- **Secret not wiped on unrelated edits** — go back to settings, leave Client Secret blank, change only the slug or toggle, save → confirm sign-in still works afterward (the blank field shouldn't have overwritten the stored secret).
- **Disconnect** — click Disconnect → config is removed, `/login/<slug>` now says "not recognized."

## 6. Multi-tenant isolation (if you're testing with 2+ orgs)

If you have two CRMITdesk orgs each with their own Entra tenant configured (different slugs), confirm a user signing in via org A's slug can only ever land in an org A account — never cross into org B — even if, hypothetically, the same Microsoft account existed in both directories. This is enforced by scoping every lookup to the org resolved from the signed `state` param, but it's worth confirming directly rather than trusting it blind.

## 7. Quick security spot-checks

- Open browser devtools → Network tab while on the Single Sign-On settings page. Confirm the `GET /api/directory/config` response never includes the actual client secret (only `hasClientSecret: true/false`).
- Log in as an `EMPLOYEE`-role user and confirm hitting `/api/directory/config` directly returns a 403.
- Confirm the app is served over HTTPS in whatever environment you're testing against — the tokens in the `/sso-callback` URL fragment and the OAuth `code` in transit both rely on TLS, same as any OAuth flow.

---

Once these pass, phase 1 is solid ground to build phase 2 (JIT provisioning + group-to-role mapping) on top of. Worth keeping this test tenant around — phase 2 will need the same app registration plus a couple of Entra security groups to test role mapping against.
