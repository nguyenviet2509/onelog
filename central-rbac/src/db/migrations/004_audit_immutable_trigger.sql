-- =============================================================================
-- Migration 004: audit_log immutable trigger
-- BEFORE UPDATE OR DELETE on audit_log → RAISE EXCEPTION
-- This is the DB-layer enforcement; rbac_writer role also has no UPDATE/DELETE
-- privilege (defence in depth).
-- =============================================================================

SET search_path = rbac, public;

CREATE OR REPLACE FUNCTION rbac.reject_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

-- Drop then recreate to ensure idempotency
DROP TRIGGER IF EXISTS audit_immutable ON rbac.audit_log;

CREATE TRIGGER audit_immutable
  BEFORE UPDATE OR DELETE ON rbac.audit_log
  FOR EACH ROW EXECUTE FUNCTION rbac.reject_audit_mutation();

-- Record this migration
INSERT INTO rbac.schema_migrations (version, description)
VALUES (4, 'audit_log append-only trigger')
ON CONFLICT (version) DO NOTHING;
