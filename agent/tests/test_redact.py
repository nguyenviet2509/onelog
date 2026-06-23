"""Same PII patterns as indexer — defense-in-depth at agent boundary too."""
from __future__ import annotations

import pytest

from agent.redact import redact

CASES = [
    ("alice@example.com logged in", "<EMAIL>"),
    ("backend 10.0.0.5 timeout", "<PRIV_IP>"),
    ("token eyJabc.def.ghi failed", "<JWT>"),
    ("key AKIAIOSFODNN7EXAMPLE leaked", "<AWS_KEY>"),
    ("Authorization: Bearer abc.def-123 here", "<TOKEN>"),
    ("user password=hunter2 admin", "<REDACTED>"),
]


@pytest.mark.parametrize("text,marker", CASES)
def test_pattern_redacted(text: str, marker: str) -> None:
    assert marker in redact(text)


def test_public_ip_preserved() -> None:
    assert "8.8.8.8" in redact("client 8.8.8.8 GET /api 200")


def test_no_pii_unchanged() -> None:
    s = "nginx healthy, request_id=abc123"
    assert redact(s) == s
