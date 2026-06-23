"""
OpenAI embedding client with retry + optional mock mode.

Mock mode (EMBED_MOCK=true): deterministic hash-based vectors. Used for tests,
offline dev, and synthetic soak — avoids burning $ when format/lag is what we
actually want to validate.
"""
from __future__ import annotations

import hashlib
import time
from collections.abc import Sequence

from openai import AsyncOpenAI
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from indexer import metrics
from indexer.config import settings
from indexer.logging_setup import log


class EmbedClient:
    def __init__(self) -> None:
        self._mock = settings.embed_mock or not settings.openai_api_key
        self._dim = settings.qdrant_vector_size
        if self._mock:
            log.info("embed.mock_mode_enabled", reason="EMBED_MOCK or no API key")
            self._client: AsyncOpenAI | None = None
        else:
            self._client = AsyncOpenAI(
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url,
            )

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        if self._mock:
            return [self._mock_vector(t) for t in texts]
        return await self._embed_remote(list(texts))

    def _mock_vector(self, text: str) -> list[float]:
        """Deterministic pseudo-vector from sha256 — same input → same output."""
        h = hashlib.sha256(text.encode("utf-8")).digest()
        # Expand digest to required dim by repeating + scaling to [-1, 1].
        raw = (h * ((self._dim // len(h)) + 1))[: self._dim]
        return [(b - 128) / 128.0 for b in raw]

    async def _embed_remote(self, texts: list[str]) -> list[list[float]]:
        assert self._client is not None
        start = time.perf_counter()
        try:
            async for attempt in AsyncRetrying(
                stop=stop_after_attempt(5),
                wait=wait_exponential(multiplier=1, min=2, max=30),
                retry=retry_if_exception_type(Exception),
                reraise=True,
            ):
                with attempt:
                    resp = await self._client.embeddings.create(
                        model=settings.embed_model,
                        input=texts,
                    )
            elapsed = time.perf_counter() - start
            metrics.embed_latency.observe(elapsed)
            metrics.embed_requests.labels(status="ok").inc()
            return [d.embedding for d in resp.data]
        except Exception as exc:
            metrics.embed_requests.labels(status="error").inc()
            log.error("embed.failed", err=str(exc), batch=len(texts))
            raise
