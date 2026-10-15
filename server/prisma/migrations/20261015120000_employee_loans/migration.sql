-- Employee loans / salary advances recovered through payroll, with an
-- auditable ledger. Additive only: no existing table changes shape, so
-- current payslips and runs are untouched.

CREATE TABLE IF NOT EXISTS "employee_loans" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'LOAN',
    "principal" DECIMAL(12,2) NOT NULL,
    "interest_rate" DECIMAL(5,2),
    "interest_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_repayable" DECIMAL(12,2) NOT NULL,
    "emi_amount" DECIMAL(12,2) NOT NULL,
    "instalments" INTEGER NOT NULL,
    "disbursed_on" DATE NOT NULL,
    "start_month" INTEGER NOT NULL,
    "start_year" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "close_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_loans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "employee_loans_org_id_user_id_idx" ON "employee_loans"("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "employee_loans_org_id_status_idx" ON "employee_loans"("org_id", "status");
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "loan_ledger_entries" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "loan_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "entry_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payslip_id" TEXT,
    "payroll_run_id" TEXT,
    "balance_after" DECIMAL(12,2),
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loan_ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "loan_ledger_entries_loan_id_idx" ON "loan_ledger_entries"("loan_id");
CREATE INDEX IF NOT EXISTS "loan_ledger_entries_payslip_id_idx" ON "loan_ledger_entries"("payslip_id");
CREATE INDEX IF NOT EXISTS "loan_ledger_entries_org_id_year_month_idx" ON "loan_ledger_entries"("org_id", "year", "month");
ALTER TABLE "loan_ledger_entries" ADD CONSTRAINT "loan_ledger_entries_loan_id_fkey"
    FOREIGN KEY ("loan_id") REFERENCES "employee_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loan_ledger_entries" ADD CONSTRAINT "loan_ledger_entries_payslip_id_fkey"
    FOREIGN KEY ("payslip_id") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
