---
title: Vector-side dedup — optimize NATS input cho scale 70-100 host
slug: vector-dedup-scale-100-host
date: 2026-08-26
type: brainstorm
status: agreed
host: onelog-vps (prod)
approach: Option B — Vector reduce transform + Indexer counter refactor
followup_to:
  - plans/reports/brainstorm-260826-0807-nats-disk-crisis-emergency-purge.md
  - plans/reports/brainstorm-260826-0834-nats-25gb-cap-impact-scale-analysis.md
---

# Vector-side dedup — scale 70-100 host

## Problem statement

Roadmap scale từ 45 → 70-100 host. Hiện tại Vector ship 100% events tới NATS, nhưng Drain3 dedup 85-90% ở Indexer output layer (batch 500 events → chỉ 56-72 new templates ghi Qdrant). Bandwidth waste tại NATS transport layer. User muốn dedup upstream để tối ưu đầu vào Indexer.

## Current state analysis

**Ingest math (baseline verified):**
- 45 host post-Vector-reclassify: 328 msg/s
- Per-host: 7.3 msg/s
- Extrapolation 100 host: 730 msg/s → NATS steady 18.7 GB (75% of 25 GB cap)
- 85 host: NATS ~20 GB → `NATSStreamSizeHighWarn` fire

**Indexer throughput:**
- Current: 1250-2500 msg/s (500 events/0.2-0.4s per batch)
- 100 host workload: 730 msg/s → **1.7-3.4x headroom** — Indexer chưa phải bottleneck
- Batch efficiency: 500 events → 56-72 new points (~85-88% events là dup ở Drain3 stage)

**Dedup landscape:**
- Vector: ❌ NO dedup/reduce/throttle transform hiện tại
- NATS: `duplicate_window: 120s` có sẵn nhưng Vector sink không set `Nats-Msg-Id` → không kick
- Indexer/Drain3: ✅ Dedup 99.93% ở output (86.6M msgs → 60,407 templates)

## Evaluated approaches

### Option A: Vector `dedupe` transform (native)
- **NATS ↓** 90% (18.7 GB → ~2 GB steady)
- **Effort:** 30 phút
- **Trade-off:** Drain3 mất counter → cluster.count sai → dashboard/alert trending broken
- **Verdict:** Quick but analytics-hostile

### Option B: Vector `reduce` transform + Indexer `.count` support ⭐ CHOSEN
- **NATS ↓** 80% (18.7 GB → ~4 GB steady)
- **Preserve** Drain3 counter (Indexer đọc `.count` field)
- **Effort:** 1-2 ngày (Vector config + Indexer refactor + test)
- **Latency:** +30s (reduce window)
- **Verdict:** Best long-term ROI

### Option C: Vector `throttle` (rate limit)
- **NATS ↓** 50% (partial cap on burst)
- **Effort:** 30 phút
- **Trade-off:** Silent drop, not true dedup
- **Verdict:** Middle ground, weaker

### Option D: Do nothing + bump cap khi warn fire
- **NATS ↓** 0%
- **Effort:** 5 phút khi warn fire (`max_bytes 25→40 GB`)
- **Verdict:** YAGNI defer

## Final recommendation: **Option B**

**Rationale:**
- Preserve TẤT CẢ Drain3 analytics (count, trending, "top errors last 24h" chuẩn)
- 80% NATS traffic reduction → runway đến 250+ host
- Investment 1-2 ngày, benefit dài hạn
- Indexer refactor rõ ràng (single function `batch_flush`)

## Design outline

### Vector config change
Insert `reduce_dupes` transform sau `reclassify_severity`, trước `warn_filter`:

```yaml
reduce_dupes:
  type: reduce
  inputs: [reclassify_severity]
  group_by: [".host", "._msg"]
  expire_after_ms: 30000
  merge_strategies:
    ".count": "sum"           # aggregate multiplicity
    ".first_ts": "min"         # earliest occurrence in window
    ".last_ts": "max"          # latest occurrence in window
    "._samples": "array"       # optional: keep 1-3 samples for context
    # Other fields: use "retain" (keep first) or "discard"

warn_filter:
  type: filter
  inputs: [reduce_dupes]       # was: reclassify_severity
  condition: '...'             # unchanged
```

