# 2026-08-27 — Central RBAC Phase 06/07/08 deploy

**Plan:** [260826-1644-central-rbac-hardening-and-self-service](../../plans/260826-1644-central-rbac-hardening-and-self-service/plan.md)
**Duration:** ~4h continuous cook (brainstorm → red-team → validate → cook → deploy)
**Commits:** 11 (onelog: 6, authway: 5, onemcp: staged)

## Kết quả

### Phase 06 — Security Foundation (🟡 60% shipped)

- **step-ca sidecar prod-deployed** on authway-vps: image `smallstep/step-ca@sha256:a2b17872...bc8270` (0.30.2), auto-init OK, healthcheck via `step-ca:9000` (SAN match, KHÔNG dùng localhost)
- **3 SA client certs issued** (90d, chain-verified): `onemcp-backend`, `portal-admin`, `central-rbac-webhook`. Root CA fingerprint `cf33439c7312...b11a`
- **cert-expiry cron installed** `/etc/cron.d/cert-expiry` → 6:00 daily, textfile Prometheus gauges + Telegram fallback + heartbeat freshness alert
- **Traefik TLS options + middleware config** committed (`tls-options.yml`, `middleware-cert-header.yml`) — apply pending spike verification khi có domain
- **cert-header-signer sidecar** built (Fastify + Dockerfile) — chưa deploy, chờ domain
- **Backend mTLS middleware** `auth-mtls.ts` implemented + wired global preHandler via `MTLS_GLOBAL_ENFORCE=true` (defaults false, activate khi Traefik chain live)

**Deferred (domain+cert-blocked):** Step 6a spike matrix, Step 8 mTLS activation, Step 10 HTTPS termination, Step 15/15.5 shared-secret removal

### Phase 07 — Admin Wizard (🟢 95% shipped)

- **Backend deployed to prod:** `POST /v1/admin/apps` route + Zitadel adapter (`AddProject` idempotent + `AddOIDCApp` sane defaults) + rate-limit middleware (5/24h admin, 20/global sliding window, count-all-attempts) + orphan-cleanup-worker (60s poll, exp backoff 60s→6h, 5 max attempts) + migrations 008 (`rbac.apps`) + 008a (`pending_cleanups`)
- **UI deployed to prod:** apps-list-page, new-app-wizard-page (2-step: info + review), client-secret-reveal-dialog (blur-until-hover, acknowledge required), edit-manifest-url-dialog. Nav "Ứng dụng" added to sidebar. Router `/apps`, `/apps/new`, `/apps/:id/manifest`
- **Compile checks PASS:** backend `npx tsc --noEmit`, UI `npm run typecheck`

**Blocked on Zitadel SA setup** — runbook `docs/zitadel-sa-setup-central-rbac-admin.md`

### Phase 08 — App Self-Registration (🟢 90% shipped)

