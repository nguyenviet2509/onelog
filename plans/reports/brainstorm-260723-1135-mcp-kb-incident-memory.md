# Brainstorm — mcp-kb: Incident Resolution Memory cho OneLog

**Date:** 2026-07-23 11:35 (Asia/Saigon)
**Owner:** trihd@inet.vn
**Status:** Approved — proceed to plan

## Problem statement
Team ops OneLog dùng OpenWebUI + mcp-vl + mcp-semantic để trace lỗi log. **Kết quả trace không được lưu lại có cấu trúc** → khi member khác gặp lỗi tương tự, phải chạy lại toàn bộ vòng LLM + Qdrant + LogsQL. Hệ quả:
- Đốt quota LLM (nhiều token cho vấn đề đã giải quyết)
- Chậm MTTR — mất kiến thức tập thể
- Không có "postmortem light" tự nhiên trong workflow

## Goal
Mỗi lỗi đã trace + fix thành công **được kế thừa** cho member tiếp theo trong ≤ 1 lượt hỏi, không đòi hỏi member phải tự search wiki/postmortem.

## Success metrics
- `kb_hit_rate` ≥ 30% sau 4 tuần dùng (tỷ lệ chat hits verified resolution)
- LLM token usage giảm ≥ 20% trên các câu hỏi lặp (đo qua Grafana LiteLLM dashboard)
- MTTR trung bình cho lỗi lặp giảm ≥ 50% (self-report team)
- ≥ 10 verified entries trong tháng đầu

## Evaluated approaches

| Option | Effort | Fit | Verdict |
|---|---|---|---|
| **A. LiteLLM Redis semantic cache** | 2-3 ngày | Cache raw response, stale silently, không có human verify | Quick-win phụ, không giải bài toán chính |
| **B. OpenWebUI KB built-in** | ~1 tuần | Manual, thiếu structured fields + auto-first-lookup | Không đủ, khó ép LLM hỏi KB trước |
| **C. mcp-kb FastMCP server + Qdrant collection** | 1-2 tuần | Structured, reuse infra sẵn (Qdrant + FastMCP pattern), enforce qua system prompt | **Chọn** |

## Recommended solution — Option C: mcp-kb

### Architecture
```
OpenWebUI ──▶ mcpo ──▶ mcp-kb (new)
                          │
                          ▼
                       Qdrant collection: resolved_incidents
                          │
                          └── (optional) sqlite: audit + verify state
```

### Data model (Qdrant payload)
```
{
  error_signature:   <sha256 of drain3 template>,
  embedding:         <question + resolution embedding>,
  question:          "why nginx 502 spikes at 3am",
  resolution:        "upstream php-fpm pool exhausted; tune pm.max_children=64",
  fix_commands:      ["systemctl restart php-fpm"],
  verify_logsql:     '_stream:{app="nginx"} status:502 | stats count()',
  resolved_by:       "trihd@inet.vn",
  resolved_at:       "2026-07-23T11:00:00+07:00",
  verified:          true|false,
  verified_by:       "..."|null,
  hit_count:         0,
  last_hit_at:       null,
  stale:             false,
  tags:              ["nginx","php-fpm"]
}
```

### MCP tools exposed
- `search_resolutions(query, min_score=0.85, only_verified=false, top_k=3)` — semantic search, trả kèm verified flag + age
- `save_resolution_draft(question, resolution, fix_commands, verify_logsql, tags)` — auto-called cuối chat (Hybrid mode)
- `verify_resolution(id)` — human gate, chuyển draft → verified
- `mark_stale(id, reason)` — flag entry lỗi thời

### Chat flow (system prompt enforcement)
1. Member hỏi → LLM **BẮT BUỘC** gọi `search_resolutions` trước tiên
2. Nếu có hit `verified=true` cosine ≥ 0.85 → trình bày cached resolution + prompt "Còn đúng không? (Yes = xong / No = trace lại)"
3. Nếu hit `verified=false` → hiển thị dưới dạng "candidate" + link tới người tạo
4. Miss / user chọn No → chạy full flow (mcp-vl + mcp-semantic + LLM)
5. Cuối turn (LLM tự quyết định khi user báo "fixed") → gọi `save_resolution_draft`
6. Member `/verify <id>` khi confirm hoạt động → verified=true

