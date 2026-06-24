# Phase 03 · Admin metrics API endpoints

**Priority:** P0 · **Status:** pending · **Depends on:** Phase 02

## Overview
6 endpoints chia 2 nhóm:
- **Aggregated overview** (gọi 1 lần/poll): `/api/admin/metrics/overview` — tất cả KPI + sparkline.
- **Detail panels**: usage chart, top queries, ingestion, alerts, top templates.

Strategy: gộp KPI vào 1 endpoint để chat dashboard chỉ poll 1 URL → giảm 5x DB load.

## Endpoints

| Path | Returns | Source |
|---|---|---|
| `GET /api/admin/metrics/overview?range=24h|7d|30d` | `{conversations:{count,deltaPct,spark[]}, tokensCost:{tokens,costUsd,budgetPct}, latency:{p50,p95,p99,deltaMs}, errors:{count,openAlerts,latestAlert}}` | `llm_calls`, `conversations`, `audit_log` |
| `GET /api/admin/metrics/usage?range=7d&groupBy=model` | `{series:[{model,points:[{t,tokens,costUsd}]}], totals:[{model,tokens,costUsd,pct}]}` | `llm_calls` group by date_trunc('day', ts) |
| `GET /api/admin/metrics/top-queries?range=7d&limit=10` | `[{query, runs, p95Ms, costUsd}]` | `messages` join `llm_calls` group by query text-hash |
| `GET /api/admin/metrics/ingestion` | `{eventsPerSec, templates, embedCachePct, ingestLagMs, queueDepth}` | indexer `/internal/metrics` JSON (proxy) |
| `GET /api/admin/alerts?status=open|all&limit=20` | `[{id, severity, key, message, ts, resolvedAt?}]` | `alerts` table (phase 06) |
| `GET /api/admin/templates/top?range=7d&limit=10` | `[{template, count, severity}]` | indexer template store |

## Implementation rules
- Tạo dir: `web/src/app/api/admin/metrics/{overview,usage,top-queries,ingestion}/route.ts` (≤ 80 lines each).
- Tạo `web/src/app/api/admin/alerts/route.ts`.
- Tạo `web/src/app/api/admin/templates/top/route.ts`.
- Postgres queries dùng raw SQL qua `db.execute(sql\`...\`)` cho aggregation (drizzle group-by hơi verbose).
- Cache: `export const revalidate = 30;` (Next route cache 30s) cho `overview`. Others có thể 60s.
- Range parser: `lib/admin/range.ts` — `parseRange("7d") -> {from:Date, to:Date, bucket:"day"}`.

## Ingestion proxy
Indexer service hiện chạy như side process. Expose `GET /internal/metrics` (JSON) — nếu chưa có, mock trả `{eventsPerSec:0,...}` với flag `INDEXER_METRICS_URL` env.

## Acceptance
- [ ] 6 endpoints respond < 500ms p95 trên dev DB với 10k+ llm_calls rows.
- [ ] Range param validation (`24h|7d|30d` only).
- [ ] Vitest integration test mỗi endpoint với seeded fixtures.
- [ ] Manual curl test trả JSON đúng schema.

## Files
- create: `web/src/app/api/admin/metrics/overview/route.ts`
- create: `web/src/app/api/admin/metrics/usage/route.ts`
- create: `web/src/app/api/admin/metrics/top-queries/route.ts`
- create: `web/src/app/api/admin/metrics/ingestion/route.ts`
- create: `web/src/app/api/admin/templates/top/route.ts`
- create: `web/src/lib/admin/range.ts`
- create: `web/src/lib/admin/queries.ts` (shared SQL helpers)

## Security note
Per default chốt: **no auth gate** trong scope này. Add `docs/deployment-security.md` note: bảo vệ admin endpoints bằng IP allowlist ở reverse proxy. Future: thêm middleware role check.
