-- Saved analytics dashboards (Dashboards page). Additive only: three new
-- tables, nothing existing changes shape. Widgets store query specs, not
-- data — every view re-runs them with the viewer's permissions.

CREATE TABLE IF NOT EXISTS "dashboards" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "role_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "legacy_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "layout" JSONB NOT NULL DEFAULT '{}',
    "date_range" JSONB,
    "refresh_minutes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "dashboards_org_id_owner_id_idx" ON "dashboards"("org_id", "owner_id");
CREATE INDEX IF NOT EXISTS "dashboards_org_id_visibility_idx" ON "dashboards"("org_id", "visibility");
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "dashboard_widgets" (
    "id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "dashboard_widgets_dashboard_id_position_idx" ON "dashboard_widgets"("dashboard_id", "position");
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_fkey"
    FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "dashboard_homes" (
    "user_id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "replace_built_in" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dashboard_homes_pkey" PRIMARY KEY ("user_id")
);
CREATE INDEX IF NOT EXISTS "dashboard_homes_dashboard_id_idx" ON "dashboard_homes"("dashboard_id");
ALTER TABLE "dashboard_homes" ADD CONSTRAINT "dashboard_homes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboard_homes" ADD CONSTRAINT "dashboard_homes_dashboard_id_fkey"
    FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
