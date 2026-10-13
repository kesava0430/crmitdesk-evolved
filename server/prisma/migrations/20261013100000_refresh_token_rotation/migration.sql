-- Refresh-token rotation with recovery (APP-2/APP-3).
--
-- Rotation used to DELETE the presented token and insert a new one. When the
-- response carrying the new token never reached the client (app frozen mid-
-- request, network drop, client timeout followed by a retry) the client was
-- left holding a token that no longer existed and was logged out on its next
-- refresh. Rotated rows are now kept for a while, remember their successor
-- (by hash only) and allow a short, bounded grace window.
--
-- Additive only: existing rows become live, un-rotated 'web' tokens, which
-- is exactly what they were.

ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "rotated_at" TIMESTAMP(3);
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "replaced_by_hash" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "grace_uses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "client_type" TEXT NOT NULL DEFAULT 'web';
-- One sign-in = one family (login token + all successors, including grace
-- siblings) so logout can revoke them together. Existing rows stay NULL and
-- act as their own family root.
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "family_id" TEXT;
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- The hourly purge deletes rotated rows past their retention.
CREATE INDEX IF NOT EXISTS "refresh_tokens_rotated_at_idx" ON "refresh_tokens"("rotated_at");
