"""
MCP server exposing semantic search over Drain3-clustered log templates.

Single MCP tool by design (KISS):
  search_log_templates(query, service?, host?, severity?, limit?) → list[dict]

The official mcp-victorialogs server already covers LogsQL/discovery/stats —
we add ONLY what it can't: semantic search over deduped templates. Claude
picks the right tool based on intent (this docstring is the contract).

This service also hosts two HTTP routes used by the edge proxy (Caddy):
  GET /healthz       — container liveness
  GET /auth/verify   — Caddy `forward_auth` target. Validates Bearer for both
                       /mcp/vl/* and /mcp/semantic/* so we keep ONE token table.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

import structlog
import uvicorn
from fastmcp import FastMCP
from pydantic import Field
from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models as qm
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response

from mcp_semantic.audit import get_audit
from mcp_semantic.auth import is_auth_enabled, token_fingerprint, verify_bearer
from mcp_semantic.config import settings
from mcp_semantic.embed import Embedder
from mcp_semantic.vmui import build_vmui_url


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


def _resolve_user(request: Request | None) -> str:
    """Best-effort user attribution for audit lines.

    Order of preference:
      1. X-Mcp-User header — set upstream by Caddy after /auth/verify success.
      2. Direct Authorization header — when a client bypasses Caddy.
      3. "unknown" — anon dev mode or misconfigured request.
    """
    if request is None:
        return "unknown"
    user = request.headers.get("x-mcp-user")
    if user:
        return user
    return verify_bearer(request.headers.get("authorization")) or "unknown"


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> Response:
    """Container liveness — no auth required, no audit noise."""
    return PlainTextResponse("ok")


@mcp.custom_route("/auth/verify", methods=["GET", "POST"])
async def auth_verify(request: Request) -> Response:
    """Caddy `forward_auth` target. 204 + X-Mcp-User on success, 401 otherwise.

    Caddy forwards the original Authorization header here (see Caddyfile). On
    success Caddy copies X-Mcp-User into the upstream request so downstream
    services (this MCP + mcp-vl) can attribute calls without re-parsing tokens.
    """
    auth_header = request.headers.get("authorization")
    user = verify_bearer(auth_header)
    audit = get_audit()
    upstream_path = request.headers.get("x-forwarded-uri", "")
    upstream_method = request.headers.get("x-forwarded-method", "")
    if user is None:
        audit.write(
            source="edge",
            user="unknown",
            event="auth.deny",
            status="denied",
            path=upstream_path,
            method=upstream_method,
            # 8-char fingerprint of the attempted token so ops can correlate
            # repeated denials to a specific (likely leaked) credential.
            auth_hint=token_fingerprint(auth_header),
        )
        # RFC 6750: signal static-Bearer challenge so mcp-remote (and any other
        # OAuth-aware client) does NOT try dynamic OAuth client registration on
        # a 401. Without this header mcp-remote walks /register → /.well-known
        # → fatal "Invalid OAuth error response" on plain-token servers.
        return JSONResponse(
            {"error": "unauthorized"},
            status_code=401,
            headers={"WWW-Authenticate": 'Bearer realm="onelog"'},
        )
    audit.write(
        source="edge",
        user=user,
        event="auth.allow",
        path=upstream_path,
        method=upstream_method,
    )
    return Response(status_code=204, headers={"X-Mcp-User": user})


def _hit_to_dict(point: Any, vmui_base: str, time_range: str | None = None) -> dict[str, Any]:
    payload = point.payload or {}
    service = payload.get("service")
    host = payload.get("host")
    severity = payload.get("severity")
    window_start = payload.get("window_start")
    window_end = payload.get("window_end")
    return {
        "score": round(float(point.score), 4),
        "template": payload.get("template"),
        "service": service,
        "host": host,
        "severity": severity,
        "count": payload.get("count"),
        "window_start": window_start,
        "window_end": window_end,
        "sample": payload.get("sample"),
        "vmui_url": build_vmui_url(
            vmui_base,
            service=service,
            host=host,
            severity=severity,
            window_start=window_start,
            window_end=window_end,
            time_range=time_range,
        ),
    }


@mcp.tool()
async def search_log_templates(
    query: Annotated[str, Field(description="Free-form question about log behavior.")],
    service: Annotated[str | None, Field(description="Optional service filter (e.g. mock-mysql).")] = None,
    host: Annotated[str | None, Field(description="Optional host filter.")] = None,
    severity: Annotated[str | None, Field(description="Optional severity filter (warning/err/...).")] = None,
    limit: Annotated[int, Field(description="Top-K (1-20, default 10).", ge=1, le=20)] = 10,
    time_range: Annotated[
        str | None,
        Field(
            description=(
                "Time window hinted by the user's question, anchored to now. "
                "Use VMUI tokens: '5m', '15m', '1h', '6h', '24h', '2d', '7d', '1w'. "
                "Examples: '2 ngày qua' → '2d', 'last hour' → '1h', 'hôm nay' → '24h'. "
                "Omit when the question has no time hint — VMUI then falls back to "
                "the cluster's indexed window. Drives the VMUI deep link time picker."
            )
        ),
    ] = None,
) -> list[dict]:
    """
    Search clustered log templates by semantic similarity.

    Returns a list of templates with: score, template (Drain3 pattern with `<*>`
    wildcards), service, host, severity, count (occurrences in window),
    window_start / window_end (RFC3339), sample (redacted example line),
    vmui_url (clickable deep link into VMUI pre-filtered for these fields).

    Use FIRST when investigating something — templates are denoised, one hit
    represents many raw lines. Then drill down with the official LogsQL tools.
    """
    qdrant, embedder = _clients()
    audit = get_audit()
    # FastMCP exposes the originating Starlette request via `get_http_request`.
    # If transport isn't HTTP/SSE (e.g. unit tests over stdio) the helper raises
    # — we treat that as "no request" and fall back to the contextvar.
    request: Request | None
    try:
        from fastmcp.server.dependencies import get_http_request

        request = get_http_request()
    except Exception:
        request = None
    user = _resolve_user(request)

    if not query.strip():
        audit.write(source="mcp_semantic", user=user, event="search_log_templates",
                    status="empty_query", query=query)
        return []

    must: list[qm.FieldCondition] = []
    for field, val in (("service", service), ("host", host), ("severity", severity)):
        if val:
            must.append(qm.FieldCondition(key=field, match=qm.MatchValue(value=str(val))))
    qfilter = qm.Filter(must=must) if must else None

    try:
        vector = await embedder.embed(query)
        resp = await qdrant.query_points(
            collection_name=settings.qdrant_collection,
            query=vector,
            query_filter=qfilter,
            limit=limit,
            with_payload=True,
        )
    except Exception as exc:  # noqa: BLE001 — surface error to client + audit
        audit.write(
            source="mcp_semantic",
            user=user,
            event="search_log_templates",
            status="error",
            query=query,
            error=str(exc),
        )
        raise

    hits = [_hit_to_dict(point, settings.vmui_base_url, time_range) for point in resp.points]
    log.info("tool.search", user=user, query=query, hits=len(hits),
             service=service, host=host, time_range=time_range)
    audit.write(
        source="mcp_semantic",
        user=user,
        event="search_log_templates",
        query=query,
        service=service,
        host=host,
        severity=severity,
        limit=limit,
        time_range=time_range,
        result_size=len(hits),
    )
    return hits


def run() -> None:
    """Console entry — serve Streamable HTTP transport (FastMCP 3.x).

    `mcp.http_app()` returns a Starlette app that exposes the MCP protocol at
    `/mcp` and any `@mcp.custom_route` handlers (/healthz, /auth/verify) at
    root. Claude Desktop reaches the MCP via `mcp-remote https://.../mcp`.
    """
    log.info(
        "mcp-semantic.starting",
        host=settings.host,
        port=settings.port,
        bearer_auth_enabled=is_auth_enabled(),
        embed_mock=settings.embed_mock,
        audit_log_path=settings.audit_log_path,
        vmui_base_url=settings.vmui_base_url,
    )
    if not is_auth_enabled():
        if settings.mcp_allow_anon:
            log.warning(
                "mcp-semantic.auth_disabled",
                note="anon mode active (MCP_ALLOW_ANON=true) — only the Caddy IP "
                     "whitelist gates the MCPs. NEVER enable in production.",
            )
        else:
            log.warning(
                "mcp-semantic.auth_fail_closed",
                note="no tokens configured AND MCP_ALLOW_ANON unset — /auth/verify "
                     "will deny every request. Set MCP_BEARER_TOKENS or MCP_ALLOW_ANON=true.",
            )
    uvicorn.run(mcp.http_app(), host=settings.host, port=settings.port, log_config=None)


if __name__ == "__main__":
    run()
