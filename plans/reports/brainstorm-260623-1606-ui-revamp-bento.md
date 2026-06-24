# Brainstorm · UI revamp (Bento Minimal)

**Date:** 2026-06-23 16:06 · **Branch:** master · **Selected mock:** `mockups/v2/02-bento-minimal.html`

## Problem
Web UI hiện tại (`web/src/app/`) đơn giản: chat 1 cột, admin chỉ Health (5 checks) + Audit list. Thiếu signal vận hành (cost, latency dist, top queries, ingestion, alerts) → user khó tự đánh giá hệ thống. UI cũ không tạo cảm giác sản phẩm "production-ready".

## Decision
- **Design language:** Bento Minimal (Linear/Vercel) — monochrome `#0a0a0b` + accent cyan, card 14px radius, border `#1f1f25`, font Geist/Inter, mono cho number.
- **Scope đợt 1:** Full revamp chat + admin trong 1 phase plan.
- **Data:** Real metrics tất cả — backend cần instrumentation mới.

## Approaches considered
| # | Style | Pros | Cons | Verdict |
|---|-------|------|------|---------|
| 01 | Aurora Glass | đẹp, premium | gradient/blur tốn render, glassmorphism phai trào lưu | rejected |
| **02** | **Bento Minimal** | data-dense, dễ scan, ít distraction, hợp dev tool | thiếu "wow" lúc nhìn lần đầu | **chosen** |
| 03 | Cyber Terminal | bản sắc, hợp log tool | mono toàn bộ kém với khách enterprise; chart ASCII hạn chế | rejected |
| 04 | Neo-Brutalist | khác biệt | bold quá → mệt mắt khi dùng dài; khó pair với data heavy | rejected |
| 05 | Editorial Pro | sang | serif headlines kém realtime feel, nhiều whitespace phí | rejected |

## Architecture
### Frontend (Next.js app router, đã có)
```
web/src/
├── components/
│   ├── chat/                  (đã có — refactor header, thêm context panel)
│   ├── ui/                    (mới: card, chip, bar, spark, donut, sidebar)
│   └── admin/                 (mới: kpi-card, line-chart, donut, table, alerts-feed)
├── app/
│   ├── globals.css            (cập nhật tokens: bg/card/line/mut/acc)
│   ├── chat/[id]/page.tsx     (sidebar + context panel)
│   └── admin/
│       ├── page.tsx           (dashboard tổng — KPIs + charts)
│       ├── health/page.tsx    (đã có — restyle)
│       └── audit/page.tsx     (đã có — restyle)
```

### Backend (new endpoints)
| Endpoint | Source | Purpose |
|---|---|---|
| `GET /api/admin/metrics/overview?range=7d` | postgres aggregations | KPI: conversations, tokens, cost, p50/p95, errors |
| `GET /api/admin/metrics/usage?range=7d&groupBy=model` | LLM call log | Token usage chart by model |
| `GET /api/admin/metrics/top-queries?range=7d` | conversations table | Top N queries · runs · p95 · cost |
| `GET /api/admin/metrics/ingestion` | indexer Prom/internal | events/s, templates, embed cache, lag |
| `GET /api/admin/alerts?status=open` | rules engine / table | Recent alerts feed |
| `GET /api/admin/templates/top` | log-template store | Top exploding templates |

### Data instrumentation
- **LLM call log** (table `llm_calls`): conversation_id, model, prompt_tokens, completion_tokens, latency_ms, ts, cost_usd. Hook tại `web/src/app/api/chat/route.ts`.
- **Tool call log** (table `tool_calls`): conversation_id, tool_name, latency_ms, ok, ts.
- **Cost calc**: lookup table `model_pricing` (per-1k input/output).
- **Ingestion metrics**: scrape từ indexer service (đã chạy) — hoặc thêm `/internal/metrics` JSON.

## Risks
- **Backend instrumentation 1 lần touch nhiều layer** → split commits theo từng metric, đừng đẩy 1 cục.
- **Cost calc drift** khi đổi model pricing → table có `effective_from`.
- **Auto-refresh 10s × 5 endpoints** = spam DB → gộp `overview` endpoint trả nhiều metric; cache 30s ở Next route handler.
- **Recharts vs custom SVG**: chọn `recharts` cho line/donut (tree-shakeable, ~30KB), giữ inline SVG cho sparkline.

## Success criteria
- [ ] `web/` build pass, không thêm dependency thừa (chỉ `recharts`).
- [ ] Chat page: sidebar grouped, header với model+tokens+cost, context panel phải.
- [ ] Admin overview: 4 KPI + token chart + service health + top queries + ingestion + alerts — load < 800ms p95.
- [ ] 6 endpoint mới có test integration (vitest + test DB).
- [ ] Visual parity ≥ 90% với `02-bento-minimal.html`.

## Open questions
- Auth/role cho admin endpoint? (hiện admin layout không gate) — assume internal trust, sẽ confirm khi plan.
- Cost pricing nguồn từ đâu? hardcode theo Anthropic public, hay env config?
- Alert engine có sẵn chưa, hay phải build skeleton?
