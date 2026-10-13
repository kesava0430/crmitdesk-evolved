-- Link an invite to the person it was raised for.
--
-- HR → People → Add person → Send an invite created the employee record and
-- the token as unrelated rows. On acceptance nothing connected them, so
-- ensureEmployeeForUser — which looks the employee up by user_id, and the
-- invited one has none yet — provisioned a SECOND employee for the same
-- human. This column carries the association that was missing.
--
-- Nullable on purpose: invites from Admin → Users have no employee record
-- behind them, and invites already in flight when this ships have no value
-- to backfill. Acceptance falls back to matching on email + org for those.

ALTER TABLE "invite_tokens" ADD COLUMN "employee_id" TEXT;

CREATE INDEX "invite_tokens_org_id_email_idx" ON "invite_tokens"("org_id", "email");

ALTER TABLE "invite_tokens"
    ADD CONSTRAINT "invite_tokens_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill invites that are still open, where exactly one unlinked employee
-- in the org carries that work email. "Exactly one" matters: with two
-- candidates there is no evidence which was invited, and guessing would
-- attach a login to the wrong person — far worse than the duplicate this
-- fixes. Those fall through to provisioning, as they do today.
UPDATE "invite_tokens" t
SET "employee_id" = e.id
FROM "employees" e
WHERE t."used_at" IS NULL
  AND t."employee_id" IS NULL
  AND e."org_id" = t."org_id"
  AND e."user_id" IS NULL
  AND lower(e."work_email") = lower(t."email")
  AND (
    SELECT count(*) FROM "employees" c
    WHERE c."org_id" = t."org_id" AND c."user_id" IS NULL AND lower(c."work_email") = lower(t."email")
  ) = 1;
