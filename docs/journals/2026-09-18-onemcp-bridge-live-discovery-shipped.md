---
date: 2026-09-18
plan: 260918-0953-onemcp-bridge-live-discovery
status: shipped
tags: [onemcp, bridge, discovery, dx, live]
authors: [trihd@inet.vn]
---

# OneMCP bridge live discovery (Option D) shipped

## TL;DR

Bottleneck DX của MVP osh_admin bridge (dev osh_admin phải nhờ Admin OneMCP register bridge mỗi lần thêm/sửa endpoint) đã resolve. Ship Option D — live discovery symmetric với `load_permissions` — trong 1 session (~2d effort thực). Dev osh_admin từ nay full autonomy: chỉ cần expose `GET /tools/list` một lần, OneMCP tự discover trong ≤60s.

## What shipped

3 phases sequential, tất cả clean build + 166 tests pass (160 pre-existing + 6 integration mới):

| Phase | Commit onemcp | Files | Effort |
|---|---|---|---|
| 1 — Discovery service + cache + schema | [`041df83`](https://github.com/inet-vn/onemcp/commit/041df83) | 11 files, +565/-2 | ~1d |
| 2 — MCP dispatch integration | [`4118fd7`](https://github.com/inet-vn/onemcp/commit/4118fd7) | 2 files, +351/-8 | ~0.5d |
| 3 — Portal UI + endpoints + mock + integration test | [`dc41b27`](https://github.com/inet-vn/onemcp/commit/dc41b27) | 9 files, +450/-10 | ~0.5d |

Onelog docs commit: [`7983197`](https://github.com/inet-vn/onelog/commit/7983197) (docs spec + guideline + runbook + mockup, +644/-24)

**Total:** 22 files changed, 4 commits across 2 repos.

## Key design decisions (LOCKED)

1. **Live fetch, không sync/store DB** — dispatcher xây synthetic `ToolBridge` in-memory (id prefixed `live:` cho audit trail). Zero migration cho dynamic bridges.
2. **In-memory cache** — TTL 60s + singleflight (chỉ 1 fetch inflight per upstream) + stale grace 5min khi fetch fail.
3. **Symmetric với Central RBAC pattern** — `load_permissions` → `load_tools` uniform.
4. **Legacy manual bridges preserved** — `tool_bridges` DB rows vẫn work (backward compat với MVP shipped 2026-09-17).
5. **Precedence:** static wins > legacy DB > live-discovered (log warn on collision).

## Insight user (pivot moment)

Ban đầu plan Option C (manifest sync 5min cron + hash + diff + soft-delete + circuit break). User đọc lại sơ đồ, phát hiện có thể "thêm load_tools" mirror với existing `load_permissions`. Insight: 2 pattern uniform tốt hơn 2 pattern khác nhau. Pivot xong effort 4d → 2d, latency 5min → 60s, complexity giảm mạnh (no diff logic, no circuit break, no DB migration cho bridges).

Cancelled Option C plan (`260918-0938-onemcp-bridge-manifest-sync`) → archived với `cancelReason` note.

## Test coverage delivered

- **15 unit tests** — `BridgeDiscoveryService` (cache/singleflight/stale/HTTPS/timeout/size cap/Zod validation)
- **7 unit tests** — `McpToolsService` live-discovery integration (merge order, collision handling, synthetic bridge dispatch)
- **6 integration tests** — real HTTP against in-process `node:http` server (wire format, auth header propagation, cache warm/invalidate, stale-serve)
- Full backend suite: **160 tests pass** (14 test files, no regression)

## Coordinate với dev osh_admin (next step)

Deliverable ready: [`docs/onemcp-bridge-discovery-spec.md`](../onemcp-bridge-discovery-spec.md) (509 lines).

Ask dev osh_admin:
1. Expose `GET /tools/list` trong osh_admin backend (bearer-protected, same token as tool calls)
2. Build tools list dynamic từ router (auto-sync khi thêm endpoint mới)
3. Verify qua `curl -H "Authorization: Bearer $TOKEN" ${base_url}/tools/list | jq .`

Sau khi dev osh_admin expose endpoint prod, Admin OneMCP chỉ cần edit upstream trong portal → paste `discovery_url` → save. Từ đó về sau dev osh_admin autonomy 100%.

## Files bumped (summary)

**onemcp backend:**
- `db/migrations/1722800000000-bridge-discovery-url.ts` (NEW)
- `tool-bridges/discovery/` — 4 files (service, schema, types, unit + integration specs)
- `tool-bridges/entities/tool-upstream.entity.ts` — add `discoveryUrl` column
- `tool-bridges/dto/upstream.dto.ts` — add discoveryUrl to Zod schema
- `tool-bridges/tool-upstreams.service.ts` — add `listWithDiscoveryUrl()`
- `tool-bridges/tool-upstreams.controller.ts` — POST `/:id/discovery-refresh`
- `tool-bridges/tool-bridges.controller.ts` — GET `/discovered`
- `tool-bridges/tool-bridges.module.ts` — export `BridgeDiscoveryService`
- `mcp/mcp-tools.service.ts` — merge live-discovered in listDefinitions + synthetic dispatch
- `mcp/mcp-tools-discovery.spec.ts` (NEW)

**onemcp portal:**
- `lib/api/tool-bridges-api.ts` — types + `refreshDiscovery` + `listDiscoveredBridges`
- `admin/tool-bridges/upstreams/upstream-form-modal.tsx` — Discovery URL input
- `admin/tool-bridges/upstreams/upstreams-table.tsx` — Live badge + Refresh cache button
- `admin/tool-bridges/bridges/bridges-table.tsx` — Source column + Live rows
- `admin/tool-bridges/tool-bridges-tabs.tsx` — fetch + pass discovered rows

**onemcp mock-osh-admin:**
- `server.js` — `GET /tools/list` route returning 3-tool catalog

**onelog docs:**
- `docs/onemcp-bridge-discovery-spec.md` (NEW, 509 lines)
- `docs/onemcp-tool-bridge-guideline.md` — Option D section
- `docs/onemcp-tool-bridge-runbook.md` — 2 procedures
- `mockups/onemcp-osh-admin-bridge-workflow.html` — mark shipped
- `plans/260918-0953-onemcp-bridge-live-discovery/plan.md` — status shipped

## Out of scope / future

- Persistent cache (Redis) — MVP in-memory OK (restart lose = 500ms one-time miss)
- Multi-instance cache invalidation — MVP single instance
- Stale-while-revalidate — MVP blocking on miss (simpler)
- Version-aware discovery — MVP ignores version field
- Auto-detect discovery_url from base_url convention — MVP require explicit input

## Unresolved

Không có blocker. Chờ dev osh_admin implement `/tools/list` endpoint để E2E verify với real backend.
