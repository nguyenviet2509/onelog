-- 013_apps_delete_grant.sql
-- Grant DELETE on rbac.apps to rbac_writer so admin delete-app endpoint works.
-- Prior migrations (008) intentionally omitted DELETE; delete flow added 2026-09-03.

GRANT DELETE ON rbac.apps TO rbac_writer;

INSERT INTO rbac.schema_migrations (version, description)
VALUES (13, 'Grant DELETE on rbac.apps to rbac_writer')
ON CONFLICT DO NOTHING;
