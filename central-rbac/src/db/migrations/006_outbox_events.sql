-- =============================================================================
-- Migration 006: rbac.outbox_events — async outbox for Zitadel Mgmt API calls.
-- Idempotent via IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- Worker uses SELECT ... FOR UPDATE SKIP LOCKED for safe multi-replica drain.
-- =============================================================================

SET search_path = rbac, public;

CREATE TABLE IF NOT EXISTS rbac.outbox_events (
  id               BIGSERIAL   PRIMARY KEY,
  idempotency_key  TEXT        NOT NULL UNIQUE,
  operation        TEXT        NOT NULL,  -- 'add_project_role' | 'remove_project_role' | 'add_user_grant' | 'update_user_grant' | 'remove_user_grant'
  args             JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'processing', 'done', 'failed', 'dead')),
  attempts         INT         NOT NULL DEFAULT 0,
  correlation_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at     TIMESTAMPTZ,
  last_error       TEXT
);

-- Partial index: only index rows the worker will poll (pending + failed, not done/dead)
CREATE INDEX IF NOT EXISTS outbox_status_created_idx
  ON rbac.outbox_events (status, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS outbox_correlation_idx
  ON rbac.outbox_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- rbac_writer needs full DML on outbox + sequence usage
GRANT SELECT, INSERT, UPDATE ON rbac.outbox_events TO rbac_writer;
GRANT USAGE ON SEQUENCE rbac.outbox_events_id_seq TO rbac_writer;

-- Record migration
INSERT INTO rbac.schema_migrations (version, description)
VALUES (6, 'rbac.outbox_events table for async Zitadel Mgmt API calls')
ON CONFLICT (version) DO NOTHING;
