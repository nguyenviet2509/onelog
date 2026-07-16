# Phase 02 — /kb Browse Tab

## Context Links

- Brainstorm: [../reports/brainstorm-260716-1422-chat-conversations-kb-search.md](../reports/brainstorm-260716-1422-chat-conversations-kb-search.md)
- Overview: [plan.md](plan.md)
- Depends on: [phase-01-kb-creation-from-chat.md](phase-01-kb-creation-from-chat.md) (cần entry đã tồn tại)

## Overview

- **Priority:** High (sau Phase 1)
- **Status:** pending
- **Effort:** ~1 tuần
- **Mục tiêu:** Trang `/kb` cho member browse + search (hybrid semantic + BM25) + filter theo dept/topic/issue + edit inline + upvote/verify.

## Key Insights

- Hybrid search MVP: Postgres `tsvector` (BM25-like) + Qdrant semantic → merge score client-side đơn giản.
- Cascade filter dept → topic → issue_type: server-side query params, không SPA state phức tạp.
- Edit inline mọi member → mỗi edit tạo record `kb_edits` (audit).

## Requirements

**Functional:**
- Search box: query text hybrid semantic + BM25 title
- Filters cascade dropdown dept → topic → issue_type (populate từ `kb_taxonomy`)
- List card: `[verified badge] title • dept/topic/issue • symptom preview • ▲upvotes • updated_at`
- Detail page `/kb/[id]`: full 3 field + tags + link source conversation + edit inline + upvote/verify buttons
- Bảng `kb_upvotes(entry_id, user_id, at)` tránh gaming upvote

**Non-functional:**
- Search latency < 500ms (P95) cho 5k entries
- Filter thay đổi → refresh danh sách < 200ms (server component + streaming)

## Architecture

```
/kb (Next.js route)
├── SearchBox → onSubmit: navigate /kb?q=...
├── FiltersCascade → onChange: navigate /kb?dept=&topic=&issue=
├── CardList (server component, SSR danh sách)
│   └── Card → link /kb/[id]
└── Pagination

/kb/[id]
├── EntryHeader (title, badges, dept/topic/issue)
├── EntryBody (symptom, root_cause, fix) — editable inline
├── TagsRow
├── ActionsBar (upvote, verify, edit-save, link-source-conv)
└── EditHistory (last 5 kb_edits)
```

## Related Code Files

**To create:**
- `web/src/app/kb/page.tsx` — list + search + filters
- `web/src/app/kb/[id]/page.tsx` — detail
- `web/src/app/kb/components/search-box.tsx`
- `web/src/app/kb/components/filters-cascade.tsx`
- `web/src/app/kb/components/entry-card.tsx`
- `web/src/app/kb/components/entry-body-editor.tsx`
- `web/src/app/kb/components/edit-history.tsx`
- `web/src/app/api/kb/route.ts` — GET list với filter+search
- `web/src/app/api/kb/[id]/route.ts` — GET / PATCH detail
- `web/src/app/api/kb/[id]/upvote/route.ts` — POST toggle upvote
- `web/src/app/api/kb/[id]/verify/route.ts` — POST toggle verify
- `web/src/app/api/kb/taxonomy/route.ts` — GET options cho filters
- `web/src/lib/kb/search.ts` — hybrid search logic (Qdrant + tsvector merge)
- `web/drizzle/migrations/00XX_kb_upvotes.sql` — bảng upvotes

**To modify:**
- `web/src/db/schema.ts` — thêm `kbUpvotes` table
- `web/src/app/layout.tsx` hoặc nav component — thêm link `/kb`

## Implementation Steps

1. **Bảng `kb_upvotes`**
   - `(entry_id, user_id) UNIQUE` — 1 user upvote 1 entry 1 lần
   - Update trigger tính lại `kb_entries.upvotes` (hoặc compute on-read)

2. **Hybrid search module** (`web/src/lib/kb/search.ts`)
   - Input: `{q?, dept?, topic?, issue?, limit=20, offset=0}`
   - Nếu có `q`:
     - Query Qdrant `kb_resolved` với embed(q), filter payload dept/topic/issue → top-40
     - Query Postgres `kb_entries` với `to_tsvector` match title+symptom → top-40
     - Merge: score = 0.6 * semantic_score + 0.4 * ts_rank_normalized → dedupe by id → top-20
   - Nếu không có `q`: pure Postgres query + order by `updated_at desc`
   - Apply pagination

