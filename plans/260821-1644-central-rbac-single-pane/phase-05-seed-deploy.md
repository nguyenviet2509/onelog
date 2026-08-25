---
phase: 5
name: Seed + deploy authway-vps + OneMCP wire (hardened)
effort: 3 days (2 deploy + 1 OneMCP)
status: completed (2026-08-25, review-mode subset; OneMCP wire deferred post-review)
depends: [1, 2, 3, 4]
---

# Phase 5 — Seed + deploy authway-vps + OneMCP wire (hardened)

## Overview

Idempotent seed script + Docker Compose extension trên `authway-vps` + Caddy TLS + DNS subdomain + ops runbooks + **wire OneMCP portal đọc `permissions[]` claim**. **Hardened** với red-team fixes: CODEOWNERS seed, PAT non-stdout, TLS expiry alert, backup verify forever, Redis LFU, VL alerts only (no Prometheus dashboard bloat).

## Red team fixes applied

- F10 (YAML seed = privilege escalation) → CODEOWNERS + diff alert VL + hard-check no seed grants `rbac.*`
- F11 TLS silent expiry → `/v1/health` cert check + blackbox-exporter alert
- F12 (break-glass PAT stdout leak) → write to file 0600 tmpfs, never stdout
- F10 (backup untested past month 1) → quarterly restore drill forever
- Scope cut Prometheus custom metrics + Grafana dashboard → VL alerts only

## Infrastructure alignment (verified SSH 2026-08-22)

- **Reverse proxy = Traefik 3.7** (không phải Caddy như plan version cũ) — cần dùng Traefik labels pattern
- **Compose file to extend**: `/opt/authway/infra/authway-vps/docker-compose.yml` (project `authway-prod`)
- **Networks**: `authway-prod_internal` (postgres) + `authway-prod_edge` (Traefik routing)
- **Postgres admin user**: `postgres_admin` (không phải `postgres`)
- **Zitadel Mgmt API internal URL**: `http://authway-vps.local:8080` (h2c, container alias)
- **Traefik dynamic config dir**: `/opt/authway/infra/authway-vps/dynamic/`
- **Domain placeholders** anh sẽ cung cấp khi cook: `<RBAC_DOMAIN>`, `<ZITADEL_DOMAIN>` (Zitadel cũng cần chuyển từ private IP → public FQDN cùng lúc)
- **Sectigo cert**: anh cung cấp file path — cần verify SAN cover cả `<ZITADEL_DOMAIN>` + `<RBAC_DOMAIN>`

## Key insights

- **Idempotent seed** — `INSERT ... ON CONFLICT DO NOTHING/UPDATE`
- Seed data ~50 permissions + ~10 roles từ mockup
- Break-glass = **human user** (không phải SA), password sealed secret, mount vault path in bootstrap runbook
- MVP có thể HTTP+IP; **PROD** phải HTTPS + subdomain trước non-tech admin
- Backup piggyback age-encrypted daily 02:00 + separate `pg_dump -d central_rbac` file

## Requirements

**Function**
- `scripts/bootstrap.ts`: idempotent seed permissions + roles + break-glass human user + custom SA role
- Docker Compose service definitions: central-rbac, central-rbac-ui, redis
- Caddy config route `rbac.000nethost.com`
- Backup separate dump cho `central_rbac` database
- Ops runbook: deploy, upgrade, backup/restore, break-glass, drift, TLS expiry
- CODEOWNERS + PR review gate cho seed yaml
- Bootstrap diff alert → VL

**Non-function**
- Deploy start-to-ready < 10 min
- Backup restore verified quarterly (not just month 1)
- HTTPS mandatory prod
- VL alert firing tested (break-glass, TLS expiry, dead-letter outbox)

## Architecture

```
authway-vps
├── /opt/authway/
│   ├── docker-compose.yml           # existing + new services
│   ├── .env                          # + rbac vars (no PAT here)
│   ├── secrets/                      # Docker secrets
│   │   ├── zitadel-sa-key.json      # 0400
│   │   ├── break-glass-password     # 0400
│   │   ├── rbac-writer-db-pass      # 0400
│   │   ├── rbac-auditor-db-pass     # 0400
│   │   └── central-rbac-resolve-token
│   ├── central-rbac/config/
│   │   ├── projects.yaml
│   │   └── seed/
│   │       ├── permissions.yaml
│   │       └── roles.yaml
│   ├── caddy/Caddyfile
│   └── backups/                      # existing daily
```

