---
name: bookstack-function-wrapper
title: Replace bookstack mcpo route with Python Function wrapper
slug: bookstack-function-wrapper
date: 2026-07-31
status: pending
owner: chuongdt@inet.vn
mode: --fast
supersedes:
  - plans/260730-1504-kb-inet-bookstack-mcp-bridge (bookstack via mcpo)
tags: [openwebui, function, bookstack, kb, tool-description, hallucination-fix]
---

## Mục tiêu

Fix root cause của "LLM tự chế keyword" bằng cách chuyển KB.inet integration từ **raw mcpo route** sang **Python Function wrapper** với docstring chi tiết bằng tiếng Việt.

## Vì sao

Từ vụ "KB có gì mới tuần này" (2026-07-31 08:35):
- LLM có tool đúng nhưng description nghèo → không truyền `days=7` → default 30 → misread response → fabricate keyword "mới nhất 2025 2026"
- Fix ở system prompt (Rule 7b) = band-aid. Prompt sẽ phình nếu cover mọi case.
- Fix ở **tool description** = root cause. Docstring Python = tool description LLM đọc.

## Scope

3 tool whitelist (search_pages, get_page, get_recent_changes) → 3 Python method với docstring rich Vietnamese examples.

Bypass mcpo cho bookstack — Function gọi thẳng `https://kb.inet.vn/api/*` (đã có eth1 route). Cắt 1 layer failure.

## Non-goals

- Không expose 17 tool còn lại của bookstack-mcp (YAGNI, whitelist đã đủ)
- Không port stdio transport
- Không semantic search

## Phases (1 phase, fast mode)

### Phase 1 — Implement + wire (2h)

1. Write `infra/openwebui/functions/bookstack-tools.py` (~150 LOC, template từ onemcp-tools.py)
   - Class `Tools` với Valves (KB_INET_URL, TOKEN_ID, TOKEN_SECRET, TIMEOUT)
   - 3 method async: `bookstack_search_pages`, `bookstack_get_page`, `bookstack_get_recent_changes`
   - Docstring chi tiết mỗi method: khi nào dùng, param VN examples, response format
   - httpx call thẳng kb.inet.vn (auth Token ID:SECRET)

2. Register OpenWebUI Admin → Functions → Import (user manual)
3. Set Function Valves (URL + token) — copy từ .env
4. Test 3 smoke query (bao gồm câu "tuần này" đã fail)
5. Cleanup:
   - Xoá bookstack upstream khỏi `infra/mcpo/config.template.json`
   - Xoá service `bookstack-mcp` khỏi `docker-compose.yml`
   - Xoá bookstack entry khỏi OpenWebUI Admin → Tools connections
   - Update `docs/openwebui-kb-routing.md` với wiring mới + anti-fab rule
6. Add anti-fabrication rule vào system prompt (single line)

## Anti-fabrication rule (Hướng 2)

Rule single-line thêm vào system prompt cuối:

```
Nếu tool trả 0 results HOẶC bạn không hiểu response format → nói với user "không tìm thấy". TUYỆT ĐỐI KHÔNG tự chế keyword khác để retry. KHÔNG rewrite câu user với năm/số cụ thể trừ khi user nói.
```

## Success criteria

- [ ] Function loaded trong OpenWebUI, 3 tool visible với tên `bookstack_search_pages`, `bookstack_get_page`, `bookstack_get_recent_changes`
- [ ] Câu "KB có gì mới tuần này" → LLM call `bookstack_get_recent_changes(days=7)` — không rewrite keyword
- [ ] Câu "Cách khắc phục Redis OOM cPanel" → `bookstack_search_pages` cite kb.inet.vn/...
- [ ] bookstack-mcp container removed, mcpo config cleaned
- [ ] System prompt gọn lại (xoá Rule 7b — user đã làm, thêm anti-fab rule cuối)

## Risks

- Function file lỗi Python → OpenWebUI Function không load. **Mitigate**: test load ngay sau import.
- Token trong Function Valve dễ leak nếu dev copy Valve config ra. **Mitigate**: Function Valve chỉ visible cho Admin.
- LLM vẫn hallucinate cho case ngoài docstring cover. **Mitigate**: log + refine docstring iteratively (Hướng 5 defer).
