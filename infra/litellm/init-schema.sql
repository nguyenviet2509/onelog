-- LiteLLM Postgres schema bootstrap (RT-F11).
--
-- Run once before first litellm-proxy startup:
--   docker compose exec postgres psql -U $POSTGRES_USER -d rag -f /tmp/init-schema.sql
-- Or from the host:
--   docker cp init-schema.sql ragstack-postgres:/tmp/
--   docker compose exec postgres psql -U rag -d rag -f /tmp/init-schema.sql
--
-- LiteLLM will auto-create its tables inside this schema on first boot because
-- LITELLM_DATABASE_URL sets search_path=litellm. Rollback path:
--   DROP SCHEMA litellm CASCADE;
-- This leaves rag-agent's tables in `public` untouched.

CREATE SCHEMA IF NOT EXISTS litellm;

-- Grant privileges to the rag user (same account LiteLLM connects with).
-- If you provisioned a dedicated litellm user, replace `rag` accordingly.
GRANT ALL PRIVILEGES ON SCHEMA litellm TO rag;
ALTER DEFAULT PRIVILEGES IN SCHEMA litellm GRANT ALL ON TABLES TO rag;
ALTER DEFAULT PRIVILEGES IN SCHEMA litellm GRANT ALL ON SEQUENCES TO rag;
