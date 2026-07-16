# Phase 01 — KB Creation từ OpenWebUI

## Context Links

- Brainstorm gốc: [../reports/brainstorm-260716-1422-chat-conversations-kb-search.md](../reports/brainstorm-260716-1422-chat-conversations-kb-search.md)
- Brainstorm pivot: [../reports/brainstorm-260716-1554-kb-openwebui-pivot.md](../reports/brainstorm-260716-1554-kb-openwebui-pivot.md)
- Plan overview: [plan.md](plan.md)

## Overview

- **Priority:** High
- **Status:** pending
- **Effort:** ~1.5 tuần
- **Mục tiêu:** Member click action "Mark Resolved" trong OpenWebUI message toolbar → OpenWebUI Function call custom web `/api/kb/summarize` → verify ownership via OpenWebUI API + fetch chat + LLM summarize + taxonomy snap → return draft URL → member review/edit tại `/kb/create` → save Postgres + Qdrant.

## Key Insights

- OpenWebUI hỗ trợ **Action** type Function (Python plugin) — button trong message toolbar, có access `__user__` + request headers (JWT).
- Verify ownership: pass-through JWT → web gọi `GET http://openwebui:8080/api/v1/chats/{id}` với JWT đó. Nếu 200 → owner.
- Chat ID OpenWebUI là string (UUID-like), khác Postgres UUID native của Phase 1 gốc → schema `kb_entries.openwebui_chat_id VARCHAR(64)`.
- Draft handoff giữa summarize → review page: dùng bảng `kb_drafts` với TTL 30 phút (SQL cron delete expired).
- **Reuse ~60% code Phase 1 gốc** (đã revert): redact, summarizer core, embed-client, qdrant-client, dedup, taxonomy-snap, schema pattern.

## Requirements

**Functional:**
- OpenWebUI Function `kb_mark_resolved` load-able trong OpenWebUI Admin → Functions
- API `POST /api/kb/summarize` — verify OpenWebUI ownership + fetch chat + summarize → save vào `kb_drafts` → return draftId
- Page `/kb/create?draft=<draftId>` — review form editable, save button
- API `POST /api/kb/entries` — verify draft ownership → redact → embed → dedup → save entry
- Taxonomy snap (unchanged from reverted design)
- Semantic dedup >0.9 (unchanged)
- Redact PII trước embed + DB (unchanged)

**Non-functional:**
- Summarize <15s (bao gồm OpenWebUI API fetch + LLM call)
- Draft TTL 30 phút
- Rate limit summarize: 20/user/day

## Architecture

```
[OpenWebUI :8090 — user chats]
  ↓ click action button "Mark Resolved" trong message toolbar
[OpenWebUI Function `kb_mark_resolved`]
  ↓ POST http://web:3000/api/kb/summarize
  ↓ Authorization: Bearer <user_jwt>, X-Openwebui-Chat-Id: <chat_id>
[Next.js /api/kb/summarize]
  ↓ verify: GET http://openwebui:8080/api/v1/chats/{id} với JWT
  ↓ fetch messages từ OpenWebUI API
  ↓ LLM summarize (DeepSeek grounded on messages + tool responses)
  ↓ taxonomy snap topic/issue_type
  ↓ INSERT kb_drafts (openwebui_chat_id, openwebui_user_id, draft_json, expires_at)
  ↓ return { draftId, reviewUrl }
[OpenWebUI Function returns markdown response]
  ↓ message: "✓ Draft ready. [Review + save](http://web:3000/kb/create?draft=xxx)"

[Member clicks link → /kb/create?draft=xxx]
  ↓ page verify draft belongs to current OpenWebUI user (session check qua OpenWebUI /api/v1/auths)
  ↓ render form với draft fields editable
  ↓ submit → POST /api/kb/entries { draftId, editedFields, force? }
[Next.js /api/kb/entries]
  ↓ SELECT draft, verify user + not expired
  ↓ redact PII → embed → dedup check
  ↓ if dedupHits >0.9 && !force → return { dedupHits }
  ↓ else: INSERT kb_entries + Qdrant upsert + increment usage_count
  ↓ DELETE draft
  ↓ return { id }
```

## Related Code Files

