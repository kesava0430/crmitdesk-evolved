# Auto-deploy: GitHub → S3 → EC2

```
push to main
   └─► GitHub Actions: npm ci, prisma generate, tsc, vite build
        └─► s3://zenkara-deploy/releases/<sha>/{server,client}-dist.tar.gz
             └─► current.txt  ← written last, the only thing the box watches
                  └─► EC2 timer (every 60s) notices, pulls, restarts
```

Nothing connects *into* the server. The instance reaches out to S3 with an
IAM role, so there is no deploy key in GitHub and port 22 can stay
restricted to your own address.

Deploy lag is up to 60 seconds. If you want it instant, swap the timer for
an SSM `send-command` from the workflow — the script is unchanged, only the
trigger differs.

---

## 1. Create the bucket

Private; nothing here is public.

```bash
aws s3 mb s3://zenkara-deploy --region eu-north-1
aws s3api put-public-access-block --bucket zenkara-deploy \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

Old releases pile up — expire them after 30 days:

```bash
aws s3api put-bucket-lifecycle-configuration --bucket zenkara-deploy \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-old-releases","Status":"Enabled","Filter":{"Prefix":"releases/"},"Expiration":{"Days":30}}]}'
```

## 2. Let GitHub assume a role (OIDC — no stored keys)

Register GitHub as an identity provider once per AWS account:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

Create `trust.json` — the `sub` condition is what stops any other repo
assuming this role. **Note the `@<id>` suffixes**: GitHub's OIDC `sub` claim
now carries the owner ID and repository ID
(`repo:<owner>@<owner-id>/<repo>@<repo-id>:ref:...`), so the older
`repo:kesava0430/crmitdesk-evolved:*` pattern no longer matches and every run
fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`. The IDs
are stable across renames. To see the exact claim GitHub sends, add a step
with `actions/github-script` that calls `core.getIDToken('sts.amazonaws.com')`
and decodes the JWT payload — or query the IDs directly:
`gh api users/kesava0430 --jq .id` and
`gh api repos/kesava0430/crmitdesk-evolved --jq .id`.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::223532249183:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:kesava0430@69373401/crmitdesk-evolved@1311218234:*" }
    }
  }]
}
```

```bash
aws iam create-role --role-name ZenkaraGitHubDeploy --assume-role-policy-document file://trust.json
aws iam put-role-policy --role-name ZenkaraGitHubDeploy --policy-name WriteReleases \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:PutObject"],"Resource":"arn:aws:s3:::zenkara-deploy/*"}]}'
```

Then in GitHub → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::223532249183:role/ZenkaraGitHubDeploy` |

## 3. Let the instance read the bucket

```bash
aws iam create-role --role-name ZenkaraEC2Deploy --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam put-role-policy --role-name ZenkaraEC2Deploy --policy-name ReadReleases \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::zenkara-deploy/*"},{"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::zenkara-deploy"}]}'

aws iam create-instance-profile --instance-profile-name ZenkaraEC2Deploy
aws iam add-role-to-instance-profile --instance-profile-name ZenkaraEC2Deploy --role-name ZenkaraEC2Deploy
```

Attach it to the instance — **EC2 → Instances → select → Actions → Security
→ Modify IAM role → `ZenkaraEC2Deploy`**. No restart needed.

An instance role means no AWS keys are stored on the box at all.

## 4. Install the puller on the server

```bash
apt install -y awscli git
```

```bash
install -m 755 /opt/zenkara-crm/deploy/zenkara-pull-deploy.sh /usr/local/bin/zenkara-pull-deploy.sh
```

```bash
cat > /etc/systemd/system/zenkara-deploy.service <<'EOF'
[Unit]
Description=Pull and apply the latest Zenkara release from S3
After=network-online.target

[Service]
Type=oneshot
Environment=ZENKARA_DEPLOY_BUCKET=zenkara-deploy
ExecStart=/usr/local/bin/zenkara-pull-deploy.sh
EOF

cat > /etc/systemd/system/zenkara-deploy.timer <<'EOF'
[Unit]
Description=Check for a new Zenkara release every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload && systemctl enable --now zenkara-deploy.timer
```

Verify the instance can see the bucket before trusting the timer:

```bash
aws s3 ls s3://zenkara-deploy/ --region eu-north-1
```

---

## Day to day

```bash
systemctl list-timers zenkara-deploy.timer     # when it next runs
journalctl -u zenkara-deploy -n 50 --no-pager  # what it did
cat /var/lib/zenkara-deploy/deployed-sha       # what is live
curl -s https://app.zenkara.in/zenkara/deployed.txt   # same, from outside
systemctl start zenkara-deploy                 # force a check now
```

## Safety properties worth knowing

- **`current.txt` is written last.** A half-uploaded release is invisible,
  so the puller can never grab an incomplete set of artifacts.
- **Artifacts are downloaded and verified before anything is touched.** A
  failed download leaves the running site alone.
- **The sha is recorded only after `/health` answers.** A crash-looping
  release is not marked deployed, so the next tick retries it rather than
  leaving you stuck.

## Rolling back

```bash
aws s3 cp s3://zenkara-deploy/current.txt -          # note the current sha
echo "<previous-sha>" | aws s3 cp - s3://zenkara-deploy/current.txt --cache-control no-cache
```

The next tick rolls the instance back within a minute. Releases are kept for
30 days, so anything in that window is a valid target.

## HTTPS (required for attendance features)

Face verification, geofenced check-in, live location and the installable
PWA all need a secure origin — browsers never show the camera or location
prompt on plain `http://`. Once DNS points at the instance and ports 80/443
are open:

```bash
sudo bash /opt/zenkara-crm/deploy/enable-https.sh ops@zenkara.in
```

That installs certbot, obtains the Let's Encrypt certificate, rewrites the
nginx site to serve 443 and redirect 80, and leaves renewal to certbot's
timer. Afterwards set these in `server/.env` and restart the API:

```
FRONTEND_URL=https://app.zenkara.in/zenkara   # WITH the base path
APP_URL=https://app.zenkara.in/zenkara        # WITH the base path (must match the OAuth redirect URIs registered with Google/Microsoft)
CORS_ORIGIN=https://app.zenkara.in            # origin only (add ,https://360.zenkara.in if used)
```

`FRONTEND_URL` without `/zenkara` makes every emailed link (user invites,
password resets, customer-portal invites, Stripe returns) point at
`https://app.zenkara.in/<page>`, which nginx doesn't route to the app — 404.
`APP_URL` is how the Google/Microsoft OAuth callbacks and CSAT survey links
reach the API (`<APP_URL>/api/...` → nginx `/zenkara/api/`).

## Billing (Stripe)

Until both keys below are set the app works normally, the Billing page says
online payment isn't available (with `BILLING_CONTACT_EMAIL` / the contact set
in Platform Admin → Pricing) and you provision licences by hand in Platform
Admin. To turn on self-serve payments:

1. **Keys.** Stripe Dashboard → Developers → API keys → copy the secret key
   into `STRIPE_SECRET_KEY` in `server/.env`. Use `sk_test_…` first.
2. **Webhook.** Developers → Webhooks → *Add endpoint*:
   - URL: `https://app.zenkara.in/zenkara/api/billing/webhook`
   - API version: **2024-06-20** (what the server pins; newer versions are
     handled too, but this one is tested)
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. **Redirects.** `FRONTEND_URL` must include the base path
   (`https://app.zenkara.in/zenkara`) — Checkout and the portal return to
   `FRONTEND_URL/billing`.
4. **Customer portal.** Settings → Billing → Customer portal: enable
   *update payment method*, *view invoices* and *cancel subscription*
   (cancel **at end of period**). Leave *switch plans* **off** — plan changes
   go through the app, which updates the existing subscription in place with
   proration. *Update quantities* may stay on for custom (per-seat) licences;
   a quantity below the seats in use is accepted but blocks new billable users.
5. **Prices.** Set them in Platform Admin → Pricing (fixed plans, custom
   licence per seat, currency, trial days). Nothing needs creating in Stripe:
   every checkout uses inline prices, and each plan change creates its own
   product. `STRIPE_PRO_PRICE_ID` / `STRIPE_ENTERPRISE_PRICE_ID` are ignored.
6. Restart the API (`sudo systemctl restart zenkara-crm-api`).

**Verifying in test mode:** with `sk_test_` keys, subscribe as a customer
Super Admin with card `4242 4242 4242 4242`; switch Pro → Enterprise from
Billing and check the Stripe dashboard shows **one** subscription with a
proration line; use card `4000 0000 0000 0341` (attaches, then fails) and
*Advance time* on a test clock to see past_due → grace → lapsed;
`stripe trigger invoice.payment_failed` / `stripe listen --forward-to …` also
work. Each webhook delivery is recorded once in the `stripe_events` table.

**INR / GST (India):**
- Set the currency to INR in Platform Admin → Pricing *before* the first paid
  checkout. Stripe ties a customer to the currency of its first subscription,
  so an org that already pays in USD keeps paying in USD (switching needs a
  new Stripe customer — cancel, clear `stripe_customer_id`, re-subscribe).
- Indian accounts: card payments for recurring INR billing need e-mandates
  (RBI); Stripe handles this in Checkout, but expect some first payments to
  require authentication. International cards on an Indian account must be
  enabled in Stripe settings.
- Checkout always collects billing address and an optional tax ID (GSTIN).
  For GST on invoices, register your GSTIN in Stripe Tax, then set
  `STRIPE_AUTOMATIC_TAX=true`. Leave it `false` until Stripe Tax is set up or
  checkout will fail.
- Prices are tax-exclusive by default (Stripe adds GST on top when automatic
  tax is on). Set your invoice prefix, legal name and GSTIN under
  Settings → Business → Public details / Invoice template.

**Grace & lapse:** a failed payment gives `LICENSE_GRACE_PERIOD_DAYS` (Pricing
→ grace) of continued access; after that the org is limited to Free —
existing users, rules and files keep working, nothing is deleted.

## What this does *not* cover

The Android app. APKs still need `npx cap sync` and a Gradle build locally —
automating that needs signing keys in CI and is worth doing only once you
are publishing to Play.
