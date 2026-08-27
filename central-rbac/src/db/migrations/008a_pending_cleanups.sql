-- =============================================================================
-- Migration 008a: rbac.pending_cleanups queue for Zitadel orphan project cleanup.
-- Phase 07 Red Team Fix #8: durable retry queue when RemoveProject rollback fails.
-- =============================================================================
--
-- Flow:
--   1. Wizard POST /v1/admin/apps → AddProject succeeds → AddOIDCApp fails
--   2. Attempt RemoveProject rollback; if that ALSO fails →
--   3. INSERT row here with error, next_retry_at
--   4. orphan-cleanup-worker retries with exp backoff (60s → 5min → 30min → 6h → give up after 5 tries)
--   5. On success: DELETE row + optional audit log entry
--   6. Wizard SearchProjects step queries this table + offers "reclaim orphan" flow to admin

SET search_path = rbac, public;

CREATE TABLE IF NOT EXISTS rbac.pending_cleanups (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Zitadel-side identity
  zitadel_project_id  TEXT        NOT NULL,
  project_name        TEXT        NOT NULL,              -- for admin reclaim UX
  zitadel_client_id   TEXT,                              -- may be NULL if AddOIDCApp never succeeded

  -- Requesting admin
  admin_sub           TEXT        NOT NULL,
  admin_email         TEXT        NOT NULL DEFAULT '',

  -- Retry state
  attempt_count       INTEGER     NOT NULL DEFAULT 0,
  last_error          TEXT,
  next_retry_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  MAX_ATTEMPTS_HINT   INTEGER     NOT NULL DEFAULT 5,    -- worker uses this; row DELETEd on give-up

  -- Lifecycle
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_cleanups_next_retry_idx ON rbac.pending_cleanups(next_retry_at);
CREATE INDEX IF NOT EXISTS pending_cleanups_project_idx    ON rbac.pending_cleanups(zitadel_project_id);
CREATE INDEX IF NOT EXISTS pending_cleanups_admin_idx      ON rbac.pending_cleanups(admin_sub);

CREATE OR REPLACE FUNCTION rbac.pending_cleanups_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pending_cleanups_update_timestamp ON rbac.pending_cleanups;
CREATE TRIGGER pending_cleanups_update_timestamp
  BEFORE UPDATE ON rbac.pending_cleanups
  FOR EACH ROW EXECUTE FUNCTION rbac.pending_cleanups_set_updated_at();

-- Grants: writer inserts + updates (worker) + deletes (on success/give-up), auditor read-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON rbac.apps TO rbac_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON rbac.pending_cleanups TO rbac_writer;
GRANT SELECT ON rbac.pending_cleanups TO rbac_auditor;

INSERT INTO rbac.schema_migrations (version, description)
VALUES (81, 'pending_cleanups queue for Zitadel orphan projects (Phase 07 Fix #8)')
ON CONFLICT (version) DO NOTHING;
