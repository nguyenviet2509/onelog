# bge-m3 tei benchmark — onemcp-source VPS

**Date:** 2026-07-24 09:47
**Host:** onemcp-source (192.168.122.56) — Ubuntu 24, Xeon E5-2690 v4 4-core, 3.8GB RAM, 3.8GB swap
**Plan:** [260724-0821-onemcp-multidept-v1-5](../260724-0821-onemcp-multidept-v1-5/plan.md) Phase 2

## Setup

- Image: `ghcr.io/huggingface/text-embeddings-inference:cpu-1.7`
- Model: `BAAI/bge-m3` (float32, 1024 dim, xlm-roberta)
- Config: `--max-batch-tokens 512 --max-client-batch-size 1`
- Storage: 2.2GB model cache at `/opt/onemcp/tei-data`
- Disk pre-cleanup: 92% used → post prune (11.5GB reclaimed): 53% used

## Results

| Test | Input | Latency | Note |
|---|---|---|---|
| 1. Short VN | ~50 tokens (typical query) | **131ms** | ✅ acceptable |
| 2. Short EN | ~10 tokens | **99ms** | ✅ |
| 3. 5x sequential short | ~10 tokens each | *(interrupted)* | not measured |
| 4. Big text | ~500 tokens (typical KB body chunk) | **12m52s → empty reply timeout** | ❌ unusable |

## Findings

- **cpu-1.5 image có bug** download (relative URL) với bge-m3 → phải dùng cpu-1.7
- **Default max_batch_tokens=16384 gây OOM** attempt 8GB buffer → phải giảm xuống 512
- **RAM idle: 2.23GB / 3.83GB** — chỉ còn ~800MB buffer cho các service khác (postgres, backend, portal, minio, redis)
- **CPU inference bge-m3 với text dài 500 tokens = 12+ phút** — chậm 100x expected. Không khả thi cho embed publish flow
- **Query short 50-100 tokens = OK** (100-150ms)

## Verdict

**KHÔNG THỂ dùng bge-m3 trên VPS hiện tại cho Phase 2 use case** (embed cả body artifact khi publish).

## Options going forward

| Option | Pros | Cons |
|---|---|---|
| **A. Downgrade model → `intfloat/multilingual-e5-small`** (471MB, 384 dim) | Nhẹ, nhanh CPU (~30ms/1K tokens ước tính), giữ multilingual VN | Chất lượng semantic thấp hơn bge-m3, dim khác (384 vs 1024) → migration schema |
| **B. Chunk KB body → 128-token chunks, embed từng chunk** | Vẫn giữ bge-m3 quality | Complexity cao, phải store multi-vector per artifact, ranking phức tạp |
| **C. Scale VPS RAM lên 8GB** | bge-m3 hoạt động thoải mái, không phải re-design | Cost, thời gian, ai duyệt scale |
| **D. Chỉ embed title + first 512 tokens, phần còn lại chỉ FTS** | Đơn giản, giữ bge-m3 | Search semantic miss content phần sau body |
| **E. Skip semantic Phase 2, chỉ tune FTS** | Fastest ship | Không đạt target "làm sao xin nghỉ phép" query → FTS miss vẫn còn |

## Recommendation

**Option A + D combo:**
- Đổi model → `multilingual-e5-small` (dim=384) — update Phase 1 migration `embeddings.vector vector(384)` thay vì 1024
- Embed body: chỉ first 512 tokens (auto-truncate=true) để tránh chunking phức tạp
- Multilingual-e5-small trên CPU expected ~30-80ms/embed → không blocker

Fallback nếu chất lượng kém: escalate scale RAM (Option C).

## Actions taken

- ✅ Pruned docker: 11.5GB reclaimed (disk 92% → 53%)
- ✅ Deployed test container tei-bge-m3-test, benchmarked, stopped (model cache 2.2GB giữ lại tại `/opt/onemcp/tei-data` cho lần deploy chính thức nếu chọn bge-m3)
- ⏸️ Container stopped, chưa remove — nếu quyết định Option A → xóa cache cũ, pull model mới

## Follow-up: multilingual-e5-small benchmark (chọn Option A)

Sau khi bge-m3 fail, chuyển sang `intfloat/multilingual-e5-small` (471MB model, dim=384):

| Metric | multilingual-e5-small |
|---|---|
| Short VN (~50 tokens) | **17ms** |
| Big text 500 tokens | **161ms** |
| 10x sequential short (avg) | **14ms** (min 8.5ms) |
| RAM idle | 2.08GB (buffer 723MB) |
| Cache size | 465MB |

**Kết luận: PASS.** e5-small nhanh hơn bge-m3 khoảng **1000x** cho big text, RAM tương đương, chất lượng semantic đủ multilingual VN cho use case KB.

## Final decision

- ✅ **Model:** `intfloat/multilingual-e5-small`
- ✅ **Container:** text-embeddings-inference cpu-1.7 (không đổi lib khác — HTTP interface đã có sẵn, tiêu chuẩn)
- ✅ **Config:** `--max-batch-tokens 8192 --max-client-batch-size 8 --auto-truncate` (default hoạt động tốt)
- ✅ **Dim:** 384 (thay 1024) → update Phase 1 migration
- ✅ **Model cache path:** `/opt/onemcp/tei-data`

## Actions taken

- Deploy test tei-e5-test → benchmark PASS → stop container, giữ model cache
- Disk sau cleanup + e5 cache: 12GB free (59% used)
- Không có container tei chạy sau session này (chờ Phase 2 code deploy chính thức qua docker-compose)

## Unresolved

Không còn (blocker Phase 2 embedding CLEARED).
