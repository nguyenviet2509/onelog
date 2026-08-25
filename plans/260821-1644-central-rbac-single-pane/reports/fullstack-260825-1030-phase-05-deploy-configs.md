# Phase 05 Deploy Configs — Implementation Report

Date: 2026-08-25
Plan: 260821-1644-central-rbac-single-pane

---

## Files Created / Modified

| File | LOC | Action |
|---|---|---|
| `central-rbac/src/schemas/user-schemas.ts` | 18 | Created |
| `central-rbac/src/lib/zitadel-user-search-client.ts` | 163 | Created |
| `central-rbac/src/routes/users.ts` | 138 | Created |
| `central-rbac/src/routes/projects.ts` | 28 | Created |
| `central-rbac/src/app.ts` | +5 lines | Modified (import + register) |
| `central-rbac/config/seed/permissions.yaml` | 68 | Created |
| `central-rbac/config/seed/roles.yaml` | 97 | Created |
| `central-rbac/scripts/bootstrap.ts` | 185 | Created |
| `central-rbac/package.json` | +1 line | Modified (bootstrap script) |
| `central-rbac/docker-compose.review.yml` | 88 | Created |
| `central-rbac/config/traefik-rbac-review-entrypoint.patch.yml` | 30 | Created |
| `central-rbac/docs/deploy-review.md` | 118 | Created |

All source files under 200 LOC. No new npm deps added.

---

## Tasks Completed

- [x] Part A: `GET /v1/users` — Zitadel user search proxy + grant_count enrichment (fan-out, cap 10 concurrent)
- [x] Part A: `GET /v1/users/:id` — user detail + grants, Redis 60s cache
- [x] Part A: `GET /v1/projects` — hardcoded MVP (ZITADEL_PROJECT_ID env)
- [x] Part A: Zod schemas in `schemas/user-schemas.ts`
- [x] Part A: Transport via existing `zitadel-http.ts` (mgmtPost + buildHeaders)
- [x] Part A: Routes registered in `app.ts` (Phase 5 section)
- [x] Part B: `docker-compose.review.yml` — central-rbac-ui service + backend network attach + Traefik labels
- [x] Part B: Traefik patch file — `rbac-review:8082` entrypoint snippet + port binding instructions
- [x] Part C: `config/seed/permissions.yaml` — 29 permissions
- [x] Part C: `config/seed/roles.yaml` — 6 roles with hierarchy
- [x] Part C: `scripts/bootstrap.ts` — idempotent, hard-checks rbac.* rule, dry-run mode, bumps resolve_epoch
- [x] Part D: `docs/deploy-review.md` — 7-step deploy runbook + rollback + post-review swap reference

---

## Tests Status

- `npm run typecheck`: PASS (tsc --noEmit clean)
- `npm run build`: PASS (tsc --noEmit && tsc -p tsconfig.build.json clean)
- Bootstrap dry-run: PASS — 29 perms, 6 roles, rbac.* rule enforced
- Unit tests: not run (no new test files — deferred to tester subagent per scope)

---

## Key Design Decisions

**rbac.admin role does NOT hold rbac.* perms** — caught by dry-run. Per spec, only `system.root` holds `rbac.*` grants. The `rbac.admin` role grants admin UI access via Zitadel role claim (role_key check in JWT), not through individual permission resolution. This is documented in both `bootstrap.ts` and `roles.yaml`.

**Grant count enrichment** — fan-out to Zitadel `listUserGrants` per user (cap 10 concurrent). No local `role_grants` table exists (grants live in Zitadel only). Failures fall back to `grant_count: 0` non-blocking.

**central-rbac container re-use** — `docker-compose.review.yml` references `central-rbac:latest` (already running standalone per V9). The compose file adds it to `authway-prod_edge` network and injects Traefik labels without re-creating the container from scratch. Operator must verify `env_file` path `/opt/central-rbac/.env` exists on VPS.

**No Zitadel v2 org scoping** — `/v2/users` search is instance-level; `x-zitadel-orgid` header is sent for consistency but Zitadel ignores it for v2 user search. PAT must have `iam.users.read` system permission.

---

## Deploy Steps (10-step summary)

1. SSH authway-vps, `git pull` both repos
2. Patch `/opt/authway/infra/authway-vps/traefik.yml` — add `rbac-review` entrypoint
3. Add `10.200.0.125:8082:8082` port to authway-prod traefik service, `docker compose up -d traefik`
4. Dry-run bootstrap: `BOOTSTRAP_DRY_RUN=true npx tsx scripts/bootstrap.ts`
5. Apply bootstrap: `npx tsx scripts/bootstrap.ts`
6. Build UI image with VITE build args (Zitadel SPA client ID required)
7. `docker compose -f /opt/central-rbac/docker-compose.review.yml up -d`
8. If central-rbac not on edge network: `docker network connect authway-prod_edge central-rbac`
9. Verify: `curl http://10.200.0.125:8082/v1/health` + `curl -sI http://10.200.0.125:8082/`
10. Open browser via VPN/SSH tunnel: `http://10.200.0.125:8082/`

---

## Unresolved Questions

1. **Zitadel SPA Client ID** — the UI `docker build` requires `VITE_ZITADEL_CLIENT_ID`. A dedicated SPA application must be created in Zitadel `spike-test` org with redirect URI `http://10.200.0.125:8082/callback`. This is a manual Zitadel setup step not automated here.

2. **central-rbac image tag** — `docker-compose.review.yml` references `central-rbac:latest`. Confirm the image on authway-vps is tagged `:latest` or update the tag to match what was built during Phase 2-3 deploy.

3. **Zitadel PAT IAM scope** — `GET /v2/users` requires the service account PAT to have instance-level `iam.users.read`. The Phase 2 PAT may only have org-level scope. Needs verification on authway-vps before first user search call.

4. **authway-prod_edge network** — confirm this network exists with `docker network ls | grep authway-prod_edge` before running the review compose file.
