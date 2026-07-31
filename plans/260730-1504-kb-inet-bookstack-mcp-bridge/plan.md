---
name: kb-inet-bookstack-mcp-bridge
title: KB.inet ↔ OpenWebUI via bookstack-mcp (read-only bridge)
slug: kb-inet-bookstack-mcp-bridge
date: 2026-07-30
status: completed
owner: chuongdt@inet.vn
mode: --fast
blockedBy: []
blocks: []
relatedReports:
  - plans/reports/brainstorm-260730-1456-kb-inet-onemcp-integration.md (implicit — brainstorm hội thoại)
tags: [kb, bookstack, mcp, openwebui, integration, read-only]
---

## Mục tiêu

Tích hợp KB.inet (BookStack) vào OpenWebUI chat của phòng kỹ thuật thông qua
`ttpears/bookstack-mcp` (standalone container, read-only). LLM tự route giữa
OneMCP (artifacts / sự kiện team) và KB.inet (SOP, runbook chuẩn hoá).
Zero-copy dữ liệu. Không đụng OneMCP core code.

## Ràng buộc (non-negotiable)

- `BOOKSTACK_ENABLE_WRITE=false` ở prod (không bao giờ bật).
- Bot user BookStack = read-only, không thấy shelves nhạy cảm (HR, Financial, Credentials).
- Không copy KB content vào OneMCP DB / embeddings.
- Deploy = docker-compose service, cùng network `onelog-internal`.

## Phases

| # | Phase | File | Status |
|---|-------|------|--------|
| 1 | Prep BookStack (bot user + token + KB audit) | phase-01-bookstack-prep.md | ✅ done (2026-07-30) |
| 2 | Deploy bookstack-mcp container | phase-02-deploy-container.md | ✅ done (2026-07-30) |
| 3 | ~~Caddy route~~ (deferred) | phase-03-caddy-route.md | deferred |
| 4 | OpenWebUI wiring + routing prompt | phase-04-openwebui-routing.md | ✅ done (2026-07-30) |
| 5 | Verify + observability | phase-05-verify-observability.md | ✅ done (2026-07-31) — E2E verified |
| 6 | **eth1 route workaround** (unplanned) | see cook report | ✅ persisted (2026-07-31) |

**Plan status:** `completed` (2026-07-31 08:32)

## Dependencies

Phase 1 → 2 → 4 → 5. Phase 3 optional/deferred.

## Risks addressed (từ brainstorm — bắt buộc xử lý)

| Risk | Xử lý ở phase |
|---|---|
| LLM gọi cả 2 tool → tốn token | Phase 4: system prompt "chọn 1 nguồn, fallback nếu empty" |
| Conflict KB cũ vs OneMCP mới | Phase 4: prompt hint ưu tiên `updated_at` mới hơn |
| Ambiguous "cách chặn IP" | Phase 4: prompt trả 2 nhãn "Quy trình chuẩn (KB)" / "Đã áp dụng (OneMCP)" |
| User mất niềm tin khi 1 hệ down | Phase 4: LLM graceful fallback; Phase 5: onboard 1 slide |
| Tool bloat (20 tool bookstack-mcp) | Phase 4: system prompt whitelist 3 tool; Phase 5: metric để quyết proxy hay không |
| BookStack down | Phase 2: timeout config; Phase 4: prompt xử lý tool error |
| ACL leak | Phase 1: bot user exclude nhạy cảm |
| Rate limit | Phase 5: theo dõi, chỉ add cache nếu cần |

## Success criteria (tổng)

- OpenWebUI chat gọi được `bookstack__search_pages` + `bookstack__get_page` thành công.
- 5 test query mẫu (phase 5) trả kết quả đúng KB.
- Zero write operation từ bot (audit BookStack log).
- OneMCP DB size không tăng do KB integration.
- 2-week metrics đạt: ≥60% chat có tool KB được cite khi hỏi kỹ thuật.

## Non-goals

- Không semantic search (fallback hướng C brainstorm — làm sau nếu cần).
- Không proxy qua OneMCP (làm sau nếu tool bloat gây noise).
- Không auto-sync KB → OneMCP.
- Không edit KB từ chat (write disabled).
- **Không** register OneMCP artifacts search vào OpenWebUI chat (chưa có, scope plan riêng).
- **Không** expose bookstack-mcp qua Caddy edge (docker internal đủ cho MVP).

## Validation notes

Validation ngày 2026-07-30 (`reports/validate-260730-1513-plan-review.md`) phát hiện:
- OpenWebUI dùng native MCP qua file `mcp-config.json` (không phải UI) ✓
- OneMCP artifacts search chưa register → Phase 4 scope thu hẹp chỉ KB
- Phase 3 (Caddy) thừa cho MVP → deferred
- ACL exclusion không cần (KB kỹ thuật thuần)
- KB size unknown → audit ở Phase 1
- System prompt trong UI không version → backup vào `docs/`
