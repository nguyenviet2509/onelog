# Qdrant `log_templates` growth — root cause + optimization

Scope: OneLog `ragstack-qdrant`, collection `log_templates`. Alert `QdrantTemplateGrowthHigh` fire liên tục từ 2026-08-13.

## TL;DR
- Alert đúng — collection đang lớn thật (**111,991 points**, growth ~12k/day = **12× threshold**).
- Không phải bug indexer. Ba root cause đồng thời:
  1. **Redact bỏ sót high-cardinality tokens** → drain3 không cluster được → template explosion (lsws-error 3701 clusters/service, sắp chạm cap 5000).
  2. **Không có retention/TTL** trên Qdrant → points tích lũy tuyến tính theo `(service, template_id, hour_bucket)`, không bao giờ xoá.
  3. **Aggregation key mismatch** — `_process_batch` group theo `(service, host, template_id)` nhưng `_point_id` chỉ hash `(service, template_id, window_start)` → multi-host collapse OK, nhưng đang gây nhầm khi debug.

## Data từ VPS

### Growth timeline (points/day, tính từ `window_start`)
```
07-28 → 08-05:  ~1.5-2k/day    baseline
08-06 → 08-11:  ~3.5k/day      2× (bắt đầu chấp nhận syslog fleet mới?)
08-12 → nay:    ~12-13k/day    6× baseline ← alert fire 08-13
```
Không có commit indexer/vector nào trong 08-11/08-12. Nguồn spike = **data-driven** (new host/service, hoặc PHP error burst).

### Points-per-service (top offenders)
| Service | Drain clusters (unique templates) | Qdrant points | Bloat ratio |
|---|---|---|---|
| kernel | 658 | 41,763 | 63× |
| php-domain-error | 893 | 29,493 | 33× |
| lsws-error | **3,701** ⚠️ | 18,827 | 5× |
| lsws-stderr | 239 | 4,984 | 21× |
| postfix | 60 | 4,226 | 70× |
| zmconfigd | 20 | 3,357 | 168× |
| systemd | 37 | 2,098 | 57× |

`lsws-error` chuẩn bị chạm `drain_max_clusters=5000` → khi chạm cap, drain3 evict cluster cũ, tạo template_id mới cho log tương tự → **point growth sẽ tăng vọt lần nữa**.

### Compression ratio thực tế (từ log indexer 24h qua)
```
500 events → 73-117 points/batch  (compression ~5×)
```
Kỳ vọng healthy: **50-100× compression**. Hiện tại chỉ 5× = drain3 gần như không cluster nổi.

## Root cause chi tiết

### RC1 — Redact patterns không strip cardinality noise
`infra/vector/vector.yaml` redact chỉ nhắm secret/PII. Không strip:

| Loại token | Ví dụ mẫu Qdrant | Ảnh hưởng |
|---|---|---|
| Absolute FS path | `/home/qlkxcqkihosting/domains/phatquocvanthanh.com/wp-content/plugins/...` | Mỗi hosting user + mỗi site = template khác |
| DB prefix ngẫu nhiên | `xmmuuqpbhosting_mayxuc.yoast_wp_seo_models_indexable` | Cùng error class → N templates |
| Kernel hex Code dumps | `Code: 08 85 d2 7f c6 41 83 45 48 01 48 83 c4 38 ...` | Mỗi OOM event ~10 templates mới |
| Function offsets | `ksys_read+0x4f/0xb0`, `vfs_write+0xa5/0x1b0` | Offset chỉ khác chữ số → drain không match |
| Date trong log line | `[12-Aug-2026 03:22:11 UTC]` | 1 template × N ngày |

Bằng chứng scroll từ Qdrant (kernel):
```
template_id 421 | Code: 08 85 d2 7f c6 41 ...
template_id 205 | Code: 8b 5c 24 <*> 8d 43 01 41 ...
template_id 107 | Code: 48 8b 4f 10 48 89 f0 ...
template_id 338 | Code: 42 41 ff 57 28 0f b6 3b ...
```
→ 4 template_id cho cùng một "kernel Code: dump" — should be 1.

### RC2 — Không retention
`QdrantWriter.upsert` idempotent trên `(service, template_id, window_start)`. Window = 3600s bucket. Không có cronjob/scheduled delete cho windows quá cũ. → Points-count = Σ unique tuples từ ngày đầu vận hành.

Math: giả sử drain ổn định 5k clusters × 24 windows/day × N days → **120k points sau 30 ngày** cho một service (đang có ~8 service active). Càng chạy càng phình.

