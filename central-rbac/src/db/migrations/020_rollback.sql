-- 020_rollback.sql — Rollback Migration 020 (app_tokens).
--
-- Safe to run: DROP TABLE cascades indexes + FK constraints.
-- Sau rollback: auth-resolve chỉ còn legacy shared token path work.
--
-- Usage:
--   docker compose exec -T central-rbac-db psql -U rbac_writer -d central_rbac \
--     < src/db/migrations/020_rollback.sql

SET lock_timeout = '5s';
SET statement_timeout = '30s';

BEGIN;

DROP TABLE IF EXISTS rbac.app_tokens CASCADE;

DELETE FROM rbac.schema_migrations WHERE version = 20;

COMMIT;
