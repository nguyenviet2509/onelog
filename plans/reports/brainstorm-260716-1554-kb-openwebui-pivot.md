# Brainstorm — KB Phase 1 pivot to OpenWebUI

**Date:** 2026-07-16 15:54 (Asia/Saigon)
**Session slug:** kb-openwebui-pivot
**Author:** brainstorm skill

---

## Problem statement

Phase 1 KB (commit `7b20851`, reverted via `c8c843b`) built KB pipeline vào custom Next.js web ở `web/src/app/chat/[id]/`. **Assumption sai:** team chat trace log qua custom web.

**Reality:** team chat exclusively qua **OpenWebUI** (`ragstack-openwebui` container, port 8090). Custom web service commented out trong `infra/docker-compose.yml` từ đầu → chưa từng deploy production.

→ Phase 1 as-built không có user reach: không ai click được "Mark Resolved" vì họ ở OpenWebUI. Postgres `conversations` gần rỗng.

## Root cause (design)

Brainstorm ban đầu (`brainstorm-260716-1422-...`) không hỏi team đang dùng UI nào. Assume Postgres `conversations` là source of truth vì schema có sẵn — nhưng schema đó thuộc custom web, chưa được adopt.

## Evaluated pivots

### A. Deploy custom web song song, dual UI
- **Pros:** không sửa code Phase 1
- **Cons:** 2 UI confuse; adoption thấp; OpenWebUI vẫn default → KB dead-on-arrival

### B. Pivot KB sang OpenWebUI API ⭐ CHỌN
- OpenWebUI có REST API: `/api/v1/chats/`, `/api/v1/chats/{id}`
- Auth: JWT (per-user) hoặc admin API key
- "Mark Resolved" trigger qua **OpenWebUI Function** (Python plugin, action button trong message toolbar)
- **Reuse ~60% Phase 1 code** (lib modules, DB schema, Qdrant, redact, summarizer core)
- **Drop:** chat UI button + modal + Postgres conversations fetch
- **Add:** OpenWebUI function + Next.js `/kb/create` review page + OpenWebUI API client

### C. Bridge: OpenWebUI SQLite → Postgres sync + KB đọc Postgres
- Nightly export
- **Pros:** decouple, Phase 1 code ít sửa
- **Cons:** thêm pipeline; latency 1 ngày; complex; vẫn cần button hook trong OpenWebUI

### D. Rewrite KB thành pure MCP tool
- **Pros:** tận dụng MCP infra
- **Cons:** UX kém (chat "tạo KB" thay vì bấm nút); waste 80% Phase 1

**Decision:** B với auth pass-through JWT (chốt 2026-07-16 15:54).

## Final design pivot

### Architecture

```
[Member chats in OpenWebUI :8090]
        ↓ bấm action "Mark Resolved" trong message toolbar
[OpenWebUI Function `kb_mark_resolved` (Python)]
        ↓ HTTP POST http://web:3000/api/kb/summarize
        ↓ headers: X-Openwebui-Chat-Id, Authorization: Bearer <user_jwt>
[Next.js web /api/kb/summarize]
        ↓ verify user owns chat via GET http://openwebui:8080/api/v1/chats/{id} with JWT
        ↓ fetch messages từ OpenWebUI API
        ↓ LLM summarize (DeepSeek)
        ↓ taxonomy snap
[Return draft + review URL]
        ↓ member clicks URL trong OpenWebUI notif
[Next.js /kb/create?token=xxx review page]
        ↓ edit draft → submit
[POST /api/kb/entries]
        ↓ redact → embed → dedup check → insert Postgres + Qdrant
```

### Reuse (unchanged from reverted Phase 1)

- `web/src/lib/kb/redact.ts` — 6 regex PII patterns
- `web/src/lib/kb/summarizer.ts` — LLM extract logic (chỉ đổi input source)
- `web/src/lib/kb/summarizer-prompt.ts` — prompt template
- `web/src/lib/kb/embed-client.ts` — OpenAI-compat embeddings
- `web/src/lib/kb/qdrant-client.ts` — Qdrant REST wrapper
- `web/src/lib/kb/dedup.ts` — semantic dedup ≥0.9
- `web/src/lib/kb/taxonomy-snap.ts` — Levenshtein + embed cosine ≥0.85
- `web/src/db/schema.ts` — kb_entries, kb_edits, kb_taxonomy tables
- `web/src/db/bootstrap.ts` DDL extension
- Env vars (DEEPSEEK, EMBED, QDRANT, KB_*)

### New / changed

