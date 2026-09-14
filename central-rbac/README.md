# Central RBAC

Central permissions + roles backend for the onelog/authway ecosystem.
Deployed co-located with Zitadel v4 on `authway-vps`.

## v2 architecture (2026-09-14) — plan [260910-1334](../plans/260910-1334-central-rbac-v2-refactor/)

Migration 019 introduces RBAC v2: hierarchy (parent_key), delegation (can_grant), tenant scope,
per-app epoch, Central-side `user_grants` (source of truth thay Zitadel). V1 endpoints tồn tại
song song 12+6 tháng transition.

**Key artifacts**:
- SDK: [`@onelog/central-rbac-client`](../central-rbac-client/) — Node.js với circuit breaker + epoch poll
- App template: [`central-rbac-app-template/`](../central-rbac-app-template/) — Fastify scaffold
- Onboarding docs: [App onboarding](../docs/central-rbac-app-onboarding.md) — 5-step register + grant + verify
- Migration v1→v2: [Manifest migration guide](../docs/central-rbac-manifest-v2-migration.md)
- Operator runbook: [Central operator runbook](../docs/central-rbac-operator-runbook.md) — dual-control operator responsibilities

## Quickstart (local dev)

```bash
# 1. Start local Postgres (port 5433, avoids host 5432 conflict)
docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies
npm install

# 3. Copy and edit env
cp .env.example .env
# Edit .env — at minimum set CENTRAL_RBAC_RESOLVE_TOKEN and ZITADEL_* vars

# 4. Run migrations (002–004; 001 is handled by docker init script)
npm run migrate

# 5. Seed dev data
npm run bootstrap-dev

# 6. Start dev server
npm run dev

# 7. Verify
curl http://localhost:3000/v1/health
```

## JWKS testing (unit vs integration)

- **Unit tests**: static JWKS file at `tests/fixtures/jwks.json` — no network needed
- **Integration tests against live Zitadel**:
  ```bash
  ssh -L 8080:10.200.0.125:8080 onelog-vps
  # Then in .env:
  ZITADEL_JWKS_URL=http://localhost:8080/oauth/v2/keys
  ```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with tsx watch (hot reload) |
| `npm run build` | TypeScript compile to `dist/` |
| `npm run typecheck` | Type check only (no emit) |
| `npm run migrate` | Run DB migrations 002–004 |
| `npm run bootstrap-dev` | Seed sample permissions + roles |
| `npm test` | Unit tests with coverage |
| `npm run test:integration` | Integration tests (requires Docker) |

## Architecture

```
src/
├── app.ts              # Fastify entry point
├── config.ts           # Env validation (zod)
├── db/
│   ├── writer-pool.ts  # rbac_writer pg.Pool
│   ├── auditor-pool.ts # rbac_auditor pg.Pool (SELECT audit_log only)
│   ├── migrations/     # 001-004 SQL files
│   └── queries/        # parameterized SQL functions
├── routes/             # Fastify route plugins
├── middleware/         # auth-jwt, auth-resolve, audit-log, vl-audit-sync
├── schemas/            # zod request/response schemas
└── lib/                # hash-chain, cycle-check, constant-time-compare, logger
```

## Security notes

- **2 DB roles**: `rbac_writer` (INSERT rbac.*, INSERT-only audit_log) + `rbac_auditor` (SELECT audit_log)
- **Audit log immutable**: DB trigger rejects UPDATE/DELETE; hash chain detects tampering
- **`/v1/resolve` always authenticated**: X-Rbac-Token or HMAC — no env bypass
- **JWT verification**: iss + aud + azp + signature checked on every request
- Never commit `.env` to git
