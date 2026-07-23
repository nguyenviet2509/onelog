---
name: chat-conversations-kb-search
title: Chat Conversations → Team KB (OpenWebUI integration)
slug: chat-conversations-kb-search
date: 2026-07-16
status: superseded-2026-07-17
supersededBy: plans/260723-1135-mcp-kb-incident-memory
owner: trihd@inet.vn
mode: --fast
pivotedAt: 2026-07-16T15:54:00+07:00
phase1CompletedAt: 2026-07-16T16:15:00+07:00
pivotReason: |
  Original brainstorm assumed custom Next.js web was primary chat UI.
  Reality: team uses OpenWebUI exclusively (port 8090). Custom web never deployed.
  Pivoted to OpenWebUI API integration — reuse ~60% of reverted Phase 1 code (lib modules,
  DB schema, redact, embedder, Qdrant, summarizer core). Drop chat-UI button+modal.
  See brainstorm-260716-1554-kb-openwebui-pivot.md.
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/brainstorm-260716-1422-chat-conversations-kb-search.md
  - plans/reports/brainstorm-260716-1554-kb-openwebui-pivot.md
relatedPlans:
  - plans/260701-1544-llm-provider-abstraction
  - plans/260622-1056-rag-logserver-victorialogs
tags: [kb, knowledge-share, openwebui, qdrant, llm]
history:
  - date: 2026-07-16T14:47+07:00
    action: "Phase 1 shipped (commit 7b20851) built for custom web"
  - date: 2026-07-16T15:54+07:00
    action: "Reverted (c8c843b) — pivoted to OpenWebUI Function + custom web review page"
  - date: 2026-07-17
    action: "SUPERSEDED — /web removed entirely; KB will use OpenWebUI native Notes + Workspace → Knowledge. No Postgres, no Function, no review page. Team saves useful chat messages via OpenWebUI's built-in note button, and admin uploads curated summaries to a shared Knowledge collection."
---

# Plan: Chat Conversations → Team KB (OpenWebUI)

## Mục tiêu

Cho member đang chat trace log trong **OpenWebUI** một action button "Mark Resolved" → LLM (DeepSeek) summarize chat → member review/edit draft trên `/kb/create` (custom web) → save vào Postgres + Qdrant. KB reusable qua semantic search (Phase 2 `/kb` browse tab).

## Vấn đề gốc

Xem [brainstorm-260716-1422-...](../reports/brainstorm-260716-1422-chat-conversations-kb-search.md).

## Pivot (2026-07-16 15:54)

Phase 1 gốc build sai data source — assume custom web chat, thực tế team dùng OpenWebUI. Pivot chi tiết: [brainstorm-260716-1554-kb-openwebui-pivot.md](../reports/brainstorm-260716-1554-kb-openwebui-pivot.md).

## Phases

| # | Phase | Status | Effort | File |
|---|-------|--------|--------|------|
| 1 | KB creation từ OpenWebUI (Function + summarize API + review page) | ✅ completed 2026-07-16 16:15 (build pass, review 8.5/10 APPROVED_WITH_MINOR — 5 major fixed) | ~1.5 tuần | [phase-01-kb-creation-from-openwebui.md](phase-01-kb-creation-from-openwebui.md) |
| 2 | `/kb` browse tab (search, filter, edit, upvote/verify) | pending | ~1 tuần | [phase-02-kb-browse-tab.md](phase-02-kb-browse-tab.md) |

## Deferred

- Sidebar auto-suggest realtime trong OpenWebUI chat
- Telegram alert append KB link
- Grafana tooltip
- Nightly auto-curate
- Entry versioning (chỉ `kb_edits` audit)

## Key dependencies

- ✅ OpenWebUI đang chạy (`ragstack-openwebui` port 8090, profile `chat`)
- ✅ Qdrant + embedder infra sẵn
- ✅ Redact patterns (`agent/src/agent/redact.py` — port sang TS)
- 🟡 Custom web (`web/`) — service commented out; Phase 1 sẽ enable ở docker-compose để expose `/api/kb/*` + `/kb/create`
- 🟡 LLM provider abstraction plan `260701-1544` — soft dep, hardcode DeepSeek trong Phase 1
- ❌ OpenWebUI Function `kb_mark_resolved.py` (build mới)
- ❌ Drizzle schema `kb_entries` (openwebui_chat_id VARCHAR), `kb_edits`, `kb_taxonomy`, `kb_drafts`

## Success metrics (post-MVP)

- Coverage: % OpenWebUI chats → KB entry ≥ 30%/tháng
- Reuse: % chat mới có ≥1 KB match >0.7 view ≥ 30%
- Quality: % entries verified hoặc upvotes≥3 ≥ 20%
- Time saved (self-report): median ≥15 min/case
