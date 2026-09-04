---
title: NATS disk crisis 81% — emergency purge + hard cap + client alert triage
slug: nats-disk-crisis-emergency-purge
date: 2026-08-26
type: brainstorm + emergency-ops
status: resolved
host: onelog-vps (prod)
severity: high (disk >80%, log loss risk)
followup_to: plans/reports/brainstorm-260825-1652-onelog-disk-optimization-nats-necessity.md
---

# NATS disk crisis — emergency purge + hard cap

## Problem statement

User báo disk >80% ~08:07 Vietnam Aug 26. Log tập trung KHÔNG được phép mất data. Cần xử lý ngay + hướng long-term tránh lặp lại.

## Findings (pre-fix, 08:07)

**Disk state:**
- `/dev/sda2`: **81G/100G (81%)** ⚠️ passed HostDiskRootWarn 75%
- 29 alerts firing (verify sau)

**NATS state:**
- Stream `LOGS`: **48.72 GB / 112.3M messages** (+10 GB from 16h ago)
- max_age=72h, compression=s2, discard=old, max_bytes=unlimited
- first_ts đúng 72h ago → rollover working, nhưng bytes vẫn grow
- Consumer pending=0, redelivered=0 (Indexer real-time)
- JetStream cap 58.6 GB → NATS at 83% of cap

**Data breakdown:**
- NATS: 46 GB (54% of disk used)
- VL: 4.9 GB (grew from 1.7 → 4.9 in 16h — rollout traffic spike)
- Docker: 16 GB rootfs + 3.3 GB unused build cache
- OS + rest: ~10 GB

**Root cause of pressure:**
1. Ingest spike Aug 25 during 45-host Ansible rollout (traffic burst)
2. NATS pre-Aug 25 06:52 UTC blocks vẫn uncompressed (aging out gradual)
3. VL fresh log influx from new client behavior post-rollout
4. Docker unused images accumulating

## Constraint

**Log loss = KHÔNG được phép.** Phân loại data layers:
- VL (30d retention) — **thật sự user-visible log storage** — không được touch
- NATS (72h buffer) — **transient queue** cho Indexer, safe to purge nếu ack'd
- Vector queue (in-memory) — ephemeral
- Client rsyslog spool (500MB per host) — local buffer nếu OneLog down

Nếu disk full → Vector fails → syslog TCP từ chối → client spool overflow → **REAL log loss.** Đây là kịch bản phải tránh.

## Immediate actions taken (10 min, zero log loss)

**A) NATS purge to consumer ack_floor** (seq=147,032,653)
- Indexer đã ack 100% messages tới ack_floor → safe drop
- Command: `nats stream purge LOGS --seq=147032653 --timeout=120s --force`
- Result: 112M msgs → 6.8k msgs, 48.72 GB → 2.6 MiB
- **Zero log loss** (VL 30d retention giữ nguyên, Indexer không cần replay)

**B) Docker system prune**
- Command: `docker system prune -f`
- Reclaimed: 3.3 GB unused build cache + dangling images
- Zero runtime impact

**C) Stream max_bytes hard cap 25GB**
- Command: `nats stream edit LOGS --max-bytes=25GB --force`
- Defense-in-depth: nếu ingest spike 2x → cap hit → discard=old drops oldest, không crash Vector
- Zero log loss (VL vẫn giữ, chỉ ảnh hưởng replay window cho Indexer)

## Result (post-fix, 08:22)

| Metric | Before | After | Δ |
|---|---|---|---|
| Disk `/` | 81G/100G (81%) | **33G/100G (33%)** | **-48 GB freed** |
| NATS stream size | 46 GB | 13 MB | -46 GB |
| Docker unused | 3.3 GB | pruned | -3.3 GB |
| Free space | 20 GB | **68 GB** | +48 GB |
| Log loss | — | **ZERO** | ✅ |

## Alert triage (29 firing at emergency time)

| Alert | Count | Source | Related? |
|---|---|---|---|
| SystemdServiceFailed | 16 | **CLIENT hosts** | ❌ Client-side, ~90 events/host/5min |
| OomKillEvent | 10 | **CLIENT hosts** | ❌ Client memory pressure (LiteSpeed+MariaDB) |
| QdrantTemplateGrowthHigh | 1 | onelog-vps | Known, separate issue |
| SystemdSessionLimitReached | 1 | Client host | Client-side |
| DiskDataHighWarn | 1 | probably onelog-vps | Correlates with pre-fix state |
| SudoEscalation | 1 | Audit event | Expected during ops |

