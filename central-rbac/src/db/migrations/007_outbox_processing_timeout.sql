-- =============================================================================
-- Migration 007: Add processing_started_at to outbox_events.
-- Enables stalled-processing recovery: rows stuck in 'processing' for >5 min
-- (crashed worker) are reclaimed on next worker startup / sweep.
-- Idempotent via IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- =============================================================================

SET search_path = rbac, public;

ALTER TABLE rbac.outbox_events
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- Index for stalled-row sweep: only rows in 'processing' state
CREATE INDEX IF NOT EXISTS outbox_processing_started_idx
  ON rbac.outbox_events (processing_started_at)
  WHERE status = 'processing';

-- Record migration
INSERT INTO rbac.schema_migrations (version, description)
VALUES (7, 'Add processing_started_at to outbox_events for stalled-processing recovery')
ON CONFLICT (version) DO NOTHING;
