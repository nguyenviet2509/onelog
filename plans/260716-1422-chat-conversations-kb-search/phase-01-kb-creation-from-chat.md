# Phase 01 — KB Creation từ Chat

## Context Links

- Brainstorm: [../reports/brainstorm-260716-1422-chat-conversations-kb-search.md](../reports/brainstorm-260716-1422-chat-conversations-kb-search.md)
- Overview plan: [plan.md](plan.md)
- Related: [../260701-1544-llm-provider-abstraction/plan.md](../260701-1544-llm-provider-abstraction/plan.md) (LLM summarize)

## Overview

- **Priority:** High
- **Status:** pending
- **Effort:** ~1 tuần
- **Mục tiêu:** Cho phép member bấm "Mark Resolved" trong chat → LLM extract entry `{symptom, root_cause, fix, dept, topic, issue, tags}` → member review/edit → save vào Postgres + embed vào Qdrant.

## Key Insights

- Postgres `messages.parts` jsonb chứa tool_call events → là evidence chính grounding LLM (tránh hallucinate).
- Insert-time semantic dedup >0.9 cosine → merge/upvote thay vì tạo trùng.
- PII (IP, hostname) cần redact TRƯỚC embed VÀ trước lưu DB (reuse `agent/redact.py`).
- **Taxonomy snap-to-existing** (Option 3, chốt 2026-07-16): LLM propose `topic`/`issue_type` free-form → server fuzzy+semantic match với `kb_taxonomy` hiện có → snap nếu score ≥0.85, else tạo mới. Tránh fragment (`disk-full` vs `disk_full` vs `ENOSPC`). Không có UI merge/rename trong MVP — auto-snap thuần.

## Requirements

**Functional:**
- Button "Mark Resolved" mỗi conversation.
- API summarize trả draft entry, member edit inline, save khi confirm.
- Auto-classify dept/topic/issue qua LLM cùng lượt summarize (giảm 1 round-trip).
- Search-time dedup: nếu cosine >0.9 với entry sẵn → UI hiện dialog "Merge / Upvote existing / Force create".
- Audit trail edit qua `kb_edits`.

**Non-functional:**
- Summarize latency < 10s (Haiku/DeepSeek).
- Cost mỗi entry < $0.005.
- Redact 100% IP + hostname pattern known.

## Architecture

```
[Chat UI "Mark Resolved"]
        ↓ POST /api/kb/summarize {conversationId}
[web API route]
        ↓ read conversations+messages
[LLM (DeepSeek/Haiku)] ← grounded prompt (tool_call evidence)
        ↓ draft entry JSON
[Return to UI]
        ↓ member review/edit
        ↓ POST /api/kb/entries {entry}
[web API route]
        ↓ redact PII
        ↓ embed(title+symptom+root_cause) → Qdrant kb_resolved
        ↓ INSERT kb_entries
[Response: {id, dedupHits?[]}]
```

## Related Code Files

**To create:**
- `web/drizzle/migrations/00XX_kb_entries.sql` — 3 bảng mới
- `web/src/db/schema.ts` — extend với `kbEntries`, `kbEdits`, `kbTaxonomy` tables
- `web/src/app/api/kb/summarize/route.ts` — LLM summarize endpoint
- `web/src/app/api/kb/entries/route.ts` — POST create entry
- `web/src/lib/kb/summarizer.ts` — LLM prompt + grounding logic
- `web/src/lib/kb/classify.ts` — dept/topic/issue classification (integrate với summarizer)
- `web/src/lib/kb/dedup.ts` — semantic dedup check
- `web/src/lib/kb/taxonomy-snap.ts` — LLM output → snap topic/issue_type vào taxonomy hiện có (fuzzy Levenshtein + semantic embed similarity, threshold 0.85)
- `web/src/lib/kb/embed-client.ts` — HTTP client gọi embedder (Python service hoặc inline)
- `web/src/lib/kb/qdrant-client.ts` — Qdrant HTTP wrapper
- `web/src/lib/kb/redact.ts` — TS wrapper gọi redact hoặc port logic từ Python

**To modify:**
- `web/src/app/chat/*.tsx` — thêm button "Mark Resolved" (component + wire API)
- `agent/src/agent/redact.py` — nếu cần expose HTTP endpoint cho web (hoặc port sang TS)

## Implementation Steps

1. **DB migration**
   - Viết Drizzle schema `kbEntries`, `kbEdits`, `kbTaxonomy` (xem brainstorm report §Data model)
   - Generate migration + apply local
   - Seed `kbTaxonomy`: departments (SRE/DBA/NetOps/AppDev/Security), initial topics/issues empty

2. **Qdrant collection**
   - Create collection `kb_resolved` với dim khớp embedder hiện tại (check `mcp-semantic/config`)
   - Distance: Cosine

3. **Redact bridge**
   - Option A: expose `POST /redact` FastAPI trên `agent/` service → web gọi HTTP
   - Option B: port logic `agent/redact.py` sang TS `web/src/lib/kb/redact.ts` (nếu logic <100 dòng)
   - **Recommend Option B** (KISS, tránh network hop)