- **New:** `web/src/lib/kb/openwebui-client.ts` — fetch chat + verify ownership qua OpenWebUI API
- **New:** `web/src/app/kb/create/page.tsx` — review draft form (thay cho modal cũ)
- **New:** `web/src/app/kb/create/kb-draft-form.tsx` — client component form
- **New:** `infra/openwebui/functions/kb_mark_resolved.py` — OpenWebUI Function (Python plugin)
- **New:** short-lived draft cache — `web/src/lib/kb/draft-store.ts` in-memory OR Postgres table `kb_drafts` (TTL 30min) để pass draft giữa summarize → create page
- **Changed:** `web/src/app/api/kb/summarize/route.ts` — nhận `{chatId}` + Authorization header, gọi OpenWebUI API thay vì Postgres
- **Changed:** `web/src/app/api/kb/entries/route.ts` — verify ownership qua OpenWebUI trước INSERT (không dùng conversationId Postgres)
- **Changed:** `web/scripts/kb-backfill.ts` — fetch chats từ OpenWebUI API (paginate) hoặc SQLite direct read
- **Dropped:** `web/src/app/chat/[id]/mark-resolved-button.tsx`, `mark-resolved-modal.tsx`
- **Dropped:** modify `web/src/app/chat/[id]/page.tsx` (revert)
- **Changed schema:** `kb_entries.conversation_id UUID` → `kb_entries.openwebui_chat_id VARCHAR(64)` (OpenWebUI dùng ULID-like string, không phải UUID native của Postgres schema). Vẫn UNIQUE nullable.

### Auth flow (JWT pass-through)

1. OpenWebUI Function có access `__user__.token` — forward vào `Authorization: Bearer <jwt>` header
2. Web API endpoint gọi `GET http://openwebui:8080/api/v1/chats/{id}` với JWT đó
3. Nếu 200 → user owns chat → OK
4. Nếu 401/404 → return 403
5. Không cần map user → users table; `kb_entries.created_by` lưu OpenWebUI user_id (VARCHAR string thay INTEGER)

### Schema adjustments

```sql
-- Đổi FK reference
kb_entries.openwebui_chat_id  VARCHAR(64) UNIQUE  -- thay conversation_id UUID
kb_entries.created_by         VARCHAR(64)         -- OpenWebUI user_id thay serial FK
-- Bỏ FK constraint tới users/conversations (khác database domain)

-- Thêm cho draft handoff
CREATE TABLE kb_drafts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  openwebui_chat_id VARCHAR(64) NOT NULL,
  openwebui_user_id VARCHAR(64) NOT NULL,
  draft_json   JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes'
);
CREATE INDEX idx_kb_drafts_expiry ON kb_drafts(expires_at);
```

### OpenWebUI Function skeleton

```python
# infra/openwebui/functions/kb_mark_resolved.py
from typing import Optional
import httpx
from pydantic import BaseModel

class Action:
    class Valves(BaseModel):
        KB_WEB_URL: str = "http://web:3000"
        TIMEOUT_S: int = 15

    def __init__(self):
        self.valves = self.Valves()

    async def action(self, body: dict, __user__: dict, __request__) -> Optional[dict]:
        chat_id = body.get("chat_id")
        jwt = __request__.headers.get("authorization", "")
        async with httpx.AsyncClient(timeout=self.valves.TIMEOUT_S) as client:
            resp = await client.post(
                f"{self.valves.KB_WEB_URL}/api/kb/summarize",
                headers={"Authorization": jwt, "X-Openwebui-Chat-Id": chat_id},
                json={"chatId": chat_id},
            )
        if resp.status_code != 200:
            return {"content": f"KB summarize failed: {resp.status_code}"}
        data = resp.json()
        review_url = f"{self.valves.KB_WEB_URL}/kb/create?draft={data['draftId']}"
        return {"content": f"Draft ready. [Review + save]({review_url})"}
```

## Success metrics (unchanged from original brainstorm)

- Coverage: % chats → KB entry ≥ 30% sau 1 tháng
- Reuse: % chat mới có ≥1 KB match >0.7 và được view ≥ 30%
- Quality: % entries verified/upvoted ≥3 ≥ 20%

## Risks + mitigation

| Risk | Mitigation |
|---|---|
| OpenWebUI API breaking changes | Pin OpenWebUI image tag (thay `:main` → `:v0.4.x`); document API endpoints used |
| JWT expiry giữa summarize → create page | Draft cache 30 phút không cần re-auth; review page dùng draftId, không tái verify ownership |
| Draft cache lộ nếu user share URL | `kb_drafts.openwebui_user_id` check tại `/kb/create` — chỉ owner mới xem/save được |
| OpenWebUI Function không load | Fallback: user copy chat URL → paste vào `/kb/create-from-url` form (manual) |
| Ownership bypass qua fake JWT | Web luôn re-verify qua OpenWebUI API (không tin JWT payload); JWT lộ = OpenWebUI vấn đề riêng |

## Unresolved

1. OpenWebUI Function type nào phù hợp: **Action** (button in message), **Filter** (pre/post processing), **Pipe** (custom model)? → Action (đã chọn trong skeleton).
2. OpenWebUI có endpoint list all chats cho backfill không? Verify: `/api/v1/chats/all` hoặc paginated `/api/v1/chats/list?skip=&limit=`.
3. Chat ID format OpenWebUI: UUID hay ULID? → Verify khi implement; schema dùng VARCHAR(64) an toàn.
4. Có cần Rate limit summarize? OpenWebUI có sẵn không? → Add tại web endpoint: max 20 summarize/user/day.
5. UX show notification cho member biết draft ready — dùng OpenWebUI Function response content (markdown link) đủ chưa hay cần webhook back?
