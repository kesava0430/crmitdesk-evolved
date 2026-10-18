-- Staff assistant over WhatsApp / Slack (server/src/utils/assistantChannels).
-- Additive only: new tables, plus one nullable column on ai_interaction_logs.
-- Every org starts with both channels OFF (no config row), so nothing changes
-- for existing customers until an owner turns a channel on.

ALTER TABLE "ai_interaction_logs" ADD COLUMN IF NOT EXISTS "channel" TEXT;

CREATE TABLE IF NOT EXISTS "assistant_channel_configs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "slack_enabled" BOOLEAN NOT NULL DEFAULT false,
    "slack_bot_token" TEXT,
    "slack_signing_secret" TEXT,
    "slack_team_id" TEXT,
    "slack_email_match" BOOLEAN NOT NULL DEFAULT false,
    "slack_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assistant_channel_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_channel_configs_org_id_key" ON "assistant_channel_configs"("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_channel_configs_slack_key_key" ON "assistant_channel_configs"("slack_key");
ALTER TABLE "assistant_channel_configs" ADD CONSTRAINT "assistant_channel_configs_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "assistant_whatsapp_links" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assistant_whatsapp_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_whatsapp_links_user_id_key" ON "assistant_whatsapp_links"("user_id");
CREATE INDEX IF NOT EXISTS "assistant_whatsapp_links_org_id_phone_e164_idx" ON "assistant_whatsapp_links"("org_id", "phone_e164");
ALTER TABLE "assistant_whatsapp_links" ADD CONSTRAINT "assistant_whatsapp_links_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assistant_whatsapp_links" ADD CONSTRAINT "assistant_whatsapp_links_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "slack_user_links" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "slack_team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "slack_user_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "slack_user_links_user_id_key" ON "slack_user_links"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "slack_user_links_slack_team_id_slack_user_id_key" ON "slack_user_links"("slack_team_id", "slack_user_id");
CREATE INDEX IF NOT EXISTS "slack_user_links_org_id_idx" ON "slack_user_links"("org_id");
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "assistant_link_codes" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "user_id" TEXT,
    "slack_team_id" TEXT,
    "slack_user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assistant_link_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "assistant_link_codes_org_id_channel_code_hash_idx" ON "assistant_link_codes"("org_id", "channel", "code_hash");
ALTER TABLE "assistant_link_codes" ADD CONSTRAINT "assistant_link_codes_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "assistant_sessions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "turns" JSONB NOT NULL DEFAULT '[]',
    "pending" JSONB,
    "pending_expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assistant_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_sessions_channel_user_id_key" ON "assistant_sessions"("channel", "user_id");
ALTER TABLE "assistant_sessions" ADD CONSTRAINT "assistant_sessions_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assistant_sessions" ADD CONSTRAINT "assistant_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
