# HA Roadmap — onelog

> Single-node MVP → multi-node HA. Doc-only, không bắt buộc implement đến khi trigger threshold.

## 0. Stack hiện tại (MVP, 2026-06-23)

```
[srv-01..N] --syslog UDP/TCP--> [Vector] --+--> [VictoriaLogs] <-- vmui / agent
                                           |
                                           +--> [NATS JetStream] --> [Indexer]
                                                                       |
                                                                       v
                                                                   [Qdrant]
                                                                       ^
[Web Next.js] <-- BFF --> [Agent FastAPI] --+-- search_log_templates --+
                                            +-- run_logsql -----------> [VictoriaLogs]
                                            +-- get_raw_lines ---------> [VictoriaLogs]
[vmalert] --> [Alertmanager] --webhook--> [Agent] --+--> [Telegram]
                                                     +--> [Postgres audit_log]
```

Mọi service single-instance, single VM. Postgres = state. Qdrant/VL = storage. Caddy = perimeter (VPN-only).

---

## 1. Khi nào migrate (trigger thresholds)

| Tín hiệu | Ngưỡng | Hành động |
|---|---|---|
| Log volume | > 200 GB/ngày | Tách VL roles (§2) |
| Qdrant collection | > 50M vector | Cluster Qdrant (§3) |
| Indexer lag | > 5 phút sustained | Scale indexer (§4) |
| Sysadmin đồng thời | > 10 | Scale agent + Redis cache (§5) |
| SLA yêu cầu | > 99.9% | Toàn bộ §2-§5 + Backup §7 |
| LLM cost | > $1k/tháng | Cache + multi-key (§5.3) |

Chưa chạm threshold → giữ single-node, focus product. Đừng over-engineer.

---

## 2. VictoriaLogs HA

Single-node hiện tại = `victoria-logs` all-in-one. HA = tách 3 role:

- **vlinsert** ×N (stateless) — nhận data từ Vector. Scale horizontal sau LB TCP.
- **vlstorage** ×2 replica — dữ liệu, replicate cross-AZ.
- **vlselect** ×N (stateless) — query path. Scale horizontal sau LB HTTP.

```
Vector --LB--> vlinsert ×N --> vlstorage ×2
                                   ^
Agent/vmui ---> vlselect ×N -------+
```

**Migration:**
1. Stand up cluster cạnh single-node, dual-write từ Vector 1 tuần.
2. Parity check: `count_over_time` per service phải match (delta < 1%).
3. Switch reads (agent + vmui) sang vlselect.
4. Tear down single-node sau 7 ngày soak.

---

## 3. Qdrant cluster

- 3 node, `replication_factor=2`, `shard_number=6`.
- API key + TLS inter-node.
- Snapshot daily → MinIO/S3 (cross-region).

**Migration:**
1. Snapshot collection `log_templates` từ single-node.
2. Restore vào cluster, switch agent `QDRANT_URL`.
3. Re-index 24h bằng Drain3 backfill (idempotent — id deterministic theo `sha1(template)`).

---

## 4. Indexer scale

Single worker giới hạn ~5k log/s embed throughput.

- **NATS cluster** 3-node thay single. Stream `LOGS` với `replicas=3`.
- **Indexer worker** ×N, share durable name `indexer-v1` → JetStream load-balance.
- **Drain3 state** chuyển từ file (`/data/drain_state`) → Redis (HSET per service) để share giữa worker.
- **Upsert idempotent** — Qdrant point id = `sha1(template_text)`, dedupe tự động.

```
NATS cluster (3) --> Indexer ×N --(batch 500/30s)--> Qdrant cluster
                          \-- state --> Redis
```

---

## 5. Agent service scale

### 5.1 Stateless container
- Đã stateless ở MVP (chỉ in-memory dedupe alert + per-request scratchpad).
- Sau LB nginx/Caddy: N replica, sticky cookie không cần (SSE tự re-connect).

### 5.2 Cache layer
- **Redis cluster** — semantic cache (query → answer hit), TTL 1h.
- Cache key = `sha1(normalized_query + top_template_ids)` để vẫn refresh khi log pattern đổi.

### 5.3 LLM cost control
- Multi-key rotation (Anthropic workload identity / multi-key pool).
- Token budget per user/day.
- Down-route: query rule-based (LogsQL trực tiếp) nếu không cần reasoning.

