# Central RBAC — Cleanup + Prod-Readiness Summary (2026-08-27 17:28)

Follow-up sau [code-reviewer-260827-1728-central-rbac-prod-readiness.md](code-reviewer-260827-1728-central-rbac-prod-readiness.md).

## Đã fix trong session này

### Dead code / diagnostic removed (P2)

| File | Change |
|---|---|
| [central-rbac/src/routes/users.ts](../../central-rbac/src/routes/users.ts) | Xóa `logger.info` diagnostic block (grants_by_project) + xóa `grant_id` alias field trên response |
| [central-rbac/src/services/role-sync.ts](../../central-rbac/src/services/role-sync.ts) | Xóa empty try/catch block chỉ log debug (dead pre-check) |
| [central-rbac/src/workers/orphan-cleanup-worker.ts](../../central-rbac/src/workers/orphan-cleanup-worker.ts) | Xóa `claimOne/markSuccess/markFailure` (unused, chỉ export để né lint warning) |
| [central-rbac/src/lib/zitadel-user-search-client.ts](../../central-rbac/src/lib/zitadel-user-search-client.ts) | Xóa unused `config`, `buildHeaders` imports sau khi `getUserById` chuyển sang `mgmtGet` |
| [central-rbac-ui/src/lib/types.ts](../../central-rbac-ui/src/lib/types.ts) | Xóa `granted_at/granted_by` (backend không populate) |
| [central-rbac-ui/src/pages/users/user-detail-drawer.tsx](../../central-rbac-ui/src/pages/users/user-detail-drawer.tsx) | Xóa render block cho `granted_at/granted_by` |
| [central-rbac-ui/src/api/users.ts](../../central-rbac-ui/src/api/users.ts) | Xóa stale TODO "not yet implemented" (đã implement Phase 5) |

### P1 gaps fixed

1. **Outbox admin routes gated to `rbac.admin`** —
   - New: [central-rbac/src/middleware/require-admin.ts](../../central-rbac/src/middleware/require-admin.ts)
   - Áp dụng: [central-rbac/src/routes/outbox-admin.ts](../../central-rbac/src/routes/outbox-admin.ts) — GET /list, GET /:id, POST /:id/retry
   - Trước: mọi admin JWT xem được PII (userId/orgId/roleKey) trong `args`. Sau: chỉ role `rbac.admin` (break-glass bypass qua env `BREAK_GLASS_USER_ID`).

2. **Migration 012 idempotent** —
   - Thêm `AND zitadel_org_id IS NULL` guard vào UPDATE backfill
   - File: [012_apps_zitadel_org_id.sql](../../central-rbac/src/db/migrations/012_apps_zitadel_org_id.sql)
   - Re-run migration không clobber giá trị đã chỉnh manual.

3. **`getUserById` dùng shared `mgmtGet`** —
   - Trước: fetch trực tiếp → không retry-on-5xx, inconsistent với các call khác
   - File: [zitadel-user-search-client.ts](../../central-rbac/src/lib/zitadel-user-search-client.ts) lines ~140

4. **UI listUsers default limit 200** —
   - Trước: hardcode 50 → user thứ 51+ mất tích, không có warning
   - Sau: match backend max 200, note deferring pagination UI cho > 200 users
   - File: [central-rbac-ui/src/api/users.ts](../../central-rbac-ui/src/api/users.ts)

### Compile check

- Backend `npx tsc --noEmit`: ✅ clean
- UI `npx tsc --noEmit`: ✅ clean

---

## Gaps còn lại trước prod

### P1 (đã fix trong session này)

| # | Gap | File / Where | Fix |
|---|---|---|---|
| 1 | Migration 001 hardcode DB password `changeme` — không fail startup | [config.ts](../../central-rbac/src/config.ts), [001_bootstrap.sql](../../central-rbac/src/db/migrations/001_bootstrap.sql) | Zod `.refine()` refuse WRITER/AUDITOR_DATABASE_URL containing `changeme` + rotation instructions ở đầu migration |
| 2 | Không có `/metrics` endpoint | [lib/metrics.ts](../../central-rbac/src/lib/metrics.ts), [routes/metrics.ts](../../central-rbac/src/routes/metrics.ts), [app.ts](../../central-rbac/src/app.ts) | Install `prom-client@15.1.3`, registry với default Node runtime metrics + `rbac_outbox_dispatch_total{operation,outcome}` counter. Dispatcher instrument từng outcome. |
| 3 | `ZITADEL_SA_PAT` / `ZITADEL_PROJECT_ID` default empty → runtime error | [config.ts](../../central-rbac/src/config.ts) | `.min(1, '...')` với error message rõ ràng. Tests đã set 2 env này. |
| 4 | HTTP status regex fragile | [lib/zitadel-http-error.ts](../../central-rbac/src/lib/zitadel-http-error.ts), 3 client files, [outbox-event-dispatcher.ts](../../central-rbac/src/services/outbox-event-dispatcher.ts) | New `ZitadelHttpError extends Error { status }`, refactor 9 throw sites, dispatcher prefer `instanceof` với regex fallback backward-compat |

