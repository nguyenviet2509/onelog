-- =============================================================================
-- Migration 008: rbac.apps table — app registry (Phase 07 Admin Wizard + Phase 08 self-registration)
-- Numbering: 005/006/007 taken by predecessor plan (metadata, outbox, outbox_timeout).
-- Plan: plans/260826-1644-central-rbac-hardening-and-self-service/phase-07-admin-wizard.md
-- =============================================================================
--
-- Slug format `^[a-z][a-z0-9]{2,31}$` enforced at app layer (Red Team Fix #13).
-- Slug prefix-collision guard also enforced at app layer during wizard.
-- App create audit → existing rbac.audit_log (action='app.create', reuse hash chain per Fix #12).

SET search_path = rbac, public;

CREATE TABLE IF NOT EXISTS rbac.apps (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- App identity
  slug                TEXT        NOT NULL UNIQUE,       -- kebab-case, immutable, format ^[a-z][a-z0-9]{2,31}$
  name                TEXT        NOT NULL,              -- human-readable display name

  -- Zitadel binding (set on successful wizard flow)
  zitadel_project_id  TEXT        UNIQUE,                -- Zitadel project snowflake ID
  zitadel_client_id   TEXT,                              -- Zitadel OIDC client ID

  -- Manifest self-registration (Phase 08 Red Team Fix #15)
  manifest_url        TEXT,                              -- HTTPS URL to app's /.well-known/rbac-permissions.json
  manifest_etag       TEXT,                              -- last-known etag for If-None-Match fetches
  last_synced_at      TIMESTAMPTZ,                       -- last successful manifest sync

  -- Lifecycle
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT        NOT NULL,              -- admin sub who ran wizard (or 'system' for seed)
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Constraint: slug case-insensitive uniqueness (defense-in-depth)
  CONSTRAINT apps_slug_lowercase CHECK (slug = lower(slug))
);

CREATE INDEX IF NOT EXISTS apps_slug_idx           ON rbac.apps(slug);
CREATE INDEX IF NOT EXISTS apps_zitadel_project_idx ON rbac.apps(zitadel_project_id) WHERE zitadel_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS apps_created_at_idx     ON rbac.apps(created_at DESC);

-- Auto-update updated_at on any UPDATE
CREATE OR REPLACE FUNCTION rbac.apps_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS apps_update_timestamp ON rbac.apps;
CREATE TRIGGER apps_update_timestamp
  BEFORE UPDATE ON rbac.apps
  FOR EACH ROW EXECUTE FUNCTION rbac.apps_set_updated_at();

-- Grants: writer full DML, auditor read-only.
GRANT SELECT, INSERT, UPDATE ON rbac.apps TO rbac_writer;
GRANT SELECT ON rbac.apps TO rbac_auditor;
-- DELETE deliberately withheld — apps should be deprecated via manifest, not hard-deleted.

INSERT INTO rbac.schema_migrations (version, description)
VALUES (8, 'apps registry table (Phase 07 admin wizard + Phase 08 manifest sync)')
ON CONFLICT (version) DO NOTHING;
