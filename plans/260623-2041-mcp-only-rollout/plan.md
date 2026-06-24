---
name: mcp-only-rollout
status: pending
created: 2026-06-23
updated: 2026-06-23
owner: trihd@inet.vn
blockedBy: []
blocks: [plans/260624-1417-observability-integration]
supersedes:
  - plans/260623-1606-ui-revamp-bento-minimal
  - plans/260623-1617-production-rollout
relatedReports:
  - plans/reports/brainstorm-260623-1644-ops-mcp-only-decision.md
relatedPlans:
  - plans/260622-1056-rag-logserver-victorialogs
---

# Plan: MCP-only rollout cho 5 ops + deprecate Web UI

## Mục tiêu
Chuyển channel chính của onelog sang **MCP-only** (Claude Desktop + mcp-vl + mcp-semantic + Claude Team Projects). Decommission Web UI + agent service. Tận dụng Claude Team subscription đã có thay vì pay Anthropic API server-side.

## Context
- Brainstorm decision: [brainstorm-260623-1644-ops-mcp-only-decision](../reports/brainstorm-260623-1644-ops-mcp-only-decision.md)
- Audience: 5 ops engineer nội bộ, đã có Claude Team subscription
- Replaces 2 plan cancelled: `ui-revamp-bento-minimal`, `production-rollout`
- Base MVP: [260622-1056-rag-logserver-victorialogs](../260622-1056-rag-logserver-victorialogs/plan.md) — VL + Vector + indexer + Qdrant + mcp-semantic MVP đã scaffolded
- Knowledge sharing: Claude Team **Projects** (1 Project `onelog-investigations`, 5 member share conversation)

## Phases

| # | Phase | Status | File |
|---|---|---|---|
| 01 | MCP production-ready (image, compose, Caddy, auth, audit, URL format) | **DONE** (smoke 6/6 pass on logserver-01, 2026-06-24) | [phase-01-mcp-production-ready.md](phase-01-mcp-production-ready.md) |
| 02 | Onboard ops + deprecate Web/agent (giữ branch `legacy-web`) | **in_progress ~70%** (bonus fixes done, docs ready, subscription verified) | [phase-02-onboard-and-deprecate-web.md](phase-02-onboard-and-deprecate-web.md) |
| 03 | **Review checkpoint** 1-2 tháng — quyết định resurrect Web UI hay giữ MCP-only | scheduled | [phase-03-review-checkpoint.md](phase-03-review-checkpoint.md) |

## Key dependencies
- Claude.ai Team subscription (5 seats, có Projects) — **MUST verify** trước Phase 02
- mcp-victorialogs source repo (Go) build được local
- Caddy + VPN/IP whitelist hiện có cho `/mcp/*` route
- VictoriaLogs + Qdrant + indexer pipeline (đã có từ MVP)

## Success criteria (toàn plan)
- [ ] 5 ops dùng MCP từ Claude Desktop, smoke test pass
- [ ] Project `onelog-investigations` có ≥10 conversation sau 2 tuần
- [ ] Web + agent containers stopped, `ANTHROPIC_API_KEY` server-side removed
- [ ] Audit log MCP capture đủ 5 user identity
- [ ] Branch `legacy-web` checkpoint trước decommission để rollback nếu cần

## Risks (top 3)
- Claude Team là Claude Code CLI (không có Projects) → knowledge share fail → must verify Phase 02 step 1
- mcp-vl image build fail → fallback dùng mcp-semantic only tạm thời
- Member quên dùng Project → fix bằng onboarding emphasize + audit weekly

## Hybrid safety net (đã chốt)
- **KHÔNG xóa code** `web/` `agent/` ngay — chỉ **comment block** trong compose, code folder stay trên master
- Branch `legacy-web` checkpoint từ master trước khi modify compose → snapshot state runnable cuối cùng
- **KEEP Postgres schema** (users/conversations/messages/audit_log) tối thiểu **6 tháng** — data lịch sử không drop
- **Resurrect drill** ngay sau Phase 02 (Step 5b) — verify branch thật sự bootable, pin lockfile, document trong `RESURRECT-NOTES.md`
- Re-evaluate sau 1-2 tháng (Phase 03) với signals cụ thể
- **Time-to-resurrect realistic:**
  - Code chạy (mock LLM): <30 phút checkout + uncomment compose
  - Smoke với LLM thật: +30 phút set API key
  - Production-ready (LLM provider lựa + cost cap + monitoring + coexist MCP): **2-4 ngày-người** (xem phase-03 sub-phase A/B/C)

## Open questions
- Subscription = Claude.ai Team hay Claude Code Team? (impact Projects)
- MCP config có per-Project hay per-machine? (verify thực tế)
- Audit retention bao lâu? (compliance internal)
- Sau 6 tháng nếu vẫn MCP-only → có nên xóa hẳn `legacy-web` branch + folder code? (sunk cost vs cleanliness)
