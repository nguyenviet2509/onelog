-- =============================================================================
-- Migration 014: add app_id column to audit_log for external app ingress
-- OneMCP + future apps push events via POST /v1/audit/ingest → app_id tags source.
-- NULL for internal rbac events (backward compat).
-- =============================================================================

SET search_path = rbac, public;

ALTER TABLE rbac.audit_log
  ADD COLUMN IF NOT EXISTS app_id TEXT;

CREATE INDEX IF NOT EXISTS audit_log_app_id_idx
  ON rbac.audit_log(app_id)
  WHERE app_id IS NOT NULL;

INSERT INTO rbac.schema_migrations (version, description)
VALUES (14, 'audit_log.app_id column for external app ingress')
ON CONFLICT (version) DO NOTHING;
