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

-- Manual licences (no Stripe subscription) used currentPeriodEnd for
-- staleness, which silently dropped comped / seeded orgs to Free a week after
-- that date. They now use manual_expires_at, left NULL here = no expiry, so
-- every manually provisioned org keeps the plan it was given.

CREATE TABLE IF NOT EXISTS "stripe_events" (
  "id"           TEXT         NOT NULL,
  "type"         TEXT         NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "stripe_events_processed_at_idx" ON "stripe_events"("processed_at");
