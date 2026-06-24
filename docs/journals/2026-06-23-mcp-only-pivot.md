---
date: 2026-06-23
title: Pivot sang MCP-only, deprecate Web UI
tags: [decision, mcp, claude-team, deprecate-web, architecture]
---

# 2026-06-23 — Pivot sang MCP-only, deprecate Web UI

## Tóm tắt
Sau brainstorm sâu về channel chiến lược cho onelog (audience = 5 ops nội bộ, đã có Claude Team subscription), quyết định **deprecate Web UI + agent service**, chỉ giữ **MCP-only** (mcp-vl official + mcp-semantic custom) + VMUI link cho raw log.

## Bối cảnh đến quyết định
Bắt đầu từ câu hỏi "cài MCP Claude Desktop để test thực tế" → dẫn tới chuỗi câu hỏi sâu hơn:
1. MCP có tác dụng gì production?
2. Khi đã có Web UI thì MCP còn cần không?
3. Web UI vẫn phải call API Claude (server-side) → cost trùng lặp khi đã trả Claude Team subscription
4. Cụ thể 5 ops + Claude Team → có nên chỉ MCP, bỏ Web UI?
5. Member 2 không thấy lịch sử chat member 1 → fix bằng Claude Team Projects

→ Conclude: với 5 ops dev + Claude Team Projects, Web UI là **tech debt thuần**.

## Quyết định chính
| | Trước | Sau |
|---|---|---|
| Channel primary | Web UI (`/chat`) | MCP từ Claude Desktop |
| Channel fallback | — | VMUI link raw log |
| LLM cost | Server pay Anthropic API per-token | $0 (Claude Team subscription đã trả) |
| Knowledge sharing | Web UI conversation list | Claude Team Project `onelog-investigations` |
| Service maintain | web + agent + indexer + qdrant + VL + MCP | indexer + qdrant + VL + MCP (-2 service) |
| Code maintain | + Next.js 3K LOC + FastAPI agent | MCP Python ~200 LOC |

## Misconception đã fix
- **Sai:** "Claude Team = 1 account chia 5 người"
- **Đúng:** Claude.ai Team = 5 seat riêng + workspace Projects để share conversation. Share credentials = ToS violation.

## Option C đã loại
Web UI + OAuth Claude Team (user thắc mắc có thể "auth Claude Team vào Web") — **không khả thi**. Anthropic phân biệt billing consumer (Pro/Team qua claude.ai) vs API platform — không expose OAuth subscription cho 3rd party app.

## Plan housekeeping
Cancel 2 plan pending vì supersededBy:
- `260623-1606-ui-revamp-bento-minimal` — revamp Web UI Bento (moot vì deprecate Web)
- `260623-1617-production-rollout` — Web UI + SSO OIDC + API key thật (sai audience model)

Tạo plan mới: `260623-2041-mcp-only-rollout/` với 2 phase:
- Phase 01: MCP production-ready (mcp-vl image, Bearer multi-token, audit, VMUI URL) — 2d
- Phase 02: Onboard 5 ops + deprecate web/agent — 1.5d

## Blocking gate
Phase 02 step 1 = **verify subscription** Claude.ai Team (có Projects) vs Claude Code CLI Team (không Projects). 3 fallback path sẵn nếu sai.

## Artifacts
- Brainstorm: [plans/reports/brainstorm-260623-1644-ops-mcp-only-decision.md](../../plans/reports/brainstorm-260623-1644-ops-mcp-only-decision.md)
- Plan mới: [plans/260623-2041-mcp-only-rollout/](../../plans/260623-2041-mcp-only-rollout/)
- 2 plan cancelled với supersededBy frontmatter trỏ về plan mới

## Reflection
- Brainstorm sâu trước implementation cứu được ~1-2 tuần code Web UI revamp + production rollout sai audience
- Câu hỏi user về knowledge sharing là critical thinking tốt — nếu skip thì sẽ deploy MCP-only mà thiếu Project setup → fail use case lớn nhất
- Brutal honesty về "Claude Team = subscription chia chứ không phải 1 account share" tránh user vi phạm ToS

## Open questions follow-up
- Confirm subscription chính xác (Claude.ai Team vs Claude Code Team) — block Phase 02
- MCP config có per-Project hay vẫn per-machine — verify thực tế khi onboard
- Audit retention policy — chốt với compliance internal