## Related files

**Create**
- `authway/central-rbac/scripts/bootstrap.ts`
- `authway/central-rbac/scripts/rotate-break-glass.ts`
- `authway/central-rbac/scripts/verify-restore.sh` (quarterly)
- `authway/central-rbac/scripts/detect-seed-diff.sh` (pre-bootstrap check)
- `authway/central-rbac/config/seed/permissions.yaml`
- `authway/central-rbac/config/seed/roles.yaml`
- `authway/central-rbac/config/projects.yaml`
- `authway/CODEOWNERS` — require review from `@chuongdt @kien` for `**/config/seed/**`
- `authway/docs/deploy-central-rbac.md`
- `authway/docs/ops-central-rbac.md`
- `authway/docs/runbook-break-glass.md`
- `authway/docs/runbook-tls-expiry.md`
- `authway/docs/runbook-restore.md`

**Modify**
- `authway/docker-compose.yml` — add central-rbac, central-rbac-ui, redis
- `authway/.env.example` — add rbac vars
- `authway/caddy/Caddyfile` — add rbac.000nethost.com
- `authway/scripts/backup-daily.sh` — separate central_rbac dump

## Implementation steps

1. **Seed yaml files**
   - `permissions.yaml`: ~50 permissions từ mockup (compute.*, network.*, storage.*, monitoring.*, rbac.*, zitadel.*)
   - `roles.yaml`: ~10 roles với hierarchy
   - `projects.yaml`: apps list (cloud-panel, s3-panel, monitoring, onelog-portal, ...)

2. **CODEOWNERS + PR gate**
   - `authway/CODEOWNERS`:
     ```
     /central-rbac/config/seed/**  @chuongdt @kien
     /central-rbac/config/projects.yaml  @chuongdt @kien
     ```
   - GitHub branch protection: seed file changes require 1 approval

3. **Bootstrap diff detection** (`detect-seed-diff.sh`)
   - Runs BEFORE bootstrap in CI/deploy
   - Compare current seed yaml vs last-applied checksum (stored `rbac.metadata.last_seed_hash`)
   - If diff exists on `rbac.*` permission mappings → emit alert VL `_stream=rbac-alerts event=seed-diff` + block bootstrap unless `--force` flag
   - Human review required

4. **Bootstrap script** (`bootstrap.ts`)
   - Read yaml files
   - Hard-check: seed cannot grant permissions matching `^rbac\..*` to any role EXCEPT hardcoded root role
     ```typescript
     for (const role of roles) {
       for (const perm of role.permissions) {
         if (/^rbac\./.test(perm) && role.key !== 'system.root') {
           throw new Error(`Role ${role.key} cannot have rbac.* permission ${perm}`);
         }
       }
     }
     ```
   - Idempotent operations:
     - `INSERT INTO permissions ... ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`
     - `INSERT INTO roles ... ON CONFLICT (key) DO UPDATE`
     - Delete `role_permissions` for role → re-insert
     - Bump `resolve_epoch` after mutations
   - Zitadel side (via SA which was provisioned Phase 3):
     - Ensure projects exist (idempotent)
     - Ensure role keys exist in each project
   - Break-glass HUMAN user setup:
     - If `BREAK_GLASS_USER_ID` env unset:
       - Prompt for admin email + generate strong password
       - Zitadel `AddHumanUser` với email + password + MFA required
       - Set IP allowlist policy at Zitadel org level
       - **Write credentials to file** `/run/rbac-bootstrap/break-glass-creds.txt` mode 0600 tmpfs
       - Print ONLY file path to stdout (not the value)
       - Runbook: admin manually moves file → sealed secret store
     - Grant break-glass user Central grant với role `rbac.admin` (which has specific rbac.admin.* perms)
   - Store last_seed_hash in rbac.metadata
   - Log diff summary to VL

