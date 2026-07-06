"""
Tool: query_victorialogs — LogsQL passthrough to VictoriaLogs.

After templates are surfaced, agent calls this to fetch raw lines for a
specific service/host/window. Hard-capped at `vl_query_limit` (default 200)
to keep the prompt fitting in context. Output is redacted again as defense-
in-depth — Vector already redacts at ingest, but we re-pass before LLM sees it.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from agent.config import settings
from agent.logging_setup import log
from agent.redact import redact

schema: dict[str, Any] = {
    "name": "query_victorialogs",
    "description": (
        "Run a LogsQL query against VictoriaLogs and return the matching lines. "
        "Use this AFTER `search_log_templates` to fetch raw evidence for a specific "
        "service/host/time window. Output is capped at the server limit; refine the "
        "query if you need more detail. LogsQL examples: "
        "`service:mock-mysql AND severity:err`, "
        "`service:mock-sshd AND _msg:~\"Failed password\"`. "
        "For quantitative questions (how many logs, count, trend) MUST use `| stats` "
        "with explicit `start`/`end` — do NOT sum counts from `search_log_templates`. "
        "Examples: `{host=\"srv-01\"} | stats count() as total` (total in window), "
        "`{host=\"srv-01\"} | stats by (_time:1h) count() as c` (hourly trend), "
        "`* | stats by (service) count() as c` (breakdown). Stats results come back "
        "as a single (or few) JSON line(s) in `lines`; read the aggregated fields there."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "logsql": {"type": "string", "description": "LogsQL query string"},
            "limit": {
                "type": "integer",
                "description": f"Max lines (server cap {settings.vl_query_limit})",
                "default": 50,
            },
            "start": {
                "type": "string",
                "description": "Optional RFC3339 start time, e.g. 2026-06-23T04:00:00Z",
            },
            "end": {
                "type": "string",
                "description": "Optional RFC3339 end time",
            },
        },
        "required": ["logsql"],
    },
}


async def run(args: dict[str, Any]) -> dict[str, Any]:
    logsql = str(args.get("logsql", "")).strip()
    if not logsql:
        return {"lines": [], "error": "empty logsql"}

    limit = max(1, min(settings.vl_query_limit, int(args.get("limit", 50))))
    params = {"query": logsql, "limit": str(limit)}
    if args.get("start"):
        params["start"] = str(args["start"])
    if args.get("end"):
        params["end"] = str(args["end"])

    url = f"{settings.vl_url.rstrip('/')}/select/logsql/query"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        log.error("tool.query_vl_failed", err=str(exc), logsql=logsql)
        return {"lines": [], "error": str(exc)}

    # VL returns newline-delimited JSON for /select/logsql/query.
    lines: list[dict[str, Any]] = []
    for raw in resp.text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if "_msg" in doc:
            doc["_msg"] = redact(str(doc["_msg"]))
        # Strip noisy stream id but keep correlation-useful fields.
        doc.pop("_stream_id", None)
        lines.append(doc)
        if len(lines) >= limit:
            break

    log.info("tool.query_vl", logsql=logsql, lines=len(lines))
    return {"lines": lines, "count": len(lines)}
