---
title: NATS max_bytes 25GB cap impact analysis — 45→75 host scale
slug: nats-25gb-cap-impact-scale-analysis
date: 2026-08-26
type: brainstorm
status: agreed
host: onelog-vps (prod)
followup_to: plans/reports/brainstorm-260826-0807-nats-disk-crisis-emergency-purge.md
followup_action: plans/260826-0834-nats-monitoring-alerts/ (pending)
---

# NATS 25 GB cap impact — scale 45→75 host

## Problem statement

User hỏi: sau khi cài `max_bytes=25GB` hard cap trong disk crisis 08:07 sáng nay, cap này có ảnh hưởng gì khi scale từ 45 host hiện tại lên 75 host (thêm 30 host)?

## Baseline math

**Verified post-Vector-reclassify (perm workaround from Aug 25):**
- 45 host → 328 msg/s tổng ingest vào NATS `logs.warn`
- **~7.3 msg/host/s** per-host baseline

## Extrapolation table

| Host count | Ingest (7.3/s) | 72h steady state (compressed s2) | Vs 25 GB cap |
|---|---|---|---|
| 45 (now) | 328 msg/s | ~8.4 GB | **66% headroom** ✅ |
| **75 (target)** | **548 msg/s** | **~14 GB** | **44% headroom** ✅ |
| 100 | 730 msg/s | ~18.7 GB | 25% headroom |
| **133 (cap boundary)** | 970 msg/s | ~25 GB | **0% — cap hit** ⚠️ |
| 150 | 1095 msg/s | ~28 GB | -12% → discard=old |
| 200 | 1460 msg/s | ~37 GB | Severe cap hit |

**Formula:** `steady_gb = host_count × 7.3 × 72 × 3600 × 413 / (1024³) × 0.5` (0.5 = s2 compression factor conservative)

**Verdict cho 75 host:** Cap 25 GB **an toàn**, 44% headroom (11 GB buffer cho spike).

**Runway đến cap boundary:** ~130 host với ingest pattern hiện tại.

## Impact khi cap hit — graceful degradation

NATS `discard=old` behavior khi cap chạm:
1. Tự drop **oldest** messages first
2. Consumer pending=0 (Indexer real-time) → oldest dropped **đã được ack rồi** → **KHÔNG data loss cho Indexer**
3. Vector vẫn publish OK (không block)
4. VL vẫn nhận ALL events qua branch riêng (via `redact` sink)
5. Chỉ shrinks replay window (72h → 48h/24h tùy volume spike)

**Log user-visible KHÔNG mất.** Chỉ AI Indexer replay ability giảm (không phải business-critical).

## Scenarios cần chú ý

### Scenario 1: Vector reclassify_severity fail/revert ⚠️
- Ingest tăng 10x (5.4k msg/s như baseline pre-Vector-fix)
- 75 host: ~136 GB uncompressed / 72h = cap hit sau vài giờ
- discard=old kick in, giữ cap 25 GB
- **Mitigation:** monitor Vector reclassify health via alert
- Detection: `NATSIngestSpike` alert (>1500 msg/s = 3x expected)

### Scenario 2: Event storm ngắn hạn (DDoS, misbehaving app) ✓
- Ingest 3-5x trong 1-2h
- 75 host × 5x = 2700 msg/s → cap hit tạm thời
- discard=old drops oldest ack'd → no impact
- Sau storm end → NATS tự recover về steady state
- **Safe scenario** — cap protects, không crash

### Scenario 3: Scale >130 host ⚠️
- Cần raise cap 25 → 40+ GB
- HOẶC reduce max_age 72h → 48h (save 33% steady state)
- HOẶC scale disk (deferred plan 260821-1536 sẵn có, 1TB)

## Evaluated approaches (defense strategy)

### Approach A — Add monitoring alerts (RECOMMENDED)
2 alerts phòng vệ:
- **NATSStreamSizeHighWarn:** fire khi storage >20GB (80% of cap) — early warn 2-3 days
- **NATSIngestSpike:** fire khi rate >1500 msg/s — detect anomaly ingest

Zero infra change, chỉ thêm rules vào existing vmalert-metrics.

### Approach B — Raise cap preemptively
Set `max_bytes=40GB` ngay bây giờ để cover future scale
- Pros: ít lo lắng, no near-term action needed
- Cons: disk usage higher steady state (~15 GB thay vì ~8 GB), no visibility if runaway growth resume

### Approach C — Do nothing (rely on hard cap alone)
Cap 25GB sẽ protect nếu ingest spike
- Pros: simplest
- Cons: no visibility trước khi cap hit → surprise degradation

## Final recommendation: **Approach A**

Add 2 alerts phòng vệ. Không cần touch cap cho 75 host. Re-evaluate cap khi:
- Consistent >20 GB storage (alert fires) → analyze cause
- Approach 100 host mark → planned bump cap 25→40 GB
- Approach 130 host mark → execute deferred disk scale plan 260821-1536

**Timeline:**
- **Now:** Add 2 alerts (plan 260826-0834 created)
- **75 host phase:** monitor, no action expected
- **100 host phase:** bump cap 25→40 GB (5-min operation)
- **130+ host phase:** scale disk 100→200 GB (execute deferred plan 260821-1536)

## Implementation considerations

- Alerts route qua existing Alertmanager Telegram
- Threshold 20 GB conservative (allows 2 days response time trước cap hit)
- Threshold 1500 msg/s = 3x expected 75-host baseline (avoid false positive)
- Rules use `job="onelog-nats"` metrics (existing scrape config)
- vmalert-metrics reload không downtime

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Alert false positive from Ansible rollout | Alert fatigue | Threshold conservative; tune sau observe 1 week |
| Metric `reserved_storage` không phản ánh actual bytes | Alert wrong threshold | Baseline verify trong Phase 01 plan |
| vmalert reload fail | 5s downtime | Existing rules cached, no data loss |

## Success metrics

- 2 rules loaded và visible qua `/api/v1/rules`
- No false fires trong 7 ngày đầu
- Cap hit sự cố tương lai được detect >2h trước khi discard=old kicks in

## Next steps

1. Execute plan `plans/260826-0834-nats-monitoring-alerts/` (pending)
2. Monitor 7 ngày sau add alerts
3. Re-evaluate cap khi approach 100 host

## Unresolved

1. Baseline `gnatsd_varz_jetstream_stats_reserved_storage` scraped value chưa xác nhận khớp `curl :8222/jsz` bytes (verify trong plan Phase 01)
2. Nếu metric mismatch → cần custom exec probe. Cost: 1 more probe script.
