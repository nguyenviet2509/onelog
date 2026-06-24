---
name: ui-revamp-bento-minimal
status: cancelled
cancelledAt: 2026-06-23
cancelReason: Web UI deprecate theo quyết định MCP-only (xem plans/reports/brainstorm-260623-1644-ops-mcp-only-decision.md). 5 ops + Claude Team Projects thay Web UI hoàn toàn.
created: 2026-06-23
updated: 2026-06-23
owner: trihd@inet.vn
blockedBy: []
blocks: []
supersededBy: plans/260623-2041-mcp-only-rollout
relatedReports:
  - plans/reports/brainstorm-260623-1606-ui-revamp-bento.md
  - plans/reports/brainstorm-260623-1644-ops-mcp-only-decision.md
relatedPlans:
  - plans/260622-1056-rag-logserver-victorialogs
mockReference: mockups/v2/02-bento-minimal.html
---

# Plan: UI Revamp — Bento Minimal (chat + admin)

## Mục tiêu
Refresh web UI lên design language **Bento Minimal** (Linear/Vercel style) cho cả chat và admin. Bổ sung real metrics: token/cost, latency p50/p95, top queries, ingestion, alerts. Mock chốt: [02-bento-minimal](../../mockups/v2/02-bento-minimal.html).

## Context
- Brainstorm: [brainstorm-260623-1606-ui-revamp-bento](../reports/brainstorm-260623-1606-ui-revamp-bento.md)
- Stack: Next.js 14 app router, Drizzle + Postgres, Tailwind 3.4. Đã có `web/src/db/schema.ts` với `users/conversations/messages/audit_log`.
- Mock visual reference: `mockups/v2/02-bento-minimal.html`
- Defaults đã chốt: admin no auth gate (IP allowlist note ở docs), pricing env-config seed từ Anthropic public, alert engine skeleton tối thiểu.

## Phases

| # | Phase | Status |
|---|---|---|
| 01 | [Design tokens + UI primitives](phase-01-design-tokens-and-primitives.md) | pending |
| 02 | [Backend instrumentation (DB + cost calc)](phase-02-backend-instrumentation.md) | pending |
| 03 | [Admin metrics API endpoints](phase-03-admin-metrics-api.md) | pending |
| 04 | [Chat page revamp](phase-04-chat-page-revamp.md) | pending |
| 05 | [Admin dashboard implementation](phase-05-admin-dashboard.md) | pending |
| 06 | [Alert engine skeleton](phase-06-alert-engine-skeleton.md) | pending |
| 07 | [Polish, tests, docs](phase-07-polish-tests-docs.md) | pending |

## Dependencies
- `recharts` (~30KB, line+donut charts). Single new dep.
- No infra change. Reuses Postgres + existing chat API.

## Success Criteria
- [ ] `npm run build` pass, no new deps khác ngoài recharts.
- [ ] Visual parity ≥ 90% với mock 02 (chat + admin).
- [ ] 6 admin endpoints trả real data, p95 < 800ms.
- [ ] Auto-refresh gộp via single `/api/admin/metrics/overview` (anti-spam DB).
- [ ] Existing chat function không regress (citations, tool calls render OK).
