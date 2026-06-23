"""
Indexer entry — orchestrates batch flow:

  NATS pull → group by (service, template_id, window) → Drain3 cluster
  → redact sample → embed unique templates → upsert Qdrant → ack NATS

One process. Metrics + health on a separate aiohttp task via asyncio.gather.
"""
from __future__ import annotations

import asyncio
import signal
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from indexer import metrics
from indexer.config import settings
from indexer.drain_cluster import DrainPool
from indexer.embed_client import EmbedClient
from indexer.logging_setup import log
from indexer.nats_consumer import NatsBatchConsumer
from indexer.qdrant_writer import QdrantWriter, TemplatePoint
from indexer.redact import redact


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _extract_msg(event: dict[str, Any]) -> str:
    """Vector publishes the redacted message under `_msg`. Fall back gracefully."""
    return str(event.get("_msg") or event.get("message") or "").strip()


def _event_ts(event: dict[str, Any]) -> float:
    """Parse `_time` (RFC3339 from Vector). Fall back to now if missing/bad."""
    t = event.get("_time")
    if isinstance(t, str):
        try:
            return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return time.time()


async def _process_batch(
    events: list[dict[str, Any]],
    drain: DrainPool,
    embed: EmbedClient,
    qwriter: QdrantWriter,
) -> None:
    start = time.perf_counter()
    metrics.last_batch_size.set(len(events))

    # Group by (service, template_id) within the window so each cluster→1 Qdrant point.
    # `aggregated[key]` accumulates count + first sample + window min/max ts.
    aggregated: dict[tuple[str, str, int], dict[str, Any]] = {}
    unmatched = 0

    for ev in events:
        service = str(ev.get("service") or "unknown")
        host = str(ev.get("host") or "unknown")
        severity = str(ev.get("severity") or "info")
        msg = _extract_msg(ev)
        if not msg:
            metrics.events_dropped.labels(reason="empty_msg").inc()
            continue

        cluster = drain.add(service, msg)
        if cluster.change_type == "cluster_created":
            unmatched += 1

        key = (service, host, cluster.template_id)
        slot = aggregated.get(key)
        ts = _event_ts(ev)
        if slot is None:
            redacted = redact(msg)
            aggregated[key] = {
                "template_id": cluster.template_id,
                "template": cluster.template,
                "service": service,
                "host": host,
                "severity": severity,
                "ts_min": ts,
                "ts_max": ts,
                "count": 1,
                "sample": redacted.text,
            }
        else:
            slot["count"] += 1
            slot["ts_min"] = min(slot["ts_min"], ts)
            slot["ts_max"] = max(slot["ts_max"], ts)
            # Promote highest severity for the cluster in this window.
            slot["severity"] = _max_severity(slot["severity"], severity)

    if not aggregated:
        return

    metrics.drain_unmatched_ratio.set(unmatched / max(1, len(events)))

    # Embed unique templates (one vector per cluster in the batch).
    templates = [slot["template"] for slot in aggregated.values()]
    vectors = await embed.embed(templates)

    points = [
        TemplatePoint(
            template_id=slot["template_id"],
            template=slot["template"],
            service=slot["service"],
            host=slot["host"],
            severity=slot["severity"],
            window_start=_iso(slot["ts_min"]),
            window_end=_iso(slot["ts_max"]),
            count=slot["count"],
            sample=slot["sample"][:1024],
            vector=vec,
        )
        for slot, vec in zip(aggregated.values(), vectors, strict=True)
    ]

    await qwriter.upsert(points)

    elapsed = time.perf_counter() - start
    metrics.batch_latency.observe(elapsed)
    metrics.batches_processed.inc()
    # Lag: now - oldest event in batch.
    oldest = min(slot["ts_min"] for slot in aggregated.values())
    metrics.ingest_lag_s.set(max(0.0, time.time() - oldest))

    log.info(
        "batch.flushed",
        events=len(events),
        points=len(points),
        unmatched=unmatched,
        elapsed_s=round(elapsed, 3),
    )


_SEVERITY_ORDER = ["info", "notice", "warning", "warn", "err", "error", "crit", "alert", "emerg"]


def _max_severity(a: str, b: str) -> str:
    def rank(s: str) -> int:
        try:
            return _SEVERITY_ORDER.index(s.lower())
        except ValueError:
            return -1
    return a if rank(a) >= rank(b) else b


async def _main_loop() -> None:
    drain = DrainPool()
    embed = EmbedClient()
    qwriter = QdrantWriter()
    await qwriter.ensure_collection()

    consumer = NatsBatchConsumer()
    await consumer.connect()

    log.info("indexer.started", batch_size=settings.batch_size, window_s=settings.batch_window_s)
    try:
        async for events, ack in consumer.batches():
            try:
                await _process_batch(events, drain, embed, qwriter)
                await ack()
            except Exception as exc:  # noqa: BLE001 — never crash the loop on per-batch errors
                log.error("batch.failed", err=str(exc), events=len(events))
                # No ack → NATS will redeliver after ack_wait
            drain.snapshot_if_due()
    finally:
        drain.snapshot_all()
        await consumer.close()


async def _run_async() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            # Windows dev shells — fall back to default behavior.
            pass

    tasks = [
        asyncio.create_task(_main_loop(), name="main_loop"),
        asyncio.create_task(metrics.serve(settings.metrics_port), name="metrics"),
        asyncio.create_task(stop.wait(), name="shutdown"),
    ]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for t in done:
        if t.get_name() != "shutdown" and (exc := t.exception()):
            log.error("indexer.task_crashed", task=t.get_name(), err=str(exc))
            raise exc


def run() -> None:
    """CLI entry — `onelog-indexer`."""
    asyncio.run(_run_async())


if __name__ == "__main__":
    run()