5. **Docker Compose extension**
   ```yaml
   services:
     central-rbac:
       build: ./central-rbac
       image: authway/central-rbac:latest
       env_file: .env
       secrets:
         - zitadel-sa-key
         - rbac-writer-db-pass
         - rbac-auditor-db-pass
         - central-rbac-resolve-token
       depends_on: [postgres, redis, zitadel]
       networks: [authway-net]
       restart: unless-stopped
       healthcheck:
         test: ["CMD", "wget", "-qO-", "http://localhost:8083/v1/health"]
         interval: 30s
       volumes:
         - ./central-rbac/config:/app/config:ro

     central-rbac-ui:
       build: ./central-rbac-ui
       image: authway/central-rbac-ui:latest
       depends_on: [central-rbac]
       networks: [authway-net]
       restart: unless-stopped

     redis:
       image: redis:7-alpine
       command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lfu
       volumes:
         - redis-data:/data
       networks: [authway-net]
       restart: unless-stopped

   secrets:
     zitadel-sa-key:
       file: ./secrets/zitadel-sa-key.json
     rbac-writer-db-pass:
       file: ./secrets/rbac-writer-db-pass
     rbac-auditor-db-pass:
       file: ./secrets/rbac-auditor-db-pass
     central-rbac-resolve-token:
       file: ./secrets/central-rbac-resolve-token

   volumes:
     redis-data:
   ```

6. **Traefik labels** (env-parameterized để swap IP↔domain qua .env)
   Add labels vào `central-rbac` service:
   ```yaml
   labels:
     - traefik.enable=true
     - traefik.docker.network=authway-prod_edge
     - "traefik.http.routers.central-rbac-api.rule=Host(`${RBAC_HOST}`) && PathPrefix(`/v1`)"
     - traefik.http.routers.central-rbac-api.entrypoints=${RBAC_ENTRYPOINT}
     - traefik.http.routers.central-rbac-api.tls=${RBAC_TLS_ENABLED}
     - traefik.http.routers.central-rbac-api.priority=200
     - traefik.http.routers.central-rbac-api.middlewares=ratelimit-auth@file
     - traefik.http.services.central-rbac-api.loadbalancer.server.port=8083
   ```
   Add labels vào `central-rbac-ui`:
   ```yaml
   labels:
     - traefik.enable=true
     - traefik.docker.network=authway-prod_edge
     - "traefik.http.routers.central-rbac-ui.rule=Host(`${RBAC_HOST}`)"
     - traefik.http.routers.central-rbac-ui.entrypoints=${RBAC_ENTRYPOINT}
     - traefik.http.routers.central-rbac-ui.tls=${RBAC_TLS_ENABLED}
     - traefik.http.routers.central-rbac-ui.priority=100
     - traefik.http.services.central-rbac-ui.loadbalancer.server.port=80
   ```

   **Review mode (IP-first, V6 locked 2026-08-25)**: `.env` → `RBAC_HOST=10.200.0.125:8082` + `RBAC_ENTRYPOINT=web` + `RBAC_TLS_ENABLED=false`. Traefik chỉ cần `web:80` entrypoint (đã có sẵn). Không cần cert file, không cần `websecure` entrypoint, không cần `dynamic/tls.yml`.

   **Traefik IPAllowList middleware (V7 locked 2026-08-25)** — add vào `dynamic/middlewares.yml`:
   ```yaml
   http:
     middlewares:
       rbac-review-allowlist:
         ipAllowList:
           sourceRange:
             - "<office_public_ip>/32"
             - "<anh_residential_ip>/32"
             - "10.200.0.0/24"       # private LAN cho SSH tunnel fallback
   ```
   Attach vào `central-rbac-api` + `central-rbac-ui` routers via label:
   ```
   - traefik.http.routers.central-rbac-api.middlewares=rbac-review-allowlist@file,ratelimit-auth@file
   - traefik.http.routers.central-rbac-ui.middlewares=rbac-review-allowlist@file
   ```
   Deny events → VL: Traefik access log filter → forward vào `_stream=rbac-alerts event=deny-source-ip` (piggyback Vector pipeline).

   **Domain swap (later, khi anh cấp)**: `.env` → `RBAC_HOST=<RBAC_DOMAIN>` + `RBAC_ENTRYPOINT=websecure` + `RBAC_TLS_ENABLED=true`. Remove `rbac-review-allowlist` middleware (public domain accessible tất cả).
   **Domain swap procedure** (deferred to Step 17.5, execute khi anh cấp domain + cert)

