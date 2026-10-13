-- Attendance / leave fixes (audit 2026-10-13, ATT-7, ATT-17, ATT-21, ATT-24,
-- ATT-26, ATT-27). Additive only; every new column has a default so existing
-- rows and orgs keep their current behaviour.

-- ATT-7: the app reported it was backgrounded; the silent-session timeout is
-- suspended until it comes back to the foreground.
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "backgrounded_at" TIMESTAMP(3);

-- ATT-17 / ATT-24: daily close-out window and selfie retention.
ALTER TABLE "attendance_policies" ADD COLUMN IF NOT EXISTS "auto_close_after_hours" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "attendance_policies" ADD COLUMN IF NOT EXISTS "selfie_retention_days" INTEGER NOT NULL DEFAULT 90;

-- ATT-26: optional-holiday allowance per policy group + the opt-in rows.
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "optional_holidays_allowed" INTEGER NOT NULL DEFAULT 2;

CREATE TABLE IF NOT EXISTS "optional_holiday_choices" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "holiday_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "optional_holiday_choices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "optional_holiday_choices_user_id_holiday_id_key" ON "optional_holiday_choices"("user_id", "holiday_id");
CREATE INDEX IF NOT EXISTS "optional_holiday_choices_org_id_user_id_idx" ON "optional_holiday_choices"("org_id", "user_id");
ALTER TABLE "optional_holiday_choices" ADD CONSTRAINT "optional_holiday_choices_holiday_id_fkey"
    FOREIGN KEY ("holiday_id") REFERENCES "holidays"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ATT-27: work-from-home leave type.
ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "is_wfh" BOOLEAN NOT NULL DEFAULT false;

-- ATT-21: at most one open session per user, enforced by the database so two
-- concurrent check-ins can't both pass the "already checked in?" read.
-- Existing duplicates (the bug this fixes, plus UTC-date check-outs that never
-- found their session) are resolved first: every open session except each
-- user's most recent one is closed at its own check-in time with
-- check_out_source 'DEDUPED', so it shows up as a zero-length session HR can
-- correct from the register instead of silently disappearing.
WITH ranked AS (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "user_id" ORDER BY "check_in_at" DESC, "created_at" DESC) AS rn
    FROM "attendance_records"
    WHERE "check_in_at" IS NOT NULL AND "check_out_at" IS NULL
)
UPDATE "attendance_records" r
SET "check_out_at" = r."check_in_at", "check_out_source" = 'DEDUPED', "outside_since" = NULL
FROM ranked
WHERE r."id" = ranked."id" AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "attendance_records_one_open_per_user"
    ON "attendance_records"("user_id")
    WHERE "check_in_at" IS NOT NULL AND "check_out_at" IS NULL;

-- Open-session lookups (check-out, heartbeat, close-out, live map) no longer
-- filter by date.
CREATE INDEX IF NOT EXISTS "attendance_records_org_id_check_in_at_idx" ON "attendance_records"("org_id", "check_in_at");