### Save mode: Hybrid (đã chốt)
- Auto-save DRAFT sau chat (dùng model rẻ như haiku/deepseek để summarize)
- Chỉ `verified=true` mới được trả về ở bước 2
- `verified=false` trả về ở bước 3 làm gợi ý, không phải fact

### Dedup / stale
- Save: check `error_signature` trùng → merge (tăng `hit_count`, append variant question) thay vì insert mới
- Stale: cron daily — entry > 90 ngày không hit hoặc log signature tái phát sau khi "resolved" > 3 lần → `stale=true`

### Curation UI (minimal)
- Static HTML trong `mockups/` hoặc endpoint `/kb` trong Caddy → list verified/draft/stale, thao tác verify/mark-stale
- Không build full CMS — đủ để review daily

### Observability
- Metric mới trong Grafana: `mcp_kb_search_total`, `mcp_kb_hit_total`, `mcp_kb_verify_total`, ước lượng `llm_tokens_saved`
- Log mọi call vào VictoriaLogs stream `mcp-kb`

## Implementation considerations & risks

| Risk | Mitigation |
|---|---|
| Cold-start rỗng → hit_rate 0% tuần đầu, team mất niềm tin | Seed 5-10 entries thủ công từ postmortem/journal cũ; ship kèm demo |
| LLM không tuân thủ "search KB first" | System prompt cứng + tool description rõ ràng; unit test prompt behavior; fallback dùng response_format ép tool call order |
| Auto-draft nhiều noise → verify không xuể | Thêm confidence score từ summarizer, chỉ hiện draft ≥ threshold; batch review UI hiển thị 5 draft/lần |
| Qdrant collection cross-contaminate với log-template embeddings hiện có | Tạo collection riêng `resolved_incidents`, khác dimension nếu embedder khác |
| Stale entry gợi ý sai fix → hỏng production | Luôn kèm `resolved_at` + banner "verified N ngày trước, tự kiểm tra"; verify_logsql để member tự re-check tình trạng hiện tại |
| Privacy: resolution chứa secret/log nhạy cảm | Chạy secret-scan (gitleaks pattern) trước khi save; redact IPs/tokens |

## Out of scope (giai đoạn này)
- Full incident management (SLA, on-call rotation, war-room) → không YAGNI
- RBAC multi-tenant → OneLog hiện single-team
- Auto-remediation (chạy fix_commands tự động) → chỉ hiển thị, member tự chạy

## Dependencies
- Qdrant (có sẵn)
- Embedder hiện tại của indexer (reuse)
- FastMCP 3.x pattern từ mcp-semantic (copy scaffold)
- mcpo (có sẵn, chỉ đăng ký thêm endpoint)
- LiteLLM cheap model cho summarizer (deepseek/haiku)

## Next steps
- Chạy `/ck:plan` sinh phase files:
  - Phase 1: scaffold mcp-kb service + Qdrant collection + docker-compose
  - Phase 2: search_resolutions + save_resolution_draft tools + auto-summarizer
  - Phase 3: verify/mark_stale + curation UI + system prompt integration
  - Phase 4: metrics + Grafana panel + seed data + docs

## Unresolved questions
- Endpoint expose curation UI qua Caddy nào? (`/kb/*` mới hay reuse sqlite-web pattern?)
- Threshold cosine 0.85 có phù hợp không? → cần thử nghiệm trên 20-30 câu hỏi thật đầu tiên
- Summarizer nên dùng model nào cụ thể — deepseek đã default, giữ nguyên hay haiku rẻ hơn?
- Có cần export/import KB (backup ngoài Qdrant snapshot) cho DR?
