# Brainstorm — Chat Conversations → Team KB (searchable)

**Date:** 2026-07-16 14:22 (Asia/Saigon)
**Session slug:** chat-conversations-kb-search
**Author:** brainstorm skill (via user trihd@inet.vn)

---

## Problem statement

Khi member A trong team kỹ thuật trace log incident trong VictoriaLogs (logs từ client servers forward về logserver), đã resolve → member B gặp incident tương tự → cần **tự động có sẵn context/KB** đã resolved, không phải trace lại từ đầu.

**Bối cảnh:** Team đang dùng OneLog webui chat để member trace log trực tiếp. Toàn bộ conversations đã lưu Postgres nhưng chưa khai thác lại.

---

## Storage audit (câu 2 của user)

| Kênh lưu | Path | Team-shareable? | Ghi chú |
|---|---|---|---|
| OneLog webui chat | Postgres `conversations` + `messages.parts` jsonb (schema [web/src/db/schema.ts](../../web/src/db/schema.ts)) | ✅ Multi-user DB | **Nguồn chính** — đang bị bỏ phí |
| Audit log tool_calls | Postgres `audit_log` | ✅ | Biết member gọi tool gì, kết quả |
| Claude Code JSONL transcripts | `~/.claude/projects/<slug>/*.jsonl` | ❌ Local per-dev | Không tái sử dụng cho team |
| Auto-memory (Claude) | `~/.claude/projects/<slug>/memory/` | ❌ Local | Bỏ qua |
| Journals | `docs/journals/*.md` | ✅ Git | Manual, ít |
| Plans/reports | `plans/` | ✅ Git | Manual |

→ Chỉ **Postgres conversations** đủ volume + auto-captured để làm base cho KB.

---

## Evaluated approaches

### Option A — Semantic search RAW conversations
- Embed nguyên conversation → Qdrant nightly
- Query khi member mới chat
- **Pros:** ~2 ngày ship, không LLM cost summarize
- **Cons:** noise (dead-end, sai giả thuyết); token embed cao; không phân biệt resolved/abandoned; khó classify

### Option B — Curated KB entries (LLM summarize) ⭐ CHỌN
- LLM extract `{symptom, root_cause, fix, department, topic, issue_type, tags}` từ conversation
- Bảng `kb_entries` + embed summary
- Trigger: member bấm "Mark Resolved" (Phase 1); auto scan idle conv (Phase 3, deferred)
- **Pros:** chất lượng cao, entry ngắn cheap-embed, reusable, có classification tự nhiên
- **Cons:** cần UX action + LLM cost (~$0.001/entry Haiku/DeepSeek)

### Option C — Hybrid A→B
- Ship A trước, promote entry hay click thành B
- **Cons:** UX phức tạp, timeline 2×

**Decision:** Option B với scope MVP Phase 1+2 (bỏ Phase 3 auto-curate).

---

## Final design (approved)

### Data model

```
kb_entries(
  id            uuid pk
  conversation_id uuid fk conversations(id)  -- source, nullable (khi tạo thủ công)
  title         varchar(200)
  department    varchar(32)   -- SRE | DBA | NetOps | AppDev | Security | ...
  topic         varchar(64)   -- mysql | rsyslog | vmalert | disk | ssh | ...
  issue_type    varchar(64)   -- disk-full | brute-force | oom | crash-loop | ...
  tags          text[]        -- free-form: host, service, error code
  symptom       text          -- triệu chứng nhận biết
  root_cause    text          -- nguyên nhân gốc
  fix           text          -- cách xử lý
  embedding_id  varchar(128)  -- Qdrant point id
  created_by    int fk users(id)
  upvotes       int default 0
  verified_by   int[]         -- danh sách user_id đã verify
  created_at    timestamptz
  updated_at    timestamptz
)

kb_edits(
  id         uuid pk
  entry_id   uuid fk kb_entries(id) on delete cascade
  user_id    int fk users(id)
  diff_json  jsonb            -- {field: {before, after}}
  edited_at  timestamptz
)

kb_taxonomy(
  kind       varchar(16)      -- department | topic | issue_type
  value      varchar(64)
  primary key(kind, value)
)
```

### LLM strategy (2-tier, provider abstraction reuse `260701-1544-llm-provider-abstraction`)

| Task | Default model | Env var |
|---|---|---|
| Summarize conversation → entry | DeepSeek V3 hoặc Haiku | `KB_SUMMARIZE_MODEL` |
| Classify dept/topic/issue | DeepSeek V3 | (share với summarize) |
| Re-rank search top-20→5 | Haiku | `KB_RERANK_MODEL` |
| Deep-analyze (fallback) | Sonnet | `KB_DEEP_MODEL` |

Grounding rule: summarize chỉ dùng `messages.parts` có `tool_call` success + assistant messages có citation làm evidence — không hallucinate free-form.

### Vector store

