"""Query embedding — mirrors agent/indexer EMBED_MOCK for compat with mock-mode soak data."""
from __future__ import annotations

import hashlib

from openai import AsyncOpenAI

from mcp_semantic.config import settings


class Embedder:
    def __init__(self) -> None:
        self._mock = settings.embed_mock or not settings.openai_api_key
        self._dim = settings.qdrant_vector_size
        self._client: AsyncOpenAI | None = None if self._mock else AsyncOpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
        )

    async def embed(self, text: str) -> list[float]:
        if self._mock:
            h = hashlib.sha256(text.encode("utf-8")).digest()
            raw = (h * ((self._dim // len(h)) + 1))[: self._dim]
            return [(b - 128) / 128.0 for b in raw]
        assert self._client is not None
        resp = await self._client.embeddings.create(model=settings.embed_model, input=[text])
        return resp.data[0].embedding