**Create:**
- `web/src/lib/kb/redact.ts` — port 6 regex từ agent/redact.py
- `web/src/lib/kb/embed-client.ts` — OpenAI-compat embed + mock
- `web/src/lib/kb/qdrant-client.ts` — Qdrant REST wrapper
- `web/src/lib/kb/dedup.ts` — top-3 cosine check
- `web/src/lib/kb/summarizer.ts` — DeepSeek call, zod validate, retry, mock
- `web/src/lib/kb/summarizer-prompt.ts` — system prompt + evidence extractor (input là OpenWebUI messages structure)
- `web/src/lib/kb/taxonomy-snap.ts` — Levenshtein + embed cosine ≥0.85
- `web/src/lib/kb/openwebui-client.ts` — fetch chat, verify ownership, list-chats (backfill), session check
- `web/src/lib/kb/draft-store.ts` — CRUD kb_drafts (create/get/delete + expire cleanup)
- `web/src/app/api/kb/summarize/route.ts` — POST endpoint
- `web/src/app/api/kb/entries/route.ts` — POST endpoint
- `web/src/app/kb/create/page.tsx` — server component load draft + render form
- `web/src/app/kb/create/kb-draft-form.tsx` — client form + submit + dedup dialog
- `web/scripts/kb-backfill.ts` — fetch OpenWebUI chats API paginated → summarize + insert
- `infra/openwebui/functions/kb_mark_resolved.py` — OpenWebUI Function (Action type)
- `web/.env.example` — new env vars

**Modify:**
- `web/src/db/schema.ts` — thêm kbEntries (openwebui_chat_id VARCHAR, created_by VARCHAR), kbEdits, kbTaxonomy, kbDrafts
- `web/src/db/bootstrap.ts` — extend DDL với 4 bảng mới + indexes + TTL cleanup index
- `infra/docker-compose.yml` — uncomment `web:` service + add KB env + `OPENWEBUI_URL: http://openwebui:8080`
- `infra/openwebui/mcp-config.json` — không sửa (KB không đi qua MCP)

**Do NOT create/modify:**
- `web/src/app/chat/` — không dùng nữa (giữ nguyên để không phá custom web nếu ai đó dùng)
- Bất kỳ file nào trong `agent/`, `indexer/`, `mcp-semantic/`

## Env vars (in `web/.env.example`)

```
# ---------- KB Phase 1 ----------
DATABASE_URL=postgres://.../rag
OPENWEBUI_URL=http://openwebui:8080      # inside docker network
DEEPSEEK_API_KEY=
KB_SUMMARIZE_MODEL=deepseek-chat
KB_LLM_MOCK=false
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small
EMBED_MOCK=false
QDRANT_URL=http://qdrant:6333
QDRANT_API_KEY=
KB_QDRANT_COLLECTION=kb_resolved
KB_DEDUP_THRESHOLD=0.9
KB_SNAP_THRESHOLD=0.85
KB_DRAFT_TTL_MINUTES=30
KB_RATE_LIMIT_PER_USER_DAY=20
KB_WEB_PUBLIC_URL=http://localhost:3000  # base URL cho review link trả về OpenWebUI Function
```

## Implementation Steps

1. **DB schema + bootstrap DDL**
   - kbEntries fields: id UUID, openwebui_chat_id VARCHAR(64) UNIQUE nullable, title, department, topic, issue_type, tags[], symptom, root_cause, fix, embedding_id, created_by VARCHAR(64), upvotes, verified_by TEXT[] (OpenWebUI user_ids), created_at, updated_at
   - kbEdits: id, entry_id FK, user_id VARCHAR(64), diff_json, edited_at
   - kbTaxonomy: (kind, value) PK, usage_count
   - kbDrafts: id UUID, openwebui_chat_id VARCHAR(64), openwebui_user_id VARCHAR(64), draft_json JSONB, created_at, expires_at
   - Index: kb_drafts(expires_at) for cron cleanup

2. **Port redact + lib modules từ commit 7b20851 (đã revert)**
   - Git-restore: `git show 7b20851:web/src/lib/kb/redact.ts > web/src/lib/kb/redact.ts` — reuse nguyên
   - Same cho embed-client.ts, qdrant-client.ts, dedup.ts, summarizer.ts, summarizer-prompt.ts, taxonomy-snap.ts
   - Fix taxonomy-snap: KHÔNG bump usage_count ở snap step (bug C1 đã fix trong revert commit — cần đảm bảo fix vẫn giữ)

