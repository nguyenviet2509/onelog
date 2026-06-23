"""
Qdrant writer — async upsert + idempotent collection init.

Point id = sha1(template_id + window_start_iso). Same template in same window
overwrites itself → no duplication if NATS redelivers a batch.
"""
from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models as qm
from qdrant_client.http.exceptions import UnexpectedResponse

from indexer import metrics
from indexer.config import settings
from indexer.logging_setup import log


@dataclass(slots=True)
class TemplatePoint:
    template_id: int
    template: str
    service: str
    host: str
    severity: str
    window_start: str
    window_end: str
    count: int
    sample: str  # redacted sample line
    vector: list[float]


class QdrantWriter:
    def __init__(self) -> None:
        self._client = AsyncQdrantClient(
            url=settings.qdrant_url,
            api_key=settings.qdrant_api_key or None,
        )

    async def ensure_collection(self) -> None:
        try:
            await self._client.get_collection(settings.qdrant_collection)
            log.info("qdrant.collection_exists", name=settings.qdrant_collection)
            return
        except (UnexpectedResponse, ValueError):
            pass

        log.info("qdrant.creating_collection", name=settings.qdrant_collection)
        await self._client.create_collection(
            collection_name=settings.qdrant_collection,
            vectors_config=qm.VectorParams(
                size=settings.qdrant_vector_size,
                distance=qm.Distance.COSINE,
            ),
        )
        # Payload indexes — speed up filter by service/host/severity/ts in agent retrieval.
        for field, schema in (
            ("service", qm.PayloadSchemaType.KEYWORD),
            ("host", qm.PayloadSchemaType.KEYWORD),
            ("severity", qm.PayloadSchemaType.KEYWORD),
            ("template_id", qm.PayloadSchemaType.INTEGER),
            ("window_start", qm.PayloadSchemaType.KEYWORD),
        ):
            await self._client.create_payload_index(
                collection_name=settings.qdrant_collection,
                field_name=field,
                field_schema=schema,
            )

    async def upsert(self, points: Sequence[TemplatePoint]) -> None:
        if not points:
            return
        qpoints = [
            qm.PointStruct(
                id=self._point_id(p),
                vector=p.vector,
                payload={
                    "template_id": p.template_id,
                    "template": p.template,
                    "service": p.service,
                    "host": p.host,
                    "severity": p.severity,
                    "window_start": p.window_start,
                    "window_end": p.window_end,
                    "count": p.count,
                    "sample": p.sample,
                },
            )
            for p in points
        ]
        start = time.perf_counter()
        try:
            await self._client.upsert(
                collection_name=settings.qdrant_collection,
                points=qpoints,
                wait=False,
            )
            elapsed = time.perf_counter() - start
            metrics.qdrant_latency.observe(elapsed)
            metrics.qdrant_upserts.inc(len(qpoints))
        except Exception as exc:  # noqa: BLE001 — qdrant client raises various
            metrics.qdrant_errors.inc()
            log.error("qdrant.upsert_failed", err=str(exc), batch=len(qpoints))
            raise

    @staticmethod
    def _point_id(p: TemplatePoint) -> str:
        raw = f"{p.service}|{p.template_id}|{p.window_start}".encode()
        digest = hashlib.sha1(raw).digest()
        return str(uuid.UUID(bytes=digest[:16]))


def run_init() -> None:
    """CLI entry — `onelog-init-qdrant`. Creates collection if missing, then exits."""
    async def _main() -> None:
        w = QdrantWriter()
        await w.ensure_collection()

    asyncio.run(_main())
