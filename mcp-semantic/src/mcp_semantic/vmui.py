"""Build clickable VMUI URLs that pre-filter log lines for a template hit.

When the semantic search returns a template like
  service=mock-mysql host=db01 severity=err  window=[t1..t2]
the IDE assistant should be able to one-click into VMUI showing the raw lines.
This builds the deep link used in tool responses.

VMUI is mounted under /select/vmui/ behind Caddy (see infra/caddy/Caddyfile).
Time picker hydrates from `g0.relative_time` / `g0.range_input` / `g0.end_input`
URL params (see VictoriaLogs vmui useTimePeriod hook).
"""
from __future__ import annotations

import re
import urllib.parse
from datetime import datetime, timezone
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


def _parse_rfc3339(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _duration_label(start: datetime, end: datetime) -> str:
    """Render a Prometheus-style duration string (5m / 2h / 3d) covering the window.

    VMUI's `g0.range_input` accepts these tokens; we always round UP so the
    actual window stays inside the rendered range — never want the deep link to
    crop out the hit it's supposed to highlight.
    """
    seconds = max(int((end - start).total_seconds()), 60)
    if seconds < 3600:
        return f"{(seconds + 59) // 60}m"
    if seconds < 86400:
        return f"{(seconds + 3599) // 3600}h"
    return f"{(seconds + 86399) // 86400}d"


_RANGE_TOKEN = re.compile(r"^\d+[smhdw]$")


def _normalize_time_range(value: str) -> Optional[str]:
    """Accept VMUI-style tokens (5m / 2h / 2d / 1w). Reject anything else.

    Claude is told to pass tokens directly; we still guard so a stray
    "2 days" doesn't poison the URL.
    """
    token = value.strip().lower().replace(" ", "")
    return token if _RANGE_TOKEN.match(token) else None


def build_vmui_url(
    base_url: str,
    *,
    service: Optional[str] = None,
    host: Optional[str] = None,
    severity: Optional[str] = None,
    window_start: Optional[str] = None,
    window_end: Optional[str] = None,
    time_range: Optional[str] = None,
) -> str:
    """Return a VMUI deep link, e.g. http://app.local/select/vmui/?#/?query=...

    Time range precedence (highest first):
      1. `time_range` — the question's intent ("2 ngày qua" → "2d"). Anchored
         to "now" so the user lands on a fresh window.
      2. `[window_start, window_end]` — the cluster's own window from the
         index (fallback when the question has no explicit time hint).
      3. None → VMUI's default "Last 5 minutes".
    """
    query = build_logsql(service=service, host=host, severity=severity)
    qs: dict[str, str] = {"query": query}

    range_token = _normalize_time_range(time_range) if time_range else None
    if range_token:
        qs["g0.relative_time"] = "none"
        qs["g0.range_input"] = range_token
        qs["g0.end_input"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    else:
        start_dt = _parse_rfc3339(window_start) if window_start else None
        end_dt = _parse_rfc3339(window_end) if window_end else None
        if start_dt and end_dt and end_dt > start_dt:
            qs["g0.relative_time"] = "none"
            qs["g0.end_input"] = window_end  # type: ignore[assignment]
            qs["g0.range_input"] = _duration_label(start_dt, end_dt)

    # VMUI lives under /select/vmui/ and uses hash routing. Querystring goes
    # *after* the hash so JS reads it from `location.hash`.
    base = base_url.rstrip("/")
    encoded = urllib.parse.urlencode(qs, quote_via=urllib.parse.quote)
    return f"{base}/select/vmui/?#/?{encoded}"