4. **Embed client**
   - Web gọi HTTP tới `indexer` hoặc `mcp-semantic` embedder (endpoint có sẵn?)
   - Nếu chưa có endpoint embed thuần, expose `POST /embed {text}` trên `indexer`

5. **LLM summarize prompt**
   - System prompt: "Bạn là KB summarizer. Extract từ conversation dưới đây theo schema JSON..."
   - User input: concat `role: content` các messages + inline `tool_call` results
   - Output schema (JSON mode): `{title, symptom, root_cause, fix, department, topic, issue_type, tags[]}`
   - Provider: đọc env `KB_SUMMARIZE_MODEL` (default `deepseek-v3` fallback `claude-haiku-4-5`)

6. **API `/api/kb/summarize`**
   - Input: `{conversationId}`
   - Read `messages` where `conversation_id=?` order by createdAt
   - Concat evidence (assistant messages + tool_call parts)
   - Call LLM → parse JSON draft
   - Return draft (KHÔNG save, member review trước)

7. **Taxonomy snap-to-existing** (mới thêm, chạy trong summarize step 6 hoặc entries step 8)
   - Sau khi LLM propose `{topic, issue_type}`, load `kb_taxonomy` rows kind IN ('topic','issue_type')
   - Fuzzy Levenshtein normalized ≥0.85 → snap
   - Else compute embed(proposal) → compare embed(existing values) cosine ≥0.85 → snap
   - Else INSERT vào `kb_taxonomy` với `usage_count=1` (schema thêm field này)
   - Trả về giá trị đã snap cho draft entry (UI show hint: "Snapped từ `disk_full` → `disk-full` (12 entries)")

8. **API `/api/kb/entries` POST**
   - Input: entry payload đã member edit
   - Redact PII fields (symptom, root_cause, fix, tags)
   - Compute embedding vector
   - Semantic dedup: search Qdrant top-3, nếu top-1 score >0.9 → return `{dedupHits: [{id, title, score}]}` chưa insert, chờ member confirm
   - Nếu confirm force / no dedup hit → INSERT `kb_entries` + upsert Qdrant point + increment `kb_taxonomy.usage_count`
   - Return `{id}`

8. **Chat UI integration**
   - Button "Mark Resolved" (right corner mỗi conversation view)
   - Click → gọi summarize → mở modal review với form editable
   - Submit → POST entries → nếu dedup hits → hiện dialog "Merge / Upvote existing #123 / Force create"
   - Success → toast + link `/kb/{id}` (Phase 2)

9. **Backfill script (opt-in, chạy tay)**
   - `scripts/kb-backfill.ts` — iterate conversations có ≥3 messages + tool_call success → summarize + insert với `verified=false`
   - Chạy 1 lần sau khi Phase 1 stable

## Todo List

- [ ] Drizzle schema + migration `kb_entries` / `kb_edits` / `kb_taxonomy`
- [ ] Qdrant collection `kb_resolved` provisioning script
- [ ] Redact TS port (hoặc HTTP bridge)
- [ ] Embed HTTP client (verify/expose endpoint)
- [ ] LLM summarize module + prompt
- [ ] Auto-classify dept/topic/issue trong summarize prompt
- [ ] Semantic dedup module
- [ ] Taxonomy snap-to-existing module + `kb_taxonomy.usage_count` field
- [ ] API `POST /api/kb/summarize`
- [ ] API `POST /api/kb/entries` (với dedup response)
- [ ] Chat UI "Mark Resolved" button + review modal
- [ ] Backfill script
- [ ] Local smoke test: 3 conversations sample → entry → verify Qdrant + Postgres consistent

## Success Criteria

- Member bấm "Mark Resolved" → nhận draft trong <10s.
- Entry save Postgres + Qdrant point atomic (rollback nếu 1 bên fail).
- Dedup detect trùng đúng khi test với 2 conversations gần giống.
- Redact xóa IP/hostname pattern trước embed (verify Qdrant payload không chứa).
- Backfill 100 conversations chạy < 15 phút.

## Risk Assessment

| Rủi ro | Mitigation |
|---|---|
| LLM output không parse được JSON | Retry với stricter prompt; validate zod schema; fallback minimal entry với warning |
| Fragment taxonomy nếu snap threshold sai | Config env `KB_SNAP_THRESHOLD` (default 0.85); log snap-decisions để audit; điều chỉnh sau khi có data thật |
| Qdrant/Postgres mất đồng bộ | Transaction Postgres commit sau Qdrant upsert; job reconcile weekly |
| Cost LLM tăng nếu conversation quá dài | Truncate evidence >8K tokens, giữ last N messages + tool_calls |
| Redact miss pattern mới | Log unredacted-suspect qua audit; iterate quy tắc |
| LLM provider abstraction plan chưa xong | Hardcode DeepSeek client trong Phase 1; refactor khi abstraction ship |

## Security Considerations

- Redact PII trước embed VÀ trước lưu KB (KB dùng chung team → giảm rò rỉ)
- API auth: reuse session middleware `web/` hiện có
- Không cho phép DELETE entry qua API public (soft delete field cân nhắc Phase 2)

## Next Steps

- Sau Phase 1 stable → Phase 2 `/kb` browse tab
- Confirm dependency LLM provider abstraction: check plan `260701-1544` status trước start
