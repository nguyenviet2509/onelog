"""
PII / secret redaction — defense-in-depth layer.

Vector VRL already redacts at ingest. This module re-runs the same patterns
before embedding, so anything that slipped (e.g. Vector parser regression,
mis-tagged field) is caught before reaching OpenAI / Qdrant payload.

Regex-only by design (KISS). Presidio + spaCy add ~500MB image weight for
marginal gain at this stage; revisit if real-world leaks observed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from indexer import metrics

_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<EMAIL>"),
    (
        "priv_ip",
        re.compile(
            r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
            r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
            r"|192\.168\.\d{1,3}\.\d{1,3})\b"
        ),
        "<PRIV_IP>",
    ),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "<JWT>"),
    ("aws_key", re.compile(r"AKIA[0-9A-Z]{16}"), "<AWS_KEY>"),
    (
        "bearer",
        re.compile(r"(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]+"),
        "Authorization: Bearer <TOKEN>",
    ),
    (
        "password",
        re.compile(r"(?i)(?:password|passwd|pwd)[\"\s:=]+[^\s,;\"]+"),
        "password=<REDACTED>",
    ),
]


@dataclass(slots=True)
class RedactResult:
    text: str
    hits: dict[str, int]


def redact(text: str) -> RedactResult:
    hits: dict[str, int] = {}
    out = text
    for kind, pat, repl in _PATTERNS:
        out, n = pat.subn(repl, out)
        if n:
            hits[kind] = n
            metrics.redact_hits.labels(kind=kind).inc(n)
    return RedactResult(text=out, hits=hits)
