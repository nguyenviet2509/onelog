---
name: mcp-kb-incident-memory
title: mcp-kb — Incident Resolution Memory (MCP + Qdrant)
slug: mcp-kb-incident-memory
date: 2026-07-23
status: cancelled-2026-07-23
cancelReason: |
  Discovered existing OneMCP project (D:/Vietnt/Project/onemcp) that already solves this exact use case
  (bug-trace KB reuse via MCP). Building mcp-kb from scratch = duplicate infra (KB store, review UI,
  audit, backup, metrics) for the same team. Pivot to bridging OneMCP into OpenWebUI instead.
owner: trihd@inet.vn
mode: --auto
blockedBy: []
blocks: []
supersededBy: plans/260723-1200-onemcp-openwebui-bridge
supersedes:
  - plans/260716-1422-chat-conversations-kb-search
relatedReports:
  - plans/reports/brainstorm-260723-1135-mcp-kb-incident-memory.md
tags: [mcp, kb, qdrant, incident, llm-cost, openwebui]
---

# Plan: mcp-kb — Incident Resolution Memory

## Mục tiêu
Loại bỏ tình trạng mỗi member ops phải trace lại cùng lỗi log từ đầu. Sau khi 1 member fix xong 1 lỗi, resolution được lưu có cấu trúc; member khác gặp lỗi tương tự → LLM tự động search KB TRƯỚC → present cached solution nếu match. Tiết kiệm quota LLM + giảm MTTR.

## Bối cảnh
- Plan cũ `260716-1422-chat-conversations-kb-search` đã superseded (pivot sang OpenWebUI native Notes — manual, không đủ enforce). Plan này thay thế bằng approach MCP tool auto-enforced.
- Brainstorm chi tiết + trade-offs: [brainstorm-260723-1135-mcp-kb-incident-memory.md](../reports/brainstorm-260723-1135-mcp-kb-incident-memory.md)

## Architecture (tóm tắt)
```
OpenWebUI ─▶ mcpo ─▶ mcp-kb (FastMCP, port 9001) ─▶ Qdrant (collection: resolved_incidents)
                          │
                          └─▶ LiteLLM (summarizer, cheap model)
```

Tools MCP: `search_resolutions`, `save_resolution_draft`, `verify_resolution`, `mark_stale`.

Save mode: **Hybrid** — auto-draft cuối chat, human `/verify` mới thành fact.

## Phases

| # | Phase | Status | Effort | File |
|---|-------|--------|--------|------|
| 1 | Scaffold mcp-kb service + Qdrant collection + wire mcpo/Caddy | pending | 2-3 ngày | [phase-01-scaffold-mcp-kb-service.md](phase-01-scaffold-mcp-kb-service.md) |
| 2 | Tools: search_resolutions + save_resolution_draft + summarizer + redact | pending | 3-4 ngày | [phase-02-search-and-save-tools.md](phase-02-search-and-save-tools.md) |
| 3 | Tools: verify_resolution + mark_stale + curation UI + system prompt | pending | 2-3 ngày | [phase-03-verify-mark-stale-curation-ui.md](phase-03-verify-mark-stale-curation-ui.md) |
| 4 | Metrics + Grafana panel + seed data + stale cron + docs | pending | 2 ngày | [phase-04-metrics-seed-docs.md](phase-04-metrics-seed-docs.md) |

Tổng: 1-2 tuần.

## Key dependencies
- ✅ Qdrant, LiteLLM, mcpo, OpenWebUI, Caddy (đang chạy)
- ✅ FastMCP 3.x scaffold từ `mcp-semantic/` (copy pattern: main.py, auth.py, audit.py, embed.py, config.py)
- ✅ Redact patterns từ `agent/src/agent/redact.py`
- 🟡 Model summarizer: DeepSeek qua LiteLLM (đã default)

## Success metrics
- `kb_hit_rate` ≥ 30% sau 4 tuần
- LLM tokens/tháng giảm ≥ 20% trên câu hỏi lặp (đo qua Grafana LiteLLM)
- ≥ 10 verified entries trong tháng đầu
- MTTR lỗi lặp giảm ≥ 50% (self-report)

## Out of scope
- Full incident management (SLA, on-call, war-room)
- Auto-remediation (chạy fix_commands tự động)
- Multi-tenant RBAC
- Sidebar realtime suggest trong OpenWebUI chat (defer)

## Risks (top 3)
1. Cold-start rỗng → seed 5-10 entries thủ công (Phase 4)
2. LLM không tuân thủ "KB first" → system prompt cứng + tool description + smoke test (Phase 3)
3. Draft noise → confidence threshold + batch review UI (Phase 3)