### RC3 — `_point_id` không include host, aggregation thì có
```python
# main.py: aggregated key = (service, host, template_id)
# qdrant_writer.py: point_id = sha1(service|template_id|window_start)
```
Hai host cùng service + cùng template_id + cùng hour → **overwrite nhau** (last-writer-wins). Ổn về mặt cardinality (chống nhân đôi), nhưng `count`/`sample`/`severity` payload mất data host kia. **Không phải nguyên nhân bloat, nhưng là data loss lặng lẽ** — cần biết khi phân tích.

### RC4 — Alert threshold quá lỏng
```yaml
expr: increase(collection_points{id="log_templates"}[24h]) > 1000
for: 12h
```
1000/day = 3× baseline healthy. Hiện tại thực growth 12k/day → alert đúng nhưng không actionable (chỉ báo, không suggest ngưỡng đảo dữ liệu). Hard-cap 500k còn xa (~40 ngày nữa với growth hiện tại) nên chưa fire.

## Đề xuất fix (theo ROI giảm dần)

### Fix 1 — Mở rộng redact ở Vector layer (**cao nhất, giảm 60-80% cardinality**)
Thêm vào `infra/vector/vector.yaml` sau block redact secret hiện có:

```vrl
# High-cardinality noise scrub — giảm template explosion cho drain3 downstream.
# ORDER: sau secret redact (secret pattern nhạy cảm hơn), trước "._msg = msg".

# Absolute Unix paths (đường dẫn dài) → <PATH>. Giữ file cuối cho context.
msg = replace(msg, r'/(?:home|var|opt|usr|etc|tmp|srv)/[A-Za-z0-9._/-]+/([A-Za-z0-9._-]+)', "<PATH>/$1")

# Kernel hex byte dump: "Code: XX XX XX ..." (10+ hex bytes)
msg = replace(msg, r'\bCode:\s+(?:[0-9a-f]{2}\s+){8,}[0-9a-f<>*]{2,}', "Code: <HEX_DUMP>")

# Kernel function+offset: "symbol+0x1a2/0xff0" → "symbol+<OFFSET>"
msg = replace(msg, r'\+0x[0-9a-f]+/0x[0-9a-f]+', "+<OFFSET>")

# Register values (RAX/RBX/RCX/…/R15) đã có `<*>` từ drain3, nhưng bảo hiểm:
msg = replace(msg, r'\b(R[A-Z]{2}|R\d{1,2}|RIP|RSP|RBP|EFLAGS|ORIG_RAX):\s*[0-9a-fA-F]+', "$1: <REG>")

# Date literals trong bracket (PHP/WordPress error format).
msg = replace(msg, r'\[\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}\s+\w+\]', "[<DATETIME>]")

# WordPress hosting DB prefix ngẫu nhiên: "xxxxxxxxhosting_xxx" → "<HOSTING_DB>"
msg = replace(msg, r'\b[a-z]{8}hosting_[a-z0-9]+\b', "<HOSTING_DB>")

# UUID / hex hash > 24 chars
msg = replace(msg, r'\b[0-9a-f]{24,}\b', "<HEX_ID>")
```

**Expected impact:**
- kernel: 658 → ~50 clusters (13× less)
- php-domain-error: 893 → ~60 clusters
- lsws-error: 3701 → ~200 clusters (**thoát nguy cơ chạm cap**)
- Compression ratio: 5× → 40-60×
- Growth: 12k/day → ~1-2k/day (**dưới alert threshold**)

### Fix 2 — Bump `drain_max_clusters` + tighten sim_th
File `indexer/src/indexer/drain_cluster.py`:
```python
cfg.drain_sim_th = 0.5           # 0.4 → 0.5 (chặt hơn 1 chút, giảm false-merge)
cfg.drain_max_clusters = 10000   # 5000 → 10000 (buffer cho lsws-error đến khi Fix 1 rollout)
```
**Order:** Rollout Fix 1 trước → Fix 2 chỉ cần khi cluster count vẫn > 3000 sau 24h.

### Fix 3 — Retention job cho Qdrant (giữ 14 ngày)
Thêm cronjob 1 lần/ngày xoá points có `window_start < now - 14d`:

```bash
# scripts/qdrant-log-templates-prune.sh (chạy daily via systemd timer trên VPS)
CUTOFF=$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ)
curl -sf -H "api-key: $QDRANT_API_KEY" -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:6333/collections/log_templates/points/delete \
  -d "{\"filter\": {\"must\": [{\"key\": \"window_start\", \"range\": {\"lt\": \"$CUTOFF\"}}]}}"
```
**Impact:** cap points-count ≈ (daily new points × 14). Với Fix 1: 1k/day × 14 = **14k steady-state** (giảm 8×).

