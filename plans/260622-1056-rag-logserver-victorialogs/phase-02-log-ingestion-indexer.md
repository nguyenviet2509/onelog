# Phase 02 — Log ingestion + Indexer (Vector + Drain3 + Redaction)

## Context
- Plan: [plan.md](plan.md)
- Design: [brainstorm report §1, §5](../reports/brainstorm-260622-1056-rag-logserver-victorialogs.md)
- Tham khảo: `victorialog/kien-truc-victorialogs.md`, `syslog/hethong_logserver.md`

## Overview
- Priority: P0
- Status: pending
- Mục tiêu: Vector.dev nhận log từ 50-200 server → **redact PII bằng VRL ngay tại ingest** → ghi VictoriaLogs (data clean) + tap stream WARN+ qua NATS → Indexer worker (Python) dedupe Drain3, redact lần 2 (defense in depth), embed, upsert Qdrant.

## Requirements
- Throughput: 10-100GB/ngày, peak 5k events/s
- Indexer lag < 2 phút từ log → Qdrant
- Dedup ratio mục tiêu: >90% volume sau Drain3
- Redaction zero leak (test inject email/IP/JWT → VL search assert không tìm thấy raw)

## Architecture
```
Servers (rsyslog/journald/filebeat-style)
   │ syslog RFC5424 / vector source
   ▼
Vector.dev
   ├── sink: victorialogs (full stream, JSON)
   └── sink: nats (stream "logs.warn", filter severity>=WARN)
                    │
                    ▼
            Indexer worker (Python)
               1. consume batch
               2. Drain3 cluster per service
               3. Aggregate window 30s/500 templates
               4. Presidio + regex redact
               5. Build chunk text
               6. Embed (OpenAI text-embedding-3-small)
               7. Upsert Qdrant
```

## Related Code Files
Create:
- `infra/vector/vector.toml`
- `infra/docker-compose.yml` (add `nats`, `indexer` services)
- `indexer/pyproject.toml`
- `indexer/src/indexer/main.py`
- `indexer/src/indexer/drain_cluster.py`
- `indexer/src/indexer/redact.py`
- `indexer/src/indexer/embed_client.py`
- `indexer/src/indexer/qdrant_writer.py`
- `indexer/src/indexer/nats_consumer.py`
- `indexer/src/indexer/config.py`
- `indexer/tests/test_redact.py`
- `indexer/tests/test_drain_cluster.py`
- `indexer/Dockerfile`

## Implementation Steps
1. **Vector config** (see `infra/vector/vector.yaml`):
   - source `syslog` UDP 514 + TCP 6514 TLS
   - transform `enrich` (normalize service/host/severity)
   - **transform `redact` VRL** — strip email, RFC1918 IP, JWT, AWS key, Bearer token, password (BEFORE VL ingest)
   - sink `victorialogs` (data đã clean)
   - sink `nats` subject `logs.warn`, filter severity WARN+
2. Thêm NATS server vào docker-compose (image `nats:latest`, JetStream enable)
3. Init Qdrant collection: `log_templates`, vector 1536d cosine, payload indexes (service, host, severity, ts_start)
4. **Indexer worker**:
   - `config.py`: pydantic-settings load env
   - `nats_consumer.py`: async subscribe `logs.warn`, batch 30s/500 msg
   - `drain_cluster.py`: dùng `drain3` lib, persist state per-service vào `/data/drain_state/{service}.json` hourly
   - `redact.py`: Presidio defense-in-depth (Vector VRL đã redact lần 1; indexer redact lần 2 trước embed để chống miss)
   - `embed_client.py`: OpenAI client, retry exponential, batch 100 chunks/call
   - `qdrant_writer.py`: async upsert, id = sha1(template_id + window_start)
   - `main.py`: orchestrate loop, expose `/metrics` Prometheus + `/health`
5. Dockerfile: python:3.12-slim, install deps, non-root user
6. docker-compose add `indexer` service, mount drain_state volume, depends_on nats/qdrant
7. Unit test:
   - `test_redact.py`: inject 10 PII pattern, assert all removed
   - `test_drain_cluster.py`: 1000 log lines → assert template count < 50
8. Load test: replay 1GB log file qua Vector → đo lag indexer

## Todo
- [ ] Vector config + TLS cert syslog
- [ ] NATS service trong compose
- [ ] Qdrant collection init script
- [ ] Indexer scaffold (pyproject, config, logging)
- [ ] NATS consumer + batching
- [ ] Drain3 wrapper + persistence
- [ ] Redaction module + test
- [ ] Embedding client + retry
- [ ] Qdrant writer
- [ ] Dockerfile + compose integration
- [ ] Load test replay 1GB
- [ ] Doc data flow

## Success Criteria
- Vector ingest 50GB/ngày không drop (queue depth < threshold)
- Drain3 unmatched_ratio < 5%
- Indexer lag p95 < 120s
- Redaction test: 0 PII trong Qdrant payload (kiểm tra 1000 sample)
- Cost embedding < $0.5/ngày ở 30k chunks
- Qdrant search returns relevant template trong < 50ms

## Risks
- NATS down → Vector buffer disk → set `buffer.type = "disk"`, max 10GB
- Drain3 state corruption → snapshot trước khi save, validate JSON
- OpenAI rate limit → retry 5xx, fallback queue, batch lớn hơn
- PII regex false negative → review weekly mẫu Qdrant payload

## Security
- syslog TCP 6514 chỉ chấp nhận TLS client cert từ server đã cấp
- Indexer chạy non-root, read-only fs trừ /data/drain_state
- OpenAI key qua sops .env, không log
- Audit redaction: log số count redacted/batch

## Next Steps
- Phase 03 query Qdrant + VictoriaLogs
