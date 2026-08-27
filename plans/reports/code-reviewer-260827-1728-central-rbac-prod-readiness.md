# Code Review — Central RBAC prod-readiness

Date: 2026-08-27 17:29
Scope: `central-rbac/src` (backend, ~5,944 LOC) + `central-rbac-ui/src` (~2,608 LOC) + 12 SQL migrations + Dockerfile.
Focus: dead code, prod-readiness gaps, KISS/YAGNI/DRY.

## Overall
Codebase in solid shape. Hardening iterations visible everywhere (H1–H5, C2, F3/F4/F8, S1/S2, Fix #8/#11/#13). Outbox pattern with advisory lock + time-bucketed idempotency is correct. JWT verify chain is chặt, HMAC replay window good, audit hash chain in place, break-glass validated at startup, graceful shutdown wired. UI stack (React Query + fetchQuery polling fresh=1) resilient to eventual consistency.

Nhưng có ~10 items nên fix trước prod (mostly P1/P2, không P0 blockers).

---

## 1. Dead code / diagnostic leftovers

| # | File:line | Item | Action |
|---|---|---|---|
| D1 | `routes/users.ts:138-148` | Diagnostic `logger.info('users: detail served')` với `grants_by_project` — leftover từ debug session drawer empty | **Remove** hoặc lower xuống `logger.debug` |
| D2 | `routes/users.ts:154,161` | Legacy alias `grant_id: g.grantId` — UI đã dùng `grant.id`, không có consumer nào cần `grant_id` (grep confirm) | **Remove** alias + comment |
| D3 | `lib/types.ts:36-37` + `pages/users/user-detail-drawer.tsx:125-129` | `Grant.granted_at` / `granted_by` — backend không populate, condition luôn false → dead render | **Remove** type fields + render block (or wire backend nếu muốn giữ) |
| D4 | `api/users.ts:6-8` | TODO comment "endpoints not yet implemented" — đã implement rồi (routes/users.ts exists) | **Remove** TODO |
| D5 | `services/role-sync.ts:138-148` | Empty `if (orgId) try { logger.debug('no Zitadel pre-check'); } catch {}` — no-op block chỉ để log lời hứa | **Remove** hoặc thay bằng single-line comment |
| D6 | `workers/orphan-cleanup-worker.ts:27-61` + `:149` | `claimOne`/`markSuccess`/`markFailure` exported "for testing" nhưng `processOne` duplicate hết logic + đang là code path thực. Comment nói "avoid unused-vars complaint" | **Remove** unused helpers, refactor `processOne` gọi chúng nếu muốn giữ DRY |
| D7 | `services/user-grant-sync.ts:20` | Doc-comment nói "removeRoleFromUser is still called in the hot path because we need current role set" — nay đã enqueue-first (không blocking Zitadel call trước enqueue) | **Update** doc comment cho đúng flow hiện tại |
| D8 | `routes/webhook-pre-token.ts:232` | Comment "wired for Phase 3 admin fail-close" — `FAIL_CLOSE_ROLE_PATTERN` chưa được đọc ở bất kỳ đâu | Xóa comment hoặc implement fail-close path |

Comments `H3 fix / H4 fix / C2 fix` — giữ vì chúng document non-obvious invariants (raw body cho HMAC, azp fallback, advisory lock semantics). Không phải noise.

---

## 2. Prod-readiness gaps

### Security

| # | Sev | Item | File:line |
|---|---|---|---|
| S1 | **P1** | `listUsers` API frontend không pass `offset`/pagination → backend default 50 → chỉ thấy 50 users đầu. Với org > 50 users = data leak-less nhưng UX bug + audit blind spot | `api/users.ts:12-17` + `routes/users.ts:36-84` (backend trả `total` nhưng UI drop) |
| S2 | **P1** | `PATCH /v1/roles/:key` **thiếu bump epoch** khi role.parent_key thay đổi thực chất **có bump** (roles.ts:103) — nhưng KHÔNG bump khi update description that's ok. Tuy nhiên **hierarchy cycle check** chỉ block khi set parent, KHÔNG check khi role bị delete + re-created (race qua createRoleWithSync). Realistic risk thấp | `routes/roles.ts:88-112` |
| S3 | **P2** | `verifyResolveAuth` accept EITHER token OR HMAC — thiếu explicit "prefer HMAC nếu cả 2 present" (attacker gửi cả 2 để confuse). Hiện tại code check token trước → HMAC bị skip nếu token match, OK; nhưng nếu token invalid, HMAC vẫn được thử → có thể exploit nếu token verify slow. Low risk vì constant-time compare | `middleware/auth-resolve.ts:114-135` |
| S4 | **P2** | `error-handler.ts:36` — trả `error.message` cho `statusCode < 500` — nếu route throw `Error("SELECT * FROM ...")` với DB error message có thể leak. Route hiện dùng safe `reply.status(...).send({error: 'human msg'})` nhưng thrown errors sẽ pass qua | `middleware/error-handler.ts:32-36` |
| S5 | **P1** | Migration 001 hardcode password `rbac_writer_changeme` / `rbac_auditor_changeme`. Comment ghi phải đổi trong prod nhưng migration này chỉ chạy 1 lần → nếu ops quên thì prod chạy default password. Nên fail startup nếu password còn "changeme" | `src/db/migrations/001_bootstrap.sql:19,22` |
| S6 | **P2** | `admin-apps.ts:73-77` `SELECT ... FROM rbac.apps WHERE lower(slug) LIKE $2` — `$2 = 'ab%'`. LIKE escape không needed vì user input `slug` đã match `^[a-z][a-z0-9-]{2,31}$` (no `%`/`_`), nhưng nếu regex đổi thì SQL injection tiềm ẩn. Add `ESCAPE` clause hoặc explicit escape | `routes/admin-apps.ts:66-73` |
| S7 | **P2** | CORS `methods: ['GET', 'POST', 'PATCH', 'DELETE']` — thiếu `OPTIONS` (Fastify + browser preflight thường auto handle nhưng explicit tốt hơn) | `app.ts:67` |
| S8 | **P1** | `outbox-admin.ts:33 GET /v1/outbox` — chỉ verifyJwt, không có role check. Bất kỳ authenticated admin JWT nào cũng đọc được toàn bộ outbox_events (bao gồm `args` có userId/orgId — PII). Cần role gate (rbac.admin) | `routes/outbox-admin.ts:33` |

### Observability

| # | Sev | Item | File:line |
|---|---|---|---|
| O1 | P1 | Không có `/metrics` endpoint (prom-client). Comment "Phase 2: replace with prom-client" xuất hiện 2x. Prod sẽ khó tune rate limit, outbox backlog | `routes/health.ts:1-6`, `middleware/audit-log.ts:71` |
| O2 | P2 | Outbox backlog không expose — chỉ có `/v1/outbox?status=dead` (admin). Alertmanager rule không biết `pending > N` là abnormal | Cần metric `rbac_outbox_pending_total`, `rbac_outbox_dead_total` |
| O3 | P2 | `correlation_id` propagate tốt trong request path, nhưng outbox event dispatch (`outbox-dispatcher.ts:82`) log `correlationId` nhưng downstream Zitadel client (zitadel-http.ts) không carry theo. Debug cross-service khó | `lib/zitadel-http.ts` — nên inject `x-correlation-id` header vào outbound |
| O4 | P2 | `webhook-pre-token.ts:274` — catch-all trả degraded response không log status/http codes → khó phân biệt Zitadel down vs DB down vs cache miss | Include error class trong log |

### Resilience

| # | Sev | Item | File:line |
|---|---|---|---|
| R1 | P1 | `zitadel-http.ts` retry once trên 5xx (500ms delay, 3s timeout). Không có exponential backoff, không có circuit breaker. Nếu Zitadel down đợt dài, outbox worker mỗi 1s spawn N calls, mỗi call tối đa 6s (2×3s) → connection exhaustion | Thêm circuit breaker (open sau X consecutive 5xx) hoặc tăng retry cadence trong worker |
| R2 | P1 | `zitadel-user-search-client.ts:148` — `getUserById` bypass `mgmtGet` helper → không có retry-on-5xx. Inconsistent với các client khác | Chuyển sang dùng `mgmtGet` |
| R3 | P2 | `writer-pool` / `auditor-pool` chưa xem — cần confirm pool size cap, statement timeout. (Chưa đọc nhưng khuyến nghị check) | `src/db/writer-pool.ts`, `src/db/auditor-pool.ts` |
| R4 | P2 | `orphan-cleanup-worker.ts:44-49` — sau max attempts, **DELETE row** → mất context để manual cleanup. Nên chuyển `status = 'dead'` cột nào đó để giữ history | `workers/orphan-cleanup-worker.ts:44-49, 94-100` |
| R5 | P2 | `outbox-worker.ts:88-91` — `bucket.waitMs()` block loop nhưng nếu `waitMs` lớn hơn shutdown grace (15s), worker không exit đúng. Check `!running` inside sleep | `services/outbox-worker.ts:87-92` |

### Outbox worker

| # | Sev | Item | File:line |
|---|---|---|---|
| OB1 | P1 | Advisory lock formula `hashtext('ugrant:${userId}:${projectId}')` — `hashtext` returns int4, khả năng collision non-zero (2^32 keyspace). Với >100k user, birthday collision ~50% ở 65k events. Không catastrophic (2 unrelated events chỉ bị serialize) nhưng deserve comment about acceptable risk hoặc dùng int8 hashing | `services/outbox-processor.ts:159` |
| OB2 | P2 | `outbox-event-dispatcher.ts:96` regex `HTTP (\d{3})` — HTTP status extract từ error message string. Fragile: nếu bất kỳ client nào throw error message khác format, sẽ classify sai (5xx→retry loop hoặc 4xx→dead prematurely). Nên throw custom error class `ZitadelHttpError { status }` | `services/outbox-event-dispatcher.ts:94-105`, all `lib/zitadel-*-client.ts` |
| OB3 | P2 | Không có DLQ table. `status='dead'` rows nằm chung `outbox_events` — vệ sinh table lâu dài cần cron cleanup. Không critical vì partial index skip `dead` | Migration future |
| OB4 | P2 | `runLoop:59` — 1s poll interval hard-coded. Không configurable qua env | Move to config |

### Cache invalidation

| # | Sev | Item | File:line |
|---|---|---|---|
| C1 | P2 | `outbox-event-dispatcher.ts:41-49 bustUserCachesFromArgs` — bust after Zitadel commit OK. Nhưng nếu Zitadel commit success **nhưng** Redis DEL fail (network blip), cache holds stale 60s. Non-fatal (UI polls fresh=1) but worth noting | Acceptable — UI mitigation covers |
| C2 | P2 | `resolve` cache dùng epoch — nhưng permissions-lookup cache `perm-hash:{hash}` KHÔNG có epoch prefix → nếu 2 role sets ở 2 epoch cùng resolve ra same permissions, lookup returns đúng. OK về correctness; nhưng nếu 1 role bị rename epoch bumps, `perm-hash:` cached lookup vẫn chứa old permissions cho old hash. Acceptable vì hash là function of permissions | `routes/resolve.ts:73-77` — comment thêm về invariant |

### Migration idempotency

| # | Sev | Item | File:line |
|---|---|---|---|
| M1 | ok | Migrations 002–012 dùng `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `CREATE OR REPLACE TRIGGER`. Re-runnable | — |
| M2 | P2 | Migration 012 `UPDATE rbac.apps SET zitadel_org_id = '385591139173990404' WHERE slug='onemcp'` — hardcoded prod org id, không idempotent hoàn toàn (idempotent về result nhưng nếu ai đó update value sau đó, re-run migration override) | `src/db/migrations/012_apps_zitadel_org_id.sql:20-21` — thêm `AND zitadel_org_id IS NULL` |
| M3 | P2 | Migration 001 (bootstrap) `CREATE ROLE ...` sẽ **fail nếu re-run** — thiếu `IF NOT EXISTS` (chỉ có với `CREATE DATABASE` cũng chưa có). Comment nói "run manually by ops ONCE" nhưng CI test/dev refresh sẽ đau | `src/db/migrations/001_bootstrap.sql` |
| M4 | P2 | Không có migration runner code trong repo (checked briefly) — cần script `apply-migrations.sh` document về ordering | Docs gap |

### UI

| # | Sev | Item | File:line |
|---|---|---|---|
| U1 | ok | Error boundary global — có | `App.tsx:22` |
| U2 | P2 | `users-list-page.tsx:56-59` — `selectedUserObjects = users.filter(u => selectedRows.has(u.id))` — nếu user rời page rồi quay lại (users query refetch mất/thêm user), `selectedRows` giữ id cũ → bulk assign silently skip. Nên prune selectedRows khi users change | `pages/users/users-list-page.tsx` |
| U3 | P2 | `use-users-query.ts:9` — `queryKey: ['users', search]` — không invalidate khi grant/revoke → grant_count list stale. useRevokeMutation:63 có `invalidateQueries(['users'])` nhưng useGrantMutation KHÔNG | `hooks/use-assignments-query.ts:44-52` |
| U4 | P2 | `bulk-assign-dialog.tsx:41` — `useEffect(() => { if (!open) abort(); return () => abort(); }, [open, abort])` — cleanup runs mỗi lần `abort` reference change; `abort` là useCallback với deps [], nên OK. Nhưng `abort()` khi `open=true` initial render → race? Test kỹ | Verify với QA |
| U5 | P2 | `oidc-client.ts:53` `store: window.sessionStorage` — token bị mất khi close tab. UX OK cho admin app, nhưng silent renew iframe qua HTTP LAN sẽ fail secure-context. Comment đã note. Accept trade-off | — |
| U6 | P2 | `utils.ts:25-35 parseRbacDegraded` + parsePermissions + parseRoles — 3 hàm gần identical, chỉ khác key. DRY violation | Extract `getClaim<T>(token, key, defaultValue)` |
| U7 | P2 | `grant-dialog.tsx:52` — `if (selectedProject === 'legacy')` — magic string. Rare vì hardcoded 1 place, nhưng dễ typo | Extract constant |
| U8 | P2 | UI không có loading skeleton — chỉ "Đang tải..." plain text. Accept cho admin tool | — |

### Config / env

| # | Sev | Item | File:line |
|---|---|---|---|
| CF1 | ok | Zod validated startup, fail-fast | `config.ts` |
| CF2 | P2 | `ZITADEL_SA_PAT` default `''` → runtime error khi first Zitadel call. Nên required trong production mode | `config.ts:45` — thêm refine `NODE_ENV=production → ZITADEL_SA_PAT non-empty` |
| CF3 | P2 | `ZITADEL_PROJECT_ID` default `''` — nếu unset, `getFallbackProjectId` throw runtime. Nên required in production | Tương tự CF2 |
| CF4 | P2 | Logger redact chỉ cover `authorization`, `x-rbac-token`, `zitadel-signature` — không redact response bodies chứa `client_secret` từ admin-apps wizard. Response body không log, OK, nhưng verify chưa có `req.body` hoặc `res.body` bị log ở đâu | Verify `logger.info(...body...)` — không thấy trong sample |

---

## 3. Code smell / KISS-YAGNI-DRY

| # | Item | File:line |
|---|---|---|
| K1 | `services/user-grant-sync.ts:236-244` `getKnownGrantOwnerOrgs` fire N-queries mỗi request đến `listUserGrantsAllOrgs` — 3+ orgs = 3+ Zitadel round-trips PER user PER list request. Users list 50 = 150+ Zitadel calls (users.ts:66-72 already documents this trade-off, but acceptable-at-page-size assumption sẽ break khi cross-org expands) | Cache `getKnownGrantOwnerOrgs` in-memory 5min |
| K2 | Idempotency time bucket 10s comment logic OK nhưng magic number `10_000`. Extract constant `IDEM_TIME_BUCKET_MS` với comment về trade-off | `services/user-grant-sync.ts:106,170,218` |
| K3 | Rate limit `admin_app_create` per-admin/global — sound, nhưng chỉ 1 scope hardcoded. Nếu thêm scope khác (e.g. `admin_role_delete`) sẽ cần env var mới copy-paste | `middleware/rate-limit-admin.ts` |
| K4 | `zitadel-http.ts` 4 methods (POST/GET/PUT/DELETE) — near-identical impl (retry once 5xx). Factor ra `mgmtRequest(method, path, ...)` DRY | `lib/zitadel-http.ts:41-116` |
| K5 | `type any` counted 1 place (utils.ts:12 debounce — necessary evil for generic). Type safety overall strong | — |
| K6 | `routes/users.ts:45-46` — inline anonymous type declaration — nên extract `UserSearchResult` interface | Minor |
| K7 | Dead `grants` (empty roleKeys) filter ở users.ts:158 — treat symptom of a bigger issue: có cách nào để update grant về empty roleKeys ngoài revoke logic? Verify không có route để set roleKeys=[] | Grep confirmed: chỉ update_user_grant với updatedRoles.filter — has empty guard branching to remove. OK. Filter là belt-and-braces. |

---

## Unresolved questions

1. **Migration runner**: có script/tool nào chạy migrations 002+? Migration 001 manual, 002+ tự động? Chưa thấy trong sample.
2. **DB pool sizing**: chưa đọc `writer-pool.ts` / `auditor-pool.ts` — cần confirm `max`, `statement_timeout`, `idle_timeout` tuned cho prod load.
3. **hasActiveGrantsForRole** (role-sync.ts:193-205) — được export nhưng chưa thấy call site. Dead export?
4. **admin-apps-sync-manifest**: 369 LOC không review kỹ trong pass này. Đề xuất pass riêng nếu Phase 08 sắp release.
5. **mTLS chain**: `MTLS_GLOBAL_ENFORCE=true` path disabled by default; nếu bật cần verify cert-header-signer + Traefik chain deployed đúng — không phải trong scope review này.
6. `writeAuditLog` failure chỉ log + increment counter (audit-log.ts:69-75). Nếu audit hash chain đứt do audit write fail, next audit sẽ tính từ chain cũ + skip → integrity check pass nhưng missing events. Acceptable behavior?

---

## Recommended priority order

1. **Now** (before prod cutover): D1, D2, S5, S8, R2, M2, CF2/CF3 — small fixes, real risk
2. **Week 1 post-launch**: O1 (metrics), R1 (circuit breaker), OB2 (custom error class), S1 (UI pagination)
3. **Nice-to-have**: D3–D8, U-series, K-series, DRY refactors

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Central RBAC backend + UI in good shape overall — outbox pattern, auth chain, and audit hash chain đều đúng và hardened qua nhiều pass. ~10 P1 items (metrics endpoint, DB password hardcoded, outbox admin RBAC gate, HTTP status regex fragile, diagnostic log leftover) nên fix trước prod cutover; các gap còn lại chủ yếu polish/DRY/observability improvements không blocking.