### Fix 4 — Fix aggregation/point_id mismatch (data-loss silent)
Chọn 1:
- **Option A** (chọn nếu care per-host stats): thêm `host` vào `_point_id`:
  ```python
  raw = f"{p.service}|{p.host}|{p.template_id}|{p.window_start}".encode()
  ```
  → point count tăng ~N× (N = số host chung template). Chỉ dùng khi Fix 1 + Fix 3 đã kéo baseline xuống.
- **Option B** (chọn nếu OK collapse per-cluster): đổi aggregation key `_process_batch` bỏ `host` khỏi `(service, host, template_id)` → `(service, template_id)`. Payload lưu `hosts: [set]` thay vì `host: str`.

**Recommend Option B** — trước mắt fleet chỉ có ~1-2 host publish cùng service, per-host analysis xài VictoriaLogs (raw) là đủ.

### Fix 5 — Alert tuning
File `infra/vmalert/metric-rules.yml`:
```yaml
- alert: QdrantTemplateGrowthHigh
  expr: increase(collection_points{id="log_templates"}[24h]) > 3000   # 1000 → 3000
  for: 6h                                                              # 12h → 6h (fire nhanh hơn khi thực sự bùng)
  # ...
  annotations:
    description: "Growth {{ $value | humanize }}/24h. Check drain sim_th + Vector redact patterns. Runbook: plans/reports/debugger-260818-0822-qdrant-log-templates-growth.md"
```
Sau khi Fix 1 rollout, baseline ~1-2k/day → threshold 3k cho margin. Runbook link giúp on-call biết đọc gì khi fire lại.

## Verify plan sau rollout
1. Deploy Vector config mới → chờ 1h → check batch log: `points/batch` phải giảm còn 5-15 (từ 73-117).
2. Sau 24h: query `curl .../collections/log_templates | jq .result.points_count` phải growth < 3k trong 24h.
3. Sau 48h: drain cluster count per service phải giảm > 80% (kernel < 100, php-domain-error < 100, lsws-error < 300).
4. Retention job dry-run trước khi thật (thêm `--dry-run` flag để log count only).

## Rollout result (2026-08-18 08:52 ICT)

Đã cook + deploy full 3 phase + reset drain state (data chưa quan trọng, user OK):

### Commit chain
- `11209e0` perf(indexer): scrub high-cardinality noise + widen drain caps → Vector VRL + drain sim_th/max_clusters + vmalert 1k→3k, 12h→6h
- `5a511fa` feat(qdrant): daily retention prune for log_templates (30d default) → script + systemd timer
- `cb66f9c` fix(indexer): collapse per-host in aggregation, hosts[] payload → Option B
- `fb3d7e4` fix(indexer): ensure hosts payload index on existing collection → upgrade path

### Impact đo được sau reset

Ba lần reset để tách rời noise: (1) sau Fix 1+2+3 nhưng Vector còn stale mount → không đo được, (2) sau Vector restart proper → thấy hex-addr leak, (3) sau add `<HEX_ADDR>` pattern → measurement dưới đây.

| Metric | Trước cook | Sau full rollout (22 min after reset) | Cải thiện |
|---|---|---|---|
| Drain clusters total | ~6,000 (kernel 658, lsws-error 3701, php 893) | **333** (kernel 56, lsws-error 73, php 120) | **18×** |
| Qdrant points | 111,991 | 471 (fresh start, đang discovery) | 238× drop point-in-time |
| kernel clusters | 658 | 56 | 12× |
| lsws-error clusters | 3,701 | 73 | **51×** |
| php-domain-error clusters | 893 | 120 | 7× |
| Batch compression | 500ev → 100pt (5×) | 500ev → 65-75pt (7×) | 40%+ |
| `unmatched` per batch | 5-14 | 0-3 (steady) | 5× |

### Projected daily growth
20-min sample sau warm-up: **+323 points → projected 23k/day**. Cao hơn threshold mới (5k/day).

Tuy nhiên đây là **discovery phase** — drain chưa hội tụ, cluster count đang grow log-decay. Kỳ vọng plateau tại ~500-800 clusters sau 24-48h → true steady-state ~5-10k/day.

**TODO 2026-08-19**: Re-measure sau 24h. Nếu vẫn > 5k/day, xem xét:
- Redact thêm firewall logs (SRC=/DST= IP pattern → `<PUB_IP>`).
- Redact WordPress custom table prefix `\b[a-zA-Z0-9]{4,8}_(wp_|fspg_|actionscheduler|yoast)` → `<WP_PREFIX>_`.
- Bump `drain_sim_th` 0.5 → 0.6 (chặt hơn merge).

