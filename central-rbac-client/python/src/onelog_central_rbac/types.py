"""types.py — Public dataclasses mirror @onelog/central-rbac-client types.ts.

Field naming:
- Config fields snake_case (Python convention)
- Wire format (ResolveResponse) snake_case (matches Central JSON)
- Env var names UPPER_SNAKE (same as Node SDK)

See ../../../SDK-CONVENTION.md for Node↔Python mapping.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

FailMode = Literal["closed", "open"]


@dataclass(frozen=True)
class CentralRbacClientConfig:
    """SDK init config. Frozen so immutable after construct.

    Use `CentralRbacClientConfig.from_env()` để build từ env vars.
    """

    central_url: str
    app_slug: str
    central_rbac_token: str
    cache_ttl_sec: int = 60
    cache_max_entries: int = 5000
    epoch_poll_interval_sec: float = 10.0
    circuit_breaker_threshold: int = 5
    circuit_breaker_reset_sec: float = 30.0
    request_timeout_ms: int = 500
    fail_mode: FailMode = "closed"

    @classmethod
    def from_env(cls) -> CentralRbacClientConfig:
        """Build config từ env vars (UPPER_SNAKE names).

        Required: CENTRAL_URL, APP_SLUG, CENTRAL_RBAC_TOKEN
        Optional (default applied nếu absent): RBAC_CACHE_TTL_SEC,
            RBAC_CACHE_MAX, RBAC_EPOCH_POLL_SEC, RBAC_CB_THRESHOLD,
            RBAC_CB_RESET_SEC, RBAC_TIMEOUT_MS, RBAC_FAIL_MODE.
        """
        fail_mode_raw = os.environ.get("RBAC_FAIL_MODE", "closed")
        if fail_mode_raw not in ("closed", "open"):
            fail_mode_raw = "closed"
        return cls(
            central_url=os.environ.get("CENTRAL_URL", ""),
            app_slug=os.environ.get("APP_SLUG", ""),
            central_rbac_token=os.environ.get("CENTRAL_RBAC_TOKEN", ""),
            cache_ttl_sec=int(os.environ.get("RBAC_CACHE_TTL_SEC", "60")),
            cache_max_entries=int(os.environ.get("RBAC_CACHE_MAX", "5000")),
            epoch_poll_interval_sec=float(os.environ.get("RBAC_EPOCH_POLL_SEC", "10")),
            circuit_breaker_threshold=int(os.environ.get("RBAC_CB_THRESHOLD", "5")),
            circuit_breaker_reset_sec=float(os.environ.get("RBAC_CB_RESET_SEC", "30")),
            request_timeout_ms=int(os.environ.get("RBAC_TIMEOUT_MS", "500")),
            fail_mode=fail_mode_raw,  # type: ignore[arg-type]
        )


@dataclass(frozen=True)
class ResolveResponse:
    """Response shape from POST /v2/resolve.

    Snake_case matches wire JSON exactly.
    """

    user_sub: str
    app_slug: str
    tenant_id: str | None
    effective_roles: list[str] = field(default_factory=list)
    permissions: list[str] = field(default_factory=list)
    epoch: int = 0
    cached: bool = False


@dataclass(frozen=True)
class PermissionCheck:
    """Return type of check_permission()."""

    granted: bool
    reason: str | None = None
    resolved_roles: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class EpochResponse:
    """Response shape from GET /v2/epoch/:app_slug."""

    app_slug: str
    epoch: int
    cached: bool = False
