"""
Format an Alertmanager alert + agent triage into a Telegram HTML message.

HTML parse mode chosen over Markdown:
  - Markdown(V1) silently breaks on unmatched `_` `*` `` ` `` in user content
    (real triage text contains code fences, brackets, asterisks).
  - MarkdownV2 demands escape of 15+ chars in ALL text — fragile.
  - HTML needs only 3 escapes (`<` `>` `&`) and tag mismatch errors are loud.

Layout:
  🚨 <b>alertname</b> — <i>severity</i>
  <b>Host:</b> <code>host</code>   <b>Service:</b> <code>service</code>
  <b>When:</b> <code>startsAt</code>
  summary
  description

  <b>Triage</b>
  agent answer with citations
"""
from __future__ import annotations

import html
from typing import Any

_SEVERITY_EMOJI = {
    "critical": "🔥",
    "warning": "⚠️",
    "info": "ℹ️",
}


def _esc(s: Any) -> str:
    """HTML-escape — turns `<`, `>`, `&` into entities Telegram accepts."""
    return html.escape(str(s), quote=False)


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
        f"{emoji} <b>{_esc(name)}</b> — <i>{_esc(severity)}</i>",
        f"<b>Host:</b> <code>{_esc(host)}</code>   "
        f"<b>Service:</b> <code>{_esc(service)}</code>",
    ]
    if when:
        lines.append(f"<b>When:</b> <code>{_esc(when)}</code>")
    if summary:
        lines.append("")
        lines.append(_esc(summary))
    if description and description != summary:
        lines.append(_esc(description))

    lines.append("")
    lines.append("<b>Triage</b>")
    lines.append(_esc(triage.strip()) if triage else "<i>(no triage available)</i>")
    return "\n".join(lines)


def fingerprint(alert: dict[str, Any]) -> str:
    """Stable id for dedupe — Alertmanager already supplies `fingerprint`."""
    fp = alert.get("fingerprint")
    if fp:
        return str(fp)
    labels = alert.get("labels") or {}
    return f"{labels.get('alertname','?')}|{labels.get('host','?')}|{labels.get('service','?')}"
