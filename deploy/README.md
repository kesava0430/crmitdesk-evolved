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
assuming this role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::223532249183:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:kesava0430/crmitdesk-evolved:*" }
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
timer. Afterwards set `FRONTEND_URL`, `CORS_ORIGIN` and `APP_URL` in
`server/.env` to `https://app.zenkara.in` and restart the API.

## What this does *not* cover

The Android app. APKs still need `npx cap sync` and a Gradle build locally —
automating that needs signing keys in CI and is worth doing only once you
are publishing to Play.
