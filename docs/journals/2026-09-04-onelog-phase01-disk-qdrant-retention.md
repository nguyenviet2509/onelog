# 2026-09-04 — OneLog Phase 01: disk optimization + Qdrant retention + budget alerts

Cook Phase 01 của plan `260904-1336-onelog-scale-hardening-v1`. Fix Qdrant status RED (crisis discovery giữa session), align retention Qdrant 30d→7d với VL, hạ log level 4 container spam, thêm textfile collector + vmalert budget rules. Bài học lớn: hypothesis 1&2 ban đầu (indexer dup, drain3 no-persist) SAI — root cause đúng chỉ là disk pressure. Fix rẻ hơn plan cũ 10x.

## Kết quả

- **Qdrant status: RED → GREEN**, optimizer_status: ok
- **Qdrant points: 402,965 → 263,887** (-35%, xoá 142k orphan > 7d)
- **Qdrant container log: 201MB → ~4KB** (recreate + `QDRANT__LOG_LEVEL=WARN` silence Actix access log)
- **Root disk: 65% → 63%** (docker builder prune 1.34G + qdrant compact sau cleanup)
- **4 container log spam silenced**: mcp-vl 34M, vector 32M, mcpo 25M, indexer 14M → warn-level
- **Systemd timers active** (4): du-metrics (5min), qdrant-prune (03:30 UTC daily), disk-hygiene-report (Sunday 08:00 ICT), docker-prune (Sunday 03:00 ICT)
- **vmalert group `disk-hygiene-budget`**: 2 rule (OnelogVolumeBudgetWarn 4-volume 80% budget + ContainerLogSpam 200MB Docker cap). Smoke test firing verified.
- **Commit**: `a0a7e1c` — 10 files, +255/-4 loc

## Chronology

### Session 1 — Plan Phase 01 draft
Đầu session: draft 5-phase plan cho scale hardening 150-host + SLO uptime ≥ 99.5%. Phase 01 = disk optimization. Ban đầu chỉ có step: baseline + budget matrix + vmalert rule.

User nhắc: "Docker log cap 100M×3 OK, qdrant 198M gần cap → nghi spam" → thêm step 2 triage log level.

### Session 2 — Qdrant duplicate hypothesis (ban đầu SAI)
User: "Nếu qdrant spam thật thì nên có dedup + xoá dup".

Đầu tiên tôi kiểm tra qdrant HTTP API → phát hiện:
- **status RED**
- 402,965 points
- optimizer error: "Not enough space available: needed 419.80 MiB, available 286.35 MiB"

Draft 3 hypothesis:
- H1: indexer dùng UUID random → mỗi upsert = new point
- H2: Drain3 state không persist → restart re-cluster
- H3: chỉ là disk pressure

Update Phase 01 step 2b: investigate + fix theo hypothesis + cleanup duplicate + backup snapshot.

**User chọn "Cook safe steps + validate 2b (Recommended)"** — không blindly implement. Explore agent verify hypothesis TRƯỚC code.

### Session 3 — Discovery: cả H1, H2 SAI
Explore agent đọc `indexer/src/indexer/qdrant_writer.py:129-132`:
```python
raw = f"{p.service}|{p.template_id}|{p.window_start}".encode()
digest = hashlib.sha1(raw).digest()
return str(uuid.UUID(bytes=digest[:16]))
```
Point ID DETERMINISTIC (SHA1 hash). Same tuple = same UUID = upsert overwrite. **Không duplicate by design.**

`drain_cluster.py:8-9`: Drain3 FilePersistence to `/data/drain_state/{service}.bin`, snapshot mỗi 15 phút, volume mount `./data/indexer:/data`. **State persist đúng.**

Sample 20 points từ qdrant → payload confirm: `window_start` bucket theo giờ (`2026-08-31T16:00:00+00:00`), point ID hash-derived. **Design đúng, 402k = legit unique (service × template × window_hour) 30d.**

Root cause chỉ là H3: disk pressure block optimizer. Fix simple: free ≥ 200MB → optimizer chạy → GREEN.

### Session 4 — User bổ sung: retention alignment
User: "Vậy khi cook không giảm được Qdrant points và disk à?"

Đúng — H3 fix chỉ unblock optimizer, points vẫn tích luỹ tuyến tính theo time (không có TTL). Query age distribution:
- > 7d: **142,289 (35%)** — orphan (VL retention chỉ 7d, không có log correlate)
- > 14d: 14,887 (3.7%)
- > 30d: 0

→ Add step retention align: xoá one-time > 7d + cron daily prune.

Discovery bonus: script `qdrant-log-templates-prune.sh` + systemd timer **đã tồn tại** với RETENTION_DAYS=30. Chỉ cần đổi 30→7 (align VL). YAGNI: dùng lại thay vì viết mới.