- Qdrant collection mới: `kb_resolved` (tách khỏi log collection)
- Embed: `title + " " + symptom + " " + root_cause` (rút gọn, cheap)
- Reuse embedder từ [mcp-semantic/src/mcp_semantic/embed.py](../../mcp-semantic/src/mcp_semantic/embed.py) hoặc [indexer/](../../indexer/)
- Redact PII trước embed qua [agent/src/agent/redact.py](../../agent/src/agent/redact.py)

### Phase 1 — KB creation từ chat (1 tuần)

**Scope:**
- DB migration schema
- Button "Mark Resolved" trong conversation UI (`web/src/app/chat/`)
- API `POST /api/kb/summarize` — input `conversationId` → gen entry (draft) → return cho member review
- API `POST /api/kb/entries` — commit entry sau khi member edit
- Auto-classify dept/topic/issue qua LLM cùng lúc summarize
- Insert-time semantic dedup: cosine >0.9 với entry sẵn → prompt merge/upvote
- Embed → Qdrant

### Phase 2 — /kb browse tab (1 tuần)

**Scope:**
- Page `/kb` (Next.js app route):
  - Search box (hybrid semantic + BM25 title)
  - Filters cascade: department → topic → issue_type
  - Card list: `[✓badge] title • dept/topic/issue • symptom preview (2 dòng) • ▲upvotes`
- Page `/kb/[id]`:
  - Full symptom + root_cause + fix
  - Link source conversation
  - Inline edit (mọi member) → tạo record `kb_edits`
  - Upvote / Verify button
- API `GET /api/kb?dept=&topic=&issue=&q=&limit=`
- API `PATCH /api/kb/:id`, `POST /api/kb/:id/upvote`, `POST /api/kb/:id/verify`

### Deferred (không trong MVP)

- Sidebar auto-suggest realtime khi member gõ trong chat
- Telegram alert append KB link
- Grafana tooltip
- Nightly auto-curate conversations idle >24h
- Entry versioning (chỉ giữ audit trail edits qua `kb_edits`)

---

## Rủi ro + mitigation

| Rủi ro | Mitigation |
|---|---|
| LLM summarize sai/hallucinate | Grounding tool_call evidence; member MUST review draft trước save |
| KB trùng lặp nhiều | Insert-time cosine dedup >0.9 → merge flow |
| PII trong summary (IP, hostname) | Reuse `agent/redact.py` trước embed và trước lưu DB |
| Member không bấm "Mark Resolved" | Chấp nhận trong MVP; Phase 3 auto-curate lấp gap sau |
| Cold start (chưa có KB) | Backfill script: chạy summarize toàn bộ conversations hiện có 1 lần (opt-in) |
| Quyền — ai cũng edit | Audit trail `kb_edits`; badge "Trusted" khi verified≥1 hoặc upvotes≥3 |

---

## Success metrics

- **Coverage:** % conversations được convert thành KB entry (target: >30% sau 1 tháng)
- **Reuse:** % chat mới có ≥1 KB match >0.7 → được view (target: >30%)
- **Quality:** % entries verified/upvoted ≥3 (target: >20%)
- **Time saved:** self-reported "đã giúp tôi tiết kiệm bao nhiêu phút" (target: median >15 min/case)

---

## Implementation dependencies

- ✅ Postgres `conversations` + `messages` (schema có)
- ✅ Qdrant (đang dùng cho logs)
- ✅ Embedder (mcp-semantic/indexer)
- ✅ Redact module (`agent/redact.py`)
- 🟡 LLM provider abstraction — trạng thái plan `260701-1544-llm-provider-abstraction` (kiểm tra đã ship chưa)
- ❌ Next.js `/kb` route + components (build mới)
- ❌ Drizzle migration + repository layer cho `kb_entries`, `kb_edits`, `kb_taxonomy`

---

## Next steps

1. Chốt design này → OK
2. Invoke `/ck:plan` với brainstorm context → tạo folder `plans/260716-1422-chat-conversations-kb-search/` với phase files
3. Verify status LLM provider abstraction plan trước implement
4. Phase 1 → Phase 2 sequential
5. Post-MVP review sau 1 tháng: đánh giá metrics → quyết định Phase 3

---

## Unresolved questions

1. Backfill conversations cũ có nên chạy ngay lúc release Phase 1 không, hay chờ team quen UX rồi mới backfill? (recommend: manual trigger admin sau Phase 1 stable)
2. Có cần bảng `kb_upvotes(entry_id, user_id, at)` để tránh 1 user upvote nhiều lần không? (recommend: có, tránh gaming)
3. `verified_by` là mọi user hay chỉ user có `role='admin'` trong `users` table? (schema hiện có `role` — có thể chỉ admin verify, mọi member upvote)
4. Provider LLM abstraction plan 260701-1544 đã implement xong chưa? Nếu chưa → Phase 1 phải hardcode 1 provider trước
5. Search "hybrid BM25 + semantic" — dùng Postgres `tsvector` (BM25-like) hay chỉ semantic Qdrant filter theo dept/topic là đủ MVP?
