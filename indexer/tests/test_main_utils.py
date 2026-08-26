"""Test main.py utility functions: _safe_weight, _extract_msg, _event_ts, _max_severity."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from indexer.main import (
    MAX_DEDUP_COUNT,
    _event_ts,
    _extract_msg,
    _max_severity,
    _safe_weight,
)


class Test_safe_weight:
    """Verify _safe_weight bounds untrusted dedup_count: None → 1, huge int → capped, errors → 1."""

    def test_safe_weight_none_returns_1(self) -> None:
        """Malformed (None) must fallback to 1."""
        assert _safe_weight(None) == 1

    def test_safe_weight_positive_int(self) -> None:
        """Normal positive int returned as-is."""
        assert _safe_weight(5) == 5
        assert _safe_weight(1) == 1
        assert _safe_weight(42) == 42

    def test_safe_weight_zero_becomes_1(self) -> None:
        """Zero is invalid count; max(1, ...) enforces minimum 1."""
        assert _safe_weight(0) == 1

    def test_safe_weight_negative_int_becomes_1(self) -> None:
        """Negative count is impossible; coerced to 1."""
        assert _safe_weight(-5) == 1
        assert _safe_weight(-1) == 1
        assert _safe_weight(-9999) == 1

    def test_safe_weight_string_numeric_coerces(self) -> None:
        """Numeric strings should int() without error."""
        assert _safe_weight("10") == 10
        assert _safe_weight("1") == 1
        assert _safe_weight("5000") == 5000

    def test_safe_weight_string_non_numeric_fallback(self) -> None:
        """Non-numeric strings fail int() → catch ValueError → return 1."""
        assert _safe_weight("bogus") == 1
        assert _safe_weight("") == 1
        assert _safe_weight("hello_world") == 1

    def test_safe_weight_float_coerces_to_int(self) -> None:
        """float can int() → truncate."""
        assert _safe_weight(3.7) == 3
        assert _safe_weight(10.1) == 10
        assert _safe_weight(0.5) == 1  # int(0.5) = 0, max(1, 0) = 1

    def test_safe_weight_list_raises_typeerror_fallback(self) -> None:
        """Unhashable / composite types fail int() → return 1."""
        assert _safe_weight([1, 2, 3]) == 1
        assert _safe_weight({"a": 1}) == 1
        assert _safe_weight((1, 2)) == 1

    def test_safe_weight_huge_int_capped(self) -> None:
        """DoS cap: any int > MAX_DEDUP_COUNT → min(..., MAX_DEDUP_COUNT)."""
        assert _safe_weight(MAX_DEDUP_COUNT) == MAX_DEDUP_COUNT
        assert _safe_weight(MAX_DEDUP_COUNT + 1) == MAX_DEDUP_COUNT
        assert _safe_weight(10**18) == MAX_DEDUP_COUNT
        assert _safe_weight(999999999999) == MAX_DEDUP_COUNT

    def test_safe_weight_huge_string_capped(self) -> None:
        """Huge numeric string still capped at MAX_DEDUP_COUNT."""
        assert _safe_weight("99999999999999999") == MAX_DEDUP_COUNT

    def test_safe_weight_returns_int_type(self) -> None:
        """Always returns int, never float or None."""
        result = _safe_weight(5)
        assert isinstance(result, int)
        result = _safe_weight(None)
        assert isinstance(result, int)
        result = _safe_weight("bogus")
        assert isinstance(result, int)

    def test_safe_weight_returns_at_least_1(self) -> None:
        """Postcondition: always >= 1."""
        test_values = [None, 0, -100, "invalid", [1, 2], 1, 5, 10**18]
        for val in test_values:
            result = _safe_weight(val)
            assert result >= 1, f"_safe_weight({val}) = {result}, expected >= 1"


class Test_extract_msg:
    """Verify _extract_msg prefers _msg, falls back to message/empty."""

    def test_extract_msg_from_underscore_msg(self) -> None:
        """_msg field is primary."""
        event = {"_msg": "primary message"}
        assert _extract_msg(event) == "primary message"

    def test_extract_msg_fallback_to_message(self) -> None:
        """Falls back to message if _msg missing."""
        event = {"message": "fallback message"}
        assert _extract_msg(event) == "fallback message"

    def test_extract_msg_prefers_underscore_msg_over_message(self) -> None:
        """_msg takes priority even if message exists."""
        event = {"_msg": "primary", "message": "fallback"}
        assert _extract_msg(event) == "primary"

    def test_extract_msg_empty_dict_returns_empty(self) -> None:
        """No fields → empty string (stripped)."""
        assert _extract_msg({}) == ""

    def test_extract_msg_strips_whitespace(self) -> None:
        """Leading/trailing whitespace stripped."""
        event = {"_msg": "  message with spaces  "}
        assert _extract_msg(event) == "message with spaces"

    def test_extract_msg_coerces_non_string_to_string(self) -> None:
        """Non-string values → str() coerced."""
        event = {"_msg": 12345}
        assert _extract_msg(event) == "12345"


class Test_event_ts:
    """Verify _event_ts parses RFC3339 _time or fallback to now."""

    def test_event_ts_parses_rfc3339(self) -> None:
        """Standard RFC3339 format (UTC Z suffix)."""
        event = {"_time": "2026-08-26T10:30:45Z"}
        ts = _event_ts(event)
        # Just verify it's a reasonable float (not current time)
        assert isinstance(ts, float)
        assert ts > 0

    def test_event_ts_rfc3339_with_offset(self) -> None:
        """RFC3339 with explicit +00:00 offset."""
        event = {"_time": "2026-08-26T10:30:45+00:00"}
        ts = _event_ts(event)
        assert isinstance(ts, float)

    def test_event_ts_missing_returns_approx_now(self) -> None:
        """No _time field → time.time()."""
        before = time.time()
        ts = _event_ts({})
        after = time.time()
        assert before <= ts <= after

    def test_event_ts_invalid_string_returns_now(self) -> None:
        """Unparseable string → fallback to now."""
        before = time.time()
        ts = _event_ts({"_time": "not-a-timestamp"})
        after = time.time()
        assert before <= ts <= after

    def test_event_ts_non_string_ignored(self) -> None:
        """_time is not string (int, dict, etc.) → ignored, fallback to now."""
        before = time.time()
        ts = _event_ts({"_time": 12345})
        after = time.time()
        assert before <= ts <= after


class Test_max_severity:
    """Verify _max_severity ranks severity correctly."""

    def test_max_severity_same_returns_either(self) -> None:
        """Same severity → returns that severity."""
        assert _max_severity("warning", "warning") == "warning"
        assert _max_severity("error", "error") == "error"

    def test_max_severity_info_lower_than_error(self) -> None:
        """Lower ranks: info < warning < error < crit."""
        assert _max_severity("info", "warning") == "warning"
        assert _max_severity("warning", "error") == "error"
        assert _max_severity("info", "error") == "error"

    def test_max_severity_higher_rank_wins(self) -> None:
        """Higher-ranked severity always wins."""
        assert _max_severity("error", "info") == "error"
        assert _max_severity("crit", "warning") == "crit"
        assert _max_severity("emerg", "error") == "emerg"

    def test_max_severity_case_insensitive(self) -> None:
        """Ranking is case-insensitive."""
        assert _max_severity("ERROR", "info") == "ERROR"
        assert _max_severity("Warning", "Info") == "Warning"

    def test_max_severity_unknown_ranks_low(self) -> None:
        """Unrecognized severity ranks below all known ones."""
        assert _max_severity("unknown", "warning") == "warning"
        assert _max_severity("unknown", "info") == "info"
        assert _max_severity("badrank", "error") == "error"

    def test_max_severity_both_unknown_returns_first(self) -> None:
        """Both unknown → returns first arg (both rank -1)."""
        result = _max_severity("xyz", "abc")
        assert result == "xyz"
