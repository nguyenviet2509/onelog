"""
Format an Alertmanager alert + agent triage into a Telegram Markdown message.

Layout:
  🚨 *<alertname>* — <severity>
  *Host:* <host>   *Service:* <service>
  *When:* <startsAt>
  <annotation summary / description>

  *Triage*
  <agent answer with citations>
"""
from __future__ import annotations

from typing import Any

# Telegram Markdown has gotchas: `_` `*` `[` `]` `(` `)` are special. For MVP
# we keep messages short and trust upstream content is well-shaped. If real
# data triggers parse errors, switch parse_mode to "MarkdownV2" + escape.

_SEVERITY_EMOJI = {
    "critical": "🔥",
    "warning": "⚠️",
    "info": "ℹ️",
}


def format_alert(alert: dict[str, Any], triage: str) -> str:
    labels = alert.get("labels") or {}
    annotations = alert.get("annotations") or {}
    severity = str(labels.get("severity", "info")).lower()
    emoji = _SEVERITY_EMOJI.get(severity, "🚨")

    name = labels.get("alertname", "UnknownAlert")
    host = labels.get("host", "?")
    service = labels.get("service") or labels.get("category") or "?"
    when = alert.get("startsAt", "")

    summary = annotations.get("summary", "")
    description = annotations.get("description", "")

    lines = [
        f"{emoji} *{name}* — _{severity}_",
        f"*Host:* `{host}`   *Service:* `{service}`",
    ]
    if when:
        lines.append(f"*When:* `{when}`")
    if summary:
        lines.append("")
        lines.append(summary)
    if description and description != summary:
        lines.append(description)

    lines.append("")
    lines.append("*Triage*")
    lines.append(triage.strip() if triage else "_(no triage available)_")
    return "\n".join(lines)


def fingerprint(alert: dict[str, Any]) -> str:
    """Stable id for dedupe — Alertmanager already supplies `fingerprint`."""
    fp = alert.get("fingerprint")
    if fp:
        return str(fp)
    labels = alert.get("labels") or {}
    return f"{labels.get('alertname','?')}|{labels.get('host','?')}|{labels.get('service','?')}"
