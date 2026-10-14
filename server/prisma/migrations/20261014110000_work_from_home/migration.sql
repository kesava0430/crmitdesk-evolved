-- Work from home: per-policy-group rules, recurring WFH schedules and a WFH
-- marker on check-in sessions (utils/wfh.ts). Additive; every new column has a
-- default, so orgs that never use WFH see no change.

-- Rules per policy group. Owner defaults: enabled, manager approval, 4 days a
-- month, no weekly cap, no notice, same-day and half days allowed, check-in
-- required on WFH days.
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "wfh_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "wfh_approval_mode" TEXT NOT NULL DEFAULT 'MANAGER';
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "wfh_max_per_month" INTEGER DEFAULT 4;
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "wfh_max_per_week" INTEGER;
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "wfh_min_notice_days" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "wfh_allow_same_day" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "wfh_allow_half_day" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "attendance_policy_groups" ADD COLUMN IF NOT EXISTS "wfh_require_check_in" BOOLEAN NOT NULL DEFAULT true;

-- Orgs that already have approved work-from-home requests were promised "WFH
-- days are paid whatever was punched". Requiring a check-in for them would
-- silently turn this month's unpunched (not yet paid) WFH days into absences
-- the moment the register recomputes, so their existing groups keep the old
-- behaviour until HR switches it on. Everyone else gets the new default.
UPDATE "attendance_policy_groups" g SET "wfh_require_check_in" = false
WHERE EXISTS (
    SELECT 1 FROM "leave_requests" r JOIN "leave_types" t ON t."id" = r."leave_type_id"
    WHERE r."org_id" = g."org_id" AND t."is_wfh" = true AND r."status" = 'APPROVED'
);

-- Sessions started on an approved WFH day.
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'OFFICE';

-- Recurring WFH (one person or a whole policy group).
CREATE TABLE IF NOT EXISTS "wfh_schedules" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT,
    "policy_group_id" TEXT,
    "weekdays" INTEGER[],
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wfh_schedules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "wfh_schedules_org_id_user_id_idx" ON "wfh_schedules"("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "wfh_schedules_org_id_policy_group_id_idx" ON "wfh_schedules"("org_id", "policy_group_id");
ALTER TABLE "wfh_schedules" ADD CONSTRAINT "wfh_schedules_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wfh_schedules" ADD CONSTRAINT "wfh_schedules_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wfh_schedules" ADD CONSTRAINT "wfh_schedules_policy_group_id_fkey"
    FOREIGN KEY ("policy_group_id") REFERENCES "attendance_policy_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Dates a schedule is skipped (for one person, or everyone on it when user_id is null).
CREATE TABLE IF NOT EXISTS "wfh_schedule_exceptions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "user_id" TEXT,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wfh_schedule_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "wfh_schedule_exceptions_schedule_id_date_idx" ON "wfh_schedule_exceptions"("schedule_id", "date");
ALTER TABLE "wfh_schedule_exceptions" ADD CONSTRAINT "wfh_schedule_exceptions_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "wfh_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
