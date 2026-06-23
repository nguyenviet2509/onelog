"""
Tool: search_log_templates — semantic Qdrant search across log clusters.

Agent calls this first when investigating "what's wrong" — Drain3 templates
already collapse noisy variants, so a single query surfaces representative
clusters with count + sample + service/host/time window.
"""
from __future__ import annotations

from typing import Any

from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models as qm

from agent.config import settings
from agent.embed_client import QueryEmbedClient
from agent.logging_setup import log

schema: dict[str, Any] = {
    "name": "search_log_templates",
    "description": (
        "Search clustered log templates (Drain3) by semantic similarity. "
        "Returns top-K templates with service, host, severity, count, sample, "
        "and time window. Use this FIRST when investigating an incident — "
        "templates are denoised, so a single hit can represent thousands of raw lines."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Free-form query, e.g. 'mysql aborted connection'"},
            "service": {"type": "string", "description": "Optional service filter (e.g. mock-mysql)"},
            "host": {"type": "string", "description": "Optional host filter"},
            "severity": {"type": "string", "description": "Optional severity filter (warning, err, ...)"},
            "limit": {"type": "integer", "description": "Top-K (default 10, max 20)", "default": 10},
        },
        "required": ["query"],
    },
}


class _Runner:
    """Lazy singletons so each tool call doesn't spin up clients/connections."""

    def __init__(self) -> None:
        self._qdrant: AsyncQdrantClient | None = None
        self._embed: QueryEmbedClient | None = None

    def _clients(self) -> tuple[AsyncQdrantClient, QueryEmbedClient]:
        if self._qdrant is None:
            self._qdrant = AsyncQdrantClient(
                url=settings.qdrant_url,
                api_key=settings.qdrant_api_key or None,
            )
        if self._embed is None:
            self._embed = QueryEmbedClient()
        return self._qdrant, self._embed


_runner = _Runner()


async def run(args: dict[str, Any]) -> dict[str, Any]:
    qdrant, embed = _runner._clients()
    query = str(args.get("query", "")).strip()
    if not query:
        return {"hits": [], "error": "empty query"}

    limit = max(1, min(20, int(args.get("limit", 10))))

    must: list[qm.FieldCondition] = []
    for field in ("service", "host", "severity"):
        val = args.get(field)
        if val:
            must.append(qm.FieldCondition(key=field, match=qm.MatchValue(value=str(val))))
    qfilter = qm.Filter(must=must) if must else None

    vector = await embed.embed(query)
    # qdrant-client 1.10+ uses `query_points`; the older `search` was removed
    # in 1.11. Result is a QueryResponse with a `points` list of ScoredPoint.
    resp = await qdrant.query_points(
        collection_name=settings.qdrant_collection,
        query=vector,
        query_filter=qfilter,
        limit=limit,
        with_payload=True,
    )

    hits = [
        {
            "score": round(float(r.score), 4),
            "template": (r.payload or {}).get("template"),
            "service": (r.payload or {}).get("service"),
            "host": (r.payload or {}).get("host"),
            "severity": (r.payload or {}).get("severity"),
            "count": (r.payload or {}).get("count"),
            "window_start": (r.payload or {}).get("window_start"),
            "window_end": (r.payload or {}).get("window_end"),
            "sample": (r.payload or {}).get("sample"),
        }
        for r in resp.points
    ]
    log.info("tool.search_log_templates", query=query, hits=len(hits))
    return {"hits": hits}