3. **API `GET /api/kb`**
   - Parse query params
   - Delegate hybrid search
   - Return `{items: EntryPreview[], total, page}`

4. **API `GET /api/kb/taxonomy`**
   - Return `{departments: [], topics_by_dept: {...}, issues_by_topic: {...}}`
   - Cache 5 phút (kb_taxonomy ít đổi)

5. **API `GET /api/kb/[id]`**
   - Return full entry + last 5 `kb_edits`

6. **API `PATCH /api/kb/[id]`**
   - Auth: mọi authenticated user (theo brainstorm decision)
   - Compute diff old vs new
   - INSERT `kb_edits` row với `diff_json`
   - UPDATE `kb_entries` (updated_at, updated fields)
   - Nếu title/symptom/root_cause đổi → re-embed + upsert Qdrant

7. **API `POST /api/kb/[id]/upvote`**
   - Toggle: nếu record tồn tại → DELETE (unvote) else INSERT
   - Return new count

8. **API `POST /api/kb/[id]/verify`**
   - Append user_id vào `verified_by[]` nếu chưa có (idempotent)
   - Return updated `verified_by[]`

9. **UI list page**
   - Server component fetch data
   - SearchBox client component (debounce 300ms → router.replace)
   - FiltersCascade client component (options từ `/api/kb/taxonomy`)
   - CardList render entries
   - Pagination server-controlled

10. **UI detail page**
    - Server component fetch entry + edit history
    - `EntryBodyEditor` client (double-click field → contenteditable → save on blur)
    - Actions client: upvote, verify → mutate + revalidate

11. **Nav integration**
    - Thêm link `/kb` trong header/sidebar hiện tại

## Todo List

- [ ] Migration `kb_upvotes`
- [ ] Hybrid search module
- [ ] API `GET /api/kb`
- [ ] API `GET /api/kb/taxonomy`
- [ ] API `GET /api/kb/[id]`
- [ ] API `PATCH /api/kb/[id]` (+ re-embed logic)
- [ ] API `POST /api/kb/[id]/upvote`
- [ ] API `POST /api/kb/[id]/verify`
- [ ] Page `/kb` (list + search + filters)
- [ ] Page `/kb/[id]` (detail + edit inline + actions)
- [ ] Nav link
- [ ] E2E smoke: create entry Phase 1 → xuất hiện `/kb` → filter → detail → edit → upvote → verify

## Success Criteria

- Search "mysql disk full" trả entry `disk-full/mysql` top-3.
- Filter dept=DBA → chỉ hiện entries DBA.
- Edit title entry → thấy record mới trong `kb_edits` + Qdrant vector cập nhật.
- Upvote toggle chính xác (không double count).
- Load `/kb` list 100 entries < 500ms.

## Risk Assessment

| Rủi ro | Mitigation |
|---|---|
| Merge score hybrid không tune tốt → kết quả kém | Log query + click-through; iterate weight 0.6/0.4 dựa data thật |
| Edit conflict (2 user edit đồng thời) | Optimistic concurrency: check `updated_at` khi PATCH; nếu stale → 409 conflict, UI refetch |
| Re-embed mỗi edit tốn cost | Chỉ re-embed khi title/symptom/root_cause đổi (skip nếu chỉ tags/dept đổi) |
| Filter dropdown chậm nếu taxonomy lớn | Cache client-side + server 5m; virtualize dropdown khi >100 items |
| Postgres tsvector không tốt cho tiếng Việt | MVP dùng `simple` config; upgrade unaccent + dictionary tiếng Việt sau |

## Security Considerations

- PATCH endpoint reject nếu payload chứa field ngoài schema (whitelist zod)
- Rate limit upvote/verify (1 req/s/user)
- XSS: render entry body qua sanitizer (DOMPurify hoặc rehype-sanitize) — content plain text từ LLM nhưng member có thể inject markdown

## Next Steps

- Post-Phase 2: metrics review 1 tháng → quyết định Phase 3 (auto-curate + Telegram integration + sidebar suggest)
- Backfill batch nếu chưa chạy Phase 1
