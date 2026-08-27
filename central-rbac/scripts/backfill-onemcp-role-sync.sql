-- One-off backfill: enqueue add_project_role for onemcp.* roles created before Migration 011.
-- Wizard didn't sync them to app's Zitadel project at time of creation.
-- Run once after Migration 011 applied + Migration 011 backfill (SET app_id).

INSERT INTO rbac.outbox_events (idempotency_key, operation, args, status)
SELECT
  encode(sha256(('add_project_role:' || a.zitadel_project_id || ':' || r.key)::bytea), 'hex'),
  'add_project_role',
  jsonb_build_object(
    'projectId', a.zitadel_project_id,
    'orgId', '387656897144029188',
    'roleKey', r.key,
    'displayName', r.description
  ),
  'pending'
FROM rbac.roles r
JOIN rbac.apps a ON a.id = r.app_id
WHERE r.key LIKE 'onemcp.%'
ON CONFLICT (idempotency_key) DO NOTHING;
