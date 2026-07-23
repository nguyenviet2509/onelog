# Phase 3 — verify_resolution + mark_stale + curation UI + OpenWebUI wiring

## Context
Phase 2 đã có save + search. Giờ cần human-in-the-loop (verify), stale handling, UI tối thiểu, và ép LLM thực sự dùng KB.

## Priority
High — mà không có verify + system prompt thì search luôn miss verified → KB vô dụng.

## Requirements

### Functional
- `verify_resolution(id, verified_by)` → set `verified=true, verified_at=now, verified_by=email`. Idempotent.
- `mark_stale(id, reason, marked_by)` → set `stale=true, stale_reason, stale_at`. Unstale = call `verify_resolution` lại (reset stale).
- Curation UI: static HTML page `mockups/onelog-kb-curation.html` served qua Caddy `/kb/*`:
  - Section "Drafts" (verified=false): list latest 20, buttons Verify | Mark Stale
  - Section "Verified" (verified=true, stale=false): list top 20 by hit_count
  - Section "Stale": list, button Re-verify
  - Client-side JS gọi thẳng mcp-kb qua REST wrapper endpoints (không qua mcpo — mcpo là JSON-RPC MCP, không tiện cho browser)
- REST wrappers cho UI: `GET /kb/drafts`, `GET /kb/verified`, `GET /kb/stale`, `POST /kb/verify/{id}`, `POST /kb/stale/{id}` — mount qua `@mcp.custom_route` trong main.py
- OpenWebUI system prompt cập nhật (Admin → Settings → Interface → Default Prompt hoặc per-model override):
  ```
  Bạn là trợ lý ops log OneLog. LUẬT CỨNG:
  1. Trước MỌI câu hỏi về lỗi/log/incident, BẮT BUỘC gọi tool `search_resolutions` TRƯỚC TIÊN.
  2. Nếu có kết quả verified score ≥ 0.85, trình bày resolution cũ + hỏi user "Còn đúng không? Yes/No".
  3. Nếu user Yes → dừng, không gọi tool khác.
  4. Nếu user No, kết quả unverified, hoặc miss → chạy full flow (mcp-vl query LogsQL, mcp-semantic search templates, phân tích).
  5. Khi user báo đã fix xong, gọi `save_resolution_draft` với question ngắn gọn + resolution + fix_commands (nếu có) + verify_logsql.
  6. KHÔNG bịa tool name. KHÔNG skip bước 1.
  ```

### Non-functional
- Curation UI page load < 1s
- Verify action ack < 300ms

## Files to modify
- `mcp-kb/src/mcp_kb/main.py` — thêm 2 MCP tools + 5 custom_route REST endpoints
- `mcp-kb/src/mcp_kb/qdrant_store.py` — thêm `list_by_filter(filter, order_by, limit)`
- `infra/caddy/Caddyfile` — route `/kb/*` → mcp-kb:9001 (không auth, hoặc basic auth tối thiểu — quyết trong step 3)
- `infra/openwebui/system-prompt-ops.md` (new) — prompt template, checked-in để dễ update

## Files to create
- `mockups/onelog-kb-curation.html` — 1 file HTML self-contained (Tailwind CDN + fetch API)
- `infra/openwebui/system-prompt-ops.md` — nội dung prompt

## Implementation steps
1. `qdrant_store.list_by_filter`: wrap Qdrant `scroll` với filter + payload sort client-side (Qdrant scroll không hỗ trợ order_by natively → fetch N*2 rồi sort)
2. Tools MCP:
   - `verify_resolution(id, verified_by)` — `update_payload({verified: true, verified_at: now, verified_by, stale: false, stale_reason: None})`
   - `mark_stale(id, reason, marked_by)` — `update_payload({stale: true, stale_reason, stale_at: now, stale_by: marked_by})`
3. REST wrapper endpoints (`@mcp.custom_route`, method GET/POST):
   - Auth: check header `X-KB-Curator-Token` (env `KB_CURATOR_TOKEN`) — team-wide shared token, đủ cho MVP nội bộ
4. Curation UI `mockups/onelog-kb-curation.html`:
   - Header input "Curator token" → localStorage
   - 3 tab: Drafts / Verified / Stale
   - Table: question | resolution (truncated + expand) | resolved_by | resolved_at | hit_count | actions
   - Confirmation dialog trước khi verify/stale
5. Caddy route:
   ```
   handle_path /kb/* {
     reverse_proxy mcp-kb:9001
   }
   handle /kb {
     # serve mockups/onelog-kb-curation.html
     root * /srv/mockups
     rewrite * /onelog-kb-curation.html
     file_server
   }
   ```
   (Điều chỉnh theo cấu trúc Caddyfile hiện tại — check existing static mount)
6. System prompt: viết `infra/openwebui/system-prompt-ops.md`, hướng dẫn admin paste vào OpenWebUI Admin UI. **KHÔNG auto-inject** (OpenWebUI không có API cho prompt update stable).
7. Smoke test end-to-end:
   - Save draft → GET /kb/drafts thấy entry
   - POST /kb/verify/{id} → GET /kb/verified thấy entry
   - Trong OpenWebUI chat: hỏi cùng câu → LLM gọi search_resolutions → trả cached
   - Hỏi câu unrelated → LLM chạy full flow

## Todo
- [ ] qdrant_store.list_by_filter
- [ ] Tool verify_resolution + mark_stale
- [ ] 5 REST wrapper endpoints + curator token auth
- [ ] Curation HTML page
- [ ] Caddy route /kb + static file mount
- [ ] system-prompt-ops.md checked in
- [ ] Manual: admin paste system prompt vào OpenWebUI (config task, ghi vào runbook)
- [ ] End-to-end smoke test trong OpenWebUI

## Success criteria
- UI `http://app.local/kb` load, hiển thị 3 tab
- Verify/stale action reflect trong Qdrant payload trong ≤ 1s
- Trong OpenWebUI: hỏi cùng câu 2 lần → lần 2 LLM present cached resolution, không gọi mcp-vl (verify qua audit log)
- Hỏi câu mới → LLM vẫn call full flow bình thường

## Risks
- **LLM không tuân thủ system prompt** (skip search_resolutions): mitigate — thêm prompt example few-shot; monitor tool call order qua audit log Phase 4; nếu > 20% miss thì escalate lên tool_choice="required"
- **Curator token leak**: mitigate — rotate qua env, chỉ trong LAN qua Caddy CIDR gate hiện có
- **Concurrent verify race**: idempotent update, không lock cần thiết
- **Caddy route conflict với existing `/kb` (nếu có)**: grep trước

## Security
- Curator token env-injected, không log
- REST endpoints CHỈ mở qua Caddy trong CIDR whitelist (đã có)
- Verify/stale actions ghi vào audit log với email actor

## Next
Phase 4: metrics + Grafana + seed data + stale cron + docs.
