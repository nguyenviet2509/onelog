# Phase 1 Migration Rehearsal Log

**Date:** 2026-07-24
**Plan:** 260724-0821-onemcp-multidept-v1-5 / phase-01
**Migrations:** 1720700000000 → 1720700300000 (4 files)

## Outcome: BLOCKED — Docker Desktop not running

### What was attempted

1. `docker run -d --rm --name onemcp-rehearsal ... pgvector/pgvector:pg16 -p 15432:5432`
   - Error: `failed to connect to docker API at npipe:////./pipe/dockerDesktopLinuxEngine`
2. Switched context to `default` (`npipe:////./pipe/docker_engine`)
   - Error: same — `docker_engine` pipe not found
3. Checked service: `com.docker.service` — Status: **Stopped**
4. Attempted `Start-Service 'com.docker.service'` — **blocked by auto-mode classifier** (system-level service modification outside project scope)

Time spent: ~10 min (within 15-min budget). Did not attempt alternative approaches (WSL2 postgres, psql direct) as they were not in spec.

## Manual verification (static analysis of migration SQL)

In lieu of live run, migrations were read and verified against plan §Success criteria:

### Migration 1720700000000 — spaces + templates + api_keys

- `spaces`: BIGSERIAL PK, slug UNIQUE, department_id FK nullable, visibility VARCHAR(16), timestamps. Index on department_id. ✓
- `templates`: key VARCHAR(64) PRIMARY KEY, schema JSONB, department_scope TEXT[], active BOOL indexed. ✓
- `api_keys`: BIGSERIAL PK, user_id FK (CASCADE DELETE), key_hash TEXT, key_prefix VARCHAR(16) UNIQUE indexed, expires_at, revoked BOOL. ✓

DOWN: `DROP TABLE IF EXISTS api_keys; templates; spaces` — reversible. ✓

### Migration 1720700100000 — artifacts multidept columns

- `ADD COLUMN IF NOT EXISTS space_id BIGINT NULL REFERENCES spaces(id) ON DELETE SET NULL`
- `ADD COLUMN IF NOT EXISTS template_key VARCHAR(64) NULL`
- `ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'space'`
- `ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0`
- `ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ NULL`
- Indexes on space_id, template_key, visibility. ✓

DOWN: drops indexes then columns. `IF EXISTS` guards idempotent. ✓

### Migration 1720700200000 — embeddings + pgvector

- `CREATE EXTENSION IF NOT EXISTS vector` — idempotent. ✓
- `embeddings`: artifact_version_id BIGINT PK FK CASCADE DELETE, vector(384), model VARCHAR(64). ✓
- DOWN: drops table only, leaves extension (correct — shared resource). ✓

### Migration 1720700300000 — seed + backfill

- Spaces: `INSERT INTO spaces SELECT code, name, id FROM departments ON CONFLICT DO NOTHING` — idempotent. ✓
- Templates: 8 rows (5 existing + sop/faq/ticket_playbook) via loop, `ON CONFLICT DO NOTHING`. ✓
- Backfill artifacts.space_id: UPDATE via JOIN to spaces.department_id WHERE space_id IS NULL. ✓
- Backfill template_key: `UPDATE artifacts SET template_key = type WHERE template_key IS NULL`. ✓
- DOWN: nullifies backfill, deletes seeded templates + spaces by key/code match. ✓

### Success criteria checks (static)

| Criterion | Assessment |
|---|---|
| `SELECT count(*) FROM templates WHERE key IN ('sop','faq','ticket_playbook')` = 3 | Seeds all 3 in loop — ✓ expected 3 |
| `SELECT count(*) FROM artifacts WHERE space_id IS NULL OR template_key IS NULL` = 0 post-backfill | UPDATE fills both columns for all rows with IS NULL — ✓ (empty table also = 0) |
| `SELECT extname FROM pg_extension WHERE extname='vector'` returns 1 row | CREATE EXTENSION IF NOT EXISTS vector — ✓ |
| All migrations pass UP + DOWN cleanly | `IF EXISTS` / `IF NOT EXISTS` guards + correct drop order — ✓ no obvious conflict |

## Action required

To run the live rehearsal, start Docker Desktop before next session and re-run:

```powershell
docker run -d --rm --name onemcp-rehearsal \
  -e POSTGRES_PASSWORD=r -e POSTGRES_DB=onemcp -e POSTGRES_USER=onemcp \
  -p 15432:5432 pgvector/pgvector:pg16

# wait ~5s for pg_isready, then:
cd D:/Vietnt/Project/onemcp/backend
$env:POSTGRES_URL="postgres://onemcp:r@localhost:15432/onemcp"
pnpm migration:run
# verify queries...
pnpm migration:revert  # x4 in reverse
pnpm migration:run     # re-apply
docker stop onemcp-rehearsal
```

## Issues / risks noted

- Migration 1720700300000 uses raw string interpolation for template SQL (single-quote escaping via `.replace(/'/g, "''")`) — correct but fragile if template content ever includes `''` sequences. Low risk for current seed data.
- `artifacts.space_id` backfill assumes 1:1 dept→space (first matching space row). If a dept has multiple spaces (future state), UPDATE picks an arbitrary one. Acceptable for Phase 1 (seed creates exactly 1 space per dept).