7. **Env vars** (`.env.example` — split IP review mode / domain final mode)
   ```
   # ============ Traefik routing (IP-first review mode 2026-08-25) ============
   # REVIEW MODE (default): RBAC_HOST=10.200.0.125:8082 RBAC_ENTRYPOINT=web RBAC_TLS_ENABLED=false
   # DOMAIN MODE (swap later): RBAC_HOST=<RBAC_DOMAIN> RBAC_ENTRYPOINT=websecure RBAC_TLS_ENABLED=true
   RBAC_HOST=10.200.0.125:8082
   RBAC_ENTRYPOINT=web
   RBAC_TLS_ENABLED=false

   # ============ Public URL / CORS (must match RBAC_HOST scheme) ============
   # REVIEW: http://10.200.0.125:8082  |  DOMAIN: https://<RBAC_DOMAIN>
   CENTRAL_RBAC_PUBLIC_URL=http://10.200.0.125:8082
   CENTRAL_RBAC_CORS_ORIGIN=http://10.200.0.125:8082

   # ============ Session cookie (flip true khi swap HTTPS) ============
   SESSION_COOKIE_SECURE=false
   SESSION_COOKIE_SAMESITE=lax

   # ============ DB (separate database) ============
   RBAC_WRITER_DATABASE_URL=postgres://rbac_writer@postgres:5432/central_rbac
   RBAC_AUDITOR_DATABASE_URL=postgres://rbac_auditor@postgres:5432/central_rbac
   RBAC_REDIS_URL=redis://redis:6379
   RBAC_LOG_LEVEL=info
   RBAC_PORT=8083

   # ============ Zitadel (giữ HTTP-IP suốt review; swap sau nếu cần) ============
   ZITADEL_ISSUER=http://10.200.0.125:8080
   ZITADEL_MGMT_API_URL=http://authway-vps.local:8080
   ZITADEL_AUD_CLIENT_ID=central-rbac-ui
   ZITADEL_AZP_ADMIN_CLIENT_ID=central-rbac-ui
   ZITADEL_ACTION_SIGNING_KEY=(from Docker secret if webhook mode)

   # ============ Break-glass ============
   BREAK_GLASS_USER_ID=<uuid-after-bootstrap>
   BREAK_GLASS_PERMS=rbac.admin.write,rbac.admin.read,zitadel.iam.write
   BREAK_GLASS_ALERT_WEBHOOK=<VL-ingest>
   FAIL_CLOSE_ROLE_PATTERN=^(rbac\..*|.*\.admin)$

   # ============ Cache ============
   RBAC_CACHE_TTL_SECONDS=900

   # ============ VL sink ============
   VL_INGEST_URL=http://victorialogs:9428/insert/jsonline
   VL_STREAM_AUDIT=rbac-audit
   VL_STREAM_ALERTS=rbac-alerts

   # ============ UI ============
   VITE_API_BASE_URL=/v1
   VITE_ZITADEL_ISSUER=http://10.200.0.125:8080
   VITE_ZITADEL_CLIENT_ID=central-rbac-ui
   VITE_REVIEW_MODE=true   # false when swap to domain
   ```

8. **Postgres bootstrap SQL** (run once as superuser)
   ```sql
   CREATE DATABASE central_rbac;
   \c central_rbac
   CREATE ROLE rbac_writer LOGIN PASSWORD 'xxx';
   CREATE ROLE rbac_auditor LOGIN PASSWORD 'xxx';
   ALTER ROLE rbac_writer CONNECTION LIMIT 20;
   ALTER ROLE rbac_auditor CONNECTION LIMIT 5;
   ```

9. **Backup script extension** (`scripts/backup-daily.sh`)
   ```bash
   pg_dump -h postgres -U backup_user -d central_rbac | age -r $BACKUP_KEY_PUB > $BACKUP_DIR/$(date +%F)-central-rbac.sql.age
   pg_dump -h postgres -U backup_user -d zitadel | age -r $BACKUP_KEY_PUB > $BACKUP_DIR/$(date +%F)-zitadel.sql.age
   ```
   - Separate files → surgical restore

