"""test_conformance.py — 20 scenarios from ../scenarios.md against Python SDK.

Groups: A auth (4), B cache (5), C circuit breaker (4), D security (4), E behavior (3).
Uses respx to intercept httpx transport — no real HTTP server.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

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


def _resolve_payload(epoch: int = 1, **extra: Any) -> dict[str, Any]:
    return {
        "user_sub": "u-1",
        "app_slug": APP_SLUG,
        "tenant_id": None,
        "effective_roles": ["test.viewer"],
        "permissions": ["test:read"],
        "epoch": epoch,
        "cached": False,
        **extra,
    }


def _cfg(**overrides: Any) -> CentralRbacClientConfig:
    defaults: dict[str, Any] = {
        "central_url": CENTRAL_URL,
        "app_slug": APP_SLUG,
        "central_rbac_token": VALID_TOKEN,
        "epoch_poll_interval_sec": 3600.0,
        "request_timeout_ms": 500,
    }
    defaults.update(overrides)
    return CentralRbacClientConfig(**defaults)


async def _close(client: CentralRbacClient) -> None:
    try:
        await client.close()
    except Exception:
        pass


pytestmark = pytest.mark.asyncio


# ═══════════════════════════════════════════════════════════════════
# Group A — Authentication (4)
# ═══════════════════════════════════════════════════════════════════

class TestGroupA_Authentication:
    async def test_A1_per_app_token_forwarded_no_warn(
        self, caplog: pytest.LogCaptureFixture,
    ) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            with caplog.at_level(logging.WARNING, logger="onelog_central_rbac.client"):
                client = CentralRbacClient(_cfg())
                try:
                    await client.resolve("u-1")
                finally:
                    await _close(client)
            assert route.calls[0].request.headers.get("x-rbac-token") == VALID_TOKEN
            assert not any("per-app" in r.message for r in caplog.records)

    async def test_A2_central_401_raises_invalid_token(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(return_value=httpx.Response(401, headers=OK_HEADERS))
            client = CentralRbacClient(_cfg())
            try:
                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-1")
                assert ei.value.code == "RBAC_INVALID_TOKEN"
                assert ei.value.http_status == 401
            finally:
                await _close(client)

    async def test_A3_missing_token_construct_raises(self) -> None:
        with pytest.raises(CentralRbacError) as ei:
            CentralRbacClient(_cfg(central_rbac_token=""))
        assert ei.value.code == "RBAC_SDK_CONFIG_ERROR"
        assert "central_rbac_token" in str(ei.value)

    async def test_A4_legacy_token_warns_no_raise(
        self, caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.WARNING, logger="onelog_central_rbac.client"):
            client = CentralRbacClient(_cfg(central_rbac_token=LEGACY_TOKEN))
        try:
            legacy_warns = [
                r for r in caplog.records
                if "per-app format" in r.message or "legacy" in r.message.lower()
            ]
            assert len(legacy_warns) >= 1
        finally:
            await _close(client)


# ═══════════════════════════════════════════════════════════════════
# Group B — Cache (5)
# ═══════════════════════════════════════════════════════════════════

class TestGroupB_Cache:
    async def test_B1_first_request_miss_calls_central(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_cfg())
            try:
                res = await client.resolve("u-1")
                assert res.cached is False
                assert route.call_count == 1
            finally:
                await _close(client)

    async def test_B2_second_request_hit_no_central_call(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_cfg())
            try:
                await client.resolve("u-1")
                res = await client.resolve("u-1")
                assert res.cached is True
                assert route.call_count == 1
            finally:
                await _close(client)

    async def test_B3_different_tenant_separate_cache_entry(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_cfg())
            try:
                await client.resolve("u-1", "dept-a")
                await client.resolve("u-1", "dept-b")
                assert route.call_count == 2
            finally:
                await _close(client)

    async def test_B4_epoch_bump_flushes_cache(self) -> None:
        current_epoch = {"n": 1}

        def epoch_response(_req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"app_slug": APP_SLUG, "epoch": current_epoch["n"]},
                headers=OK_HEADERS,
            )

        async with respx.mock(assert_all_called=False) as mock:
            resolve_route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            mock.get(EPOCH_URL).mock(side_effect=epoch_response)

            client = CentralRbacClient(_cfg(epoch_poll_interval_sec=0.05))
            try:
                await asyncio.sleep(0.12)                # let poller establish baseline
                await client.resolve("u-1")
                assert resolve_route.call_count == 1
                current_epoch["n"] = 2
                await asyncio.sleep(0.2)                 # let poller detect bump
                await client.resolve("u-1")
                assert resolve_route.call_count == 2
            finally:
                await _close(client)

    async def test_B5_manual_flush_cache_forces_miss(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_cfg())
            try:
                await client.resolve("u-1")
                client.flush_cache()
                await client.resolve("u-1")
                assert route.call_count == 2
            finally:
                await _close(client)


# ═══════════════════════════════════════════════════════════════════
# Group C — Circuit breaker (4)
# ═══════════════════════════════════════════════════════════════════

class TestGroupC_CircuitBreaker:
    async def test_C1_five_failures_open_circuit(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(500, headers=OK_HEADERS)
            )
            client = CentralRbacClient(
                _cfg(circuit_breaker_threshold=5, circuit_breaker_reset_sec=3600.0)
            )
            try:
                for i in range(5):
                    with pytest.raises(CentralRbacError):
                        await client.resolve(f"u-{i}")
                assert route.call_count == 5
                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-6")
                assert ei.value.code == "RBAC_CIRCUIT_OPEN"
                assert route.call_count == 5
            finally:
                await _close(client)

    async def test_C2_open_rejects_without_http(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(500, headers=OK_HEADERS)
            )
            client = CentralRbacClient(
                _cfg(circuit_breaker_threshold=5, circuit_breaker_reset_sec=3600.0)
            )
            try:
                for i in range(5):
                    with pytest.raises(CentralRbacError):
                        await client.resolve(f"u-{i}")
                before = route.call_count
                with pytest.raises(CentralRbacError):
                    await client.resolve("next-a")
                with pytest.raises(CentralRbacError):
                    await client.resolve("next-b")
                assert route.call_count == before
            finally:
                await _close(client)

    async def test_C3_half_open_allows_one_probe(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            route = mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(500, headers=OK_HEADERS)
            )
            client = CentralRbacClient(
                _cfg(circuit_breaker_threshold=5, circuit_breaker_reset_sec=0.2)
            )
            try:
                for i in range(5):
                    with pytest.raises(CentralRbacError):
                        await client.resolve(f"u-{i}")
                await asyncio.sleep(0.25)
                before = route.call_count
                with pytest.raises(CentralRbacError):
                    await client.resolve("probe")
                assert route.call_count == before + 1
            finally:
                await _close(client)

    async def test_C4_probe_success_closes_circuit(self) -> None:
        mode = {"status": 500}

        def dynamic(_req: httpx.Request) -> httpx.Response:
            if mode["status"] == 500:
                return httpx.Response(500, headers=OK_HEADERS)
            return httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)

        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(side_effect=dynamic)
            client = CentralRbacClient(
                _cfg(circuit_breaker_threshold=5, circuit_breaker_reset_sec=0.2)
            )
            try:
                for i in range(5):
                    with pytest.raises(CentralRbacError):
                        await client.resolve(f"u-{i}")
                await asyncio.sleep(0.25)
                mode["status"] = 200
                await client.resolve("probe")
                for i in range(3):
                    res = await client.resolve(f"follow-{i}")
                    assert res is not None
            finally:
                await _close(client)


# ═══════════════════════════════════════════════════════════════════
# Group D — Security (4)
# ═══════════════════════════════════════════════════════════════════

class TestGroupD_Security:
    async def test_D1_prod_fail_open_constructor_throws(self) -> None:
        os.environ["ENV"] = "production"
        with pytest.raises(CentralRbacError) as ei:
            CentralRbacClient(_cfg(fail_mode="open"))
        assert ei.value.code == "RBAC_SDK_CONFIG_ERROR"
        assert "fail_mode=open" in str(ei.value) or "DEV ONLY" in str(ei.value)

    async def test_D2_central_5xx_fail_close_raises(self) -> None:
        os.environ["ENV"] = "production"
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(return_value=httpx.Response(500, headers=OK_HEADERS))
            client = CentralRbacClient(_cfg(fail_mode="closed"))
            try:
                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-1")
                assert ei.value.code == "RBAC_CENTRAL_5XX"
            finally:
                await _close(client)

    async def test_D3_no_full_token_in_logs(
        self, caplog: pytest.LogCaptureFixture,
    ) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(return_value=httpx.Response(401, headers=OK_HEADERS))
            with caplog.at_level(logging.DEBUG, logger="onelog_central_rbac.client"):
                client = CentralRbacClient(_cfg(central_rbac_token=LEGACY_TOKEN))
                try:
                    await client.resolve("u-1")
                except CentralRbacError:
                    pass
                await _close(client)
            joined = " ".join(r.message for r in caplog.records)
            assert LEGACY_TOKEN not in joined
            assert VALID_TOKEN not in joined

    async def test_D4_x_api_version_mismatch_raises(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers={"X-Api-Version": "1"})
            )
            client = CentralRbacClient(_cfg())
            try:
                with pytest.raises(CentralRbacError) as ei:
                    await client.resolve("u-1")
                assert ei.value.code == "RBAC_MANIFEST_MISMATCH"
            finally:
                await _close(client)


# ═══════════════════════════════════════════════════════════════════
# Group E — Behavior (3)
# ═══════════════════════════════════════════════════════════════════

class TestGroupE_Behavior:
    async def test_E1_epoch_poller_runs_at_interval(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            epoch_route = mock.get(EPOCH_URL).mock(
                return_value=httpx.Response(200, json={"app_slug": APP_SLUG, "epoch": 1}, headers=OK_HEADERS)
            )
            client = CentralRbacClient(_cfg(epoch_poll_interval_sec=0.1))
            try:
                await asyncio.sleep(0.4)
                assert epoch_route.call_count >= 3
            finally:
                await _close(client)

    async def test_E2_resolve_returns_full_shape(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            mock.post(RESOLVE_URL).mock(
                return_value=httpx.Response(200, json=_resolve_payload(), headers=OK_HEADERS)
            )
            client = CentralRbacClient(_cfg())
            try:
                res = await client.resolve("u-1", "dept-a")
                assert isinstance(res.user_sub, str)
                assert isinstance(res.app_slug, str)
                assert res.tenant_id is None or isinstance(res.tenant_id, str)
                assert isinstance(res.effective_roles, list)
                assert isinstance(res.permissions, list)
                assert isinstance(res.epoch, int)
                assert isinstance(res.cached, bool)
            finally:
                await _close(client)

    async def test_E3_close_stops_poller(self) -> None:
        async with respx.mock(assert_all_called=False) as mock:
            epoch_route = mock.get(EPOCH_URL).mock(
                return_value=httpx.Response(200, json={"app_slug": APP_SLUG, "epoch": 1}, headers=OK_HEADERS)
            )
            client = CentralRbacClient(_cfg(epoch_poll_interval_sec=0.05))
            await asyncio.sleep(0.15)
            before = epoch_route.call_count
            await client.close()
            await asyncio.sleep(0.25)
            after = epoch_route.call_count
            assert after - before <= 1
