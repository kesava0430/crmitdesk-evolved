# Attachment storage — where to configure what

There are **two separate configuration levels**, and they are often confused:

| Level | Who does it | Where | How often |
|---|---|---|---|
| 1. Enable the integration | You, the platform operator | Environment variables on the server | Once per deployment |
| 2. Connect an account | Each client's own org owner | In the app: **Storage** page (`/storage`) | Once per client org |

**There is no single Google account that stores everybody's files.** The design is
deliberately per-organisation: every client connects *their own* Google Drive, and
their attachments live in their own Drive. Your own organisation is not special —
you connect yours through exactly the same screen.

The alternative is **hosted storage**: one S3 bucket that you own, shared by every
org, with objects namespaced by `orgId`. That one is plan-gated.

---

## Level 1 — Enable it on the deployment (you, once)

### 1a. Create the Google OAuth client

1. Go to <https://console.cloud.google.com/> and create a project (or pick one).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type **External** (unless every client is in your own Workspace).
   - Fill in app name, support email, developer email.
   - **Scopes** — add exactly these two:
     - `.../auth/drive.file`
     - `.../auth/userinfo.email`
   - Publish the app. While it is in *Testing*, only accounts you list as test
     users can connect, and refresh tokens expire after 7 days — which will look
     like "everyone's attachments broke after a week". Publish before onboarding
     real clients.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorised redirect URI** — this must match byte for byte:

     ```
     https://<your-backend-domain>/api/storage/google/callback
     ```

     For local development: `http://localhost:4000/api/storage/google/callback`
   - Copy the **Client ID** and **Client secret**.

> **Why `drive.file` and not full Drive access?** `drive.file` lets the app see
> and manage *only the files it created itself*. It keeps the consent screen at
> Google's "sensitive" tier. Full Drive access is a "restricted" scope and needs
> a paid annual third-party security assessment before Google will let you use it
> in production. See `server/src/utils/googleDrive.ts`.

### 1b. Set the environment variables

On Render (or wherever the **server** runs) — Dashboard → your service →
Environment:

```bash
# Google Drive (bring-your-own, per client org)
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx

# The backend's OWN public URL. The redirect URI is built from this as
# `${APP_URL}/api/storage/google/callback`, so if this is wrong or still
# localhost, Google returns redirect_uri_mismatch.
APP_URL=https://your-backend.onrender.com

# Where the user's browser is sent back to after consent (the /storage page).
FRONTEND_URL=https://your-frontend.onrender.com

# Refresh tokens are encrypted at rest with this before hitting the database.
# Required — without it, connecting will fail.
ENCRYPTION_KEY=<32+ random characters>

# Already set for auth; also signs the 10-minute OAuth `state` parameter
# that proves which org started the connection.
JWT_SECRET=<your existing value>
```

**Optional — hosted storage** (your own S3/R2/MinIO bucket, offered to clients
whose plan includes a quota):

```bash
S3_BUCKET=crmitdesk-attachments
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=auto                       # 'auto' for Cloudflare R2
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for real AWS S3
```

Restart the service. The Storage page reads
`GET /api/storage/status`, whose `configured` and `hosted.available` flags come
straight from whether these variables are set — so if an option is greyed out in
the UI, that is the variable that is missing.

---

## Level 2 — Connect an account (each org, in the app)

**Where:** left sidebar → **Integrations → Storage**, or go directly to
`/storage`.

**Who can see it:** SUPER_ADMIN, IT_MANAGER, CRM_MANAGER.
**Who can change it:** SUPER_ADMIN of that organisation only. Connecting an
OAuth integration is treated at the same trust level as billing, so managers can
see the status but not rewire it.

### Option A — the org's own Google Drive

1. Storage page → **Your own Google Drive** → **Connect**.
2. You are sent to Google's consent screen. Sign in as the account whose Drive
   should hold the files — usually a shared/service account owned by the
   business, **not** an individual employee who might leave.