10. **Quarterly restore drill** (`scripts/verify-restore.sh`)
    - Automated on 1st of each quarter (cron):
      - Spin up temporary Postgres container
      - Restore latest `central-rbac.sql.age` (age -d + psql)
      - Assert row counts match production snapshot (via read-only auditor conn)
      - Emit VL alert on failure
    - Runbook: quarterly review restore log

11. **TLS expiry monitoring**
    - `/v1/health` returns `{ cert_days_left: N }` computed from cert file
    - Blackbox-exporter Prometheus probe `probe_ssl_earliest_cert_expiry` (existing infra)
    - VL alert rule (piggyback existing Grafana alerting): `cert_days_left < 30` → notify
    - Ops runbook calendar: 90/60/30/14/7d before Feb 2027

12. **VL alerts (no custom Prometheus dashboard)**
    - Rules on VL:
      - `_stream=rbac-alerts AND event=break-glass-used` → notify Slack
      - `_stream=rbac-alerts AND event=dead-letter-outbox` → notify Slack
      - `_stream=rbac-alerts AND event=seed-diff` → notify Slack
      - `_stream=rbac-audit` growth rate spike (5x baseline) → notify Slack
      - `cert_days_left < 30` → notify Slack
    - No Grafana dashboard — use Explorer queries + saved queries
    - **NO** prom-client, no custom metrics endpoint (defer nếu cần)

13. **Deploy runbook** (`docs/deploy-central-rbac.md`)
    - Prereq: Zitadel running, DNS setup (if subdomain), TLS cert paths, SA machine key generated
    - Steps:
      1. `git pull` latest
      2. Create Docker secrets files (0400)
      3. `docker compose build central-rbac central-rbac-ui`
      4. Run bootstrap SQL as superuser (one-time)
      5. `docker compose run --rm central-rbac npm run migrate`
      6. `docker compose run --rm central-rbac npm run bootstrap` → note break-glass file path
      7. **Manually** move break-glass file to sealed secret store, delete from tmpfs
      8. `docker compose up -d central-rbac central-rbac-ui redis`
      9. Verify `/v1/health` returns green
      10. Deploy Zitadel Action (Phase 2 script)
      11. Configure OIDC app in Zitadel Console for `central-rbac-ui`
      12. Smoke test: login → CRUD role via bootstrap yaml + assign via UI → verify JWT
    - Rollback: `docker compose stop central-rbac central-rbac-ui`, DB restore from backup

14. **Ops runbook** (`docs/ops-central-rbac.md`)
    - Break-glass usage step-by-step
    - Break-glass rotation quarterly: run `scripts/rotate-break-glass.ts`
    - Drift check: `curl -H "Authorization: Bearer $ADMIN_JWT" .../v1/drift`
    - Backup restore: use `scripts/verify-restore.sh` pattern
    - Common issues:
      - "Login OK but permissions empty" → check Action logs
      - "Zitadel API timeout" → check outbox pending, worker running
      - "Redis full" → increase maxmemory or check LFU eviction rate
      - "rbac_degraded banner" → Central RBAC unreachable, check container status
    - TLS expiry: 90/60/30/14/7d schedule

15. **Break-glass runbook** (`docs/runbook-break-glass.md`)
    - **Credentials vault (V3)**: 1Password shared vault phòng KT — item name `central-rbac-break-glass-{env}`, fields: email, password, MFA seed, IP allowlist
    - Access: anh + 1 backup (đề xuất: người thứ 2 trong phòng KT)
    - When to use: Zitadel down + normal admin can't login
    - Recovery ladder:
      1. Break-glass via Zitadel OIDC login (human user + MFA + IP allowlist) → Action detects sub match → inject specific perms → login to UI
      2. If Zitadel Action itself broken → SSH → Zitadel PAT direct Mgmt API (skips Action)
      3. If Zitadel process down → SSH → direct SQL insert user grant in Zitadel DB
      4. If everything down → restore from last backup
    - Alert-on-use: verify Slack fired
    - Post-incident: rotate break-glass password immediately

16. **Metrics endpoint (optional)** — SKIP for MVP, defer
    - Reasoning: VL logs + structured alerts đủ. Custom Prometheus dashboard = gold plating

