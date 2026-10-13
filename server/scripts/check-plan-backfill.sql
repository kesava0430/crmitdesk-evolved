-- LIC-26 diagnostic: which organisations lost a paid plan when migration
-- 20260914090000_custom_licensing dropped organizations.plan without copying
-- it onto subscriptions.plan?
--
-- That migration can't be undone from code (the column is gone), so this is a
-- READ-ONLY comparison you run by hand:
--
--   1. Restore a database backup taken BEFORE 2026-09-14 into a scratch DB
--      (never over production), e.g.  createdb crm_backup && pg_restore -d crm_backup backup.dump
--   2. psql crm_backup  -f server/scripts/check-plan-backfill.sql -v phase=backup
--        → writes /tmp/org_plans_before.csv
--   3. psql <production> -f server/scripts/check-plan-backfill.sql -v phase=compare
--        → lists every org whose pre-migration plan was paid but whose
--          licence today is FREE (or has no subscription row at all).
--   4. Review the list, then fix each org in Platform Admin → org → Licence
--      (that writes an audit-log entry), not with ad-hoc SQL.
--
-- Nothing in this file writes to the production database.

\if :{?phase}
\else
  \echo 'Usage: psql <db> -f check-plan-backfill.sql -v phase=backup|compare'
  \quit
\endif

\if `echo :phase | grep -qx backup && echo true || echo false`
  -- Phase 1, on the RESTORED BACKUP: snapshot org → plan as it was.
  \copy (SELECT o.id AS org_id, o.name, o.plan AS org_plan, s.plan AS sub_plan, s.status AS sub_status, s.stripe_subscription_id FROM organizations o LEFT JOIN subscriptions s ON s.org_id = o.id ORDER BY o.created_at) TO '/tmp/org_plans_before.csv' WITH CSV HEADER
  \echo 'Wrote /tmp/org_plans_before.csv — now run with -v phase=compare against production.'
\else
  -- Phase 2, on PRODUCTION (read-only): compare with today's licences.
  BEGIN; -- temp table only; nothing else is written
  CREATE TEMP TABLE org_plans_before (org_id TEXT, name TEXT, org_plan TEXT, sub_plan TEXT, sub_status TEXT, stripe_subscription_id TEXT) ON COMMIT DROP;
  \copy org_plans_before FROM '/tmp/org_plans_before.csv' WITH CSV HEADER

  SELECT b.org_id,
         b.name,
         b.org_plan                     AS plan_before_migration,
         COALESCE(s.plan, '(no row)')   AS plan_now,
         s.status                       AS status_now,
         s.stripe_subscription_id       AS stripe_subscription_now,
         s.manual_note
  FROM org_plans_before b
  LEFT JOIN subscriptions s ON s.org_id = b.org_id
  WHERE b.org_plan IS NOT NULL
    AND b.org_plan <> 'FREE'
    AND COALESCE(s.plan, 'FREE') = 'FREE'
  ORDER BY b.name;
  COMMIT;
\endif