3. On approval you land back on `/storage` with the connected email shown.
4. The app creates a folder called **`CRMITdesk Evolved Attachments`** in that
   Drive. Every attachment from every record in that org goes there.

Storage used is the client's own Google quota. Nothing counts against their
CRMITdesk plan.

### Option B — hosted storage (your bucket)

Storage page → **Hosted storage** → **Connect**. No OAuth, one click. Requires
both that you set the `S3_*` variables *and* that the org's plan includes a
quota:

| Plan | Hosted storage |
|---|---|
| Free | 0 GB — Drive only |
| Pro | 5 GB |
| Enterprise | 50 GB |

Free-plan orgs only ever see the Google Drive option; the hosted button returns
a clear upgrade message rather than failing silently.

### If no client ever connects anything

Uploads fall back to your hosted bucket automatically **if** `S3_*` is set and
the org's plan has a quota. If S3 is not configured on the deployment, the user
gets a 400 that says to connect storage in Settings → Storage. (Before this
week's fix that path returned a 500 from inside the AWS SDK.)

---

## Switching or disconnecting

The app **blocks** a switch that would strand files, with a 409 explaining how
many. Three actions trigger the guard while Google Drive attachments exist:

- disconnecting storage
- switching from Drive to hosted
- reconnecting a **different** Google account

Reconnecting the **same** account just refreshes tokens and is always allowed.

The reason is that the files stay in the customer's Drive but the credentials
needed to reach them are overwritten — so from inside CRMITdesk they become
permanently unreachable, which is worse than an error message. To proceed you
must delete those attachments first.

---

## Per-client onboarding checklist

For each new client organisation:

1. Their SUPER_ADMIN signs in.
2. **Integrations → Storage**.
3. Either **Connect Google Drive** (sign in as *their* business Google account),
   or **Connect hosted storage** if they are on Pro/Enterprise.
4. Confirm the green "connected" banner shows the expected email address.
5. Upload one test file to any record and download it back.

Point 3 is worth being explicit about with clients: whoever signs in at that
step owns the Drive that holds their data. A departing employee's personal
Google account is the failure case to avoid.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` | `APP_URL` does not match the authorised redirect URI in Google Cloud Console — including `http` vs `https` and any trailing slash. |
| "Google Drive isn't configured on this deployment yet" | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` missing on the server. |
| "Google did not return a long-lived connection" | The account previously granted access and Google withheld a new refresh token. Revoke at <https://myaccount.google.com/permissions> and connect again. |
| "This connection link has expired" | The signed `state` lasts 10 minutes. Start from **Connect** again. |
| Connections break roughly weekly | The OAuth consent screen is still in **Testing**. Publish it. |
| "This organization's Google Drive connection has changed since this file was uploaded" | The org reconnected a different Google account at some point. The file is still in the old Drive, just not reachable from here. |
| Hosted storage button does nothing / 400 | `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` not set. |
| Hosted storage 402 | The org's plan has a 0 GB quota (Free). |

---

## What the code does with the files

- Uploads never touch the server's local disk — the buffer goes straight from
  the request to Drive or S3. Render wipes local disk on every redeploy, so a
  local-disk path would silently lose every attachment.
- Downloads stream back **through** the API rather than redirecting to a Drive
  link, so access is governed by CRMITdesk's own org/permission checks, not by
  Google Drive sharing settings. Staff without a Google account can still
  download.
- Refresh tokens are encrypted with `ENCRYPTION_KEY` before being stored, and
  refreshed transparently 60 seconds before expiry.
- Uploads are limited to 25 MB, with an extension allowlist enforced before the
  file is buffered (`server/src/utils/uploadPolicy.ts`).
- Deleting a record now deletes its attachments — rows *and* the stored files —
  and a daily sweep catches anything the database cascaded away behind the
  application's back (`server/src/utils/entityCleanup.ts`).

Relevant source: `server/src/modules/storage/`, `server/src/utils/storage.ts`,
`server/src/utils/googleDrive.ts`, `server/src/utils/s3Storage.ts`,
`client/src/pages/StoragePage.tsx`.
