-- Bulk attendance corrections (register "Bulk edit"). Every day a bulk request
-- changes still gets its own audit row; batch_id ties those rows together so
-- the change history can show "bulk" and a whole batch can be found again.
-- Nullable, no default: existing rows (single edits) simply have no batch.

ALTER TABLE "attendance_audits" ADD COLUMN IF NOT EXISTS "batch_id" TEXT;

CREATE INDEX IF NOT EXISTS "attendance_audits_batch_id_idx" ON "attendance_audits"("batch_id");
