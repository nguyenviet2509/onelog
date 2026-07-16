# Phase 02 — /kb Browse Tab

## Context Links

- Brainstorm gốc: [../reports/brainstorm-260716-1422-chat-conversations-kb-search.md](../reports/brainstorm-260716-1422-chat-conversations-kb-search.md)
- Pivot brainstorm: [../reports/brainstorm-260716-1554-kb-openwebui-pivot.md](../reports/brainstorm-260716-1554-kb-openwebui-pivot.md)
- Overview: [plan.md](plan.md)
- Depends on: [phase-01-kb-creation-from-openwebui.md](phase-01-kb-creation-from-openwebui.md)

## Overview

- **Priority:** High (sau Phase 1)
- **Status:** pending
- **Effort:** ~1 tuần
- **Mục tiêu:** Trang `/kb` cho member (auth qua OpenWebUI JWT hoặc access page với OpenWebUI cookie) browse + hybrid search + filter dept/topic/issue + edit inline + upvote/verify.

## Key Insights

- Auth: verify OpenWebUI JWT (like Phase 1). `kb_entries.created_by` là OpenWebUI user_id (VARCHAR).
- Hybrid search: Postgres `tsvector` (BM25) + Qdrant semantic → merge score 0.6/0.4.
- Filter cascade: department → topic → issue_type từ `kb_taxonomy`.
- Edit inline mọi member → INSERT `kb_edits` audit trail.
- Upvote/Verify: bảng `kb_upvotes(entry_id, user_id VARCHAR, at)` — dùng OpenWebUI user_id string.

## Requirements

**Functional:**
- Search box (hybrid), filter cascade, list card, detail page với inline edit
- Upvote toggle (bảng kb_upvotes tránh duplicate)
- Verify: append vào `kb_entries.verified_by TEXT[]` (OpenWebUI user_ids)
- Link về source chat (OpenWebUI URL): `${OPENWEBUI_PUBLIC_URL}/c/{openwebui_chat_id}`

**Non-functional:**
- Search P95 <500ms cho 5k entries
- Filter change refresh <200ms

## Related Code Files

**Create:**
- `web/src/app/kb/page.tsx` — list + search + filters
- `web/src/app/kb/[id]/page.tsx` — detail + edit inline
- `web/src/app/kb/components/search-box.tsx`
- `web/src/app/kb/components/filters-cascade.tsx`
- `web/src/app/kb/components/entry-card.tsx`
- `web/src/app/kb/components/entry-body-editor.tsx`
- `web/src/app/kb/components/edit-history.tsx`
- `web/src/app/api/kb/route.ts` — GET list
- `web/src/app/api/kb/[id]/route.ts` — GET / PATCH
- `web/src/app/api/kb/[id]/upvote/route.ts`
- `web/src/app/api/kb/[id]/verify/route.ts`
- `web/src/app/api/kb/taxonomy/route.ts`
- `web/src/lib/kb/search.ts` — hybrid Qdrant + tsvector
- `web/src/lib/kb/kb-auth.ts` — reuse Phase 1 openwebui-client for verify user

**Modify:**
- `web/src/db/schema.ts` — thêm kbUpvotes (user_id VARCHAR)
- `web/src/db/bootstrap.ts` — DDL kb_upvotes
- Nav: thêm link `/kb` (hoặc tạo minimal layout header — custom web hiện chỉ có /chat, cần header nav)

## Implementation Steps

1. Bảng `kb_upvotes(entry_id UUID FK, user_id VARCHAR(64), at TIMESTAMPTZ, PRIMARY KEY(entry_id, user_id))`
2. Auth middleware: verify OpenWebUI JWT ở tất cả /api/kb/* routes (import từ Phase 1 openwebui-client)
3. Hybrid search module (mô tả trong brainstorm gốc, unchanged)
4. API GET /api/kb — parse query params + hybrid search
5. API GET /api/kb/taxonomy — cache 5m
6. API GET /api/kb/[id] — full entry + last 5 edits
7. API PATCH /api/kb/[id] — auth, diff, insert kb_edits, update kb_entries, re-embed if title/symptom/root_cause đổi
8. API POST /api/kb/[id]/upvote — toggle
9. API POST /api/kb/[id]/verify — append user_id vào verified_by[] idempotent
10. UI list page (server component + client SearchBox/Filters)
11. UI detail page (edit inline + actions + link về OpenWebUI chat)
12. Nav header với link /kb

## Todo List

- [ ] Migration kb_upvotes (user_id VARCHAR)
- [ ] Auth middleware reuse Phase 1 openwebui-client
- [ ] Hybrid search
- [ ] API list/detail/patch/upvote/verify/taxonomy
- [ ] Page /kb + /kb/[id]
- [ ] E2E smoke: create entry Phase 1 → filter /kb → detail → edit → upvote → verify

## Success Criteria

- Search "mysql disk full" → top-3 relevant
- Filter dept=DBA → chỉ DBA entries
- Edit title → kb_edits row + Qdrant re-embed
- Upvote toggle chính xác (unique constraint)
- Load /kb 100 entries <500ms
- Verify OpenWebUI user duplicate không double-add vào verified_by[]

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Hybrid score tune kém | Log query + click-through, iterate weights |
| Edit conflict concurrent | Optimistic concurrency via updated_at check, 409 on stale |
| Re-embed mỗi edit cost cao | Chỉ re-embed nếu title/symptom/root_cause thay đổi |
| Postgres tsvector tiếng Việt kém | MVP dùng `simple`; upgrade unaccent + Vi dict sau |
| Custom web layout thiếu — user không thấy /kb link đâu | Tạo minimal top nav trong `web/src/app/layout.tsx` với link Chat + KB |

## Security

- Auth all routes via OpenWebUI JWT
- Zod validate whitelist fields on PATCH
- Rate limit upvote/verify (1/s/user)
- Sanitize markdown render trong detail page (DOMPurify hoặc rehype-sanitize)

## Next Steps

- Post-Phase 2 metrics review 1 tháng
- Phase 3 candidates: OpenWebUI sidebar suggest (auto-hint khi member đang chat có case tương tự), Telegram append, auto-curate nightly, versioning
