"""
NATS JetStream pull consumer with batch yield.

Flow: connect → ensure stream `LOGS` binds to subject `logs.warn` → durable pull
consumer → yield (events, ack_callback) when batch_size or batch_window_s reached.

Pull (not push) so backpressure is natural: if processing slows, messages stay
queued on the server instead of overflowing the client.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable, Coroutine
from typing import Any

import nats
from nats.aio.client import Client as NATS
from nats.errors import TimeoutError as NATSTimeout
from nats.js.api import ConsumerConfig, RetentionPolicy, StorageType, StreamConfig
from nats.js.errors import NotFoundError

from indexer import metrics
from indexer.config import settings
from indexer.logging_setup import log

AckFn = Callable[[], Coroutine[Any, Any, None]]


class NatsBatchConsumer:
    def __init__(self) -> None:
        self._nc: NATS | None = None
        self._sub: Any = None

    async def connect(self) -> None:
        self._nc = await nats.connect(settings.nats_url, name="onelog-indexer")
        js = self._nc.jetstream()

        # Ensure stream exists. Vector publishes to logs.warn; we bind a stream
        # capturing logs.* so future taps (logs.audit, etc.) flow without re-config.
        try:
            await js.stream_info(settings.nats_stream)
        except NotFoundError:
            await js.add_stream(
                StreamConfig(
                    name=settings.nats_stream,
                    subjects=["logs.>"],
                    retention=RetentionPolicy.LIMITS,
                    storage=StorageType.FILE,
                    max_age=86400 * 3,  # 3 day buffer if indexer offline
                )
            )
            log.info("nats.stream_created", stream=settings.nats_stream)

        self._sub = await js.pull_subscribe(
            subject=settings.nats_subject,
            durable=settings.nats_durable,
            config=ConsumerConfig(
                ack_wait=60,  # seconds before redelivery if not acked
                max_ack_pending=settings.batch_size * 4,
            ),
        )
        log.info(
            "nats.subscribed",
            stream=settings.nats_stream,
            subject=settings.nats_subject,
            durable=settings.nats_durable,
        )

    async def close(self) -> None:
        if self._nc is not None:
            await self._nc.close()
            self._nc = None

    async def batches(self) -> AsyncIterator[tuple[list[dict[str, Any]], AckFn]]:
        """Yield (events, ack_all) tuples. Caller awaits ack_all() after processing."""
        assert self._sub is not None, "call connect() first"
        while True:
            events: list[dict[str, Any]] = []
            msgs_to_ack: list[Any] = []
            window_end = time.time() + settings.batch_window_s

            while len(events) < settings.batch_size and time.time() < window_end:
                remaining = max(1, int(window_end - time.time()))
                try:
                    msgs = await self._sub.fetch(
                        batch=min(100, settings.batch_size - len(events)),
                        timeout=min(5, remaining),
                    )
                except NATSTimeout:
                    continue
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    log.error("nats.fetch_failed", err=str(exc))
                    await asyncio.sleep(1)
                    continue

                for m in msgs:
                    try:
                        events.append(json.loads(m.data))
                    except json.JSONDecodeError:
                        metrics.events_dropped.labels(reason="json_decode").inc()
                        await m.ack()
                        continue
                    msgs_to_ack.append(m)
                    metrics.events_consumed.inc()

            if not events:
                continue

            async def ack_all() -> None:
                for m in msgs_to_ack:
                    try:
                        await m.ack()
                    except Exception as exc:  # noqa: BLE001
                        log.warning("nats.ack_failed", err=str(exc))

            yield events, ack_all
