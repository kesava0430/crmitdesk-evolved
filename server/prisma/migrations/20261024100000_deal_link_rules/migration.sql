-- "Related deals" rule (deal detail → Related deals / Lessons from past deals).
-- Additive only: one new table. No row = feature not set up for that org, so
-- nothing changes for existing customers until a CRM admin picks the fields.
-- Matching on custom field text uses lower(trim + collapsed whitespace), served
-- by the existing (custom_field_id, entity_id) unique index's leading column.

CREATE TABLE IF NOT EXISTS "deal_link_rules" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ALL',
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "deal_link_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "deal_link_rules_org_id_key" ON "deal_link_rules"("org_id");
ALTER TABLE "deal_link_rules" ADD CONSTRAINT "deal_link_rules_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
