-- =============================================================================
-- Migration 010: Permissions deprecation + app manifest columns.
-- Phase 08 Red Team Fix #15 (manifest_url) + immutable-key deprecation (Fix #9).
-- Numbering: 008/008a for Phase 07 apps + pending_cleanups.
-- =============================================================================
--
-- Extends rbac.permissions with soft-delete + alias fields.
-- rbac.apps already has manifest_url + manifest_etag from migration 008 — this
-- migration adds NO columns to apps (idempotency guard for retrofit envs).

SET search_path = rbac, public;

-- Add soft-delete + alias to permissions (immutable-key rule: never DELETE, only deprecate)
ALTER TABLE rbac.permissions
  ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alias_of      TEXT REFERENCES rbac.permissions(key) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS permissions_deprecated_idx ON rbac.permissions(deprecated_at) WHERE deprecated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS permissions_alias_of_idx    ON rbac.permissions(alias_of)      WHERE alias_of IS NOT NULL;

-- Comment for schema documentation
COMMENT ON COLUMN rbac.permissions.deprecated_at IS 'Soft-delete timestamp — permission remains readable but new grants blocked at app layer';
COMMENT ON COLUMN rbac.permissions.alias_of      IS 'Optional: redirect this deprecated key to a canonical replacement key';

INSERT INTO rbac.schema_migrations (version, description)
VALUES (10, 'permissions deprecation + alias fields (Phase 08 Fix #9)')
ON CONFLICT (version) DO NOTHING;
