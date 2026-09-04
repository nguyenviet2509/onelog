# Brainstorm — KB scale & chat trace speed

**Date:** 2026-07-24 08:05
**Trigger:** User hỏi "nếu KB nhiều lên có chậm không? tối ưu chat OpenWebUI thế nào?"
**Related plan:** [`plans/260724-0805-kb-chat-latency-quick-wins/`](../260724-0805-kb-chat-latency-quick-wins/plan.md)

## Scout finding (OneMCP search internals)

Source: Explore agent read `d:\Vietnt\Project\onelog\onemcp\backend\src\**` — key facts:

- Search = **Postgres FTS (tsvector GIN) + trigram GIN + unaccent** (VN diacritics stripped)
- **No pgvector semantic** (deferred P4 Part 2)
- **No Redis cache** — raw SQL every call
- Hard limit 20 default / 50 max; ranking: `ts_rank_cd*2 + trigram_sim + service_boost + tag_boost`
- Filter `a.status = 'published'` **at DB level** (WHERE clause line 151 `search.service.ts`)
- Returns `ts_headline` **snippet 25-word** — không full body
- Rate limit 30 req/min per IP
- Indexes: `ix_artifact_versions_body_search` (GIN tsvector), `ix_artifacts_title_trgm` (GIN trigram), btree on `status`, `service`

## Bottleneck theo scale

| KB size | FTS latency | Cảm giác user | Real bottleneck |
|---|---|---|---|
| 100 | <30ms | Instant | LLM think (2-5s) |
| 1K | 50-150ms | Instant | LLM think + multi-query |
| 5K | 150-400ms | Vẫn OK | Multi-query round-trip |
| 10K | 400ms-1s | Bắt đầu thấy | GIN scan + trigram |
| 50K+ | 1-3s | Chậm rõ | Cross-dept, no cache, no vector |

Với usage pattern OneLog (team ~10 người, ~5-20 KB/tuần): **~2-3 năm mới chạm 5K**.

## Kết luận premise (chưa verify — cần Phase 0 metrics)

**Hypothesis** bottleneck chat trace hiện tại KHÔNG phải Postgres FTS mà là:
1. LLM tự sinh 2-4 query rồi gọi search tuần tự → 4 round-trip
2. `onemcp_get` sau `onemcp_search` → thêm 1 round-trip
3. DeepSeek streaming TTFT ~500ms + tool-call parse
4. httpx TLS handshake mỗi request (không keep-alive) → ~100ms/call

**Caveat:** hypothesis dựa trên code reading, chưa đo. Phase 0 (metrics baseline N=15) sẽ verify.

## 3 hướng giải quyết — ranked

### A. Prompt tuning + persistent client + aggressive timeout (chọn — Quick Wins plan)
Zero infra. Effort ~75 phút. Target cắt 40-60% TTFT.

### B. Redis cache layer
Defer. Chỉ trigger khi VM metrics báo p95 search > 500ms hoặc > 100 search/phút. Hit rate < 20% cho query kiểu trace log → ROI thấp.

### C. pgvector semantic
Defer. Trigger khi KB > 10K hoặc user query natural language không khớp keyword. OneMCP roadmap P4 Part 2 đã cover.

### D. (chống chỉ định) Denormalize / materialized view / sharding
KHÔNG làm. Over-engineering với 5-20K rows/năm.

## Điểm mù cần biết

1. **OpenWebUI Function sandbox** có thể reset module state mỗi request → singleton pattern (Phase 2) có thể fail. Cần probe verify.
2. **`status=published` double-filter** — Tool hardcode + DB WHERE. Vô hại, nhưng cản feature "search cả pending của mình" sau này.
3. **`ts_headline` snippet trống** khi query dài không match → LLM có thể hallucinate. Cần fallback auto-get nếu snippet < 40 chars.
4. **Trigram GIN REINDEX time** khi > 20K rows: vài phút maintenance.

## Recommended actions (từ brainstorm → plan)

| # | Action | Effort | ROI |
|---|---|---|---|
| 1 | System prompt: 1-query + trust-snippet | 10min | ⭐⭐⭐⭐⭐ |
| 2 | Persistent httpx client + probe | 25min | ⭐⭐⭐⭐ (conditional) |
| 3 | Timeout split search=4s/get=8s + graceful degrade | 15min | ⭐⭐⭐ |
| 4 | Baseline metrics N=15 (**làm TRƯỚC**) | 45min | ⭐⭐⭐⭐ |
| 5 | Redis cache | 4h | ⭐⭐ (defer) |
| 6 | pgvector semantic | 1-2 ngày | ⭐⭐⭐⭐ (defer) |

## Unresolved

- OpenWebUI Function sandbox có persist module-level state không? → probe test Phase 2 step 1
- Ts_headline snippet quality thực tế ra sao với query VN dài? → observe trong Phase 0 baseline
- DeepSeek streaming TTFT có phải dominant thật không? → Phase 0 metrics sẽ trả lời
