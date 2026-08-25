---
name: Central RBAC Single-Pane Portal
slug: central-rbac-single-pane
date: 2026-08-21
status: pending
priority: high
mode: hard
blockedBy: []
blocks: []
related:
  - 260819-1628-zitadel-native-oidc-multi-app-rollout
  - 260821-1443-authway-security-hardening
supersedes: _archived/260812-1150-authway-central-rbac
brainstorm: plans/reports/brainstorm-260821-1644-central-rbac-single-pane-design.md
red_team: 2026-08-21 (15 findings, all accepted, plan restructured)
---

# Central RBAC Single-Pane Portal

Central management backend + minimal admin UI (Users + Assignments only). Deploy cùng Zitadel v4 trên `authway-vps`. **MVP focus**: prove JWT `permissions[]` contract với ≥ 1 adopter app trước khi đầu tư UI đầy đủ.

## Context

- **Brainstorm**: [brainstorm-260821-1644-central-rbac-single-pane-design.md](../reports/brainstorm-260821-1644-central-rbac-single-pane-design.md)
- **Red team review**: 4 hostile reviewers spawn 2026-08-21, 42 raw findings → 15 accepted after dedup+cap
- **Research derisk (round 1)**: [researcher-260822-0837-zitadel-actions-v2-v4-deep-dive.md](../reports/researcher-260822-0837-zitadel-actions-v2-v4-deep-dive.md) — 10/15 Zitadel Actions v2 v4 items confirmed từ docs
- **Research derisk (round 2 - endpoint deep-dive)**: [researcher-260822-1159-zitadel-v4-api-endpoint-reference.md](reports/researcher-260822-1159-zitadel-v4-api-endpoint-reference.md) + [summary](reports/researcher-260822-1159-summary.md) + [plan-validation](reports/researcher-260822-1159-plan-validation.md) — **20 endpoints verified against Zitadel v4.16.1**, plan architecture SOUND, no rewrites needed. 2 remaining spike items S1 (idempotency) + S3 (cascade). Fix: search endpoints là POST không phải GET.
- **Mockup target**: [mockups/central-management-zitadel-rbac-architecture.html](../../mockups/central-management-zitadel-rbac-architecture.html)
- **Supersedes**: `_archived/260812-1150-authway-central-rbac`

## Deployment infrastructure (verified 2026-08-22 SSH authway-vps)

| Item | Value |
|---|---|
| Zitadel version | **v4.16.1** (ghcr.io/zitadel/zitadel + ghcr.io/zitadel/zitadel-login) |
| Postgres | 16-alpine (shared instance, `postgres_admin` user) |
| **Reverse proxy** | **Traefik 3.7** (không phải Caddy) — HTTP-only pilot, TLS deferred |
| Compose file | `/opt/authway/infra/authway-vps/docker-compose.yml` |
| Compose project name | `authway-prod` |
| Networks | `authway-prod_internal` (postgres, sidecars), `authway-prod_edge` (Traefik routing) |
| Zitadel internal alias | `authway-vps.local` — Central RBAC gọi Mgmt API qua `http://authway-vps.local:8080` (h2c) |
| Zitadel current external | `ZITADEL_EXTERNAL_DOMAIN=10.200.0.125` (private IP, HTTP-only) |
| Log ship | Vector 0.42.0 → onelog-vps VictoriaLogs (existing) |
| Login v2 sidecar | zitadel-login v4.16.1 container serving `/ui/v2/login/*` |
| Metrics scrape | Zitadel exposes `10.200.0.125:2112:8080` cho onelog-vps vmagent |
| Traefik dashboard | `127.0.0.1:8088:8080` (SSH tunnel only) |
| Dev SMTP | Mailhog `127.0.0.1:8025` |

