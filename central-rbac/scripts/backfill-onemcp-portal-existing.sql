-- Backfill: enqueue add_project_role for onemcp.viewer/editor/admin into
-- the PRE-EXISTING OneMCP Portal Zitadel project (385595003772076035, org Authway Internal).
-- Wizard originally created a separate project (388071945217769476); we swapped rbac.apps
-- to point to the real portal project. Now we need the 3 default roles to exist on
-- the portal's Zitadel side so grants can reference them.
--
-- Run once after: (1) rbac.apps DELETE wizard row + INSERT portal row, (2) roles.app_id
-- UPDATE to new app id.

INSERT INTO rbac.outbox_events (idempotency_key, operation, args, status)
SELECT
  encode(sha256(('add_project_role:385595003772076035:' || rk)::bytea), 'hex'),
  'add_project_role',
  jsonb_build_object(
    'projectId', '385595003772076035',
    'orgId', '385591139173990404',
    'roleKey', rk,
    'displayName', dn
  ),
  'pending'
FROM (VALUES
  ('onemcp.viewer', 'OneMCP Viewer'),
  ('onemcp.editor', 'OneMCP Editor'),
  ('onemcp.admin',  'OneMCP Admin')
) AS t(rk, dn)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, args->>'roleKey' AS role_key;
