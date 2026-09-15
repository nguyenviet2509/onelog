-- 020_app_tokens.sql — Per-app tokens for /v2/resolve authentication.
--
-- Plan: 260915-0830-central-rbac-per-app-token-migration phase 1.
--
-- Vấn đề: Central hiện dùng shared CENTRAL_RBAC_RESOLVE_TOKEN cho tất cả apps.
-- Leak 1 app → compromise toàn hệ thống, không revoke per-app, không audit
-- rõ nguồn caller, không rate limit per-app.
--
-- Fix: CREATE TABLE rbac.app_tokens với format `rbac_<8prefix>_<24secret>`,
-- argon2id hash, multi-token per app, soft-revoke, actor tracking.
--
-- Backwards compat: shared token vẫn work qua auth middleware fallback (Phase 2)
-- tới cutoff 2028-01-01. Additive — không đụng existing schema.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

BEGIN;

-- ============================================================================
-- 1. CREATE TABLE rbac.app_tokens
-- ============================================================================
-- Columns:
--   - token_prefix: 8 base32 chars, indexed for O(1) lookup in auth middleware
--   - token_hash:   argon2id hash of full token (~50ms verify, cached in-memory)
--   - label:        human-readable identifier ('prod', 'staging', 'dev-alice')
--   - created_by:   actor user_sub from admin JWT (audit)
--   - revoked_at/by: soft-delete for revoke, cache invalidated on revoke
--   - last_used_at: throttled update (60s bucket per token) for freshness signal

CREATE TABLE IF NOT EXISTS rbac.app_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        UUID NOT NULL REFERENCES rbac.apps(id) ON DELETE CASCADE,
  token_prefix  TEXT NOT NULL CHECK (token_prefix ~ '^[a-z0-9]{8}$'),
  token_hash    TEXT NOT NULL,
  label         TEXT NOT NULL CHECK (length(label) BETWEEN 2 AND 32 AND label ~ '^[a-z0-9-]+$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT
);

-- ============================================================================
-- 2. Indexes
-- ============================================================================
-- Partial unique: cho phép reuse label sau khi revoke.
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_tokens_app_label_active
  ON rbac.app_tokens (app_id, label)
  WHERE revoked_at IS NULL;

-- Prefix lookup: hot path trong auth-resolve middleware.
CREATE INDEX IF NOT EXISTS idx_app_tokens_prefix_active
  ON rbac.app_tokens (token_prefix)
  WHERE revoked_at IS NULL;

-- ============================================================================
-- 3. Grants
-- ============================================================================
-- rbac_writer: full CRUD (admin routes create/list/revoke)
-- rbac_auditor: SELECT audit view of tokens (không leak hash — column-level không cần vì hash không compromise)
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rbac_writer') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON rbac.app_tokens TO rbac_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rbac_auditor') THEN
    EXECUTE 'GRANT SELECT ON rbac.app_tokens TO rbac_auditor';
  END IF;
END
$do$;

-- ============================================================================
-- 4. Register migration
-- ============================================================================
INSERT INTO rbac.schema_migrations (version, applied_at)
VALUES (20, now())
ON CONFLICT (version) DO NOTHING;

COMMIT;
