# 2026-08-27 — Central RBAC grant flow e2e bugs + fixes

Phase 07/08 e2e test session sau Migration 011 (multi-project awareness). 3 bugs UI/backend chặn workflow grant→revoke→re-grant.

## Bối cảnh

Sau khi apply architectural fix Migration 011 (commit `8636657`), lần đầu test workflow đầy đủ trên prod (authway-vps qua SSH tunnel `localhost:8082`). Đối tượng test: Spike Tester (`spike-user@spike-test.local`, userId `387657093185798148`), grant `onemcp.admin` (Zitadel project OneMCP `388071945217769476`).

## Bugs phát hiện

### Bug 1 — UI drawer không cập nhật sau grant/revoke
**Triệu chứng**: Toast "Đã thu hồi... (đang đồng bộ...)" xuất hiện nhưng badge `onemcp.admin` vẫn nằm trong drawer sau 5s+.

**Root cause** (3 lớp chồng lên nhau):
1. `POST/DELETE /v1/assignments` chỉ bust cache `assignments:v1:{userId}`, KHÔNG bust `user-detail:v1:{userId}` — drawer đọc từ endpoint sau, cached 60s.
2. Ngay cả khi bust: mutation là enqueue-first (outbox async ~1-2s). UI refetch ngay lập tức → backend cache miss → fetch Zitadel → **worker chưa chạy** → trả grant CŨ → cache lại 60s. Cache poisoned.
3. React-query `invalidateQueries` re-run queryFn cũ, không có cơ chế bypass cache.

**Fix**:
- [routes/assignments.ts](../../central-rbac/src/routes/assignments.ts) — bust cả 2 caches (user-detail + assignments) trong POST + DELETE.
- [services/outbox-event-dispatcher.ts](../../central-rbac/src/services/outbox-event-dispatcher.ts) — sau khi Zitadel commit thành công (add/update/remove user grant), worker chủ động bust cache theo `userId` trong args. Đảm bảo cache đầu độc bị dọn khi state thật đã update.
- [routes/users.ts](../../central-rbac/src/routes/users.ts) — thêm query param `?fresh=1` bypass cache read + write. Polling refetch không tự đầu độc cache khi Zitadel còn stale.
- [api/users.ts](../../central-rbac-ui/src/api/users.ts) — `getUserDetail(id, fresh)` truyền `?fresh=1` khi được yêu cầu.
- [hooks/use-assignments-query.ts](../../central-rbac-ui/src/hooks/use-assignments-query.ts) — thay `invalidateQueries` bằng `fetchQuery` với queryFn dùng `fresh=true`. Polling cadence 0ms, 700ms, 1.8s, 3.2s, 5s.

### Bug 2 — Grant rỗng còn lại trong Zitadel + UI hiện row trống
**Triệu chứng**: Sau khi thu hồi role duy nhất trong grant, UI hiện project `388071945217769476` không có badge nào nhưng vẫn có nút "Thu hồi". Zitadel giữ grant với `roleKeys: []`.

**Root cause**: `removeRoleFromUser` khi partial revoke làm `updatedRoles.length === 0` vẫn enqueue `update_user_grant` với empty array thay vì `remove_user_grant`.

**Fix**:
- [services/user-grant-sync.ts](../../central-rbac/src/services/user-grant-sync.ts) — check `updatedRoles.length === 0` → chuyển sang `remove_user_grant` (DELETE full grant).
- [routes/users.ts](../../central-rbac/src/routes/users.ts) — defensive filter `roleKeys.length > 0` trong grant map, tránh leftover từ trước fix hiện lên UI.
- Cleanup: `DELETE /management/v1/users/{userId}/grants/388074788435787780` xoá grant rỗng đã tồn tại.

### Bug 3 — Re-grant sau revoke bị swallow bởi idempotency key
**Triệu chứng**: User grant → revoke thành công → grant lại role cùng, không có event outbox mới, Zitadel không update. Log: `outboxId:8, inserted:false`.

**Root cause**: Idem key `sha256('add_or_update_user_grant' | userId | projectId | roleKey)` cố định vĩnh viễn theo tuple. Lần grant đầu tạo event #8 (done). Grant lại có cùng key → `ON CONFLICT DO NOTHING` → trả về row cũ đã done, KHÔNG tạo event mới.

**Fix**:
- [services/user-grant-sync.ts](../../central-rbac/src/services/user-grant-sync.ts) — thêm `timeBucket = floor(Date.now() / 10s)` vào idem key cho cả 3 paths (grant, partial-revoke, full-revoke). Retry network <10s vẫn dedupe (đúng mục đích idempotency), nhưng grant-revoke-grant qua ≥1s luôn tạo event mới. Worker advisory lock + merge logic vẫn an toàn nếu có double enqueue.

## Xác thực (Zitadel-side)

Trước fix, Spike Tester ở Zitadel còn:
- grantId `388074788435787780` project OneMCP với `roleKeys: []` (từ update trước fix)

Sau fix + cleanup:
- Chỉ còn grantId `387765915778809860` project spike-project `[rbac.admin, spike.role.a, spike.role.b]` (chưa bị đụng trong session).
- Grant OneMCP đã xoá sạch qua Management API DELETE.

## Bài học

- **Enqueue-first pattern** yêu cầu cache invalidation ở CẢ 2 điểm: khi enqueue (bust ngay để tránh serve stale response) VÀ khi worker commit (bust để dọn cache có thể đã bị đầu độc bởi refetch sớm).
- **Idempotency key phải bounded theo thời gian** khi state có thể đảo chiều (grant↔revoke). Vĩnh viễn theo tuple = swallow cycle valid.
- **UI type contract phải match backend response chính xác** — không đồng bộ `id` vs `grant_id` gây bug im lặng (DELETE `/undefined`) mà không có test type-check nào bắt được. Cần integration test cho grant/revoke round-trip.
- **Empty state edge case ở worker level**: Zitadel không reject `roleKeys: []` update, giữ grant lại làm rác. Client phải chuyển sang DELETE thay vì trust Zitadel enforce.

## Files thay đổi

Backend (central-rbac):
- `src/routes/assignments.ts` — bust cả user-detail + assignments caches
- `src/routes/users.ts` — thêm `id` field + fresh bypass + empty-role filter
- `src/services/outbox-event-dispatcher.ts` — bust cache sau Zitadel commit
- `src/services/user-grant-sync.ts` — empty→remove_user_grant + time-bucketed idem key

UI (central-rbac-ui):
- `src/api/users.ts` — `fresh` param
- `src/hooks/use-assignments-query.ts` — polling refetch với fresh=1

## Follow-ups (không blocking)

- Integration test grant→revoke→re-grant cycle ở CI để bắt regression.
- Dọn dead outbox event #4 (pre-Migration 011 leftover).
- Migration 008a version=81 typo (cosmetic).
- Sync `docs/development-standards/backend-caching.md` bổ sung enqueue-first cache invalidation pattern (sau khi có nhiều case hơn để generalize).
