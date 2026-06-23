"""
MCP server exposing semantic search over Drain3-clustered log templates.

Single tool by design (KISS):
  search_log_templates(query, service?, host?, severity?, limit?) → list[dict]

The official mcp-victorialogs server already covers LogsQL/discovery/stats —
we add ONLY what it can't: semantic search over deduped templates. Claude
picks the right tool based on intent (this docstring is the contract).
"""
from __future__ import annotations

import logging
from typing import Annotated

import structlog
from fastmcp import FastMCP
from pydantic import Field
from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models as qm

from mcp_semantic.config import settings
from mcp_semantic.embed import Embedder


def _setup_logging() -> structlog.stdlib.BoundLogger:
    logging.basicConfig(format="%(message)s", level=settings.log_level.upper())
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelName(settings.log_level.upper())
        ),
        cache_logger_on_first_use=True,
    )
    return structlog.get_logger("mcp-semantic")


log = _setup_logging()

mcp = FastMCP(
    name="onelog-semantic",
    instructions=(
        "Semantic search over log templates (Drain3 clusters + OpenAI embeddings). "
        "Use this when keyword/LogsQL queries miss because of fuzzy intent — e.g. "
        "'database keeps disconnecting', 'unauthorized access', 'something wrong "
        "with payments'. For exact LogsQL queries / facets / stats, prefer the "
        "official mcp-victorialogs tools."
    ),
)

_qdrant: AsyncQdrantClient | None = None
_embedder: Embedder | None = None


def _clients() -> tuple[AsyncQdrantClient, Embedder]:
    global _qdrant, _embedder
    if _qdrant is None:
        _qdrant = AsyncQdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key or None)
    if _embedder is None:
        _embedder = Embedder()
    return _qdrant, _embedder


@mcp.tool()
async def search_log_templates(
    query: Annotated[str, Field(description="Free-form question about log behavior.")],
    service: Annotated[str | None, Field(description="Optional service filter (e.g. mock-mysql).")] = None,
    host: Annotated[str | None, Field(description="Optional host filter.")] = None,
    severity: Annotated[str | None, Field(description="Optional severity filter (warning/err/...).")] = None,
    limit: Annotated[int, Field(description="Top-K (1-20, default 10).", ge=1, le=20)] = 10,
) -> list[dict]:
    """
    Search clustered log templates by semantic similarity.

    Returns a list of templates with: score, template (Drain3 pattern with `<*>`
    wildcards), service, host, severity, count (occurrences in window),
    window_start / window_end (RFC3339), sample (redacted example line).

    Use FIRST when investigating something — templates are denoised, one hit
    represents many raw lines. Then drill down with the official LogsQL tools.
    """
    qdrant, embedder = _clients()
    if not query.strip():
        return []

    must: list[qm.FieldCondition] = []
    for field, val in (("service", service), ("host", host), ("severity", severity)):
        if val:
            must.append(qm.FieldCondition(key=field, match=qm.MatchValue(value=str(val))))
    qfilter = qm.Filter(must=must) if must else None

    vector = await embedder.embed(query)
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
    log.info("tool.search", query=query, hits=len(hits), service=service, host=host)
    return hits


def run() -> None:
    """Console entry — serve over SSE (Claude Desktop / Code use this transport)."""
    log.info("mcp-semantic.starting", host=settings.host, port=settings.port,
             bearer_auth=bool(settings.mcp_bearer), embed_mock=settings.embed_mock)
    # FastMCP serves SSE at /sse and HTTP at / by default.
    mcp.run(transport="sse", host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
