-- Server-verified face liveness (utils/liveness). Additive: one new column
-- with a default and one new table.
--
-- require_liveness defaults to TRUE for every org, deliberately: this is a
-- security fix (a photo of the person used to pass face verification), so the
-- old behaviour must not remain the default. Orgs that don't use face
-- verification are unaffected — the flag only matters when a rule includes
-- the face signal.

ALTER TABLE "attendance_policies" ADD COLUMN IF NOT EXISTS "require_liveness" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "face_liveness_challenges" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "result" TEXT,
    "failure_reason" TEXT,
    "details" JSONB,
    "evidence_frame" TEXT,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "face_liveness_challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "face_liveness_challenges_user_id_created_at_idx" ON "face_liveness_challenges"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "face_liveness_challenges_org_id_result_created_at_idx" ON "face_liveness_challenges"("org_id", "result", "created_at");
ALTER TABLE "face_liveness_challenges" ADD CONSTRAINT "face_liveness_challenges_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "face_liveness_challenges" ADD CONSTRAINT "face_liveness_challenges_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
