---
title: NATS disk 34GB root cause — client rsyslog severity misclassification
slug: nats-disk-root-cause-severity-misclassification
date: 2026-08-25
type: brainstorm
status: agreed
host: onelog-vps (prod)
relates: plans/reports/brainstorm-260825-1334-onelog-disk-pressure-nats-tune.md
followup_to: plans/260825-1334-onelog-nats-tune-defer-1tb
---

# NATS disk root cause — severity misclassification flood

## Problem statement

Post-tune (compression=s2) NATS vẫn 34GB (chưa rollover). User hỏi tại sao NATS chiếm 34GB trong khi VictoriaLogs (cùng nguồn data, 30d retention) chỉ 1.2GB. Đây là tiếp theo brainstorm 260825-1334 để tìm root cause thật sự của disk pressure.

## Findings

### 1. Volume ratio bất thường

| | VictoriaLogs | NATS JetStream `LOGS` |
|---|---|---|
| Content | ALL severity events | severity=warning+ only (via Vector warn_filter) |
| Retention | 30d | 72h (3d) |
| Ingest rate | ~6,700 msg/s | ~5,400 msg/s |
| Storage | 1.2GB compressed | 34GB uncompressed |
| Bytes/msg | ~0.07 (columnar zstd) | ~413 (raw JSON + headers) |
| Compression ratio | ~5000x | ~1x (until s2 tune) |

**Ratio 5400/6700 = 80% events pass warn_filter.** Bất thường (expected 5-8% cho typical infra).

### 2. Severity distribution (VL query last 5min)

```
warning:  1,948,969  (95.6%)  ← flood
info:        49,320  (2.4%)
err:          5,130  (0.25%)
notice:       2,127
debug:        2,627
crit:             9
alert:            2
(empty):      6,487
Total:    2,020,671 / 5min
```

**95.6% logs = severity="warning" tại syslog transport layer.**

### 3. Content analysis (sample warning messages)

Actual message content bên trong messages severity=warning:
- `[NOTICE]` LiteSpeed access/redirect logs — **normal traffic, NOT warning**
- `[INFO]` LiteSpeed CLEANUP process signals — **routine ops**
- `[NOTICE]` LiteSpeed connection Content len logs
- `[Warning]` MySQL aborted connections — real warning (~1-2%)
- `[error]` ModSecurity WAF blocks — real error (~1%)

**Actual severity breakdown inside "warning"-tagged messages:**
- ~90-95% = NOTICE/INFO (misclassified traffic logs)
- ~3-5% = real warnings
- ~1-2% = real errors

### 4. Root cause chain

```
Client rsyslog config sai priority mapping
   ↓ (LiteSpeed/MySQL logs forwarded với facility.local* → priority=warning)
   ↓
Syslog message arrives Vector với .severity="warning"
   ↓
Vector warn_filter passes (trusts syslog priority naively, no content-level parsing)
   ↓
Publish → NATS logs.warn subject
   ↓
NATS ingest 5.4k msg/s × 72h × 413B = ~120GB unbounded (limited by max_bytes cap 58GB)
   ↓
Indexer consumer throughput ~1-2k msg/s → không catch up → 20M+ pending
   ↓
Disk pressure 65G/100G
```

### 5. NATS thực sự làm nhiệm vụ gì?

**Role trong OneLog architecture:**
- **NOT log storage** — VictoriaLogs mới là log store (query, search, retention)
- **Message queue buffer** giữa Vector và Indexer AI pipeline
- Indexer consume batches → Drain3 clustering (log templates) → embed → Qdrant vectors
- 72h retention = replay window cho Indexer restart / catch-up debug
- Backpressure absorption (Vector không block khi Indexer chậm)

**Design intent:** ~500 msg/s real warn+/err → 72h × 500 × 400B = ~5GB. Reasonable buffer.

**Reality:** ~5400 msg/s misclassified → 72h × 5400 × 413B = ~120GB (capped 58GB) — 10x hơn intent.

### 6. Post-tune expectation (compression=s2 chỉ)

- Compression s2 nén raw JSON ~2-3x
- 34GB uncompressed → ~10-15GB compressed (sau 72h rollover)
- Vẫn 10x hơn design intent → **compression chỉ bandaid, không fix root cause**

## Evaluated approaches

### A. Fix client rsyslog config (đúng root cause)
Ansible rollout rsyslog config chuẩn cho 50 host → preserve internal log level từ app → syslog priority match content.

**Pros:**
- Fix đúng root cause
- Correct severity distribution ở TẤT CẢ downstream (VL, NATS, future consumers)
- Metrics/alerting chính xác hơn

**Cons:**
- Cần Ansible rollout tới 50 host — có risk deployment
- Không immediate — mỗi host cần config change + rsyslog restart
- Yêu cầu identify tất cả app patterns (LiteSpeed, MySQL, Apache, custom apps)

### B. Fix Vector re-classification (workaround nhanh)
Thêm Vector transform trước `warn_filter` parse `.message` regex, override `.severity` dựa trên internal level marker `[NOTICE]/[INFO]/[error]/[Warning]`.

**Pros:**
- Zero client-side change
- Effect ngay khi Vector reload config
- Centralized logic (1 nơi thay vì 50 host)
- Reversible qua config revert

**Cons:**
- Workaround, không đúng root cause
- Nếu app đổi format log → phải update regex
- Vector CPU overhead thêm (regex per message)
- Không fix cho VL — VL vẫn nhận severity=warning cho NOTICE logs (nhưng VL storage rẻ, chấp nhận được)

### C. Sampling / rate limit
Vector `throttle` transform sample 10% for NOTICE/INFO trước NATS. Giữ signal statistical.