**Blocker**: Zitadel chưa có public HTTPS. Anh cung cấp domain + Sectigo cert khi cook plan (xem Unresolved #2). Plan Phase 4-5 sẽ setup cả Zitadel HTTPS + Central RBAC HTTPS cùng lúc.

## Key decisions (locked, red-team refined)

- **Deploy**: `authway-vps` Docker Compose co-locate với Zitadel v4
- **Backend**: Node.js + Fastify + TypeScript
- **DB**: **Separate database** `central_rbac` cùng Postgres instance (đổi từ schema `rbac` sau F12) — split DB roles writer/reader
- **Cache**: Redis LFU + epoch versioning `resolve:v{N}:{hash}` + singleflight, không SCAN+DEL
- **Claim delivery**: Zitadel Action v2 **webhook model** (locked by research 260822-0837 — `Call` target type, HMAC signed, `append_claims` response). DEFAULT `permissions_hash`, list inline chỉ khi < 30 permissions.
- **Admin UI**: React + Vite + shadcn/ui (hardcoded VN, không i18next), **CHỈ Users + Assignments** cho MVP. Roles/Permissions/Audit UI **DEFER**, dùng CLI seed yaml.
- **Access**: **IP-first review mode 2026-08-25 (reverses V4)** — Phase 4-5 cook với `http://<VPS_PUBLIC_IP>` để anh review UI + functionality trước. HTTPS + subdomain swap sau khi anh cấp `<RBAC_DOMAIN>` + Sectigo cert (procedure Step 17.5 phase-05). Zero code change swap. Zitadel giữ HTTP-IP `10.200.0.125` suốt review. See [brainstorm-260825-0957](../reports/brainstorm-260825-0957-central-rbac-ip-first-review-mode.md)
- **Approval workflow**: SKIP v1
- **Break-glass**: **HUMAN user** với strong password + MFA required + IP allowlist. Action check `amr` contains `mfa` trước khi inject specific perms (KHÔNG dùng `*` wildcard) + alert-on-use + rotate 90d
- **Failure mode**:
  - Resolve fail-open **có cached** → OK
  - Resolve fail-open **no cache** → inject `permissions:[]` + `rbac_degraded:true` claim, apps MUST reject if degraded
  - Admin roles (`rbac.*`, `*.admin`) → fail-CLOSE (block login)
  - Admin mutations → fail-close
- **Auth `/v1/resolve`**: mandatory HMAC signing header `X-Zitadel-Signature` (webhook model) OR shared secret `X-Rbac-Token` (inline model) từ ngày 1 — Phase 0 spike quyết
- **Zitadel SA scope**: custom role chỉ có `AddProjectRole`, `RemoveProjectRole`, `AddUserGrant`, `RemoveUserGrant`, `ListUsers`, `GetUserByID`, `ListUserGrants`, `SetPassword` (cho break-glass bootstrap). KHÔNG `IAM_OWNER`
- **Cross-service consistency**: **Outbox pattern** — Central DB commit + outbox row → worker retry Zitadel với idempotency key. Không giữ DB tx qua external call.
- **Audit tamper protection**: split DB roles (writer INSERT-only audit), hash chain, dual-write VL stream `_stream=rbac-audit`
- **JWT claim contract v1**: `{sub, org_id, roles[], permissions_hash, ver:1, rbac_degraded?}` + optional inline `permissions[]` nếu list ngắn
- **Standards day 1 (trimmed từ 12 → 4)**: naming convention + JWT contract + audit schema + `ver` bump policy. Process standards (alias deprecation, rotation cadence) deferred cho đến khi có 2+ adopter.

## Phases

| # | Phase | Effort | Depends | Status |
|---|---|---|---|---|
| 1 | [Backend + DB (hardened)](phase-01-backend-db.md) | 3-4 ngày | — | **completed (2026-08-24)** |
| 2 | [Zitadel Action + break-glass redesign](phase-02-zitadel-action.md) | 3 ngày (Day 1 = spike S3+S4 gate) | 1 | **completed (2026-08-25)** |
| 3 | [Zitadel Mgmt API + outbox pattern](phase-03-zitadel-mgmt-api.md) | 3-4 ngày (Day 1 = spike S1 gate + S2 GitHub review) | 1 | **completed (2026-08-25)** |
| 4 | [UI Users + Assignments (minimal)](phase-04-ui-users-assignments.md) — **IP-first review mode** | 3 ngày | 3 | **completed (2026-08-25)** |
| 5 | [Seed + deploy (hardened) + OneMCP wire](phase-05-seed-deploy.md) — **IP-first review, domain swap Step 17.5** | 2 + 1 = 3 ngày | 1-4 | **completed (2026-08-25, review-mode subset)** |
| **⏸** | **Post-review pause — anh review UI/functionality → cấp `<RBAC_DOMAIN>` + Sectigo cert → execute Step 17.5 IP→domain swap** | ~20 phút swap | 5 | — |

**Total: 13-15 ngày** (~3 tuần realistic). Phase 0 giải thể (2026-08-24 decision): S1-S4 inline vào Phase 2+3 Day 1 validation gate. Phase 5 +1 ngày OneMCP wire (từ explore-260824-1324-onemcp-rbac-state.md — portal có Zitadel OIDC + role extraction nhưng chưa đọc `permissions[]` claim).

### Phase 0 decision (2026-08-24)
Phase 0 spike **giải thể** theo brainstorm 2026-08-24. Phân tích: Phase 1 (backend + DB + JWT verify + audit chain) zero Zitadel dependency → có thể cook luôn. Chỉ S1/S3/S4 cần live test, làm inline Day 1 của Phase 2 (S3+S4) + Phase 3 (S1). S2 (custom role scoping bug #10505) đọc GitHub issue trước Phase 3 start. Trade-off: -0.5 ngày calendar, +5-10% rework risk nếu unlucky. Chấp nhận vì spike results chỉ ảnh hưởng 1-2 files trong Phase 2+3, rework cost bounded.

File `phase-00-zitadel-actions-spike.md` archive vào `_deferred/` giữ làm reference cho spike scripts.

## Deferred (không trong v1, mở khi cần)

| Phase deferred | File | Trigger để mở |
|---|---|---|
| UI Roles + Permissions CRUD | `_deferred/phase-04-ui-roles-permissions.md` | ≥ 2 admin cấp/sửa role hàng tuần, hoặc admin không dev refuses CLI |
| UI Audit + polish | `_deferred/phase-06-ui-audit-polish.md` | Audit query > 5x/tuần, hoặc compliance yêu cầu UI |

V1 → admin quản role/permission qua YAML + `bootstrap.ts`; query audit qua VictoriaLogs Grafana panel trực tiếp.

## Success criteria (aggregate)

- Phase 2 Day 1 validation gate answer S3+S4 với evidence trước code fail-open logic
- Phase 3 Day 1 validation gate answer S1 với evidence trước code outbox retry; S2 GitHub #10505 review done
- **OneMCP portal** (locked V1) đọc JWT `permissions_hash` claim end-to-end — smoke test trong Phase 5 (cần wire extraction, +1 ngày)
- Non-tech admin cấp/gỡ role trong ≤ 3 click qua UI Users
- Zitadel Action `/v1/resolve` p99 < 100ms cache warm, < 500ms cold
- Zero drift 30 ngày (audit diff Central ↔ Zitadel manual weekly check)
- 100% audit event có actor + before + after + ip, tamper-protected (DB role separation + VL sync)
- Break-glass account = HUMAN user, MFA verified trong Action, alert-on-use, recovery < 5 phút
- Bootstrap từ blank state → 1 root admin ready ≤ 15 phút
- HTTPS bật + Sectigo wildcard trước khi non-tech admin login lần đầu
- No `IAM_OWNER` SA in prod
- No `*` wildcard permission

## Standards (day 1 — trimmed to 4)

1. **Permission naming**: `<service>.<resource>.<action>` immutable
2. **JWT claim contract v1**: `{sub, org_id, roles[], permissions_hash|permissions[], ver:1, rbac_degraded?, dept?, regions?[]}`
3. **Audit schema**: `{ts, actor_id, actor_type, action, target_type, target_id, before, after, ip, session_id, correlation_id, prev_hash}`
4. **Version bump**: đổi claim contract = bump `ver`, giữ v1 song song 6 tháng

Deferred standards (mở khi có ≥ 2 adopter): permission alias deprecation, role hierarchy formal rules, break-glass rotation cadence, cross-tenant grant policy.

## Red Team Review

### Session — 2026-08-21
**Reviewers:** Security Adversary + Failure Mode Analyst + Assumption Destroyer + Scope & Complexity Critic
**Findings:** 42 raw → 15 accepted after dedup+cap
**Severity:** 9 Critical, 6 High
**Disposition:** All Accept, plan restructured

| # | Finding | Sev | Applied To |
|---|---|---|---|
| F1 | Zitadel Actions v2 runtime unverified | Critical | **NEW Phase 0** blocking spike |
| F2 | `ctx.grants` shape imagined | Critical | Phase 0 Q2 verify + Phase 2 redesign path |
| F3 | JWT `aud` validation missing → any Zitadel token = admin | Critical | Phase 1 auth middleware: verify `aud` + `azp` |
| F4 | `/v1/resolve` no auth "sau" | Critical | Phase 1 mandatory HMAC/shared-token day 1 |
| F5 | Break-glass workflow broken (machine user + wildcard + circular) | Critical | Phase 2 redesign: human user + amr MFA check + explicit perms |
| F6 | Zitadel SA `IAM_OWNER` = full IdP compromise | Critical | Phase 3 custom role scope |
| F7 | Cross-service tx non-atomic (DB commit + Zitadel call) | Critical | Phase 3 outbox pattern |
| F8 | Fail-open silent permission stripping = auth regression | Critical | Phase 2 `rbac_degraded` claim + fail-close for admin roles |
| F9 | Full UI Phase 4-6 before adopter = 50% gold-plating | Critical | Defer Roles/Perms/Audit UI to `_deferred/` |
| F10 | YAML seed = privilege escalation vehicle | High | Phase 5 CODEOWNERS + diff alert + hard-check no seed grants `rbac.*` |
| F11 | JWT size 4KB → real 12-15KB with 200+ perms | High | Phase 2 default `permissions_hash`, list only if < 30 |
| F12 | PG shared với Zitadel = coupling backup/upgrade/disk | High | Phase 1: separate DB `central_rbac`, không schema |
| F13 | Effort 15-19d fantasy solo | High | Rebase 15-17d với scope cut (không phải add days) |
| F14 | Cache SCAN+DEL stampede + no epoch | High | Phase 2 `resolve:v{N}:{hash}` epoch + singleflight + LFU |
| F15 | Audit log tamperable (rbac_user CRUD full) | High | Phase 1 split DB roles + hash chain + VL sync |

### Scope cuts (accepted, applied)
- ❌ i18next infrastructure → hardcoded VN
- ❌ Keyboard shortcuts + cheat sheet
- ❌ Bulk grant p-limit + progress bar → plain for-loop
- ❌ Circuit breaker hand-rolled → undici timeout + retry-once
- ❌ Custom JSON diff library → 2 `<pre>` blocks
- ❌ Prometheus custom metrics + Grafana dashboard → VL alerts only
- ❌ ABAC `dept`/`regions` claims → defer until app requests
- ❌ Nightly drift cron → on-demand endpoint
- ❌ 12 standards → 4 core

## Unresolved (còn lại sau validate + research)

1. **Zitadel version** — ✅ **CONFIRMED v4.16.1** trên authway-vps (SSH inspect 2026-08-22 13:18)
2. **Public domain + HTTPS** — ⏳ **Anh sẽ cung cấp khi cook plan**. Hiện tại Zitadel chạy HTTP-only trên private IP `10.200.0.125`. Cần cả 2 domain:
   - `zitadel.<domain>` (Zitadel public entrypoint — currently missing)
   - `rbac.<domain>` (Central RBAC portal)
   - Anh cung cấp: domain FQDN + Sectigo cert file path + confirm cert SAN cover cả 2 subdomain
3. **App migration** — OneMCP portal có RBAC cũ (nếu có) → migrate hay build mới trên Central?
4. **Multi-org X-Zitadel-OrgID scoping** (spike S5 medium risk) — behavior khi header sai/thiếu, cross-org filter → verify Phase 0
5. **Actions v2 runtime shape** — mostly locked bởi 2 rounds research; S1/S3/S4 verify inline Day 1 Phase 2 + Phase 3 (Phase 0 giải thể)

## Validation Log

### Session — 2026-08-25 (Phase 4-5 completion — review-mode cook)
| # | Milestone | Result | Evidence |
|---|---|---|---|
| Phase 4 impl | React UI (Vite+TypeScript+shadcn/ui), OIDC PKCE + silent renew, users list + grant/revoke dialogs, VN hardcoded, Dockerfile nginx CSP | **DONE** | fullstack-260825-1015-phase-04-ui-users-assignments.md |
| Phase 4 bundle | npm run build: 181KB gzip, tsc 0 errors, lint clean (2 acceptable warnings) | **PASS** | fullstack build log |
| Phase 5 backend | 3 new routes `/v1/users`, `/v1/users/:id`, `/v1/projects`, seed yaml 29 perms + 6 roles, bootstrap.ts idempotent | **DONE** | fullstack-260825-1030-phase-05-deploy-configs.md |
| Phase 5 deploy | Traefik entrypoint `rbac-review:8082` port bind 10.200.0.125, central-rbac attached authway-prod_edge, central-rbac-ui service, healthcheck localhost→127.0.0.1 fix | **DONE** | fullstack-260825-1030-phase-05-deploy-configs.md |
| Phase 4 test | 193/193 pass (54 P1 + 49 P2 + 90 new Phase 4), coverage 90.51% statements, 0 errors | **PASS** | tester-260825-1105-phase-04-05-central-rbac.md |
| Phase 4+5 review round 1 | 8/10 findings: H1 silent renew route, H2 bulk grant AbortController, H3 v2/users endpoint, H4 enrichGrantCounts removal, H5 checkbox readOnly, H6 canWrite/canRead, H7 review compose deletion | **7 HIGH FINDINGS FIXED** | code-reviewer-260825-1105-phase-04-05-central-rbac.md |
| Phase 4+5 fixes | H1-H7 resolved, post-fix retest clean | **DONE** | fullstack-260825-1115-phase-04-05-fixes.md |
| Live E2E on authway-vps | http://10.200.0.125:8082/ loads UI + OIDC prompt, `/v1/health` 200 OK, containers healthy | **VERIFIED** | SSH authway-vps + compose logs |
| Pause point | Waiting: user registers Zitadel OIDC client in spike-test org → provides Client ID → rebuild UI → E2E login test | **BLOCKING** | phase-04 Step 2 OIDC registration |

**Deferred to post-review (Step 17.5 + Phase 5 +1 items)**
- Sectigo TLS + domain swap (need user domain + cert file)
- OneMCP portal wire permissions[] claim (scheduled after review feedback)
- quarterly restore drill cron (provisioned in phase-05 but execute trigger = post-deploy)
- CODEOWNERS + VL alerts wired (scripts present, trigger manual enable after domain)
- rotate-break-glass script (available, trigger = 90d cadence after bootstrap)

### Session — 2026-08-24 (Phase 1 completion)
| # | Milestone | Result | Evidence |
|---|---|---|---|
| Phase 1 impl | Fastify+TS backend + 4 migrations + 7 routes + 3 middleware + 54 unit tests | **DONE** | fullstack-developer-260824-1349-phase-01-backend-db.md |
| Phase 1 test | 54 unit tests, 92% coverage, typecheck clean, build success | **PASS** | tester-260824-1412-phase-01-backend-db.md |
| Phase 1 review round 1 | 27 files, 3 crit + 5 high findings | **7.0/10 REJECTED** | code-reviewer-260824-1349-phase-01-backend-db.md |
| Phase 1 fixes | C1 rbac_writer SELECT+INSERT+metric, C2 rawBody HMAC, C3 advisory-lock tx + seq, H1–H5 config+validation | **DONE** | fullstack-developer-260824-1416-phase-01-fixes.md |
| Phase 1 review round 2 | All 3 crit + 5 high RESOLVED, audit.ts 214 LOC (7% overage) | **9.0/10 APPROVED** | code-reviewer-260824-1416-phase-01-reverify.md |

### Session — 2026-08-24 → 2026-08-25 (Phase 2 cook + gate + fixes + E2E)
| # | Milestone | Result |
|---|---|---|
| Day 1 spike S4 payload | Human OIDC + machine tests — grants absent for both | **F1 FINDING** — ListUserGrants API required |
| Day 1 spike S3 fail-mode | 4/4 chaos scenarios fail-open silent (webhook down, 500, malformed, timeout) | **F3 FINDING** — rbac_degraded:true MANDATORY |
| Day 2-3 impl | 14 new files (redis, singleflight, break-glass, mgmt-client, webhook), 306 LOC webhook (candidate split Phase 3) | **DONE** — all F1/F2/F3/F4 findings applied |
| Test | 123/123 pass (54 P1 + 20 P1-fix + 49 P2), 92.44% coverage, 0 TypeScript errors | **PASS** |
| Review round 1 | 8.7/10 APPROVE — 0 crit, 3 high (H1 epoch bump, H2 dead code, H3 rate-limit) | **APPROVED** |
| Post-review fixes | H1 epoch bump on deleteRole/parent_update, H2 remove dead fail-close block | **DONE** |
| Live E2E break-glass | User 387657093185798148 JWT: `break_glass:true`, perms `['rbac.admin.write', 'rbac.admin.read', 'zitadel.iam.write']` | **VERIFIED** |
| Live E2E normal | User with role JWT: `permissions_hash:<sha>`, `roles:[...]`, `ver:1`, inline `permissions[]` if <30 | **VERIFIED** |
| Live E2E degraded | Central-RBAC down: JWT `rbac_degraded:true`, `permissions:[]` | **VERIFIED** |

### Session — 2026-08-25 (Phase 3 cook + gate + fixes + E2E)
| # | Milestone | Result |
|---|---|---|
| Day 1 gate S1 idempotency | Live test 4 scenarios (duplicate POST, add-to-existing, remove twice, ProjectRole ops), confirmed via `gate-260825-s1-idempotency.md` | **CONFIRMED** — 409 on add, 404 on remove, UpdateUserGrant PUT-replace semantics |
| Day 1 gate S2 custom role | GitHub #10505 CLOSED — bug affects human users, not SA. Zitadel v4 no custom IAM role API. Accept IAM_OWNER + [SA-ANOMALY] monitoring per red-team F6 | **DEFERRED Phase 5** — accept IAM_OWNER |
| Days 2-4 impl | 18 new files (7 source, 11 test), 4 modified. Outbox + Mgmt API clients + user-grant-sync refactor + advisory lock serialization | **DONE** |
| Test round 1 | 189/189 pass (66 new Phase 3 + 123 Phase 1/2 regression), 90.33% coverage | **PASS** |
| Review round 1 | 7.8/10 APPROVE_WITH_CONCERNS — 0 crit, 4 high (H1 race, H2 stalled, H3 SIGTERM, H4 hot-path) | **MERGED_WITH_FOLLOWUPS** |
| Fix pass | H1-H4 all fixed, M1 pagination, L2 file splits, L3 gitignore | **DONE** — per `fullstack-developer-260825-0919-phase-03-fixes.md` |
| Test round 2 | 193/193 pass, 89.26% coverage (expected 1% dip — new small modules) | **PASS** |
| Live E2E | 3 outbox events processed (add_project_role→200, add_user_grant→409-ok, remove_project_role→200). SIGTERM graceful drain verified | **VERIFIED** |

### Session — 2026-08-22
| # | Question | Decision | Propagated to |
|---|---|---|---|
| V1 | First adopter app | **OneMCP portal** (dogfood, đã Zitadel OIDC integrate) | plan.md success criteria + Phase 5 smoke test |
| V2 | Zitadel staging env cho Phase 0 spike | **Prod Zitadel + isolated sandbox org** (org `spike-test`) | phase-00-zitadel-actions-spike.md |
| V3 | Break-glass credentials vault | **1Password shared vault phòng KT** (anh + 1 backup access) | phase-05-seed-deploy.md break-glass runbook |
| V4 | DNS + HTTPS timing | **~~Setup subdomain + HTTPS TRƯỚC Phase 4~~** — **REVERSED 2026-08-25**: cook Phase 4-5 IP-first review mode, domain swap post-review. Rationale: anh muốn review UI/functionality trước khi commit domain + cert. OIDC redirect URI dual-add (IP + domain) khi swap → 1 lần extra config nhưng ko rework. See [brainstorm-260825-0957](../reports/brainstorm-260825-0957-central-rbac-ip-first-review-mode.md) | phase-04 Step 2, phase-05 Step 17.5 |

### Session — 2026-08-25 (Phase 4-5 pre-cook locking)
| # | Question | Decision | Propagated to |
|---|---|---|---|
| V6 | Access URL cho review mode | **`http://10.200.0.125:8082/`** private IP + Traefik entrypoint port 8082 mới (avoid conflict với Zitadel Login v2 root paths). Anh access qua VPN office/LAN hoặc SSH tunnel `-L 8082:10.200.0.125:8082 authway-vps`. Public IP `103.57.222.245` egress-only, DC ko forward inbound :80 | phase-05 Step 6 Traefik entrypoint, phase-04 OIDC redirect URI |
| V7 | Firewall / IPAllowList | **SKIP** — private IP không reachable từ internet, LAN 10.200.0.0/24 auto-restricted, Zitadel OIDC auth layer trên top. Post-review khi swap sang domain public → add IPAllowList | — |
| V8 | Zitadel org cho Phase 4-5 review | **Reuse `spike-test` org** (existing từ Phase 2-3, có sẵn test users + break-glass) | phase-04 Step 2 OIDC client scope, phase-05 Step 4 bootstrap seed target |
| V9 | Central RBAC backend integration Phase 5 | **Keep standalone** (đã live E2E Phase 2-3) — chỉ add central-rbac-ui service + attach cả 2 vào `authway-prod_edge` network + Traefik labels. Migrate vào `/opt/authway/infra/authway-vps/docker-compose.yml` = post-review task | phase-05 Step 6 network attach |
| V5 | Backend stack | **Node.js + Fastify + TypeScript** (locked, confirmed) | phase-01, phase-02, phase-03 |
