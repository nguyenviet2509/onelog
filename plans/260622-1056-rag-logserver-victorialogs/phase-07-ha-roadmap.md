# Phase 07 — HA roadmap (doc, không implement MVP)

## Context
- Plan: [plan.md](plan.md)
- Design: [brainstorm report §9](../reports/brainstorm-260622-1056-rag-logserver-victorialogs.md)

## Overview
- Priority: P2
- Status: pending
- Mục tiêu: Tài liệu hoá lộ trình từ single-node → cluster HA. Không implement, chỉ document để team có roadmap khi cần scale.

## Requirements
- Doc trong `docs/ha-roadmap.md` ≤ 800 LOC
- Cover: VictoriaLogs HA, Qdrant sharding, indexer scale, agent stateless, backup/DR

## Deliverables
Single doc: `docs/ha-roadmap.md`

## Outline doc

### 1. Trigger thresholds (khi nào cần migrate)
- Log volume > 200GB/ngày
- Qdrant collection > 50M vector
- Sysadmin > 10 user đồng thời
- Bot/agent uptime SLA cần > 99.9%

### 2. VictoriaLogs HA
- Tách `vlinsert` / `vlselect` / `vlstorage` (đã đề cập `victorialog/kien-truc-victorialogs.md`)
- Replica 2x storage node
- Load balancer trước vlinsert/vlselect
- Migration: parallel run, dual-write 1 tuần, switch read

### 3. Qdrant cluster
- 3-node cluster, replication_factor=2, shard_number=6
- API key + TLS giữa node
- Snapshot S3/MinIO
- Migration: snapshot single-node → restore cluster → switch agent endpoint

### 4. Indexer scale
- Vector → NATS JetStream cluster (3 node) thay vì single
- Indexer worker → consumer group, scale horizontal N pod
- Drain3 state → chuyển từ file → Redis/Postgres để share giữa worker
- Idempotent upsert Qdrant (id deterministic)

### 5. Agent service scale
- Stateless container → scale horizontal sau LB (nginx/traefik)
- Session/semantic cache → Redis cluster
- Audit log → ship sang VictoriaLogs (dogfood)
- Anthropic API: dùng workload identity/multi-key rotation

### 6. Telegram bot
- Bot single instance vẫn ổn (Telegram long polling 1 instance)
- Nếu muốn redundant: webhook + HTTPS LB + leader election

### 7. Backup & DR
- VictoriaLogs: snapshot incremental sang S3 daily, retention 30d
- Qdrant: snapshot daily + replica cross-region
- Redis: AOF + RDB cross-region replica
- Drill restore quarterly, target RTO 1h / RPO 24h

### 8. Observability
- VictoriaMetrics song song (nếu chưa có) cho metrics agent/indexer
- Grafana dashboard: ingest rate, indexer lag, Qdrant qps, LLM cost/giờ, agent p95
- Alert: indexer lag > 5min, Qdrant disk > 80%, LLM cost > $20/giờ

### 9. Security hardening
- Vault thay sops khi multi-node
- mTLS giữa các service nội bộ
- Network policy / firewall per-service
- LLM egress qua proxy whitelist domain

### 10. Cost projection cluster
- Estimate ở 500 server / 500GB ngày: VL 3-node 64G mỗi node, Qdrant 3-node 32G, agent 3 replica, LLM $500-1000/tháng

### 11. Migration checklist
- Pre-cutover: dual-write, parity check
- Cutover: maintenance window 30 phút, switch DNS
- Post-cutover: monitor 48h, rollback plan

## Todo
- [ ] Viết outline đầy đủ thành prose
- [ ] Vẽ sơ đồ ASCII single-node vs cluster
- [ ] Bảng so sánh cost single-node vs cluster
- [ ] Review với team
- [ ] Commit `docs/ha-roadmap.md`

## Success Criteria
- Doc < 800 LOC, đủ 11 section
- Team có thể đọc và biết exact steps khi cần scale
- Có sơ đồ trực quan

## Risks
- Doc lỗi thời nếu tech stack đổi → review mỗi 6 tháng
- Threshold migrate quá thấp/cao → revisit sau 3 tháng MVP chạy thật

## Next Steps
- Khi trigger threshold đạt → tạo plan riêng cho từng phase migration