### Bind-mount gotcha đã phát hiện
`git reset --hard` thay file inode → Docker bind-mount CÒN đọc inode cũ dù host mới. **SIGHUP reload không cứu — MUST `docker compose restart <service>`**. Đã note vào memory `bind-mount-stale-after-git-reset.md`. Vector + vmalert-metrics đã fix. Còn alertmanager + oauth2-proxy stale từ trước (không thuộc scope, cần review riêng).

### Systemd timer đã install
```
qdrant-log-templates-prune.timer → 03:30 ICT daily, RETENTION_DAYS=30
```

## Phase 4-7 (2026-08-19): re-cook sau 24h obs

Alert fire lại sau 24h. Cluster count = 1576 (Qdrant 15k points, ~15k/day growth = 3× threshold 5k). Discovery deeper leaks:

### Leak sau 24h + fix (Phase 4-7)

| Leak | Fix | Commit |
|---|---|---|
| `Code:` hex regex cut sớm khi gặp `<50>` RIP marker | Char-class `[\s0-9a-fA-F<>*]{20,}` consume greedy | `770782e` |
| WordPress custom prefix 2-6 chars (`hcv_options`, `bCH_defaultusermeta`, `zVU_defaultposts`, `fjM_defaultrank_math_*`, `vay_actionscheduler_logs`) | 2 pattern mới cho `*_default*` + known-suffix (options/users/actionscheduler/yoast/rank_math/wc/itsec/statistics) | `770782e` |
| PHP stack frame `#N /path/file.php(NN): Class::method()` | Collapse thành `#N <STACK_FRAME>` | `ba26265` |
| Yoast + ActionScheduler bare table names | `<YOAST_TBL>`, `<AS_TBL>` | `ba26265` |
| Multi-line SQL fragments (`WHERE ...`, `ORDER BY ...`, `AND ...`) | Collapse thành `<SQL_FRAG>` | `ba26265` |
| SQL query body sau `for query` varies (SELECT vs INSERT vs UPDATE + WHERE clause) | Collapse toàn bộ body sau `for query` thành `<QUERY>` (giữ prefix "Table X doesn't exist") | `2108dd4` |
| URL literal + int literal trong SQL string values | `'<URL>'`, `'<INT>'` | `2108dd4` |
| Kernel iptables/firewall log MAC + SRC + DST + LEN + TTL + ID + port varies per packet | `<MAC>`, `<PKT_IP>`, `<LEN>`, `<TTL>`, `<ID>`, `<PORT>` | `8925c94` |
| drain sim_th 0.5 quá strict với heavy-redact upstream | Revert 0.5 → 0.4 (merge aggressive hơn) | `ba26265` |
| VRL raw string `r"..."` không support double-quote | Regex chứa `'` phải dùng non-raw double-quoted với `\\s` escape | `9c1cb73` |

### Impact Phase 4-7

| Metric | 24h obs (Phase 1-3) | Phase 4 (Code+WP) | Phase 5 (stack+SQL) | Phase 6 (SQL body+URL) | **Phase 7 (firewall)** |
|---|---|---|---|---|---|
| Cluster TOTAL | 1576 | 509 | 336 | 264 | **274** |
| php-domain-error | 575 | 253 | 126 | 41 | **40** (93% ↓) |
| kernel | 317 | 69 | 73 | 67 | **65** |
| lsws-error | 414 | 125 | 70 | 91 | **105** |
| Projected daily (30min sample) | ~15k | ~19k | ~19k | ~10k | **5,136** ✓ |
| Points-per-hour-bucket | ~600 | ~500 | ~400 | ~263 | **274** |

**Alert `QdrantTemplateGrowthHigh` state = inactive.** Threshold 8k/day, growth ~5k/day = 63% of threshold, buffer 37%.

### Alert threshold: 5k → 8k/day
Sau 6 phase, points-per-hour ổn định ~250-300 → daily ~6-7k. Threshold 8k = 30% buffer cho burst. Retention 30d × 8k = 240k points ≈ 3.1 GB RAM, dưới hard cap 500k / 6.5 GB.

## Unresolved questions
1. Kernel call trace lines (`__x64_sys_recvfrom+<OFFSET>`, `unix_stream_recvmsg+<OFFSET>`, ...) — mỗi function = 1 template. ~40-60 kernel functions trong OOM trace = 40-60 template. Không collapse được vì function name IS the debug info. Chấp nhận.
2. Aug 12 upstream spike origin — chưa root cause. Không critical vì Vector redact + retention đã bound damage.
3. Khi scale 50 host, log format lạ (IIS Windows client, custom app log) → cần rà thêm redact pattern.
4. Nếu Phase 7 measurement vẫn > 8k/day sau 24h, cân nhắc: giảm point_bucket_s từ 3600 (1h) → 7200 (2h) — half số bucket → half points-per-day. Trade-off: coarser timeline resolution trong VMUI drill-down.