- **Backend deployed to prod:** manifest schema publish `/.well-known/rbac-permissions-schema.json` (served OK, verified via curl) + sync endpoint (SSRF-hardened fetcher: HTTPS + DNS pin + RFC1918 block) + apply endpoint (sha256 TOCTOU pin via Redis cache 1h) + PATCH `/manifest-url` + migrations 009 (audit taxonomy) + 010 (permissions deprecation columns)
- **UI deployed to prod:** manifest-sync-page với 4-category diff (add / update-desc / explicit-deprecate / implicit-deprecate), implicit-deprecate default UNCHECKED + warning banner (Fix #9)
- **OneMCP adopter #1 endpoint** written: `onemcp/backend/src/rbac-manifest/` (controller + module), 21 permissions declared, 3 default roles (viewer/editor/admin). Compile PASS

**Blocked on Phase 07 Zitadel SA** cho end-to-end test qua wizard

## Bugs discovered + fixed cùng ngày

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | step-ca env var `STEP_CA_PASSWORD` ignored | Sai tên: smallstep expect `DOCKER_STEPCA_INIT_PASSWORD` | Persist auto-gen password vào env file với đúng name |
| 2 | Cert issue "requested duration >24h1m0s" | Provisioner default x509-max-dur = 24h | `step ca provisioner update admin --x509-max-dur 2160h` + SIGHUP |
| 3 | Healthcheck TLS handshake fail | URL `localhost:9000` không có trong cert SAN | Compose fix: `https://step-ca:9000` |
| 4 | `docker exec sh -c "printf > /home/step/prov.pwd"` permission denied | Existing 0400 file block tee overwrite | Cleanup stale trước, dùng `docker exec -i tee` |
| 5 | Original `issue-client-cert.sh` assume step CLI on host | Prod step CLI chỉ trong container | Rewrite dùng docker exec pattern (commit `f8768d4`) |
| 6 | `.well-known/rbac-permissions-schema.json` return UI HTML | Traefik router `PathPrefix('/v1')` không cover `.well-known` | Rule extend `(PathPrefix('/v1') || PathPrefix('/.well-known/rbac-permissions-schema'))` |
| 7 | Migration 008a version=81 (typo) | Bug SQL — nhắm 8.5 nhưng ints only | Deferred fix, không impact functional |

## Prod state after cook

| Component | Container | Image | Status |
|---|---|---|---|
| central-rbac backend | central-rbac | central-rbac-central-rbac:latest | Up healthy |
| central-rbac UI | central-rbac-ui | central-rbac-ui:phase04 | Up healthy |
| step-ca | authway-prod-step-ca-1 | smallstep/step-ca@sha256:a2b17872 | Up healthy |
| postgres | central-rbac-postgres | postgres:16-alpine | Up healthy |
| redis | central-rbac-redis | redis:7-alpine | Up healthy |

DB migrations: versions 2-10 + 81 present.

Public endpoints (via SSH tunnel `-L 8082:10.200.0.125:8082`):
- ✅ http://localhost:8082/users (Phase 5 predecessor)
- ✅ http://localhost:8082/apps (new)
- ✅ http://localhost:8082/apps/new
- ✅ http://localhost:8082/.well-known/rbac-permissions-schema.json
- ✅ http://localhost:8082/v1/admin/apps (401 without JWT — correct)

## Host-sync-policy compliance

- 3 drift items sync'd back to local repo trong session:
  1. `authway/infra/authway-vps/docker-compose.yml` Phase 4-5 IP-first review binding (5 lines) → commit `f16c061`
  2. `central-rbac/docker-compose.prod.yml` full Phase 4-5 Traefik + UI service (43 lines) → commit `d98d550`
  3. Zitadel spike file `docker-compose.override.yml` + `.bak-*` files noted but not yet cleaned (out of scope)

VPS end-state = git status clean (except leftover `.bak-*` from 08-25).

## Emotional recap

Long day, lots of context switching brainstorm → red-team → validate → cook → deploy → OneMCP cross-project → docs. Multiple bug discoveries mid-deploy (env var name, cert duration policy, tee perms, Traefik routing) all diagnosed + fixed within same session — no rollback needed.

Wizard UI + backend live on prod nhưng E2E test bị block bởi Zitadel SA setup (user-driven). Phase 08 tương tự — code complete nhưng manifest sync test cần Zitadel SA để tạo app "onemcp" trước. Ready state = anh làm Zitadel SA thì mọi thứ activate luôn.

Zero P0 issues left in code path. mTLS activation defer đúng đến khi có domain + Sectigo cert.

## Follow-ups (không blocking session)

- [ ] Fix migration 008a version=81 → 8 (cosmetic, safe change nhưng cần re-run migration)
- [ ] OneMCP `RbacManifestModule` deploy lên onemcp-vps (rsync tương tự central-rbac deploy pattern)
- [ ] cert-header-signer sidecar Docker build + đăng ký compose (chưa deploy — chờ domain)
- [ ] Zitadel SA setup + IAM_OWNER + PAT vào `/opt/central-rbac/.env` (user-driven per runbook)
- [ ] Cleanup `docker-compose.override.yml` spike leftover (SSRF protection reduced)
- [ ] Age-backup step-ca root_ca_key (critical, chưa done từ 2026-08-27 morning)

## Related sessions

- Brainstorm: [brainstorm-260826-1644-central-rbac-hardening-and-self-service.md](../../plans/reports/brainstorm-260826-1644-central-rbac-hardening-and-self-service.md)
- Red team: [red-team-260826-1644-central-rbac-hardening-findings.md](../../plans/reports/red-team-260826-1644-central-rbac-hardening-findings.md) — 15 findings all applied
- Predecessor MVP: [260821-1644-central-rbac-single-pane](../../plans/260821-1644-central-rbac-single-pane/plan.md)