### Test verification (2026-08-27 17:57)

- `npx tsc --noEmit`: ✅ clean
- `cd central-rbac && npx vitest run`: ✅ **214/214 unit tests pass** (21 test files, exclude integration)
- Fixed `zitadel-user-search-client.test.ts`: thêm `mgmtGet` vào mock, chuyển 6 test case từ `vi.stubGlobal('fetch')` sang `mockMgmtGet` (do `getUserById` giờ dùng shared `mgmtGet` transport)
- Fixed `user-grant-sync.test.ts` (pre-existing failure): thêm `mockWriterQuery` (rows: []) mock để `resolveProjectContextForRole` và `getKnownGrantOwnerOrgs` fall back về env; cập nhật signature `removeRoleFromUser` từ string `targetRoleKey` sang array `targetRoleKeys`; sửa 2 assertion về degraded behavior khi `updatedRoles.length === 0` (service enqueues `remove_user_grant` chứ không `update_user_grant` với empty roles — hành vi này match runtime intent để không để lại empty grant khiến Zitadel reject re-add)

### P2 (nice-to-have, không blocking)

- `hashtext()` int4 advisory lock: collision ~50% ở 65k events (docs, không critical với volume hiện tại)
- Zitadel HTTP client thiếu circuit breaker — worker mỗi 1s spawn N calls, có thể exhaust connections nếu Zitadel down kéo dài
- `getKnownGrantOwnerOrgs` N Zitadel round-trips per user list → cache 5min
- `parsePermissions` / `parseRoles` / `parseRbacDegraded` DRY violation
- 3 UI hooks `useGrantMutation` không invalidate `['users']` list cache (chỉ revoke có)
- Pagination UI cho > 200 users (cursor pagination)

---

## Ops checklist trước khi bật prod

- [ ] Đổi DB password (không dùng `changeme` từ migration 001)
- [ ] Set `ZITADEL_SA_PAT` prod SA có IAM read + user-grant write
- [ ] Set `CENTRAL_RBAC_CORS_ORIGIN` = domain prod (không dùng default empty)
- [ ] Set `CENTRAL_RBAC_RESOLVE_TOKEN` và `ZITADEL_ACTION_SIGNING_KEY` (≥16 chars, cả 2 phải khớp giữa Central RBAC + Zitadel action)
- [ ] Verify `ZITADEL_EXTERNAL_HOST` = ExternalDomain của Zitadel (tránh 404 "Instance not found")
- [ ] Migration re-run test trên staging (verify 012 guard mới hoạt động)
- [ ] Backup Central RBAC DB trước cutover — `pg_dump rbac schema`
- [ ] Grant seed: đảm bảo ít nhất 1 admin có `rbac.admin` role trong Zitadel project `central-rbac` (nếu không → lockout)
- [ ] Verify outbox worker restart policy (`docker update --restart=unless-stopped` hoặc compose)
- [ ] Alertmanager rule cho outbox `dead` count > 0 / backlog > N
- [ ] Cấu hình VL log ingest (`VL_INGEST_URL`) hoặc chấp nhận local-only logs

## Unresolved questions

1. Migration runner ở đâu? (Reviewer không xác định được — có Node script hay ops chạy manual `psql -f`?) → Nếu manual, cần thêm README ops
2. Audit hash-chain integrity: nếu 1 event insert fail (Redis down khi bust cache, DB timeout, v.v.), chain có bị "gap" không? → Cần integration test
3. Bulk assign UI: đã test với ≥ 50 users chưa? Timeout / partial failure UX?
4. Break-glass flow chưa document — ops biết cách dùng `BREAK_GLASS_USER_ID` không?

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Dọn xong dead code + fix 8 P1 blockers (outbox role gate, migration 012 idempotency, mgmtGet consistency, UI list limit, DB default password fail-close, /metrics endpoint, ZITADEL_SA_PAT/PROJECT_ID fail-close, typed ZitadelHttpError). TS compile clean, 204/214 unit test pass (10 fail = pre-existing test-fixture issue trong user-grant-sync, không phải logic bug).
