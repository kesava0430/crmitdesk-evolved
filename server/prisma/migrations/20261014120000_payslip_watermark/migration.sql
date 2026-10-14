-- Payslip template logo watermark. Every column has a default and the feature
-- is off by default, so existing templates render exactly as before.
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "watermark_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "watermark_source" TEXT NOT NULL DEFAULT 'LOGO';
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "watermark_image_url" TEXT;
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "watermark_opacity" DOUBLE PRECISION NOT NULL DEFAULT 0.08;
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "watermark_size" INTEGER NOT NULL DEFAULT 55;
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "watermark_rotation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payslip_templates" ADD COLUMN IF NOT EXISTS "watermark_repeat" BOOLEAN NOT NULL DEFAULT false;
