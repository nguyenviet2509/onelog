-- =============================================================================
-- Migration 003: audit_log table with hash chain columns
-- Append-only forensic log. DB role separation enforced in 002 grants.
-- actor_email denormalized at write time (no JOIN needed for audit UI).
-- =============================================================================

SET search_path = rbac, public;

CREATE TABLE IF NOT EXISTS rbac.audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           BIGSERIAL   NOT NULL UNIQUE,              -- monotonic sequence for deterministic ORDER (H5)
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Actor info (denormalized at write time from JWT — no Zitadel lookup needed)
  actor_id      TEXT        NOT NULL,
  actor_type    TEXT        NOT NULL DEFAULT 'user',   -- 'user' | 'service'
  actor_email   TEXT        NOT NULL DEFAULT '',

  -- Action + target
  action        TEXT        NOT NULL,                  -- e.g. 'permission.create'
  target_type   TEXT        NOT NULL,                  -- 'permission' | 'role' | 'role_permission'
  target_id     TEXT        NOT NULL,

  -- Before/after state snapshots (capped at 8KB each via app layer)
  before_state  JSONB,
  after_state   JSONB,

  -- Correlation
  ip            TEXT,
  session_id    TEXT,
  correlation_id TEXT,

  -- Hash chain (tamper evidence)
  row_hash      TEXT        NOT NULL,                  -- sha256 of row content fields
  prev_hash     TEXT,                                  -- previous row's chained_hash (NULL for first row)
  chained_hash  TEXT        NOT NULL                   -- sha256(prev_hash || row_hash)
);

-- Audit log is append-only — no updates, no deletes (trigger in 004)
-- Index for common query patterns
CREATE INDEX IF NOT EXISTS audit_log_ts_idx       ON rbac.audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_id_idx ON rbac.audit_log(actor_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx   ON rbac.audit_log(action);
CREATE INDEX IF NOT EXISTS audit_log_target_idx   ON rbac.audit_log(target_type, target_id);

-- ---------------------------------------------------------------------------
-- Grants: rbac_writer INSERT + SELECT (SELECT needed to read prev_hash for
--         chain computation), rbac_auditor SELECT-only.
-- UPDATE and DELETE are explicitly revoked on writer (trigger in 004 also
-- blocks them as belt-and-suspenders, but revoke keeps least-privilege).
-- ---------------------------------------------------------------------------
GRANT INSERT, SELECT ON rbac.audit_log TO rbac_writer;
-- seq is BIGSERIAL — writer needs USAGE on the underlying sequence to INSERT
GRANT USAGE ON SEQUENCE rbac.audit_log_seq_seq TO rbac_writer;
-- Explicitly deny UPDATE and DELETE (belt + suspenders alongside trigger)
REVOKE UPDATE, DELETE ON rbac.audit_log FROM rbac_writer;

GRANT SELECT ON rbac.audit_log TO rbac_auditor;

-- Record this migration
INSERT INTO rbac.schema_migrations (version, description)
VALUES (3, 'audit_log with hash chain columns')
ON CONFLICT (version) DO NOTHING;