**Pros:**
- Đơn giản hơn regex re-classification
- Giữ signal cho AI clustering (statistically representative)

**Cons:**
- Vẫn ăn 10% volume flood
- Lose specific events (bad for incident forensics)
- AI clustering có thể miss patterns rare

### D. Tắt Indexer + NATS
Nếu AI Indexer value chưa rõ, tắt hoàn toàn Indexer + NATS. Chỉ dùng VL.

**Pros:**
- Save 30GB+ storage
- Save Indexer CPU + Qdrant storage
- Simpler architecture

**Cons:**
- Lose AI clustering / semantic search feature
- Dev investment lãng phí
- Nếu tương lai cần AI → rebuild

### E. Kết hợp B + A (RECOMMENDED)
B ngay (Vector re-classify) → immediate 90% drop.
A song song (Ansible rollout) → correct root cause dài hạn.
Post-A: có thể revert B (giữ clean architecture).

## Final recommendation: **Option E (B ngay + A dài hạn)**

**Rationale:**
- B: Zero-downtime, immediate effect, blast radius = 1 file (Vector config)
- A: Root cause fix, long-term correctness, but 50-host rollout cần plan careful
- E kết hợp: có immediate relief + roadmap fix đúng
- Sau A hoàn tất, revert B để giữ Vector config clean (chỉ trust syslog priority)

## Implementation considerations

### Option B (immediate — Vector transform)

Vector config addition (before `warn_filter`):

```yaml
transforms:
  # Re-classify severity based on internal log level marker
  # Client rsyslog sends everything as priority=warning; parse actual level from message.
  reclassify_severity:
    type: remap
    inputs: [redact]
    source: |
      # Extract internal log level from message body
      msg = string!(.message)
      if match(msg, r'\[Warning\]|\[WARN\]|\[warning\]') {
        .severity = "warning"
      } else if match(msg, r'\[Error\]|\[error\]|\[ERR\]') {
        .severity = "err"
      } else if match(msg, r'\[Critical\]|\[crit\]|\[FATAL\]') {
        .severity = "crit"
      } else if match(msg, r'\[NOTICE\]|\[Notice\]') {
        .severity = "notice"
      } else if match(msg, r'\[INFO\]|\[Info\]|\[DEBUG\]') {
        .severity = "info"
      }
      # else: keep original severity (fallback trust syslog priority)

  warn_filter:
    type: filter
    inputs: [reclassify_severity]  # changed from [redact]
    condition: 'includes(["warning", "warn", "err", "error", "crit", "alert", "emerg"], string!(.severity))'
```

**Deploy:**
1. Edit `/opt/onelog/infra/vector/vector.yaml` VPS
2. `docker compose restart vector` (or `curl :8686/quit` for graceful reload if API support)
3. Verify NATS ingest rate drops 90% within 1-2 min
4. Sync config về local repo + push (Vector config IS git-tracked)

### Option A (long-term — Ansible rsyslog rollout)

Scope:
- Identify actual apps forwarding logs (LiteSpeed, MySQL, Apache, custom)
- Design rsyslog config template preserving priority per app
- Ansible playbook rollout to 50 host
- Validation: sample host severity distribution before/after
- Rollback plan per-host

Estimated effort: 1-2 tuần dev + test lab hosts trước prod rollout.

## Risks + mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Vector regex miss pattern → mis-classify | Some real warnings dropped | Test on sample data trước deploy; keep fallback = trust syslog priority nếu no marker match |
| Vector regex CPU overhead | Vector CPU +10-20% | Monitor CPU post-deploy; regex simple + short-circuit fast |
| App changes log format → regex broken | Silent classification failure | Alert on severity distribution shift (unusual spike/drop) |
| Ansible rollout breaks 50 host rsyslog | Downtime log ingest | Rollout 1 host → 5 host lab → prod batches; canary validation |
| B deployed nhưng A không xong → cả 2 tồn tại → maintenance burden | Config drift | Document clearly, add TODO cleanup post-A |

## Success metrics

**Post-Option B (immediate):**
- NATS ingest rate: 5.4k msg/s → **<600 msg/s** (10% of before, chỉ real warn+/err)
- Indexer consumer pending: 20M → **catch up to <1M within 24-48h**
- NATS storage sau 72h rollover: 34GB → **<5GB**
- Disk `/dev/sda2`: 65G → **<35G**

**Post-Option A (long-term):**
- VL severity distribution: warning 95% → **warning ~5%**
- Vector re-classify transform removable (revert Option B)
- Client-side syslog priority accurate for future consumers

## Next steps

1. Create implementation plan cho Option B (immediate — Vector re-classify)
2. Deploy Option B, verify metrics
3. Create separate plan cho Option A (Ansible rollout) sau khi B stable
4. Sau A hoàn tất: revert B, keep architecture clean

## Unresolved

1. **Regex coverage:** liệt kê đầy đủ app patterns (LiteSpeed, MySQL, Apache, LSPHP, ModSecurity, custom apps)? Cần sample thêm host để cover edge cases.
2. **Empty severity messages:** 6,487 msgs/5min có `.severity=""` — origin nào? Cần trace source.
3. **Real WARN+ rate estimate:** sau re-classify, expected NATS ingest ~500 msg/s? Cần verify với sample trước deploy.
4. **Indexer catch-up time:** với 20M pending + 1-2k/s process rate → ~3-6h catch up. Có nên purge pending không?
5. **NATS chưa rollover:** old 34GB blocks vẫn uncompressed. Force manual purge (`nats stream purge`) sau khi Indexer catch up để tăng tốc effect?
