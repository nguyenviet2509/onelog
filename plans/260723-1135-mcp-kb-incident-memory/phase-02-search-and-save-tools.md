# Phase 2 — search_resolutions + save_resolution_draft + summarizer

## Context
Phase 1 đã có scaffold + Qdrant collection. Giờ implement 2 tool chính + auto-summarizer.

## Priority
High — làm nên value chính của plan.

## Requirements

### Functional
- `search_resolutions(query, min_score=0.85, only_verified=false, top_k=3)` → list `{id, question, resolution, verified, resolved_at, hit_count, score, stale}`. Increment `hit_count` + set `last_hit_at` cho kết quả top-1 nếu score ≥ min_score.
- `save_resolution_draft(question, resolution, fix_commands=[], verify_logsql=None, tags=[], chat_ref=None)` → `{id, error_signature, dedup: "merged"|"created"}`. Auto-generate `error_signature` (sha256 của normalize(question)+normalize(resolution first-100-chars)). Nếu signature trùng → merge (append variant question, không overwrite resolution).
- Auto-summarizer helper `summarize_chat(chat_transcript) -> ResolutionDraft`: gọi LiteLLM với model rẻ, prompt trả JSON `{question, resolution, fix_commands, verify_logsql, tags, confidence}`. Nếu confidence < 0.5 → skip save.
- Redact secrets trước khi save: IP private/pub, tokens (regex sk-*, ey*), emails ngoài `@inet.vn`, path chứa `.env`

### Non-functional
- Latency search < 500ms p95
- Summarizer timeout 30s, fail-open (không block chat, chỉ log warn)

## Files to modify
- `mcp-kb/src/mcp_kb/main.py` — fill 2 tools
- `mcp-kb/src/mcp_kb/qdrant_store.py` — bổ sung `search_with_score`, `find_by_signature`, `merge_variant`
- `mcp-kb/src/mcp_kb/embed.py` — reuse
- (new) `mcp-kb/src/mcp_kb/summarizer.py` — LiteLLM client + prompt template + JSON parse
- (new) `mcp-kb/src/mcp_kb/redact.py` — port từ `agent/src/agent/redact.py`
- (new) `mcp-kb/src/mcp_kb/signature.py` — normalize + sha256

## Files to create
- `mcp-kb/tests/test_signature.py` — 5 cases: cùng question wording khác → cùng signature; khác lỗi → khác signature
- `mcp-kb/tests/test_redact.py` — IP/token/email/path
- `mcp-kb/tests/test_summarizer_prompt.py` — snapshot prompt template (không call LLM thật)

## Implementation steps

### 1. signature.py
```python
def normalize(text: str) -> str:
    # lowercase, collapse whitespace, strip timestamps ISO/epoch, strip UUIDs, strip IPs
    ...
def compute_signature(question: str, resolution: str) -> str:
    return sha256((normalize(question) + "|" + normalize(resolution[:100])).encode()).hexdigest()
```

### 2. redact.py
Port `agent/src/agent/redact.py` — cùng regex patterns. Apply cho `question`, `resolution`, `fix_commands`, `verify_logsql` trước khi upsert.

### 3. summarizer.py
```python
SYSTEM = """Bạn tóm tắt 1 cuộc chat trace lỗi log thành entry KB.
Trả JSON: {"question": "...", "resolution": "...", "fix_commands": [...], "verify_logsql": "...", "tags": [...], "confidence": 0.0-1.0}
Confidence thấp nếu: chat chưa kết luận, chưa xác nhận fix work, chỉ discuss.
Không suy diễn — chỉ trích từ chat."""
def summarize(transcript: str, model: str = "deepseek") -> dict | None:
    ...  # LiteLLM /chat/completions, response_format=json_object, timeout 30s
```

### 4. Tool `search_resolutions`
- Embed `query` → vector
- Qdrant search với filter `{stale: false}` (+ `verified: true` nếu only_verified)
- Filter client-side score ≥ min_score
- Nếu có top-1 với score ≥ min_score: `update_payload(id, {hit_count+=1, last_hit_at=now})`
- Emit audit log + metric (Phase 4 wire in)

### 5. Tool `save_resolution_draft`
- Redact tất cả input string
- Compute signature
- `find_by_signature(sig)`:
  - hit → `merge_variant`: append question vào `variant_questions` (payload list mới), giữ nguyên resolution + verified, return `dedup: "merged"`
  - miss → embed question → upsert với `verified=false, hit_count=0`, return `dedup: "created"`

### 6. Summarizer wiring
- Không tự động gọi từ mcp-kb (không có access chat transcript)
- Cách wire: system prompt OpenWebUI (Phase 3) sẽ hướng dẫn LLM tự gọi `save_resolution_draft(...)` khi user báo "fixed"
- summarizer.py chỉ được gọi bởi endpoint HTTP phụ `/summarize` (nếu ta cần batch import chat cũ) — optional, MVP không cần

## Todo
- [ ] signature.py + tests
- [ ] redact.py port + tests
- [ ] summarizer.py (chỉ code, không auto-trigger MVP)
- [ ] qdrant_store: search_with_score, find_by_signature, merge_variant
- [ ] Tool search_resolutions
- [ ] Tool save_resolution_draft
- [ ] Manual test: curl save → search → verify hit_count tăng
- [ ] Unit tests pass

## Success criteria
- Test: save 3 entries khác lỗi → search 1 câu tương tự → trả đúng top-1 score ≥ 0.85
- Test: save 2 entries cùng bản chất khác wording → signature dedup → merged (chỉ 1 doc trong Qdrant)
- Test: input có `sk-abc123` → sau save Qdrant payload không chứa string đó
- Test: search top-1 hit → hit_count tăng từ 0 → 1

## Risks
- **Signature quá strict** (cùng lỗi khác wording tạo signature khác) → collision rate thấp → nhiều duplicate. Mitigate: normalize aggressive (strip số, timestamp, IP), test 20 câu thực tế.
- **Signature quá loose** (lỗi khác nhưng cùng signature) → merge sai. Mitigate: dedup phải kèm cosine ≥ 0.9 check trước khi merge, không chỉ signature.
- **Redact false positive** ăn mất context có ích. Mitigate: log ra redacted diff để review.

## Security
- Redact BẮT BUỘC trước upsert
- Reject query > 4KB (DoS)
- Rate limit tool call: 30/min/token (Phase 3 hoặc defer)

## Next
Phase 3: verify/mark_stale + curation UI + OpenWebUI system prompt integration.