3. **openwebui-client.ts**
   - `fetchChat(chatId, jwt)` → GET /api/v1/chats/{id} → return messages array
   - `verifyOwnership(chatId, jwt)` → status 200/403
   - `listAllChats(adminApiKey, skip, limit)` → paginated cho backfill
   - `getCurrentUser(jwt)` → GET /api/v1/auths → return {id, email}

4. **draft-store.ts**
   - `createDraft(chatId, userId, draft)` → INSERT with 30-min expires_at → return id
   - `getDraft(id, userId)` → verify user + not expired → return draft
   - `deleteDraft(id)` → cleanup after commit
   - `cleanupExpired()` → cron helper

5. **summarizer.ts adapt evidence extraction**
   - Input format thay đổi: OpenWebUI messages `[{role, content, timestamp}]` thay Postgres `messages.parts` jsonb
   - OpenWebUI không có tool_call structure như Anthropic → evidence = assistant text + user context, thiếu grounded tool results
   - Alternative grounding: nếu chat có `citations` field (RAG plugin), extract vào evidence
   - Prompt tweak: strict JSON output, if evidence quality low → set draft `symptom` với warning tag

6. **API `POST /api/kb/summarize`**
   - Auth header `Authorization: Bearer <jwt>`, body `{chatId}`
   - Rate limit check (query INSERT count from kb_drafts+kb_entries for user today)
   - `openwebuiClient.verifyOwnership(chatId, jwt)` → 403 if fail
   - `openwebuiClient.fetchChat(chatId, jwt)` → messages
   - LLM summarize → draft
   - Taxonomy snap topic/issue_type
   - INSERT kb_drafts → return `{draftId, reviewUrl}`

7. **API `POST /api/kb/entries`**
   - Body `{draftId, edits?, force?}` + Authorization header
   - `openwebuiClient.getCurrentUser(jwt)` → verify user
   - `draftStore.getDraft(draftId, userId)` → 404/410 if not found/expired
   - Merge draft + edits
   - Redact PII on symptom/root_cause/fix/tags
   - Embed title+symptom+root_cause
   - Dedup: Qdrant top-3, if top1 >0.9 && !force → return `{dedupHits}` (không delete draft)
   - Else: INSERT kb_entries (openwebui_chat_id, created_by=userId), Qdrant upsert (rollback DB if Qdrant fail)
   - Increment `kb_taxonomy.usage_count` cho topic + issue_type đã snap
   - DELETE draft
   - Return `{id}`

8. **Page `/kb/create?draft=<id>`**
   - Server component: load draft (need session — get user from OpenWebUI JWT cookie hoặc query param)
   - **Session strategy:** OpenWebUI Function trả URL với `?draft=xxx&token=<short_token>` — token là random 32-byte hex lưu trong `kb_drafts.access_token` (add column) và verified server-side
   - Alternative: reuse OpenWebUI JWT cookie nếu web + OpenWebUI cùng domain (không phải trường hợp này — port khác)
   - Recommend: access_token trong draft row
   - Render form editable: title, symptom, root_cause, fix, department dropdown, topic input, issue_type input, tags input
   - Client component `kb-draft-form.tsx` handle submit + dedup dialog (Merge / Force Create; upvote branch TODO Phase 2)

9. **OpenWebUI Function `kb_mark_resolved.py`**
   - Type: Action (button trong message toolbar)
   - Access `__user__.token`, `body.chat_id`
   - POST to `${KB_WEB_URL}/api/kb/summarize`
   - Return markdown link content
   - Handle errors: 429 rate limit, 403 ownership, 500 LLM fail
   - Config valves: KB_WEB_URL, TIMEOUT_S=15
   - Load via OpenWebUI Admin → Functions → paste code

