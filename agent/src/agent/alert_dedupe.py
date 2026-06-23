"""
In-memory TTL dedupe — drops duplicate alerts within `alert_dedupe_ttl_s`.

Process-local on purpose: agent is single-instance for MVP. When we scale to
multi-replica, swap to Redis (interface is just `seen(key)` → bool).
"""
from __future__ import annotations

import time
from threading import Lock

from agent.config import settings


class TTLDedupe:
    def __init__(self, ttl_s: int | None = None) -> None:
        self._ttl = ttl_s if ttl_s is not None else settings.alert_dedupe_ttl_s
        self._seen: dict[str, float] = {}
        self._lock = Lock()

    def seen(self, key: str) -> bool:
        """Returns True if `key` was seen within TTL. Otherwise marks + returns False."""
        now = time.time()
        with self._lock:
            self._evict(now)
            if key in self._seen:
                return True
            self._seen[key] = now + self._ttl
            return False

    def _evict(self, now: float) -> None:
        expired = [k for k, exp in self._seen.items() if exp <= now]
        for k in expired:
            del self._seen[k]


dedupe = TTLDedupe()
