---
name: chat-conversations-kb-search
title: Chat Conversations → Team KB (searchable, classified)
slug: chat-conversations-kb-search
date: 2026-07-16
status: phase-1-completed
owner: trihd@inet.vn
mode: --fast
phase1CompletedAt: 2026-07-16T14:47:00+07:00
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/brainstorm-260716-1422-chat-conversations-kb-search.md
  - plans/260716-1422-chat-conversations-kb-search/reports/code-reviewer-260716-1447-phase01-kb-creation.md
relatedPlans:
  - plans/260701-1544-llm-provider-abstraction  # LLM cho summarize (soft dep, hardcode DeepSeek trong Phase 1)
  - plans/260622-1056-rag-logserver-victorialogs  # base infra: web UI chat + Postgres schema
tags: [kb, knowledge-share, chat, qdrant, llm]
---

# Plan: Chat Conversations → Team KB

## Mục tiêu

Biến chat conversations trace log của member trong OneLog webui thành KB searchable + classified (phòng ban / chủ đề / issue), để member sau gặp incident tương tự có sẵn tài liệu resolved — không phải trace lại.

## Vấn đề & Bối cảnh

- Chat DB Postgres đã lưu đầy đủ nhưng bị bỏ phí.
- Journals `docs/journals/` share được nhưng manual, thấp volume.
- Claude Code JSONL transcripts local-per-user, không share team.

→ Chỉ Postgres conversations đủ volume + auto-captured để làm KB base. Xem [brainstorm report](../reports/brainstorm-260716-1422-chat-conversations-kb-search.md).

## Phases

| # | Phase | Status | Effort | File |
|---|-------|--------|--------|------|
| 1 | KB creation từ chat ("Mark Resolved" + LLM summarize + Qdrant embed) | ✅ completed 2026-07-16 (build pass, code-review 8/10 APPROVED_WITH_MINOR, smoke test pending user) | ~1 tuần | [phase-01-kb-creation-from-chat.md](phase-01-kb-creation-from-chat.md) |
| 2 | `/kb` browse tab (search, filter dept/topic/issue, edit) | pending | ~1 tuần | [phase-02-kb-browse-tab.md](phase-02-kb-browse-tab.md) |

## Deferred (không trong MVP)

- Sidebar auto-suggest realtime trong chat
- Telegram alert append KB link
- Grafana tooltip
- Nightly auto-curate conversations idle >24h
- Entry versioning (chỉ giữ audit trail edits qua `kb_edits`)

## Key dependencies

- ✅ Postgres `conversations` + `messages.parts` — [web/src/db/schema.ts:19-34](../../web/src/db/schema.ts#L19-L34)
- ✅ Qdrant + embedder — [mcp-semantic/](../../mcp-semantic/), [indexer/](../../indexer/)
- ✅ Redact PII — [agent/src/agent/redact.py](../../agent/src/agent/redact.py)
- 🟡 LLM provider abstraction — plan [260701-1544-llm-provider-abstraction](../260701-1544-llm-provider-abstraction/plan.md) pending; nếu chưa ship khi Phase 1 start → hardcode 1 provider (DeepSeek hoặc Haiku) làm fallback
- ❌ Next.js `/kb` route + components (build mới trong Phase 2)
- ❌ Drizzle migration `kb_entries`, `kb_edits`, `kb_taxonomy`

## Success metrics (post-MVP, sau 1 tháng)

- Coverage: % conversations → KB entry ≥ 30%
- Reuse: % chat mới có ≥1 KB match >0.7 và được view ≥ 30%
- Quality: % entries verified/upvoted ≥3 ≥ 20%
- Time saved (self-reported): median ≥ 15 min/case
