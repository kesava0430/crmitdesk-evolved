-- AI cost controls: provider prompt-cache accounting + a persistent answer cache.

-- Prompt tokens served from the provider's prompt cache (billed at a discount).
ALTER TABLE "ai_interaction_logs" ADD COLUMN IF NOT EXISTS "cached_prompt_tokens" INTEGER NOT NULL DEFAULT 0;

-- Shared cache for repeatable AI answers, keyed by a hash of the full prompt.
CREATE TABLE IF NOT EXISTS "ai_response_cache" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "cache_key" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_response_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_response_cache_org_id_cache_key_key" ON "ai_response_cache"("org_id", "cache_key");
CREATE INDEX IF NOT EXISTS "ai_response_cache_expires_at_idx" ON "ai_response_cache"("expires_at");

DO $$ BEGIN
  ALTER TABLE "ai_response_cache" ADD CONSTRAINT "ai_response_cache_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
