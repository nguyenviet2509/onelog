-- Migration 012 — track Zitadel project OWNER org per app.
--
-- Cross-org projects (e.g., existing OneMCP Portal owned by "Authway Internal",
-- users granted from "spike-test" org) require Zitadel Management API calls to
-- send x-zitadel-orgid = project owner org, not user's org. Previously we used
-- env ZITADEL_ORG_ID → all cross-org grants died with 4xx.
--
-- Runtime rule (see services/user-grant-sync.ts): resolveProjectContext(roleKey)
-- returns { projectId, orgId } from apps table. Legacy roles (app_id NULL) fall
-- back to env ZITADEL_PROJECT_ID + ZITADEL_ORG_ID.

BEGIN;

ALTER TABLE rbac.apps
  ADD COLUMN IF NOT EXISTS zitadel_org_id TEXT;

-- Backfill known apps by slug — safe because slug is unique + this migration
-- ships together with app-registration code that requires zitadel_org_id.
-- After this migration, wizard writes zitadel_org_id explicitly on INSERT.
-- Guard AND zitadel_org_id IS NULL makes the UPDATE idempotent on migration re-run
-- (won't clobber a manually-corrected org id set by an operator).
UPDATE rbac.apps SET zitadel_org_id = '385591139173990404'
 WHERE slug = 'onemcp'
   AND zitadel_project_id = '385595003772076035'
   AND zitadel_org_id IS NULL;

COMMIT;
