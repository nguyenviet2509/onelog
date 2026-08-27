-- =============================================================================
-- Migration 001: Bootstrap — run as postgres superuser ONCE
-- Creates the central_rbac database and the two application roles.
-- This script is EXTERNAL to the migration runner (run manually by ops).
--
-- PASSWORD ROTATION IS MANDATORY BEFORE FIRST BOOT:
--   Either edit the two `changeme` placeholders below OR set them via psql:
--     psql -U postgres \
--       -v rbac_writer_pw=$(openssl rand -hex 24) \
--       -v rbac_auditor_pw=$(openssl rand -hex 24) \
--       -f 001_bootstrap.sql
--   then reference the resulting DATABASE_URLs from central-rbac env.
--
-- Runtime guard: config.ts refuses to start if WRITER_DATABASE_URL or
-- AUDITOR_DATABASE_URL still contains the substring `changeme`, so a forgotten
-- rotation fails at boot instead of silently shipping default creds.
-- =============================================================================

-- Step 1: Create the database (connect to postgres default DB first)
CREATE DATABASE central_rbac
  ENCODING 'UTF8'
  LC_COLLATE 'en_US.utf8'
  LC_CTYPE 'en_US.utf8'
  TEMPLATE template0;

-- Step 2: Connect to central_rbac, then run the rest
\connect central_rbac

-- Writer role: INSERT on rbac schema tables + INSERT-only on audit_log.
-- ROTATE THIS PASSWORD — config.ts refuses `changeme` at startup.
CREATE ROLE rbac_writer WITH LOGIN PASSWORD 'rbac_writer_changeme' CONNECTION LIMIT 20;

-- Auditor role: SELECT on audit_log only — cannot touch rbac schema.
-- ROTATE THIS PASSWORD — config.ts refuses `changeme` at startup.
CREATE ROLE rbac_auditor WITH LOGIN PASSWORD 'rbac_auditor_changeme' CONNECTION LIMIT 5;

-- Prevent roles from creating objects or connecting to other databases
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE central_rbac FROM PUBLIC;
GRANT CONNECT ON DATABASE central_rbac TO rbac_writer;
GRANT CONNECT ON DATABASE central_rbac TO rbac_auditor;

-- Create rbac schema (migrations 002+ will create tables within it)
CREATE SCHEMA IF NOT EXISTS rbac;
GRANT USAGE ON SCHEMA rbac TO rbac_writer;
GRANT USAGE ON SCHEMA rbac TO rbac_auditor;
