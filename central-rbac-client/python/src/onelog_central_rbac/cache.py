"""cache.py — LRU + TTL cache wrapper mirror @onelog/central-rbac-client lru-cache.

Key format: sha256(user_sub + '|' + app_slug + '|' + (tenant_id or 'NULL'))
See ../../../SPEC.md §2.1.
"""
from __future__ import annotations

import hashlib
from typing import Optional

from cachetools import TTLCache

from .types import ResolveResponse


class ResolveCache:
    """LRU + TTL cache for ResolveResponse.

    Mirror of Node lru-cache used trong client.ts.
    """

    def __init__(self, max_size: int, ttl_sec: float) -> None:
        self._cache: TTLCache[str, ResolveResponse] = TTLCache(
            maxsize=max_size,
            ttl=ttl_sec,
        )

    @staticmethod
    def build_key(user_sub: str, app_slug: str, tenant_id: Optional[str]) -> str:
        """SHA256(user_sub | app_slug | tenant_id or 'NULL').

        MUST match Node SDK format exactly (see SPEC.md §2.1).
        """
        raw = f"{user_sub}|{app_slug}|{tenant_id if tenant_id is not None else 'NULL'}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def get(self, key: str) -> Optional[ResolveResponse]:
        return self._cache.get(key)

    def set(self, key: str, value: ResolveResponse) -> None:
        self._cache[key] = value

    def clear(self) -> None:
        self._cache.clear()

    def __len__(self) -> int:
        return len(self._cache)