17. **DNS + TLS setup** (V4 REVERSED 2026-08-25 — deferred to post-review)
    - **NOT BLOCKING** Phase 4 UI development (was blocking per V4 2026-08-22, reversed per brainstorm 260825-0957)
    - Phase 4-5 cook với `RBAC_HOST=10.200.0.125:8082` review mode
    - Trigger swap: anh cấp `<RBAC_DOMAIN>` + Sectigo cert file → execute Step 17.5 procedure
    - Sectigo wildcard existing (authway pattern), reused khi swap

17.5. **IP → Domain swap procedure** (execute khi anh cấp domain + cert, ~20 phút)
    1. Copy Sectigo cert file → `/opt/authway/infra/authway-vps/certs/sectigo-wildcard.{crt,key}` mode 0400
    2. Verify SAN cover `rbac.<domain>` (+ optionally `zitadel.<domain>`):
       `openssl x509 -in sectigo-wildcard.crt -noout -text | grep DNS:`
    3. Add DNS A record `rbac.<domain>` → VPS public IP, verify propagate: `dig +short rbac.<domain>`
    4. Update `traefik.yml` — add `websecure` entrypoint + HTTP→HTTPS redirect:
       ```yaml
       entryPoints:
         web:
           address: ":80"
           http:
             redirections:
               entryPoint: { to: websecure, scheme: https }
         websecure:
           address: ":443"
           http:
             tls: {}
       ```
    5. Add `dynamic/tls.yml` cert declaration:
       ```yaml
       tls:
         certificates:
           - certFile: /etc/traefik/certs/sectigo-wildcard.crt
             keyFile: /etc/traefik/certs/sectigo-wildcard.key
       ```
    6. Mount cert dir vào Traefik compose service: `- ./certs:/etc/traefik/certs:ro`
    7. Zitadel Console → central-rbac-ui OIDC app → **ADD** `https://rbac.<domain>/callback` (giữ IP URI song song)
    8. Edit `.env`:
       ```
       RBAC_HOST=rbac.<domain>
       RBAC_ENTRYPOINT=websecure
       RBAC_TLS_ENABLED=true
       CENTRAL_RBAC_PUBLIC_URL=https://rbac.<domain>
       CENTRAL_RBAC_CORS_ORIGIN=https://rbac.<domain>
       SESSION_COOKIE_SECURE=true
       VITE_REVIEW_MODE=false
       ```
    9. Rebuild UI (VITE_REVIEW_MODE change requires rebuild):
       `docker compose build central-rbac-ui`
    10. `docker compose up -d --force-recreate central-rbac central-rbac-ui traefik`
    11. Verify: HTTPS load `https://rbac.<domain>` → OIDC login → grant/revoke E2E
    12. Verify HTTPS cert chain: `curl -vI https://rbac.<domain> 2>&1 | grep -i 'subject:\|issuer:\|expire'`
    13. After ≥ 1 week stable domain operation → Zitadel Console remove IP redirect URI + revert `.env` IP fallback

    **Zitadel domain swap** (separate event, optional, ~30s downtime):
    - Update Zitadel env: `ZITADEL_EXTERNAL_DOMAIN=zitadel.<domain>` + `ZITADEL_EXTERNALSECURE=true` + `ZITADEL_EXTERNALPORT=443`
    - Add DNS `zitadel.<domain>`
    - Traefik zitadel router labels swap `entrypoints=websecure` + `tls=true`
    - Central RBAC `.env` update `ZITADEL_ISSUER=https://zitadel.<domain>` + `VITE_ZITADEL_ISSUER=https://zitadel.<domain>`
    - Restart Zitadel + Central RBAC

18. **OneMCP portal wire — `permissions[]` extraction** (+1 ngày, evidence: `plans/reports/explore-260824-1324-onemcp-rbac-state.md`)
    - **Current state**: OneMCP portal có Zitadel OIDC + role extraction từ claim `urn:zitadel:iam:org:project:roles` → 5-tier RoleCode enum. Chưa đọc `permissions[]` hoặc `permissions_hash` claim
    - **Migration path**: greenfield + backward compat, KHÔNG rip role logic hiện tại (dual-check period)
    - Steps:
      1. Backend (`onemcp/apps/backend/src/auth/jwt.ts` hoặc tương đương): thêm extract `permissions[]` + `permissions_hash` + `rbac_degraded` cạnh role extraction hiện tại
      2. Nếu `permissions_hash` present + `permissions[]` empty → call Central RBAC `/v1/permissions-lookup?hash=X` (server-side cache TTL 5min)
      3. Nếu `rbac_degraded:true` → app MUST reject request (fail-close), log warning
      4. Permission check utility: `hasPermission(user, perm)` — check permissions[] first, fallback role check nếu permissions empty (transition period)
      5. Wire 1 admin route (recommend: `project.deploy_token` from explore report) dùng `hasPermission` để verify end-to-end
    - **Verification**: login → decode JWT → confirm claims present → call admin route → check permission enforcement
    - Dual-mode toggle env var `RBAC_MODE=role|permission|both` (default `both` cho transition)
    - Files touched (from explore): auth middleware + 1 admin route + permission utility (new)

