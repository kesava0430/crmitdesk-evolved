-- Rerun payroll after salary changes: reopen finalised/paid runs, keep every
-- issued payslip as a revision, and track the difference vs what was paid.
-- Additive only; existing runs/payslips get version 1 and no lock, so they
-- behave exactly as before until someone reopens one.

ALTER TABLE "payroll_runs" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payroll_runs" ADD COLUMN IF NOT EXISTS "finalized_by" TEXT;
ALTER TABLE "payroll_runs" ADD COLUMN IF NOT EXISTS "locked_at" TIMESTAMP(3);

ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "revised_at" TIMESTAMP(3);
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "paid_difference" DECIMAL(12,2);

CREATE TABLE IF NOT EXISTS "payslip_revisions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "payslip_id" TEXT,
    "payroll_run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payslip_revisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "payslip_revisions_org_id_payroll_run_id_idx" ON "payslip_revisions"("org_id", "payroll_run_id");
CREATE INDEX IF NOT EXISTS "payslip_revisions_payslip_id_idx" ON "payslip_revisions"("payslip_id");
ALTER TABLE "payslip_revisions" ADD CONSTRAINT "payslip_revisions_payslip_id_fkey"
    FOREIGN KEY ("payslip_id") REFERENCES "payslips"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payslip_revisions" ADD CONSTRAINT "payslip_revisions_payroll_run_id_fkey"
    FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