Note: Vector `reduce` cần initial `.count = 1` on each event → thêm remap trước reduce hoặc set trong reduce.

### Indexer refactor (Python)
Current logic (pseudocode):
```python
for event in batch:
    template = drain3.add_log_message(event._msg)
    if template.cluster_id in seen: continue
    embed(template) → qdrant.upsert(...)
```

New logic to support `.count`:
```python
for event in batch:
    count = event.get("count", 1)  # fallback for non-reduced events
    template = drain3.add_log_message(event._msg, count=count)  # weighted add
    ...
```

Drain3 library có thể cần custom to support weighted count. Alternative: iterate `add_log_message` N times per event.

### Batch semantics
- Vector `reduce` emit event mỗi 30s (expire_after_ms=30000)
- Batch size vẫn 500 → nhưng mỗi event contains `count=N` → Indexer effectively processes `sum(counts)` messages
- Drain3 cluster.size accumulates correctly
- Qdrant point.count field updated proportionally

## Implementation considerations

1. **Vector `reduce` window tuning:** 30s balance. Ngắn quá → ít dedup. Dài quá → latency semantic search cao.
2. **Group_by key selection:** `[.host, ._msg]` — cùng host + cùng message = dedup. Nếu chỉ dùng `[._msg]` (không host) → cross-host dedup mạnh hơn nhưng mất host attribution.
3. **_samples optional:** giữ 1-3 sample messages/window để Indexer có context cho embedding (nếu message có variable). Không critical vì Drain3 đã handle templating.
4. **Fallback compatibility:** Indexer phải handle events KHÔNG có `.count` field (backwards compat trong transition period).
5. **Drain3 API:** Check if `add_log_message(msg, count=N)` supported natively. Nếu không, override method hoặc iterate.
6. **Rollout safety:** Deploy Vector change FIRST (adds `.count` field, doesn't break Indexer). Then Indexer refactor to read `.count`. Zero downtime.

## Risks + mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Drain3 lib không support weighted count | Refactor blocked | Fallback: iterate `add_log_message` N times (slower but correct) |
| `.count` field không được reduce chính xác | Wrong counters | Test kỹ Vector reduce config với known input |
| Vector reduce buffer memory grow | RSS spike | Monitor Vector memory + tune expire_after_ms |
| Batch latency +30s ảnh hưởng semantic search | User complaint slow | UX still <1 min end-to-end (acceptable) |
| Rollback path | Config revert | Vector transform + Indexer are separate commits, revert independent |

## Success metrics

- [ ] Vector reduce transform deployed, no error in logs
- [ ] `.count` field present trong NATS messages (verify qua nats-box sub)
- [ ] NATS ingest rate reduces 60-80% at same host count (measure before/after)
- [ ] NATS steady state storage: ~4 GB (vs current ~14 GB)
- [ ] Indexer processes correctly: cluster.size matches expected (weighted count)
- [ ] Drain3 templates count consistent với pre-dedup baseline
- [ ] Qdrant new templates rate KHÔNG giảm (chỉ dedup input, không dedup output)
- [ ] Grafana dashboards trending KHÔNG bị broken

## Success criteria for 100-host readiness

- NATS steady <5 GB at 100 host (buffer for spike)
- No cap warning (below 20 GB threshold)
- Indexer throughput sustained
- Semantic search latency <60s end-to-end

## Next steps

1. Create implementation plan cho Option B
2. Research Drain3 weighted count API (Python drain3 library docs)
3. Design test harness verify count semantics
4. Execute plan when dev bandwidth available

## Unresolved

1. **Drain3 API:** support `add_log_message(msg, count=N)` natively? — verify sau khi read drain3 docs / source
2. **Vector reduce initial `.count`:** cần remap trước reduce hoặc reduce hỗ trợ initial=1? — verify Vector docs
3. **_samples strategy:** giữ 1 sample hay array? Trade-off memory vs context quality
4. **Cross-host dedup:** group_by `[._msg]` (no host) vs `[.host, ._msg]` — user preference?
5. **Rollout timing:** deploy trước khi scale 70 host hay sau khi warn fire?
