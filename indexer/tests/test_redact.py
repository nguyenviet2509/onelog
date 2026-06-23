"""Verify defense-in-depth redact catches PII patterns Vector should already strip."""
from __future__ import annotations

import pytest

from indexer.redact import redact

CASES = [
    ("alice@example.com logged in", "email", "<EMAIL>"),
    ("backend 10.0.0.5 timeout", "priv_ip", "<PRIV_IP>"),
    ("internal 172.16.5.10 healthy", "priv_ip", "<PRIV_IP>"),
    ("nat box 192.168.1.1 up", "priv_ip", "<PRIV_IP>"),
    ("token eyJabc.def.ghi failed", "jwt", "<JWT>"),
    ("key AKIAIOSFODNN7EXAMPLE leaked", "aws_key", "<AWS_KEY>"),
    ("Authorization: Bearer abc.def-123 here", "bearer", "<TOKEN>"),
    ("user password=hunter2 admin", "password", "<REDACTED>"),
]


@pytest.mark.parametrize("text,kind,marker", CASES)
def test_redact_known_patterns(text: str, kind: str, marker: str) -> None:
    out = redact(text)
    assert marker in out.text, f"{kind}: marker {marker!r} missing in {out.text!r}"
    assert out.hits.get(kind, 0) >= 1


def test_public_ip_preserved() -> None:
    """Only RFC1918 redacted — public IPs stay so we can correlate attacker sources."""
    out = redact("client 8.8.8.8 GET /api 200")
    assert "8.8.8.8" in out.text
    assert "priv_ip" not in out.hits


def test_no_pii_no_hits() -> None:
    out = redact("nginx healthy, request_id=abc123")
    assert out.hits == {}
    assert out.text == "nginx healthy, request_id=abc123"


def test_multiple_kinds_same_line() -> None:
    out = redact("user alice@example.com from 10.0.0.5 token eyJa.b.c")
    assert out.hits.get("email", 0) == 1
    assert out.hits.get("priv_ip", 0) == 1
    assert out.hits.get("jwt", 0) == 1
