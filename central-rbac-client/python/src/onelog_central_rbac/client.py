"""client.py — CentralRbacClient main class mirror @onelog/central-rbac-client.

Public API (mirror Node camelCase → Python snake_case):
    async resolve(user_sub, tenant_id=None) -> ResolveResponse
    async check_permission(user_sub, permission_key, tenant_id=None) -> PermissionCheck
    async get_epoch() -> int
    flush_cache() -> None
    async close() -> None

Behavior mirrors nodejs/src/client.ts. See ../../../SPEC.md.
"""
from __future__ import annotations

import dataclasses
import logging
import os
import re
from typing import Any

import httpx

from .cache import ResolveCache
from .circuit_breaker import CircuitBreaker
from .epoch_poller import EpochPoller
from .errors import CentralRbacError
from .types import CentralRbacClientConfig, PermissionCheck, ResolveResponse

logger = logging.getLogger("onelog_central_rbac.client")

# Per-app token format from Central v2.0.1 (plan 260915-0830).
_PER_APP_TOKEN_RE = re.compile(r"^rbac_[a-z0-9]{8}_[a-z0-9]{24}$")

# Env markers considered production (any match).
_PRODUCTION_ENV_MARKERS = ("production", "prod")
_ENV_VARS = ("ENV", "PYTHON_ENV", "APP_ENV", "NODE_ENV")


def _is_production() -> bool:
    for var in _ENV_VARS:
        val = os.environ.get(var, "").lower()
        if val in _PRODUCTION_ENV_MARKERS:
            return True
    return False


