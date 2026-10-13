-- Face ID re-enrolment approval workflow.
--
-- Replacing an enrolled face now needs Super Admin sign-off. The proposed
-- descriptors and their sample images live here until a decision is made, so
-- the row in face_enrollments keeps serving attendance untouched meanwhile.

CREATE TABLE "face_reenrollment_requests" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "descriptors" JSONB NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "sample_images" JSONB NOT NULL,
    "previous_selfie" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "active_pending_user_id" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "face_reenrollment_requests_pkey" PRIMARY KEY ("id")
);

-- At most one PENDING request per user. Postgres allows unlimited NULLs in a
-- unique index, so holding the user id here only while PENDING turns
-- duplicate prevention into a constraint the database enforces, rather than a
-- read-then-write that two concurrent submissions could both pass.
CREATE UNIQUE INDEX "face_reenrollment_requests_active_pending_user_id_key"
    ON "face_reenrollment_requests"("active_pending_user_id");

CREATE INDEX "face_reenrollment_requests_org_id_status_idx"
    ON "face_reenrollment_requests"("org_id", "status");

CREATE INDEX "face_reenrollment_requests_org_id_user_id_idx"
    ON "face_reenrollment_requests"("org_id", "user_id");

ALTER TABLE "face_reenrollment_requests"
    ADD CONSTRAINT "face_reenrollment_requests_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "face_reenrollment_requests"
    ADD CONSTRAINT "face_reenrollment_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "face_reenrollment_requests"
    ADD CONSTRAINT "face_reenrollment_requests_decided_by_fkey"
    FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