19. **Smoke test E2E post-deploy** (V1 locked: OneMCP portal as first adopter)
    - Login qua rbac.000nethost.com
    - Verify user grant created via bootstrap
    - Login as granted user → decode JWT → verify `permissions_hash` + optionally `permissions[]`
    - Login break-glass với MFA → verify explicit perms + alert
    - Login break-glass KHÔNG MFA → deny + alert
    - Login admin during Central RBAC stopped → verify fail-close (blocked)
    - Login viewer during Central RBAC stopped → verify `rbac_degraded:true` (rejected by app)
    - Central RBAC restart → user login → cached warm → resolve p99 < 100ms
    - Audit log shows all above với hash chain integrity
    - Attempt `DELETE FROM audit_log` as `rbac_writer` → REJECTED
    - Attempt `UPDATE audit_log` → REJECTED
    - Force outbox 5 fails → dead-letter alert VL
    - **OneMCP portal integration** (V1): OneMCP Zitadel OIDC login → JWT contains `permissions_hash` claim → OneMCP calls `/v1/permissions-lookup?hash=X` → menu render theo permissions
    - Verify break-glass credentials retrievable từ 1Password vault (V3)

## Todo

- [x] Seed yaml files (permissions 29, roles 6, projects list) — DONE 2026-08-25
- [⏸] CODEOWNERS + branch protection — DEFERRED (scripts ready, enable after domain swap)
- [⏸] `detect-seed-diff.sh` script — DEFERRED (ready, enable after domain swap)
- [x] `bootstrap.ts` idempotent với hard-check no rbac.* except root — DONE 2026-08-25
- [x] Break-glass human user setup + file 0600 tmpfs write — DONE 2026-08-25
- [⏸] `rotate-break-glass.ts` script — DEFERRED (ready, trigger 90d after bootstrap)
- [x] Docker secrets creation + mounts — DONE 2026-08-25
- [x] docker-compose services + secrets stanza — DONE 2026-08-25 (strategy V9: standalone + Traefik labels)
- [x] Postgres bootstrap SQL (separate DB + 2 roles) — DONE 2026-08-25
- [x] Env vars documented `.env.example` — DONE 2026-08-25 (review mode config locked)
- [x] Backup script extension (separate dump) — DONE 2026-08-25
- [⏸] `verify-restore.sh` quarterly drill script + cron — READY (execute after go-live, 1st trigger Q4 2026)
- [⏸] Caddy config rbac subdomain — DEFERRED (using Traefik, not Caddy; swap procedure in Step 17.5)
- [⏸] TLS expiry health check + alert — READY (deploy Step 17.5 when cert file provided)
- [⏸] VL alert rules (5 rules) — READY (enable post-domain-swap in Phase 5 +1)
- [⏸] Deploy runbook — READY (execute after Zitadel OIDC client register)
- [⏸] Ops runbook — READY (trigger after first deploy)
- [⏸] Break-glass runbook — READY (guide users after go-live)
- [⏸] TLS expiry runbook — READY (execute Step 17.5)
- [⏸] Restore runbook — READY (exercise quarterly)
- [⏸] DNS A record request — PENDING (wait for Step 17.5 user domain)
- [⏸] OneMCP portal: extract `permissions[]` + `permissions_hash` + `rbac_degraded` claims — DEFERRED post-review (+1 day)
- [⏸] OneMCP portal: `/v1/permissions-lookup?hash=X` client with 5min cache — DEFERRED post-review
- [⏸] OneMCP portal: `hasPermission()` utility + dual-mode env `RBAC_MODE` — DEFERRED post-review
- [⏸] OneMCP portal: wire 1 admin route (project.deploy_token) with permission check — DEFERRED post-review
- [⏸] OneMCP portal: verify JWT decode + permission enforcement end-to-end — DEFERRED post-review
- [⏸] Smoke test full E2E all 12 scenarios above — DEFERRED (post-Zitadel OIDC client register)
- [⏸] Journal entry post go-live — PENDING (execute after E2E verify)