class CentralRbacClient:
    """Central RBAC v2 client.

    Async. Instantiate once per process (singleton). Call close() on shutdown.
    """

    def __init__(self, config: CentralRbacClientConfig) -> None:
        # ── Config validation ──────────────────────────────────────────────
        if not config.central_url:
            raise CentralRbacError("RBAC_SDK_CONFIG_ERROR", "central_url required")
        if not config.app_slug:
            raise CentralRbacError("RBAC_SDK_CONFIG_ERROR", "app_slug required")
        if not config.central_rbac_token:
            raise CentralRbacError("RBAC_SDK_CONFIG_ERROR", "central_rbac_token required")

        # ── HARDCODED production + fail_mode=open reject ───────────────────
        if _is_production() and config.fail_mode == "open":
            raise CentralRbacError(
                "RBAC_SDK_CONFIG_ERROR",
                "fail_mode=open is DEV ONLY and cannot be used in production. "
                "Central down = apps must return 503, never bypass RBAC. "
                "If Central is down persistently, fix root cause (HA setup, incident response).",
            )

        # Warn once nếu token không match per-app format (legacy sunset 2028-01-01).
        if not _PER_APP_TOKEN_RE.match(config.central_rbac_token):
            logger.warning(
                "[central-rbac-client] central_rbac_token does not match per-app format "
                "(rbac_<prefix>_<secret>). Legacy shared token detected app_slug=%s. "
                "Migrate via Central Admin UI (/apps/<slug>/tokens). Legacy support ends 2028-01-01.",
                config.app_slug,
            )

        # Normalize URL (strip trailing slash).
        self._config = dataclasses.replace(
            config,
            central_url=config.central_url.rstrip("/"),
        )

        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(self._config.request_timeout_ms / 1000.0),
        )
        self._cache = ResolveCache(
            max_size=self._config.cache_max_entries,
            ttl_sec=self._config.cache_ttl_sec,
        )
        self._breaker = CircuitBreaker(
            threshold=self._config.circuit_breaker_threshold,
            reset_sec=self._config.circuit_breaker_reset_sec,
        )
        self._poller = EpochPoller(
            interval_sec=self._config.epoch_poll_interval_sec,
            fetch_epoch=self._fetch_epoch,
            on_epoch_change=self._on_epoch_change,
        )
        self._poller.start()
        self._closed = False

    # ── Public API ─────────────────────────────────────────────────────────

    async def resolve(
        self,
        user_sub: str,
        tenant_id: str | None = None,
    ) -> ResolveResponse:
        cache_key = ResolveCache.build_key(user_sub, self._config.app_slug, tenant_id)

        cached = self._cache.get(cache_key)
        if cached is not None:
            logger.debug("central-rbac-client: cache hit user_sub=%s", user_sub)
            return dataclasses.replace(cached, cached=True)

        if not self._breaker.can_proceed():
            if self._config.fail_mode == "open":
                logger.warning(
                    "central-rbac-client: SDK_FAILOPEN_BYPASS — circuit open + fail_mode=open "
                    "(DEV ONLY) app_slug=%s",
                    self._config.app_slug,
                )
                return self._empty_bypass(user_sub, tenant_id)
            raise CentralRbacError(
                "RBAC_CIRCUIT_OPEN",
                "Central unreachable, circuit open (fail_mode=closed)",
            )

        try:
            result = await self._call_resolve(user_sub, tenant_id)
            self._breaker.record_success()
            self._cache.set(cache_key, result)
            return dataclasses.replace(result, cached=False)
        except CentralRbacError:
            self._breaker.record_failure()
            if self._config.fail_mode == "open":
                logger.warning(
                    "central-rbac-client: SDK_FAILOPEN_BYPASS — call failed + fail_mode=open "
                    "(DEV ONLY) app_slug=%s",
                    self._config.app_slug,
                )
                return self._empty_bypass(user_sub, tenant_id)
            raise

    async def check_permission(
        self,
        user_sub: str,
        permission_key: str,
        tenant_id: str | None = None,
    ) -> PermissionCheck:
        result = await self.resolve(user_sub, tenant_id)
        if permission_key in result.permissions:
            return PermissionCheck(granted=True, resolved_roles=list(result.effective_roles))
        return PermissionCheck(
            granted=False,
            reason=f"permission '{permission_key}' not in resolved set",
            resolved_roles=list(result.effective_roles),
        )

    async def get_epoch(self) -> int:
        return await self._fetch_epoch()

    def flush_cache(self) -> None:
        self._cache.clear()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._poller.stop()
        self._cache.clear()
        await self._http.aclose()

    # ── Internal ──────────────────────────────────────────────────────────

    async def _call_resolve(
        self,
        user_sub: str,
        tenant_id: str | None,
    ) -> ResolveResponse:
        url = f"{self._config.central_url}/v2/resolve"
        body = {
            "user_sub": user_sub,
            "app_slug": self._config.app_slug,
            "tenant_id": tenant_id,
        }
        try:
            res = await self._http.post(
                url,
                json=body,
                headers={"x-rbac-token": self._config.central_rbac_token},
            )
        except httpx.TimeoutException as err:
            raise CentralRbacError(
                "RBAC_CENTRAL_UNREACHABLE",
                f"Central {url} timeout: {err}",
            ) from err
        except httpx.HTTPError as err:
            raise CentralRbacError(
                "RBAC_CENTRAL_UNREACHABLE",
                f"Central {url} unreachable: {err}",
            ) from err

        self._verify_response(res, url)
        data: dict[str, Any] = res.json()
        return ResolveResponse(
            user_sub=data["user_sub"],
            app_slug=data["app_slug"],
            tenant_id=data.get("tenant_id"),
            effective_roles=list(data.get("effective_roles", [])),
            permissions=list(data.get("permissions", [])),
            epoch=int(data.get("epoch", 0)),
            cached=bool(data.get("cached", False)),
        )

    async def _fetch_epoch(self) -> int:
        url = f"{self._config.central_url}/v2/epoch/{self._config.app_slug}"
        try:
            res = await self._http.get(
                url,
                headers={"x-rbac-token": self._config.central_rbac_token},
            )
        except httpx.TimeoutException as err:
            raise CentralRbacError(
                "RBAC_CENTRAL_UNREACHABLE",
                f"Central {url} timeout: {err}",
            ) from err
        except httpx.HTTPError as err:
            raise CentralRbacError(
                "RBAC_CENTRAL_UNREACHABLE",
                f"Central {url} unreachable: {err}",
            ) from err

        self._verify_response(res, url)
        data: dict[str, Any] = res.json()
        return int(data["epoch"])

    def _verify_response(self, res: httpx.Response, url: str) -> None:
        api_version = res.headers.get("x-api-version")
        if api_version is not None and api_version != "2":
            raise CentralRbacError(
                "RBAC_MANIFEST_MISMATCH",
                f"Central returned X-Api-Version={api_version!r}, expected '2'. "
                "Check Central deploy version.",
            )
        status = res.status_code
        if status == 401:
            raise CentralRbacError(
                "RBAC_INVALID_TOKEN",
                "X-Rbac-Token rejected by Central",
                http_status=401,
            )
        if status == 404:
            raise CentralRbacError(
                "RBAC_APP_NOT_FOUND",
                f"Central 404: {url}",
                http_status=404,
            )
        if status >= 500:
            raise CentralRbacError(
                "RBAC_CENTRAL_5XX",
                f"Central 5xx: {status}",
                http_status=status,
            )
        if status >= 400:
            raise CentralRbacError(
                "RBAC_CENTRAL_4XX",
                f"Central 4xx: {status}",
                http_status=status,
            )

    def _on_epoch_change(self, new_epoch: int, old_epoch: int | None) -> None:
        logger.info(
            "central-rbac-client: epoch changed, flushing cache (new=%s old=%s app_slug=%s)",
            new_epoch,
            old_epoch,
            self._config.app_slug,
        )
        self.flush_cache()

    def _empty_bypass(self, user_sub: str, tenant_id: str | None) -> ResolveResponse:
        return ResolveResponse(
            user_sub=user_sub,
            app_slug=self._config.app_slug,
            tenant_id=tenant_id,
            effective_roles=[],
            permissions=[],
            epoch=0,
            cached=False,
        )
