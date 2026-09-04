---
title: OneLog disk pressure — root cause NATS misconfig, defer 1TB plan
slug: onelog-disk-pressure-nats-tune
date: 2026-08-25
type: brainstorm
status: agreed
host: onelog-vps (prod)
relates: plans/260821-1536-onelog-1tb-hot-disk-separation (defer)
---

# OneLog disk pressure — brainstorm summary

## Problem statement

User báo shipping log từ ~50 host về OneLog, hỏi disk còn bao lâu đầy, và có nên execute plan `260821-1536-onelog-1tb-hot-disk-separation` không.

## Findings (onelog-vps, 2026-08-25)

**Disk state:**
- `/dev/sda2` = 100GB, used **59G**, free **42G**
- Aug 21 → Aug 25 growth: 32G → 59G = ~6.75 GB/day net
- `/opt/onelog/infra/data` = 31G, phân bổ:
  - **NATS JetStream = 29G** (bomb)
  - VictoriaLogs = 1.1G (thực sự nhỏ)
  - OpenWebUI = 918M, Qdrant = 376M, VM = 183M

**NATS `LOGS` stream config:**
- `subjects: ["logs.>"]` — receive tất cả
- `max_age: 72h` (3 ngày)
- `compression: none`
- `retention: limits` (không WorkQueue → không auto-delete sau ack)
- `max_bytes: -1` (cap chỉ ở server 58.6GB)

**Consumer duy nhất `indexer-v1`:**
- `filter_subject: "logs.warn"` → chỉ đọc logs.warn
- `num_pending: 14.6M` messages
- `consumer_count: 1`

**Root cause:** ~80% messages (logs.info/error/debug) sit idle 3d rồi rớt theo max_age, không consumer nào đọc. Waste ~25GB.

**Runway:**
- Nếu tuyến tính (không cap): fill trong ~6 ngày
- Thực tế: NATS cap ở 58.6GB → tự chậm lại sau ~3 ngày cap-hit, VL growth chậm → **~2-3 tuần** trước critical
- Không phải "sắp đầy trong vài ngày" như ấn tượng ban đầu

**Scale context (from user):**
- 50 host đã ship xong + 20 host tới → **70 host steady state**
- Ingest expected: ~14 GB/day raw (nếu không tune NATS)

## Evaluated approaches

### Approach A — Fix root cause NATS, no new disk
Edit stream `LOGS` config online, không downtime. Bump VL retention 7d → 30d. Save ~15-25GB tùy aggressive/conservative.

**Pros:**
- Zero downtime, zero infra change
- Root cause fix, không phải bandaid
- Runway trên 100GB đủ vô hạn cho 70 host

**Cons:**
- Nếu tương lai add consumer mới cho subject khác (logs.info aggregate) và đã siết subjects → phải revert config

### Approach B — Execute plan 260821-1536 nguyên bản
Add 1TB, migrate 5 HOT services, VL retention 7d → 30d.

**Pros:**
- I/O isolation VL vs OS
- Chuẩn bị sẵn cho scale 200+ host

**Cons:**
- 5-10 min downtime
- 1TB waste cho ~10GB data thật (99% capacity thừa)
- Plan assumptions đã lệch (viết lúc HOT 3.4G, giờ 31G — mà 31G là do NATS bug, không phải data thật)
- Không fix root cause NATS misconfig

### Approach C — Hybrid (AGREED) ⭐
1. **Now:** Fix NATS conservative — giữ `subjects: ["logs.>"]`, giảm `max_age: 72h → 48h`, bật `compression: s2`. Expected save ~15GB.
2. **Bump VL retention** 7d → 30d (thêm ~5GB, negligible).
3. **Defer plan 1TB:** giữ ticket DC đang chờ, KHÔNG cancel. Đánh giá lại khi:
   - `/dev/sdb` gắn xong: check current disk usage post-tune → nếu <50GB thì cancel migration, để disk dành scale/compliance sau
   - Xuất hiện I/O contention (iowait, VL query slow)
   - Roadmap scale >200 host trong 6 tháng tới
   - Compliance nâng retention >30d

## Final recommendation

**Approach C — Conservative NATS tune + defer 1TB plan.**

**NATS edit target config:**
```
subjects: ["logs.>"]          # keep flexibility for future consumers
max_age: 48h                  # 72h → 48h (save 33%)
compression: s2               # none → s2 (save 50-70%)
retention: limits             # unchanged
```

**Expected result post-tune:**
- NATS: 30G → ~10-12G
- Total disk: 59G → ~40G (60% free)
- Runway: >6 tháng cho 70 host steady

**VL retention target:** 30 ngày HOT (sweet spot debug + compliance thường), S3 cold tier chỉ khi compliance yêu cầu >30d.

## Implementation considerations

1. **Compression change requires stream restart:** JetStream apply compression cho message MỚI sau edit; message cũ giữ nguyên uncompressed. Full effect sau ~48h (khi buffer roll over).
2. **max_age 72h → 48h:** message hiện đang 3d sẽ bị drop ngay khi apply. OK vì Indexer đã ack tới stream_seq 89.7M (only 14.6M pending recent).
3. **Verify Vector không dùng NATS:** confirm Vector push trực tiếp vào VL (bypass NATS). Nếu có consumer Vector khác thì cần review pending trước edit.
4. **Backup NATS config:** dump current config trước edit để có rollback path.
5. **Monitor 48h post-tune:** disk usage curve, NATS store size, Indexer consumer pending không tăng bất thường.

## Risks + mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Compression tăng CPU NATS | ~5-10% CPU | Monitor, s2 nhẹ hơn zstd |
| max_age 48h → mất replay window nếu Indexer down >2 ngày | Data loss cho warn analysis | Alert Indexer down >6h |
| Có publisher publish subject không ai consume → vẫn waste (chỉ giảm 33% qua max_age) | Vẫn tồn tại | Long-term: audit publishers, drop unused subjects |
| Ticket DC 1TB đã submit — nếu cancel muộn có charge | Chi phí nhỏ | Giữ ticket, defer quyết định đến khi disk gắn |

## Success criteria

- [ ] NATS `LOGS` stream config applied (subjects, max_age=48h, compression=s2)
- [ ] `curl :8222/jsz` verify config match target
- [ ] Sau 48h: NATS store size <15GB
- [ ] Sau 48h: disk usage `/dev/sda2` <45GB
- [ ] VL_RETENTION bumped 7d → 30d, verify với `curl :9428/select/logsql/query` on old timestamp
- [ ] Indexer consumer `num_pending` không tăng bất thường (baseline 14.6M ± 20%)
- [ ] Zero downtime confirmed
- [ ] Plan `260821-1536` status updated → `deferred` với note lý do

## Next steps

1. Create implementation plan cho NATS tune (1 phase, ~1h effort).
2. Update plan `260821-1536-onelog-1tb-hot-disk-separation` status: `pending` → `deferred`, add note referencing this brainstorm.
3. Set reminder recheck khi `/dev/sdb` gắn xong.

## Unresolved

1. **Vector ingest path vào VL:** confirm bypass NATS? Nếu Vector consume subject nào trên NATS thì cần liệt kê trước khi siết config.
2. **Publishers audit:** subject nào đang publish vào `logs.>`? Có subject nào orphan (no consumer, no plan)? — long-term cleanup, không blocker cho tune này.
3. **Snapshot cron `snapshot-daily.sh`:** đang backup NATS? Nếu có, verify vẫn OK sau compression change.