### Session 5 — Cook auto-mode
Cook 15 step sequential (safe-first order):
1. Baseline snapshot report
2. Docker builder prune → 1.34G free (từ 1.2G reclaimable báo trước)
3. Set `QDRANT__LOG_LEVEL=WARN` trong compose + recreate → status GREEN + log 201M → 4K ngay
4. Create payload index `window_start` (datetime) — cần cho range filter delete efficient
5. Snapshot backup collection 2.9G (rollback safety)
6. One-time delete points > 7d cutoff → -142k
7. Deploy `qdrant-log-templates-prune.service` với RETENTION_DAYS=7 → daily prune
8. Container log level: `LOG_LEVEL=WARNING` (indexer), `VECTOR_LOG=warn` (vector), `MCP_LOG_LEVEL=warn` (mcp-vl), `--log-level warning` (mcpo entrypoint)
9. Vector.yaml redact ordering audit PASS: redact → reclassify → warn_filter/vl_noise_filter → reduce
10. `du-metrics.sh` textfile collector → emit `onelog_data_volume_bytes` + `onelog_container_log_bytes`
11. `disk-hygiene-report.sh` weekly + Telegram (Sunday 08:00 ICT)
12. vmalert 2 rule: `OnelogVolumeBudgetWarn` + `ContainerLogSpam`
13. Deploy: SCP + systemd daemon-reload + timer enable + node-exporter recreate với `--collector.textfile.directory` + `-v ./data/textfile_collector:/textfile-collector:ro`
14. Smoke test: emit fake 300MB metric → vmalert vào state `pending` ✓ (test qua state pending không cần đợi `for: 15m`)
15. Commit + push origin/master + VPS reset

## Gotchas

- **Vmalert reload không auto**: sửa `metric-rules.yml` trên host xong phải `docker kill --signal=HUP` container mới reload. First eval defer 5m boundary → xem log "will start in Xm Ys".
- **NATS budget conflict**: NATS `max_bytes=5GB` cap → sẽ luôn ~5GB steady state → luôn hit 80% budget = false positive. Exclude khỏi `OnelogVolumeBudgetWarn` vì đã có `NATSStreamSizeHighWarn` riêng.
- **Node-exporter port**: không expose 9100/9101 ra host trong compose (scraped qua docker network). `curl localhost:9101` từ host → connection refused. Query metrics phải qua `http://victoriametrics:8428/api/v1/query`.
- **Qdrant `curl` không có trong container** (không có exec base tools). Query qdrant từ host qua `localhost:6333` (port 127.0.0.1:6333 published).
- **VL partitions ≠ retention**: có 8 partitions (20260828..20260904) nhưng VL_RETENTION=7d. Auto-drop background chạy ~1x/day → partition oldest có thể lag 1 ngày trước khi drop. Không phải bug.
- **Explore agent tiết kiệm 1 chu kỳ implement→revert**: nếu blindly refactor indexer theo H1 → mất 2h + risk phá NATS consumer. Validation trước code = KISS win.

## Decisions

| Decision | Why | Alternative rejected |
|---|---|---|
| Retention Qdrant 7d (không 30d) | Align VL retention → mất semantic search history nhưng cũng mất VL log correlate cùng lúc, symmetric | 14d compromise (ưa hơn nếu VL bump 14d sau) |
| Không dedup cleanup (chỉ retention) | Hypothesis H1/H2 SAI, không có duplicate thật | Dedup script keep-earliest (over-engineered) |
| Reuse existing prune script | Đã idempotent, safety-guard >50%, systemd timer đã enabled | Viết script mới (DRY violation) |
| Exclude NATS khỏi budget rule | max_bytes=5GB = de-facto budget, alert riêng có sẵn | Bump budget 6GB (patch triệu chứng) |
| Test alert = state pending (không đợi 15m) | `for: 15m` là deadband; pending = expr đã match | Change `for: 30s` tạm (config drift risk) |
| Textfile collector qua bind mount | Node-exporter user restricted, script chạy host user → file transfer qua FS đơn giản | HTTP push (viết pushgateway sidecar) |

## Refs

- Plan: `plans/260904-1336-onelog-scale-hardening-v1/`
- Baseline report: `plans/reports/baseline-260904-1456-phase01-disk-snapshot.md`
- Memory saved: `.claude/projects/.../memory/qdrant-log-templates-design-notes.md`
- Commit: `a0a7e1c feat(onelog): disk optimization + qdrant retention + budget alerts`
- Previous journal: `docs/journals/2026-08-31-onelog-disk-full-apache-spam-fix.md` (crisis → Phase 01 proactive follow-up)
- Explore evidence: `indexer/src/indexer/qdrant_writer.py:129-132`, `indexer/src/indexer/drain_cluster.py:8-9`

## Next

- Phase 02 (Forwarder GitOps) — highest priority sau Phase 01
- Watch Sunday 2026-09-06: first weekly disk-hygiene-report Telegram post
- Watch Saturday 03:30 UTC: qdrant prune first run với 7d cutoff (expected ~2k delete)
- Watch vmalert 24h: nếu budget warn firing thật, review budget matrix

## Unresolved

- VL partition oldest (20260828, 7.0G) chưa auto-drop sau 6d. Có phải retention background chạy chậm hay bug? Kiểm tra lần sau nếu partition > 8 days.
- Container `sqlite-web` (127kB size, unclear active users) — có cần đưa vào profile opt-in như indexer không?
- Grafana budget 1GB → hiện 224MB (22%). Nếu dashboard tăng, budget cần bump. Bao lâu nữa hit?
