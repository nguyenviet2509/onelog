-- Enqueue add_or_update_user_grant for Spike Tester onemcp.admin on the
-- existing OneMCP Portal Zitadel project (385595003772076035, org Authway Internal).
-- Called after wizard-project grant revoked + rbac.apps swapped to portal project.

INSERT INTO rbac.outbox_events (idempotency_key, operation, args, status)
VALUES (
  encode(sha256(('add_or_update_user_grant:manual-backfill:' || extract(epoch FROM now())::text)::bytea), 'hex'),
  'add_or_update_user_grant',
  jsonb_build_object(
    'userId', '387657093185798148',
    'orgId', '385591139173990404',
    'projectId', '385595003772076035',
    'roleKey', 'onemcp.admin'
  ),
  'pending'
)
RETURNING id;
