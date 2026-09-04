# Brainstorm: Broad query guard + KB call gating

**Session**: 260822-1329 · Asia/Saigon
**Trigger**: User quan ngại 2 điểm khi 70 hosts forward log về VL:
  1. Broad query không filter host → có overload như incident 2M tokens không?
  2. Rule 1 hiện BUỘC gọi KB trước MỌI câu → có lãng phí không?
**Decision**: Rewrite rule 1 thành intent classifier + thêm rule 9e broad query guard. Commit `21497df`.

## Problem statement

### P1 — Broad query risk

Data thực tế (verify từ VL):
- Total: **47,138,235** log entries
- Top 5 hosts: mailer-0204 (15.9M), onehost-webhn092302 (7.8M), onehost-webhn072403 (8.1M), authway (45k), onemcp (18k)
- Distribution cực skewed — 2-3 hosts chiếm 60-70% volume

Với rule 9c hiện có `| limit 50` cho raw fetch:
- Query broad `severity:err _time:1d | limit 50` → VL sort by time DESC, trả 50 dòng mới nhất
- 50 dòng nhiều khả năng đến từ 1-2 hosts dominant (mailer-0204 dominant)
- 60+ hosts còn lại có thể có critical alerts nhưng KHÔNG lọt vào 50 rows
- False-negative debugging severe

### P2 — KB call waste

Rule 1 hiện: mọi câu hỏi log/incident → `onemcp_search` TRƯỚC.

Cost mỗi KB call vô ích:
- ~1-2 giây latency
- ~500-1500 tokens context (tool schema wrapper + response)
- 1 quota trong cap 6 tool calls/turn (rule 17)

Phân loại intent thực tế phòng KT:
| Intent | Ví dụ | KB value |
|---|---|---|
| Data fetch | "show 10 log err mailer-0204" | ❌ Không |
| Problem-solving | "vì sao mail down", "cách fix 502" | ✅ Cao |
| Exploratory | "24h qua có gì bất thường" | 🟡 Trung bình |

Ước lượng: 40-60% câu hỏi hàng ngày là data fetch → wasted KB calls.

## Approaches evaluated

### Q1 — Broad query strategy

| Option | Behavior | Trade-off |
|---|---|---|
| **Chosen: Overview-first** | Broad → stats by host → user drill → raw fetch | +1 turn nhưng cover 70 hosts, insight tốt |
| Force clarify | Broad → hỏi host? → không tool | UX friction nặng, expert bực |
| Auto top-N hosts | Broad → auto drill 5 hosts nhiều err | Phức tạp, có thể miss host quan trọng |

### Q2 — KB gating strategy

| Option | Behavior | Trade-off |
|---|---|---|
| **Chosen: Intent classifier** | Keywords "fix/vì sao" → KB. "show/list" → skip KB | Lược 40-60% KB calls, có ~10% classify sai |
| Explicit only | KB chỉ khi user bảo "check KB" | Bỏ lỡ value KB không biết |
| Keep as-is (safety-first) | Luôn KB trước | Waste 40-60% cases |

### Level implementation

| Option | Behavior |
|---|---|
| **Chosen: Prompt-only** | Rule mới trong system prompt, LLM tự classify. KISS. |
| Pre-flight Filter | Python Filter regex match trước LLM. Deterministic nhưng +code +install |

## Final solution

### Rule 1 rewrite — Intent classifier

**Trước**: BUỘC gọi `onemcp_search` TRƯỚC MỌI câu.

**Sau**: chia 3 branch (1a/1b/1c) dựa keyword classify.

- 1a PROBLEM-SOLVING (fix / vì sao / troubleshoot / runbook / how to / recover / khôi phục): KB first
- 1b DATA QUERY (show / list / count / stats / thống kê / xem log): SKIP KB, đi thẳng log tools
- 1c AMBIGUOUS: HỎI user clarify trước khi gọi tool

### Rule 9e mới — Broad query guard

```
Query VL KHÔNG có filter host: hoặc service: → BUỘC stats by (host)/(service) TRƯỚC.
Sau overview → user drill → raw fetch với filter đầy đủ.
✅ severity:err _time:1d | stats by (host) count() as errs | sort by (errs desc) | limit 20
❌ severity:err _time:1d | limit 50
```

### Files changed

- [`infra/openwebui/system-prompt-ops.md`](../../infra/openwebui/system-prompt-ops.md) commit `21497df`
- Defense-in-depth table thêm 2 rule
- Version note top-of-file cập nhật timestamp 260822-1329

## Implementation checklist

- [x] Edit prompt file (rule 1a/1b/1c + rule 9e)
- [x] Commit + push origin/master (`21497df`)
- [x] Sync VPS git reset --hard (clean tree)
- [ ] **User manual**: paste block mới vào Admin → Settings → Interface → Default System Prompt (hoặc per-model DeepSeek override)
- [ ] Test 3 câu mẫu:
    - "show 10 log err mailer-0204 24h qua" → LLM SKIP KB, gọi VL trực tiếp
    - "cách fix nginx 502" → LLM gọi onemcp_search trước
    - "hôm nay có lỗi gì" → LLM dùng `stats by (host)` trước, hỏi drill

## Impact assessment

| Câu hỏi | Trước | Sau | Tiết kiệm |
|---|---|---|---|
| "list 10 log X" | KB call + VL call | Chỉ VL call | ~2s + 1-2k tokens |
| "cách fix Y" | KB call + VL call | KB call + VL call | 0 (giữ nguyên) |
| "hôm nay có lỗi gì" | VL 50 rows (miss 60 hosts) | VL stats overview + drill có filter | Insight tốt hơn, không bloat |
| "24h qua bất thường" | Auto gọi KB | Hỏi user clarify | Không tự đoán lệch |

## Risks

1. **LLM classify sai intent** (~10% cases): VD "log X đâu rồi" — LLM có thể phân data query trong khi user muốn fix. Mitigation: rule 1c fallback hỏi clarify khi keyword không rõ.
2. **User dùng keyword không có trong classifier**: VD "check", "audit". Mitigation: rule 1c capture ambiguous, LLM hỏi clarify thay vì đoán.
3. **Broad query stats by host chạy chậm khi có 70+ hosts**: VL query 24h + stats by (host) trên 47M entries có thể timeout 25s LiteLLM. Mitigation: hint LLM giới hạn window nhỏ hơn (1h) cho broad, expand khi cần. Nếu vẫn timeout → thêm rule "broad query start with _time:1h".

## Success metrics (đo trong 1-2 tuần)

- **KB calls giảm 40-60%** khi user dùng data query keywords (verify qua LiteLLM logs)
- **Zero incident false-negative** (missed critical alert từ host không dominant)
- **User feedback**: không thấy nhiều friction từ clarify prompt (rule 1c)

## Resolved / Unresolved

### Resolved 260822-1343 — Broad query performance

Bench trực tiếp trên VL (47M entries):

| Query | Window | Latency |
|---|---|---|
| `severity:err \| stats by (host)` | 1h / 6h / 24h | 13-16ms |
| `_time:24h \| stats by (host)` (no severity filter) | 24h | 16ms |
| `severity:>=warn _time:24h \| stats by (host)` | 24h | 19ms |

Tất cả broad stats query < 20ms, xa dưới ngưỡng 25s LiteLLM timeout. VictoriaLogs index by _time + stats aggregation cực hiệu quả. **KHÔNG cần thêm rule `_time:1h` default** — over-restrictive không justify.

### Unresolved

- Chưa có metric đo tỷ lệ classify sai của LLM. Có thể thêm sau qua log tag `intent_class` trong system prompt (LLM tự declare intent trước khi gọi tool).
