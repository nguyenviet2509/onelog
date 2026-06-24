"""Append-only JSON Lines audit log for MCP traffic.

One line per event. Source field distinguishes mcp-semantic tool calls from
edge auth checks (the /auth/verify endpoint Caddy hits before /mcp/vl/*).
File rolled by host logrotate, not by this process — keeps the writer tiny.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AuditLogger:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        # Best-effort: ensure dir exists. If we can't create it the first write
        # will raise; ops should mount the volume at deploy time.
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        self._lock = threading.Lock()

    def write(
        self,
        *,
        source: str,
        user: str,
        event: str,
        status: str = "ok",
        **fields: Any,
    ) -> None:
        """Append one JSON line. Never raises — audit must not break the tool."""
        entry: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "user": user,
            "event": event,
            "status": status,
        }
        # Drop None values to keep lines tight; ops grep these files.
        for k, v in fields.items():
            if v is not None:
                entry[k] = v
        line = json.dumps(entry, ensure_ascii=False, default=str)
        try:
            with self._lock, self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            # Swallow — losing 1 audit line is better than 500ing a tool.
            # stderr will be visible in `docker logs` if the volume is missing.
            import sys

            print(f"[audit] failed to write {self.path}: {line}", file=sys.stderr)


# Module-level singleton, lazy-initialized once under a lock so two coroutines
# racing on first call cannot end up with separate AuditLogger instances (each
# would carry its own write lock → torn JSON lines under concurrency).
_audit: AuditLogger | None = None
_audit_lock = threading.Lock()


def get_audit() -> AuditLogger:
    global _audit
    if _audit is None:
        with _audit_lock:
            if _audit is None:
                from mcp_semantic.config import settings

                _audit = AuditLogger(settings.audit_log_path)
    return _audit
