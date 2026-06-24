"""Build clickable VMUI URLs that pre-filter log lines for a template hit.

When the semantic search returns a template like
  service=mock-mysql host=db01 severity=err  window=[t1..t2]
the IDE assistant should be able to one-click into VMUI showing the raw lines.
This builds the deep link used in tool responses.

VMUI is mounted under /select/vmui/ behind Caddy (see infra/caddy/Caddyfile).
The hash-routed UI expects `g0.expr` / `g0.range_input` query params.
"""
from __future__ import annotations

import urllib.parse
from typing import Optional


def _quote_value(value: str) -> str:
    """LogsQL quotes string literals with double quotes. Escape any embedded ones."""
    return value.replace('"', '\\"')


def build_logsql(
    service: Optional[str] = None,
    host: Optional[str] = None,
    severity: Optional[str] = None,
) -> str:
    """Compose a LogsQL filter from the structured fields of a template hit."""
    parts: list[str] = []
    if service:
        parts.append(f'service:"{_quote_value(service)}"')
    if host:
        parts.append(f'host:"{_quote_value(host)}"')
    if severity:
        parts.append(f'severity:"{_quote_value(severity)}"')
    return " AND ".join(parts) if parts else "*"


def build_vmui_url(
    base_url: str,
    *,
    service: Optional[str] = None,
    host: Optional[str] = None,
    severity: Optional[str] = None,
    window_start: Optional[str] = None,
    window_end: Optional[str] = None,
) -> str:
    """Return a VMUI deep link, e.g. http://app.local/select/vmui/?#/?query=...

    Time range is encoded as `start`/`end` (RFC3339 from Qdrant payload). VMUI
    accepts these and reflects them in its time picker.
    """
    query = build_logsql(service=service, host=host, severity=severity)
    qs: dict[str, str] = {"query": query}
    if window_start:
        qs["start"] = window_start
    if window_end:
        qs["end"] = window_end
    # VMUI lives under /select/vmui/ and uses hash routing. Querystring goes
    # *after* the hash so JS reads it from `location.hash`.
    base = base_url.rstrip("/")
    encoded = urllib.parse.urlencode(qs, quote_via=urllib.parse.quote)
    return f"{base}/select/vmui/?#/?{encoded}"
