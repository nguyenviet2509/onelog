# onelog indexer

Consume WARN+ logs from NATS JetStream, cluster with Drain3, redact, embed → Qdrant.

## Quickstart (compose)

```bash
# 1. Bring up infra (NATS auto-included now)
cd infra
docker compose up -d

# 2. Build + start indexer (profile-gated so you can opt out)
docker compose --profile indexer up -d --build indexer

# 3. Tail logs
docker compose logs -f indexer
```

## Env

| Var | Default | Notes |
|---|---|---|
| `NATS_URL` | `nats://nats:4222` | |
| `NATS_SUBJECT` | `logs.warn` | Vector publishes here |
| `NATS_STREAM` | `LOGS` | Auto-created if missing |
| `NATS_DURABLE` | `indexer-v1` | Bump to reset offset |
| `QDRANT_URL` | `http://qdrant:6333` | |
| `QDRANT_COLLECTION` | `log_templates` | Auto-created at startup |
| `OPENAI_API_KEY` | — | Required unless `EMBED_MOCK=true` |
| `EMBED_MODEL` | `text-embedding-3-small` | 1536d |
| `EMBED_MOCK` | `false` | `true` → deterministic hash vectors (no API) |
| `BATCH_SIZE` | `500` | Flush trigger (size) |
| `BATCH_WINDOW_S` | `30` | Flush trigger (time) |
| `DRAIN_STATE_DIR` | `/data/drain_state` | Mounted volume |
| `METRICS_PORT` | `9100` | Prometheus `/metrics` + `/health` |

## Local dev

```bash
cd indexer
pip install -e ".[dev]"
EMBED_MOCK=true NATS_URL=nats://localhost:4222 QDRANT_URL=http://localhost:6333 onelog-indexer
```

## Tests

```bash
pytest -q
```

## Operating

- Check pipeline lag: `curl localhost:9100/metrics | grep ingest_lag`
- Reset consumer offset: bump `NATS_DURABLE` env (e.g. `indexer-v2`) and restart
- Force Drain3 snapshot before shutdown: SIGTERM is handled — clean stop snapshots all
- Disable embed cost during soak: `EMBED_MOCK=true`

## What lives where

- `src/indexer/config.py` — env-driven settings
- `src/indexer/nats_consumer.py` — JetStream pull, batch yield
- `src/indexer/drain_cluster.py` — per-service Drain3 + JSON snapshot
- `src/indexer/redact.py` — regex defense-in-depth (Vector VRL is layer 1)
- `src/indexer/embed_client.py` — OpenAI + mock mode
- `src/indexer/qdrant_writer.py` — idempotent upsert (sha1 id)
- `src/indexer/main.py` — orchestrator + metrics server
