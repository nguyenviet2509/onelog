"""Prometheus metrics + /health HTTP endpoint."""
from __future__ import annotations

import asyncio
import time

from aiohttp import web
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

# Counters
events_consumed = Counter("indexer_events_consumed_total", "NATS messages consumed")
events_dropped = Counter("indexer_events_dropped_total", "Events dropped (parse/format error)", ["reason"])
batches_processed = Counter("indexer_batches_processed_total", "Batches flushed to Qdrant")
redact_hits = Counter("indexer_redact_hits_total", "PII redactions applied at indexer (defense-in-depth)", ["kind"])
embed_requests = Counter("indexer_embed_requests_total", "Embedding API calls", ["status"])
qdrant_upserts = Counter("indexer_qdrant_upserts_total", "Points upserted to Qdrant")
qdrant_errors = Counter("indexer_qdrant_errors_total", "Qdrant upsert errors")

# Gauges
last_batch_size = Gauge("indexer_last_batch_size", "Events in last flushed batch")
drain_unmatched_ratio = Gauge("indexer_drain_unmatched_ratio", "Drain3 unmatched ratio in last batch")
ingest_lag_s = Gauge("indexer_ingest_lag_seconds", "Lag from event timestamp to flush")

# Histograms
embed_latency = Histogram("indexer_embed_latency_seconds", "OpenAI embed latency")
qdrant_latency = Histogram("indexer_qdrant_upsert_latency_seconds", "Qdrant upsert latency")
batch_latency = Histogram("indexer_batch_latency_seconds", "End-to-end batch processing")

_started_at = time.time()


async def _metrics(_: web.Request) -> web.Response:
    # aiohttp rejects charset in `content_type=` since 3.10. CONTENT_TYPE_LATEST
    # includes `; charset=utf-8`, so pass the full string via headers instead.
    return web.Response(body=generate_latest(), headers={"Content-Type": CONTENT_TYPE_LATEST})


async def _health(_: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "uptime_s": int(time.time() - _started_at)})


async def serve(port: int) -> None:
    """Run aiohttp server forever exposing /metrics + /health. Caller awaits."""
    app = web.Application()
    app.router.add_get("/metrics", _metrics)
    app.router.add_get("/health", _health)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    # Block forever — main loop runs concurrently via asyncio.gather.
    await asyncio.Event().wait()
