-- =============================================================================
-- Migration 002: RBAC core tables + grants
-- Run as postgres_admin (superuser) against central_rbac database.
-- Idempotent via IF NOT EXISTS / IF NOT EXISTS patterns.
-- =============================================================================

SET search_path = rbac, public;

-- ---------------------------------------------------------------------------
-- permissions: atomic capability units, key is immutable after creation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rbac.permissions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        NOT NULL UNIQUE,   -- e.g. "onemcp.kb.read" — IMMUTABLE
  description TEXT        NOT NULL DEFAULT '',
  alias_of    TEXT        REFERENCES rbac.permissions(key) ON DELETE RESTRICT,
  deprecated  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS permissions_key_idx ON rbac.permissions(key);
CREATE INDEX IF NOT EXISTS permissions_alias_of_idx ON rbac.permissions(alias_of) WHERE alias_of IS NOT NULL;

-- ---------------------------------------------------------------------------
-- roles: named groupings of permissions, single-parent hierarchy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rbac.roles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        NOT NULL UNIQUE,   -- e.g. "dept.it.admin"
  description TEXT        NOT NULL DEFAULT '',
  parent_key  TEXT        REFERENCES rbac.roles(key) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS roles_key_idx ON rbac.roles(key);
CREATE INDEX IF NOT EXISTS roles_parent_key_idx ON rbac.roles(parent_key) WHERE parent_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- role_permissions: M:N join between roles and permissions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rbac.role_permissions (
  role_key       TEXT NOT NULL REFERENCES rbac.roles(key)       ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES rbac.permissions(key) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, permission_key)
);

CREATE INDEX IF NOT EXISTS role_permissions_perm_idx ON rbac.role_permissions(permission_key);

-- ---------------------------------------------------------------------------
-- schema_migrations: tracks applied migration versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rbac.schema_migrations (
  version     INTEGER     PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT        NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Grants for rbac_writer (INSERT/UPDATE/DELETE on rbac tables)
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON rbac.permissions       TO rbac_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON rbac.roles             TO rbac_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON rbac.role_permissions  TO rbac_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON rbac.schema_migrations TO rbac_writer;

-- rbac_auditor has NO access to rbac tables — only audit_log (granted in 003)

-- ---------------------------------------------------------------------------
-- updated_at trigger function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rbac.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER permissions_updated_at
  BEFORE UPDATE ON rbac.permissions
  FOR EACH ROW EXECUTE FUNCTION rbac.set_updated_at();

CREATE OR REPLACE TRIGGER roles_updated_at
  BEFORE UPDATE ON rbac.roles
  FOR EACH ROW EXECUTE FUNCTION rbac.set_updated_at();

-- Record this migration
INSERT INTO rbac.schema_migrations (version, description)
VALUES (2, 'rbac core tables: permissions, roles, role_permissions')
ON CONFLICT (version) DO NOTHING;
