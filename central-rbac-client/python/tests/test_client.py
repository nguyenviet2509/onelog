"""test_client.py — CentralRbacClient init + HTTP behavior via respx.

Covers config validation, prod fail-open guard, legacy warn, cache hit/miss,
error taxonomy, X-Api-Version verify, close() semantics.

Uses respx to intercept httpx calls — no real HTTP.
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator

import httpx
import pytest
import respx

from onelog_central_rbac import (
    CentralRbacClient,
    CentralRbacClientConfig,
    CentralRbacError,
)

CENTRAL_URL = "http://mock-central.local"
APP_SLUG = "test-app"
VALID_TOKEN = "rbac_ab12cd34_efgh5678ijkl9012mnop3456"
LEGACY_TOKEN = "abcdef1234567890"

RESOLVE_URL = f"{CENTRAL_URL}/v2/resolve"
EPOCH_URL = f"{CENTRAL_URL}/v2/epoch/{APP_SLUG}"

OK_HEADERS = {"X-Api-Version": "2"}


def _resolve_payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "user_sub": "u-1",
        "app_slug": APP_SLUG,
        "tenant_id": None,
        "effective_roles": ["test.viewer"],
        "permissions": ["test:read"],
        "epoch": 1,
        "cached": False,
    }
    base.update(overrides)
    return base


def _build_config(**overrides: object) -> CentralRbacClientConfig:
    defaults: dict[str, object] = {
        "central_url": CENTRAL_URL,
        "app_slug": APP_SLUG,
        "central_rbac_token": VALID_TOKEN,
        "epoch_poll_interval_sec": 3600.0,
        "request_timeout_ms": 500,
    }
    defaults.update(overrides)
    return CentralRbacClientConfig(**defaults)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _clear_env() -> AsyncIterator[None]:
    """Ensure no env leakage between tests."""
    saved = {k: os.environ.get(k) for k in ("ENV", "PYTHON_ENV", "APP_ENV", "NODE_ENV")}
    for k in saved:
        os.environ.pop(k, None)
    yield  # type: ignore[misc]
    for k, v in saved.items():
        if v is not None:
            os.environ[k] = v
        else:
            os.environ.pop(k, None)


# ── Config validation ─────────────────────────────────────────────────────

class TestConfigValidation:
    def test_missing_central_url_raises(self) -> None:
        with pytest.raises(CentralRbacError) as ei:
            CentralRbacClient(_build_config(central_url=""))
        assert ei.value.code == "RBAC_SDK_CONFIG_ERROR"

    def test_missing_app_slug_raises(self) -> None:
        with pytest.raises(CentralRbacError) as ei:
            CentralRbacClient(_build_config(app_slug=""))
        assert ei.value.code == "RBAC_SDK_CONFIG_ERROR"

    def test_missing_token_raises(self) -> None:
        with pytest.raises(CentralRbacError) as ei:
            CentralRbacClient(_build_config(central_rbac_token=""))
        assert ei.value.code == "RBAC_SDK_CONFIG_ERROR"

    def test_prod_fail_open_hardcoded_reject(self) -> None:
        for env_var in ("ENV", "PYTHON_ENV", "APP_ENV", "NODE_ENV"):
            os.environ[env_var] = "production"
            try:
                with pytest.raises(CentralRbacError) as ei:
                    CentralRbacClient(_build_config(fail_mode="open"))
                assert ei.value.code == "RBAC_SDK_CONFIG_ERROR"
                assert "fail_mode=open" in str(ei.value) or "DEV ONLY" in str(ei.value)
            finally:
                os.environ.pop(env_var, None)

    def test_prod_fail_closed_allowed(self) -> None:
        os.environ["ENV"] = "production"
        client = CentralRbacClient(_build_config(fail_mode="closed"))
        asyncio.get_event_loop().run_until_complete(client.close())

    def test_legacy_token_warn_no_raise(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.WARNING, logger="onelog_central_rbac.client"):
            client = CentralRbacClient(_build_config(central_rbac_token=LEGACY_TOKEN))
        assert any("per-app format" in r.message for r in caplog.records)
        asyncio.get_event_loop().run_until_complete(client.close())

    def test_valid_token_no_warn(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.WARNING, logger="onelog_central_rbac.client"):
            client = CentralRbacClient(_build_config())
        assert not any("per-app format" in r.message for r in caplog.records)
        asyncio.get_event_loop().run_until_complete(client.close())


# ── HTTP behavior via respx ────────────────────────────────────────────────

@pytest.mark.asyncio
class TestResolve:
    async def test_resolve_calls_central_and_caches(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_build_config())
            try:
                r1 = await client.resolve("u-1")
                assert r1.cached is False
                assert route.call_count == 1
                r2 = await client.resolve("u-1")
                assert r2.cached is True
                assert route.call_count == 1
            finally:
                await client.close()

    async def test_different_tenant_separate_entries(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_build_config())
            try:
                await client.resolve("u-1", "dept-a")
                await client.resolve("u-1", "dept-b")
                assert route.call_count == 2
            finally:
                await client.close()

    async def test_flush_cache_forces_re_resolve(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_build_config())
            try:
                await client.resolve("u-1")
                client.flush_cache()
                await client.resolve("u-1")
                assert route.call_count == 2
            finally:
                await client.close()

    async def test_check_permission_grants_and_denies(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_build_config())
            try:
                ok = await client.check_permission("u-1", "test:read")
                assert ok.granted is True
                denied = await client.check_permission("u-1", "test:admin")
                assert denied.granted is False
                assert denied.reason is not None
            finally:
                await client.close()


@pytest.mark.asyncio
class TestErrorTaxonomy:
    async def test_401_raises_invalid_token(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(return_value=httpx.Response(401, headers=OK_HEADERS))
            client = CentralRbacClient(_build_config())
            try:
                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-1")
                assert ei.value.code == "RBAC_INVALID_TOKEN"
                assert ei.value.http_status == 401
            finally:
                await client.close()

    async def test_404_raises_app_not_found(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(return_value=httpx.Response(404, headers=OK_HEADERS))
            client = CentralRbacClient(_build_config())
            try:
                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-1")
                assert ei.value.code == "RBAC_APP_NOT_FOUND"
            finally:
                await client.close()

    async def test_500_raises_central_5xx(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(return_value=httpx.Response(500, headers=OK_HEADERS))
            client = CentralRbacClient(_build_config())
            try:
                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-1")
                assert ei.value.code == "RBAC_CENTRAL_5XX"
            finally:
                await client.close()

    async def test_x_api_version_mismatch_raises(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers={"X-Api-Version": "1"})
            )
            client = CentralRbacClient(_build_config())
            try:
                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-1")
                assert ei.value.code == "RBAC_MANIFEST_MISMATCH"
            finally:
                await client.close()

    async def test_missing_x_api_version_accepted(self) -> None:
        """Absence = accept (rollout window)."""
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload())      # no header
            )
            client = CentralRbacClient(_build_config())
            try:
                r = await client.resolve("u-1")
                assert r is not None
            finally:
                await client.close()


@pytest.mark.asyncio
class TestCircuitBreakerIntegration:
    async def test_opens_after_5_failures(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(return_value=httpx.Response(500, headers=OK_HEADERS))
            client = CentralRbacClient(
                _build_config(
                    circuit_breaker_threshold=5,
                    circuit_breaker_reset_sec=3600.0,
                )
            )
            try:
                for i in range(5):
                    with pytest.raises(CentralRbacError):
                        await client.resolve(f"u-{i}")
                assert route.call_count == 5

                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-x")
                assert ei.value.code == "RBAC_CIRCUIT_OPEN"
                assert route.call_count == 5    # no extra HTTP call
            finally:
                await client.close()

    async def test_fail_open_bypass_returns_empty_perms(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(return_value=httpx.Response(500, headers=OK_HEADERS))
            client = CentralRbacClient(_build_config(fail_mode="open"))
            try:
                r = await client.resolve("u-1")
                assert r.permissions == []
                assert r.effective_roles == []
            finally:
                await client.close()


@pytest.mark.asyncio
class TestSecurity:
    async def test_no_full_token_in_logs(
        self, caplog: pytest.LogCaptureFixture,
    ) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(return_value=httpx.Response(401, headers=OK_HEADERS))
            with caplog.at_level(logging.DEBUG, logger="onelog_central_rbac.client"):
                client = CentralRbacClient(_build_config(central_rbac_token=LEGACY_TOKEN))
                try:
                    with pytest.raises(CentralRbacError):
                        await client.resolve("u-1")
                finally:
                    await client.close()
            joined = " ".join(r.message for r in caplog.records)
            assert LEGACY_TOKEN not in joined
            assert VALID_TOKEN not in joined
