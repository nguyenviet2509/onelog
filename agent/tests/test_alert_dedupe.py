"""TTL dedupe behavior — same key twice = second is duplicate, after TTL = fresh."""
from __future__ import annotations

import time

from agent.alert_dedupe import TTLDedupe


def test_first_seen_returns_false() -> None:
    d = TTLDedupe(ttl_s=60)
    assert d.seen("fp-1") is False


def test_second_seen_within_ttl_returns_true() -> None:
    d = TTLDedupe(ttl_s=60)
    d.seen("fp-1")
    assert d.seen("fp-1") is True


def test_seen_resets_after_ttl_expiry() -> None:
    d = TTLDedupe(ttl_s=1)
    d.seen("fp-1")
    time.sleep(1.1)
    assert d.seen("fp-1") is False


def test_distinct_keys_independent() -> None:
    d = TTLDedupe(ttl_s=60)
    assert d.seen("fp-1") is False
    assert d.seen("fp-2") is False
    assert d.seen("fp-1") is True
