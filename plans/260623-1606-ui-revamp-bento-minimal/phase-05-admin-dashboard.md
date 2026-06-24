# Phase 05 · Admin dashboard

**Priority:** P0 · **Status:** pending · **Depends on:** Phase 01, 03

## Overview
Triển khai dashboard tổng `/admin` theo bento grid mock 02. 12-col grid, 4 KPI row + token chart (col-span 8 row-span 2) + service health + ingestion + top queries + top templates + alerts.

## Page structure
`web/src/app/admin/page.tsx` (hiện 5 lines, sẽ thành ~120 lines).

Section breakdown:
1. **Header row**: "Operations" title + range tabs (24h/7d/30d) → stored in URL `?range=7d`.
2. **KPI row** (4 cards col-span-3):
   - Conversations + Δ + sparkline.
   - Tokens · Cost + budget bar.
   - Latency p50/p95 + Δ.
   - Errors · open alerts (red accent).
3. **Token chart** col-span-8 row-span-2: multi-line recharts (sonnet/haiku/opus).
4. **Service health** col-span-4: list các check (extends current `/admin/health`).
5. **Ingestion** col-span-4: 2x2 mini-grid (events/s, templates, embed cache, lag).
6. **Top queries** col-span-5: table N/p95/$.
7. **Top templates** col-span-4: font-mono list with count badge.
8. **Alerts** col-span-3: feed với severity dots.

## Components (new in `components/admin/`)
- `kpi-card.tsx` — title, big number, delta, optional spark/bar.
- `token-usage-chart.tsx` — recharts `<LineChart>` 3 series + legend.
- `health-list.tsx` — service rows với dot + latency (reuse existing `/api/admin/health`).
- `ingestion-tiles.tsx` — 4 tile small.
- `top-queries-table.tsx`
- `top-templates-list.tsx`
- `alerts-feed.tsx`
- `range-tabs.tsx` — URL-synced range switcher.

Mỗi component ≤ 80 lines. Container component (`page.tsx`) wire data fetching.

## Data fetching
- Server component fetch `overview` + parallel `Promise.all` các endpoint khác.
- Pass props xuống sub-components.
- Client-side auto-refresh: thêm `"use client"` wrapper `<AutoRefresh interval={30000}>` re-fetch via `router.refresh()`.

## Routing/nav
- Top tabs trong `web/src/app/admin/layout.tsx`: Overview / Health / Audit / Alerts.
- Existing `/admin/health`, `/admin/audit` restyle dùng `Card`+`Chip` primitives nhưng giữ nguyên logic.

## Acceptance
- [ ] `/admin` render đủ 8 section, no console error.
- [ ] Range switch update URL + reload data.
- [ ] Chart render 3 series, tooltip OK.
- [ ] Auto-refresh 30s không spam (chỉ 1 request/poll vì gộp overview).
- [ ] Visual diff với mock ≤ 10%.

## Files
- modify: `web/src/app/admin/page.tsx`, `web/src/app/admin/layout.tsx`, `web/src/app/admin/health/page.tsx`, `web/src/app/admin/audit/page.tsx`
- create: `web/src/components/admin/{kpi-card,token-usage-chart,health-list,ingestion-tiles,top-queries-table,top-templates-list,alerts-feed,range-tabs,auto-refresh}.tsx`
- add dep: `recharts`
