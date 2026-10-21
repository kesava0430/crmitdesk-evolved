-- Net pay is floored at 0; deductions the period's pay can't cover are kept here
-- (shown on the payslip and in the run review) instead of a negative net pay.
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "unrecovered_deductions" DECIMAL(12,2) NOT NULL DEFAULT 0;
