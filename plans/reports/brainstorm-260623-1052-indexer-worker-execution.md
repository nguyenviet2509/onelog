# Indexer Worker Execution Plan (Phase 02 deferred portion)

## Context
- Plan: [260622-1056-rag-logserver-victorialogs](../260622-1056-rag-logserver-victorialogs/plan.md)
- Parent phase: [phase-02-log-ingestion-indexer.md](../260622-1056-rag-logserver-victorialogs/phase-02-log-ingestion-indexer.md)
- Trigger: 2 client setup xong, đợi log soak. Tận dụng window này build indexer worker (đã defer) bằng synthetic data.

## Decision
Build indexer worker NGAY với synthetic log fixture. Khi log thật về thì swap input → soak test luôn. Không đợi log thật vì:
- Scope indexer độc lập (NATS in / Qdrant out), test được offline
- Unblock Phase 03 (RAG agent cần Qdrant có data)
- Phase 03 scaffold có thể kick song song nửa sau khi indexer ổn

## Scope (chỉ phần deferred của Phase 02)
- Indexer worker Python: NATS consumer → batch → Drain3 → redact (defense-in-depth) → embed → Qdrant upsert
- Synthetic log generator (test fixture)
- Unit + integration test
- Docker + compose integration
- KHÔNG đụng: Vector config (đã DONE), client rsyslog (đã DONE 2 nodes)

## Breakdown (~3-4 ngày)

### D1: Scaffold + NATS + Drain3
- [ ] `indexer/pyproject.toml` (deps: nats-py, drain3, qdrant-client, openai, presidio-analyzer, pydantic-settings, structlog)
- [ ] `indexer/src/indexer/config.py` — pydantic-settings (NATS_URL, QDRANT_URL, OPENAI_API_KEY, BATCH_SIZE=500, BATCH_WINDOW_S=30, DRAIN_STATE_DIR)
- [ ] `indexer/src/indexer/nats_consumer.py` — async JetStream pull subscribe `logs.warn`, batch by size/time
- [ ] `indexer/src/indexer/drain_cluster.py` — per-service Drain3 instance, persist `/data/drain_state/{service}.json` hourly + atomic rename
- [ ] `indexer/tests/fixtures/synthetic_logs.py` — generator: nginx access (200/404/500), mysql error, sshd auth fail, audit kv, app stack trace. 1000-line corpus + edge cases (long lines, unicode, malformed)
- [ ] `indexer/tests/test_drain_cluster.py` — feed 1000 synthetic lines → assert < 50 templates, persistence round-trip

### D2: Redact + Embed + Qdrant
- [ ] `indexer/src/indexer/redact.py` — Presidio + regex (email/RFC1918 IP/JWT/AWS key/Bearer/password=). Return redacted text + count
- [ ] `indexer/tests/test_redact.py` — 10 PII patterns inject → assert 0 leak. Include false-positive checks (don't redact public IP if config says so, don't break stack traces)
- [ ] `indexer/src/indexer/embed_client.py` — OpenAI text-embedding-3-small, batch 100, retry exponential (tenacity), token budget log
- [ ] `indexer/src/indexer/qdrant_writer.py` — async upsert, id = sha1(template_id + window_start_iso), payload {service, host, severity, ts_start, ts_end, count, template, sample_redacted}
- [ ] Init script `indexer/scripts/init_qdrant.py` — create collection `log_templates`, 1536d cosine, payload indexes

### D3: Main loop + observability + Docker
- [ ] `indexer/src/indexer/main.py` — orchestrate: consume → group by (service, template_id, 30s window) → aggregate count → redact sample → embed unique templates → upsert
- [ ] Prometheus `/metrics`: batch_size, drain_unmatched_ratio, redact_count, embed_latency_ms, qdrant_upsert_lag_s
- [ ] `/health` endpoint
- [ ] structlog JSON logging
- [ ] `indexer/Dockerfile` — python:3.12-slim, non-root, multi-stage
- [ ] `infra/docker-compose.yml` — add `indexer` service, mount `/data/drain_state`, depends_on nats+qdrant
- [ ] `indexer/tests/test_integration.py` — spin embedded NATS + Qdrant testcontainer, push 100 synthetic msgs, assert Qdrant has expected points

### D4: Synthetic soak + handoff prep
- [ ] Replay script: generate 1GB synthetic log → push NATS → measure lag, dedup ratio, cost
- [ ] Tuning: batch size, embed batching, Qdrant batch upsert
- [ ] Doc `indexer/README.md` — run local, env vars, metrics, troubleshooting
- [ ] Smoke test với 1 client thật khi log về (verify schema match synthetic)

## Success Criteria (Indexer-specific subset)
- Synthetic 1GB replay: lag p95 < 120s, drain unmatched < 5%, 0 PII leak (1000 sample audit)
- Embed cost < $0.5/ngày projected ở 30k chunks
- Unit test coverage ≥ 80% cho redact + drain_cluster
- Integration test pass: NATS → Qdrant end-to-end với testcontainer

## Parallel Track (nửa sau D2/D3)
Khi indexer scaffold ổn, có thể kick Phase 03 scaffold song song (khác directory, không conflict):
- `agent/pyproject.toml`, FastAPI skeleton, Postgres schema migration, LangGraph stub
- Defer wire Qdrant retrieval đến khi indexer có data

## Risks
- **Synthetic ≠ real format** → khi log thật về phải tune Drain3/parser. Mitigation: dùng template từ `victorialog/` docs + 2 client thật log mẫu sớm nhất có thể (vài giờ là đủ để cross-check format)
- **OpenAI rate limit ở soak** → batch lớn + retry, có thể mock embed cho synthetic test để tiết kiệm cost
- **Drain3 state file corruption** → atomic write (tmp + rename), validate JSON load

## Next Steps
1. User approve → tạo files theo D1
2. Sau D3 → kick Phase 03 scaffold song song
3. Khi log soak về → integration test indexer với log thật, tune parser nếu cần

## Unresolved
- Mock embed client cho synthetic test? (recommend yes để giảm cost soak, real embed chỉ bật ở integration test thật)
- Drain3 persistence interval: hourly đủ chưa hay cần shorter để giảm mất state khi crash?