### 5.4 Audit log
- `audit_log` table hiện ở Postgres. Khi > 10M row/tháng: ship sang VictoriaLogs (dogfood) + partition Postgres monthly.

---

## 6. Telegram bot

- 1 bot instance vẫn OK (Telegram long-poll/webhook đơn).
- Nếu muốn redundant: webhook mode + LB HTTPS + leader election (Redis lock).
- Alert ack/silence từ Telegram (callback button) → Phase sau MVP.

---

## 7. Backup & DR

| Component | Method | Retention | RPO | RTO |
|---|---|---|---|---|
| VictoriaLogs | snapshot incremental → S3 daily | 30d | 24h | 1h |
| Qdrant | snapshot daily + cross-region replica | 14d | 24h | 30m |
| Postgres | pg_basebackup daily + WAL ship 5min | 30d | 5min | 30m |
| Redis | AOF every 1s + RDB hourly + replica | 7d | 1s | 5m |
| NATS | JetStream replicas=3 (no external backup needed) | — | — | inline |

**Drill restore quarterly.** Untested backup = no backup.

---

## 8. Observability

- **VictoriaMetrics** scrape: agent/indexer/web `/metrics` (Prometheus format).
- **Grafana dashboard tối thiểu:**
  - Ingest rate (events/s) per service
  - Indexer lag (NATS pending - delivered)
  - Qdrant qps + p99 latency
  - LLM token spend per hour + cost projection
  - Agent p95 chat latency
  - audit_log error rate
- **Alert:**
  - indexer lag > 5 min, 5 min for
  - Qdrant disk > 80%
  - LLM cost > $20/giờ
  - chat error rate > 5%

---

## 9. Security hardening

- **Secrets** — sops/age cho MVP, Vault khi multi-node.
- **mTLS** giữa các service nội bộ (cert-manager + step-ca).
- **Network policy** — Cilium/Calico, default-deny per namespace.
- **LLM egress** — proxy whitelist domain (`api.anthropic.com`, `api.openai.com`).
- **Auth** — Phase 09 plug OIDC corp IdP, gỡ anonymous session stub. VPN-only đến khi đó.

---

## 10. Cost projection (500 srv, 500 GB/ngày)

| Item | Spec | $/tháng |
|---|---|---|
| VL cluster | 3×64GB RAM / 2TB SSD | ~$900 |
| Qdrant cluster | 3×32GB RAM / 500GB SSD | ~$450 |
| Agent | 3×4GB | ~$120 |
| Indexer | 3×8GB | ~$180 |
| Postgres | 2×16GB primary + replica | ~$200 |
| LLM | Claude Sonnet, ~10M tok in / 2M out / ngày | $500-1000 |
| **Total** | | **~$2.4-3k/tháng** |

So với single-node MVP (~$150/tháng VM + $200 LLM) → 8-12× cost. Đừng migrate nếu chưa chạm thresholds §1.

---

## 11. Migration checklist (mỗi component)

**Pre-cutover (1 tuần):**
- [ ] Stand up cluster cạnh single-node
- [ ] Dual-write enabled
- [ ] Parity check daily, delta < 1%
- [ ] Smoke test toàn bộ flow trên cluster

**Cutover (30 phút maintenance window):**
- [ ] Announce ở team chat
- [ ] Pause writes (Vector buffer)
- [ ] Flush in-flight
- [ ] Switch DNS / endpoint env
- [ ] Resume writes
- [ ] Smoke test E2E

**Post-cutover (48h):**
- [ ] Monitor metrics + error rate
- [ ] Rollback plan ready (switch DNS back)
- [ ] Tear down single-node sau 7d soak

---

## 12. Roadmap visual

```
[NOW] single-node (MVP)
   |
   v  trigger §1
[+1mo] backup §7 + obs §8         <- low effort, high ROI
   |
   v
[+3mo] indexer scale §4 + Redis cache §5.2
   |
   v
[+6mo] Qdrant cluster §3
   |
   v
[+9mo] VictoriaLogs HA §2 + mTLS §9
   |
   v
[+12mo] full multi-region DR
```

---

## Review cadence

Revisit doc mỗi 6 tháng hoặc khi:
- Tech stack có breaking change (VL/Qdrant major version)
- Threshold §1 chạm 70%
- Incident lộ gap mới

**Owner:** trihd@inet.vn. **Last reviewed:** 2026-06-23.
