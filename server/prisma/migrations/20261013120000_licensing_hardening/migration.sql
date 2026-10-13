-- Licensing / billing hardening (audit 2026-10-13, LIC-7/9/12/18/20/24).
-- Every column is nullable or has a default, so this is safe on live data and
-- changes no existing org's entitlements by itself.

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "seats_override"                  INTEGER,
  ADD COLUMN IF NOT EXISTS "extra_features"                  TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "manual_note"                     TEXT,
  ADD COLUMN IF NOT EXISTS "manual_expires_at"               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trial_ends_at"                   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "had_paid_subscription"           BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "last_stripe_event_at"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_invoice_amount_cents"       INTEGER,
  ADD COLUMN IF NOT EXISTS "platform_email_quota_monthly"    INTEGER,
  ADD COLUMN IF NOT EXISTS "platform_whatsapp_quota_monthly" INTEGER;

-- Orgs that are (or were) on a Stripe subscription have paid before — they
-- must not be offered a first-time trial.
UPDATE "subscriptions" SET "had_paid_subscription" = true
WHERE "stripe_subscription_id" IS NOT NULL OR "stripe_customer_id" IS NOT NULL;

-- Manual licences (no Stripe subscription) used to lapse at
-- current_period_end + grace (7 days by default). They now expire only on
-- manual_expires_at. Copy the old effective deadline across so nothing
-- changes on deploy: already-lapsed rows stay lapsed, future ones lapse when
-- they always would have — the operator extends (or clears) the date in
-- Platform Admin. Rows with no current_period_end keep NULL = no expiry.
-- (Demo orgs are re-seeded with NULL.)
UPDATE "subscriptions"
SET "manual_expires_at" = "current_period_end" + interval '7 days'
WHERE "stripe_subscription_id" IS NULL
  AND "plan" <> 'FREE'
  AND "current_period_end" IS NOT NULL
  AND "manual_expires_at" IS NULL;

-- Payment-problem rows without a grace deadline used to get
-- current_period_end + 7 days. The new evaluation counts grace from the
-- failure instead, which would lapse such rows on deploy — give them an
-- explicit deadline no earlier than they had before (7 = default grace days).
UPDATE "subscriptions"
SET "grace_until" = GREATEST(now(), COALESCE("current_period_end", now())) + interval '7 days'
WHERE "status" IN ('past_due', 'incomplete', 'unpaid')
  AND "grace_until" IS NULL;

CREATE TABLE IF NOT EXISTS "stripe_events" (
  "id"           TEXT         NOT NULL,
  "type"         TEXT         NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "stripe_events_processed_at_idx" ON "stripe_events"("processed_at");
