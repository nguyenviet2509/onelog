"""Embed a single query → vector for Qdrant search. Mirrors indexer EMBED_MOCK behavior."""
from __future__ import annotations

import hashlib

from openai import AsyncOpenAI

from agent.config import settings
from agent.logging_setup import log

_DIM = 1536  # text-embedding-3-small — must match indexer/Qdrant collection.


class QueryEmbedClient:
    def __init__(self) -> None:
        self._mock = settings.embed_mock or not settings.openai_api_key
        if self._mock:
            log.info("embed.mock_mode", reason="EMBED_MOCK or no API key")
            self._client: AsyncOpenAI | None = None
        else:
            self._client = AsyncOpenAI(
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url,
            )

    async def embed(self, text: str) -> list[float]:
        if self._mock:
            return _mock_vector(text)
        assert self._client is not None
        resp = await self._client.embeddings.create(
            model=settings.embed_model, input=[text]
        )
        return resp.data[0].embedding


def _mock_vector(text: str) -> list[float]:
    h = hashlib.sha256(text.encode("utf-8")).digest()
    raw = (h * ((_DIM // len(h)) + 1))[:_DIM]
    return [(b - 128) / 128.0 for b in raw]