**Key insight:** OOM/SystemdFailed KHÔNG phải problem của onelog-vps — là CLIENT hosts (nethost-*, turboweb-*) đang có issue. OneLog đúng chức năng detect anomaly.

Timing correlation với disk crisis: cả 2 xuất hiện sau đêm Ansible rollout Aug 25 + traffic burst. Correlation, không phải causation.

## Steady-state projection (post-fix)

**Assumptions:**
- 45 host stable
- Ingest 330-500 msg/s (post-Vector-reclassify workaround, permanent)
- Compression s2 active for all future blocks
- max_bytes=25GB hard cap

**Forecast:**
- NATS steady state: 15-20 GB (72h × 330 msg/s × 413 bytes × 0.5 compression)
- Peak scenario: 25 GB (hits cap, discard=old kicks in — safe)
- VL: ~3 GB/30d retention (steady growth ~100MB/day)
- Total data dir: ~25-30 GB steady
- Disk usage: ~40-45 GB steady (33% + 10-15GB growth)

**Runway trước cần scale disk:** ~1 năm với 45 host stable. Nếu scale >100 host → cần disk 200GB+.

## Long-term recommendations (không urgent)

### 1. Add monitoring alert cho NATS storage trend
Vmalert rule fire khi NATS stream >20GB (early warn trước khi chạm 25GB cap):
```yaml
- alert: NATSStreamHigh
  expr: nats_stream_bytes / (1024*1024*1024) > 20
  for: 15m
  labels:
    severity: warning
```
Requires nats-exporter metrics exposed (đã có).

### 2. Investigate client OOM + SystemdFailed
Riêng plan — không phải OneLog issue. Fleet health investigation:
- Which hosts OOM most frequently?
- Memory sizing đủ chưa? (LiteSpeed + LSPHP + MariaDB workload profile)
- dbgovernor kill sequences hợp lý chưa?

### 3. Consider Qdrant retention policy
QdrantTemplateGrowthHigh alert firing — templates accumulate forever, no TTL. Long-term concern. Design TTL job hoặc rebuild collection periodically.

### 4. Docker log driver uniform limits
Chỉ VL container có `max-size:100m max-file:3`. Audit + set uniform cho toàn stack để tránh 1 container log verbose ăn disk.

### 5. Automate periodic NATS purge (defense in depth)
Cron job weekly purge NATS tới consumer ack_floor. Prevents runaway buildup nếu compression ratio drift hoặc ingest spike undetected.

## Risks + mitigation (post-fix state)

| Risk | Mitigation |
|---|---|
| Ingest spike 2x+ → NATS hit 25GB cap | discard=old drops oldest, Vector không block. Log lost = only from NATS buffer (>72h old), VL intact |
| Indexer stall + max_age drop unacked | Not applicable now (pending=0, real-time processing). Nếu Indexer chết → 72h replay OK |
| VL grows unexpectedly fast | Already alert (DiskDataHighWarn). Manual retention tune nếu cần |
| Docker log grows unbounded per container | Audit & set uniform (follow-up #4) |
| Disk fill silent (no early warn) | Add NATS trend alert (follow-up #1) |

## Success criteria (all met)

- [x] Disk usage <50% after immediate action
- [x] NATS storage <15 GB (dropped to 13MB, will refill to steady ~15-20GB)
- [x] Zero log loss (VL intact, Indexer already ack'd purged content)
- [x] Vector + Indexer + NATS all healthy
- [x] Hard cap installed (max_bytes=25GB)
- [x] Root cause + follow-ups documented

## Unresolved

1. **NATS trend alert chưa add** — follow-up #1
2. **Client fleet OOM/SystemdFailed** — cần separate investigation, 45-host health audit
3. **Qdrant retention TTL** — no policy, long-term time bomb
4. **Docker log limits audit** — follow-up #4
5. **Automate weekly NATS purge?** — trade-off complexity vs safety net
