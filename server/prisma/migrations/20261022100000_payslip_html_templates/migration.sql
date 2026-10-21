-- Payslip templates written in HTML (layout = 'CUSTOM_HTML'). Both columns are
-- nullable and unused by the built-in layouts, so existing templates and
-- issued payslips render exactly as before.
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "html_body" TEXT;
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "html_css" TEXT;
