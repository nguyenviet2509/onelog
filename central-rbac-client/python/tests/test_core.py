"""test_core.py — Pure-logic unit tests: cache, circuit breaker, errors, tenant_id.

No HTTP, no async — just isolated behavior of SDK primitives.
"""
from __future__ import annotations

import hashlib
import time

import pytest

from onelog_central_rbac.cache import ResolveCache
from onelog_central_rbac.circuit_breaker import CircuitBreaker
from onelog_central_rbac.errors import CentralRbacError
from onelog_central_rbac.types import ResolveResponse
from onelog_central_rbac.util.tenant_id import make_extractor, parse_spec


# ── ResolveCache ───────────────────────────────────────────────────────────

class TestResolveCache:
    def test_build_key_format_matches_node_sdk(self) -> None:
        """SHA256(user_sub | app_slug | 'NULL') — must be identical to Node."""
        node_expected = hashlib.sha256(b"u-1|app-x|NULL").hexdigest()
        assert ResolveCache.build_key("u-1", "app-x", None) == node_expected

    def test_build_key_null_tenant_uses_literal_string(self) -> None:
        with_null = ResolveCache.build_key("u-1", "app-x", None)
        with_empty = ResolveCache.build_key("u-1", "app-x", "")
        assert with_null != with_empty

    def test_build_key_separates_tenants(self) -> None:
        assert (
            ResolveCache.build_key("u-1", "app-x", "dept-a")
            != ResolveCache.build_key("u-1", "app-x", "dept-b")
        )

    def test_build_key_separates_apps(self) -> None:
        assert (
            ResolveCache.build_key("u-1", "app-a", None)
            != ResolveCache.build_key("u-1", "app-b", None)
        )

    def test_get_set_clear(self) -> None:
        cache = ResolveCache(max_size=10, ttl_sec=60)
        r = ResolveResponse(user_sub="u", app_slug="a", tenant_id=None, epoch=1)
        cache.set("k1", r)
        assert cache.get("k1") == r
        cache.clear()
        assert cache.get("k1") is None

    def test_ttl_expiry(self) -> None:
        cache = ResolveCache(max_size=10, ttl_sec=0.05)
        r = ResolveResponse(user_sub="u", app_slug="a", tenant_id=None, epoch=1)
        cache.set("k", r)
        time.sleep(0.1)
        assert cache.get("k") is None


# ── CircuitBreaker ─────────────────────────────────────────────────────────

class TestCircuitBreaker:
    def test_closed_by_default(self) -> None:
        cb = CircuitBreaker(threshold=3, reset_sec=1.0)
        assert cb.get_state() == "closed"
        assert cb.can_proceed() is True

    def test_opens_after_threshold_failures(self) -> None:
        cb = CircuitBreaker(threshold=3, reset_sec=1.0)
        for _ in range(3):
            assert cb.can_proceed()
            cb.record_failure()
        assert cb.get_state() == "open"
        assert cb.can_proceed() is False

    def test_success_resets_counter(self) -> None:
        cb = CircuitBreaker(threshold=3, reset_sec=1.0)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        cb.record_failure()
        cb.record_failure()
        assert cb.get_state() == "closed"

    def test_half_open_after_reset(self) -> None:
        cb = CircuitBreaker(threshold=2, reset_sec=0.05)
        cb.record_failure()
        cb.record_failure()
        assert cb.get_state() == "open"
        time.sleep(0.08)
        assert cb.can_proceed() is True   # probe allowed
        assert cb.get_state() == "half-open"

    def test_half_open_success_closes(self) -> None:
        cb = CircuitBreaker(threshold=2, reset_sec=0.05)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.08)
        cb.can_proceed()
        cb.record_success()
        assert cb.get_state() == "closed"

    def test_half_open_failure_reopens(self) -> None:
        cb = CircuitBreaker(threshold=2, reset_sec=0.05)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.08)
        cb.can_proceed()
        cb.record_failure()
        assert cb.get_state() == "open"

    def test_single_flight_probe(self) -> None:
        cb = CircuitBreaker(threshold=1, reset_sec=0.05)
        cb.record_failure()
        time.sleep(0.08)
        assert cb.can_proceed() is True     # first probe claimed
        assert cb.can_proceed() is False    # second probe rejected


# ── CentralRbacError ───────────────────────────────────────────────────────

class TestCentralRbacError:
    def test_stores_code_and_message(self) -> None:
        err = CentralRbacError("RBAC_INVALID_TOKEN", "test msg", http_status=401)
        assert err.code == "RBAC_INVALID_TOKEN"
        assert str(err) == "test msg"
        assert err.http_status == 401

    def test_default_http_status_none(self) -> None:
        err = CentralRbacError("RBAC_INTERNAL_ERROR", "boom")
        assert err.http_status is None

    def test_can_be_raised_and_caught(self) -> None:
        with pytest.raises(CentralRbacError) as ei:
            raise CentralRbacError("RBAC_CIRCUIT_OPEN", "test")
        assert ei.value.code == "RBAC_CIRCUIT_OPEN"


# ── tenant_id extractor ────────────────────────────────────────────────────

class TestTenantIdExtractor:
    def test_parse_spec_valid_sections(self) -> None:
        assert parse_spec("query.dept") == ("query", "dept")
        assert parse_spec("params.tid") == ("params", "tid")
        assert parse_spec("headers.x-tid") == ("headers", "x-tid")
        assert parse_spec("body.dept") == ("body", "dept")

    def test_parse_spec_rejects_bad_format(self) -> None:
        with pytest.raises(ValueError, match="expected 'section.key'"):
            parse_spec("nokey")

    def test_parse_spec_rejects_bad_section(self) -> None:
        with pytest.raises(ValueError, match="must be query"):
            parse_spec("cookie.tid")

    def test_make_extractor_routes_to_correct_getter(self) -> None:
        calls: dict[str, str] = {}
        result = make_extractor(
            "query.dept",
            get_query=lambda k: (calls.__setitem__("query", k), "dept-a")[1],
            get_param=lambda k: (calls.__setitem__("param", k), None)[1],
            get_header=lambda k: (calls.__setitem__("header", k), None)[1],
            get_body_key=lambda k: (calls.__setitem__("body", k), None)[1],
        )
        assert result == "dept-a"
        assert calls == {"query": "dept"}