10. **Backfill script**
    - Env `OPENWEBUI_ADMIN_API_KEY` (get from OpenWebUI admin)
    - `listAllChats(key, skip, limit)` paginate 50/batch
    - Skip chats already in kb_entries.openwebui_chat_id
    - Summarize + create draft with `verified=false` + auto-commit (skip review) hoặc chỉ tạo draft chờ human curate
    - Rate 5 chats/min
    - CLI: `--dry-run`, `--limit N`, `--user-id X` (filter)

11. **Compose update**
    - Uncomment `web:` service block
    - Add environment: OPENWEBUI_URL, DEEPSEEK_API_KEY, KB_*, EMBED_*, OPENAI_*, QDRANT_URL, KB_WEB_PUBLIC_URL
    - Add profiles: `[web, kb]` để `--profile kb up -d web` bring KB up
    - depends_on: postgres, qdrant (openwebui optional — soft link vì openwebui có profile riêng)

## Todo List

- [ ] DB migration DDL cho 4 bảng (kb_entries + openwebui_chat_id, kb_edits, kb_taxonomy, kb_drafts)
- [ ] Restore & adapt lib/kb/* modules từ commit 7b20851
- [ ] openwebui-client.ts (fetchChat, verifyOwnership, listAllChats, getCurrentUser)
- [ ] draft-store.ts + access_token generation
- [ ] Adapt summarizer.ts evidence extraction cho OpenWebUI message format
- [ ] API POST /api/kb/summarize (auth + rate limit + fetch + summarize + snap + draft insert)
- [ ] API POST /api/kb/entries (verify draft + redact + embed + dedup + insert + cleanup)
- [ ] Page /kb/create + form component
- [ ] OpenWebUI Function kb_mark_resolved.py
- [ ] Backfill script với OpenWebUI API pagination
- [ ] docker-compose.yml enable web service + env
- [ ] .env.example
- [ ] Local smoke: chat 1 conversation trong OpenWebUI → click action → verify draft URL → save → verify Postgres + Qdrant

## Success Criteria

- Member trong OpenWebUI thấy action "Mark Resolved" trong message toolbar
- Click action → nhận markdown link → open review page < 15s tổng
- Review page hiển thị draft, edit + save works
- Dedup detect trùng đúng khi test 2 chats gần giống
- Redact xóa IP/hostname trước embed
- Rate limit 20/day/user enforced
- Draft expire 30 phút, không dùng được sau hết hạn
- Backfill 50 chats < 10 phút, no duplicate entries

## Risk Assessment

| Risk | Mitigation |
|---|---|
| OpenWebUI API endpoint đổi giữa versions | Pin OpenWebUI image `:v0.4.x` thay `:main`; log full request/response schema |
| JWT hết hạn giữa summarize → review | Draft cache dùng access_token riêng, không cần re-auth |
| Draft URL bị share/lộ | access_token 32-byte hex + verify user_id server-side |
| OpenWebUI messages structure không có tool_call structure | Prompt handle text-only chat; flag draft với `evidence_quality=low` nếu thiếu grounding data |
| Rate limit bypass qua nhiều tài khoản | Add global daily cap qua env; alert nếu vượt |
| Function load fail (Python syntax lỗi) | Test locally trước, dùng `openwebui functions test` CLI nếu có |
| kb_drafts table grow không kiểm soát | Opportunistic GC runs fire-and-forget on every /api/kb/summarize. Full coverage: schedule external cron hourly → `curl -s -X POST http://web:3000/api/kb/internal/cleanup-drafts -H "x-internal-token: $INTERNAL_CRON_TOKEN"`. Token configured via INTERNAL_CRON_TOKEN env (see .env.example). |
| Web service startup order — cần openwebui reachable | Không blocking; API check tại request-time; log rõ nếu OPENWEBUI_URL unreachable |

## Security Considerations

- Redact PII trước lưu KB (KB shared team)
- Verify OpenWebUI ownership qua real API call, không tin JWT payload
- Draft access_token đủ dài random (32 bytes = 256 bit)
- No secrets in error messages returned to OpenWebUI Function
- OpenWebUI admin API key trong backfill script — chỉ đọc, không sửa/xóa chats

## Next Steps

- Sau Phase 1 stable → Phase 2 `/kb` browse tab (search + filter + edit + upvote/verify)
- Phase 2 dùng `kb_entries.created_by` VARCHAR (OpenWebUI user_id) — không thay đổi
