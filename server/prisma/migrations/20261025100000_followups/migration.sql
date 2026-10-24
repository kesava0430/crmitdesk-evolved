-- Follow-ups (utils/followups): reminders, digest, status icons, sent/received
-- email logging. Additive only — every new column is nullable or defaulted,
-- so existing activities/tasks keep their meaning (assigned_to NULL = the
-- creator does it; reminded_at NULL = not reminded yet, but the reminder
-- poller only fires for items that fell due within the last few hours, so
-- old rows never produce a burst of notifications on deploy).

ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "assigned_to" TEXT;
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "reminded_at" TIMESTAMP(3);
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "email_message_id" TEXT;
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "email_meta" JSONB;

DO $$ BEGIN
  ALTER TABLE "activities" ADD CONSTRAINT "activities_assigned_to_fkey"
    FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deal-side lookups had no index (only org_id and lead_id were indexed).
CREATE INDEX IF NOT EXISTS "activities_deal_id_idx" ON "activities"("deal_id");
-- Reminder poller, My Work and list status: open items by due time per org.
CREATE INDEX IF NOT EXISTS "activities_org_id_done_due_at_idx" ON "activities"("org_id", "done", "due_at");
-- Reply matching (email sync looks up In-Reply-To / References).
CREATE INDEX IF NOT EXISTS "activities_email_message_id_idx" ON "activities"("email_message_id");

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reminded_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "followup_prefs" (
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "digest" BOOLEAN NOT NULL DEFAULT true,
    "last_digest_on" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "followup_prefs_pkey" PRIMARY KEY ("user_id")
);
CREATE INDEX IF NOT EXISTS "followup_prefs_org_id_idx" ON "followup_prefs"("org_id");
DO $$ BEGIN
  ALTER TABLE "followup_prefs" ADD CONSTRAINT "followup_prefs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "followup_prefs" ADD CONSTRAINT "followup_prefs_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
