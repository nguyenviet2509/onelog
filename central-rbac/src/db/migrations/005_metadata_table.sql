-- =============================================================================
-- Migration 005: rbac.metadata table for epoch counter and other KV config.
-- Idempotent via IF NOT EXISTS.
-- =============================================================================

SET search_path = rbac, public;

CREATE TABLE IF NOT EXISTS rbac.metadata (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed epoch at 1 so first cache key is resolve:v1:... (not v0)
INSERT INTO rbac.metadata (key, value)
VALUES ('resolve_epoch', '1')
ON CONFLICT (key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON rbac.metadata TO rbac_writer;

-- Record migration
INSERT INTO rbac.schema_migrations (version, description)
VALUES (5, 'rbac.metadata table for epoch counter')
ON CONFLICT (version) DO NOTHING;
