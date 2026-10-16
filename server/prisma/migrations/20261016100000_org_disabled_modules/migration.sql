-- Per-org module switch-off by the platform operator (Platform Admin → org →
-- Modules). Feature keys listed here are removed from the org's effective
-- licence in every payment state (utils/licensing.ts evaluateLicense), on top
-- of extra_features which can only ADD. Empty for every existing org, so the
-- migration changes nobody's access.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "disabled_features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