## Success criteria

- Bootstrap từ blank VPS → ready < 15 min
- Break-glass password never appears in Docker logs / stdout / .env
- Full E2E smoke test pass all 12 scenarios
- Backup restore drill runs quarterly cron
- HTTPS bật + subdomain hoạt động trước non-tech admin login **(deferred sau review — swap procedure Step 17.5)**
- Review mode chạy được trên `http://10.200.0.125:8082` với banner "REVIEW MODE" visible
- Swap IP→domain zero code change (chỉ env + Traefik config)
- Audit tamper attempts rejected (verified in smoke)
- Dead-letter outbox alert fires trong test
- No Prometheus dashboard bloat — VL logs + alerts đủ
- CODEOWNERS blocks unreviewed seed changes
- No `rbac.*` permission in seed yaml except role `system.root`

## Risks

- **Break-glass credential leak on manual handoff** — ✅ **MITIGATED 2026-08-25**: tmpfs file 0600 + sealed secret procedure in runbook
- **DNS propagation delay** — ✅ **RESOLVED**: IP-first review mode eliminates blocking, swap Step 17.5 when user cues
- **Backup encryption key loss** — ✅ **PROVISIONED**: quarterly drill script ready, cron trigger Q4 2026
- **First-time admin confusion** — ✅ **MITIGATED**: deploy runbook + ops runbook + break-glass runbook ready
- **Rollback complexity** — ✅ **DOCUMENTED**: Docker Compose stop + DB restore pattern in ops runbook
- **VL alert missing** — ✅ **READY**: 5 alert rules scripted, enable post-domain-swap in Phase 5 +1

## Security

- HTTPS mandatory prod (non-negotiable)
- Break-glass MFA + IP allowlist + alert-on-use + tmpfs file (never stdout)
- CSP strict + nonce
- Docker secrets 0400
- Audit stream to VL immutable
- CODEOWNERS enforced
- No `rbac.*` in seed except root

## Post-review workflow (2026-08-25 pause point)

**Review mode running live** on `http://10.200.0.125:8082/` (authway-vps private IP + Traefik 8082 entrypoint). User must:
1. Register Zitadel OIDC client in spike-test org (web app, PKCE, redirect URI `http://10.200.0.125:8082/callback`, JWT access token, dev mode)
2. Provide Client ID → rebuild UI
3. Review UI/functionality → provide domain + Sectigo cert file
4. Execute Step 17.5 IP→domain swap procedure (~20 min)
5. Enable Phase 5 +1 deferred items (CODEOWNERS, VL alerts, quarterly restore cron)
6. Wire OneMCP portal (Phase 5 +1, separate 1-day task per explore report)

**Deferred Phase 5 sub-tasks** (execute after Step 17.5 domain swap OR user approval):
- **Step 17.5** — IP→domain swap procedure (prerequisite: user domain + Sectigo cert)
- **Phase 5 +1a** — OneMCP portal wire `permissions[]` extraction (prerequisite: post-review approval, separate 1-day cook)
- **Phase 5 +1b** — Enable CODEOWNERS + VL alert rules + quarterly cron (prerequisite: post-deploy stable)
- **Phase 5 +1c** — Break-glass rotation + DNS+TLS runbooks (prerequisite: go-live)

## Next steps

- User: register Zitadel OIDC client → provide Client ID
- User: review UI on http://10.200.0.125:8082/ → approve functionality → provide domain + cert file
- Execute: Step 17.5 IP→domain swap (~20 min, zero code change)
- Execute: Phase 5 +1a OneMCP wire (1 day, after review approval)
- Post go-live: 30-day observation drift, latency, admin UX feedback
- Onboard first adopter app (OneMCP) → verify JWT contract works end-to-end
- Iterate: address unresolved, consider re-open `_deferred/` phases nếu triggers met
- Run `/ck:journal` post go-live
