-- =============================================================================
-- Migration 009: Manifest sync audit — reuses rbac.audit_log hash chain.
-- Phase 08 Red Team Fix #12: no separate table; extend action taxonomy on audit_log.
-- =============================================================================
--
-- Actions added (semantic only, no schema change):
--   'manifest.sync.fetch'  — admin triggered manifest fetch; target_id=app.id
--   'manifest.sync.apply'  — admin approved diff apply; target_id=app.id;
--                            after_state = {items:[{action,id}], sha256, counts}
--   'manifest.sync.cache'  — server-side sha256-indexed cache stored
--
-- This migration exists to document the semantic + ensure schema_migrations bumped.
-- No DDL; audit_log already has hash chain + immutable trigger from migrations 003/004.

SET search_path = rbac, public;

INSERT INTO rbac.schema_migrations (version, description)
VALUES (9, 'manifest sync audit taxonomy (reuses rbac.audit_log hash chain — no new table)')
ON CONFLICT (version) DO NOTHING;
