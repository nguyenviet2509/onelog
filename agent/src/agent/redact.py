"""
Defense-in-depth redact applied to raw VL passthrough data BEFORE feeding LLM.

Mirrors `indexer/src/indexer/redact.py` patterns. Kept inline (KISS) rather than
extracted to a shared package — 2 services, ~30 lines of regex; extract when a
3rd consumer appears.
"""
from __future__ import annotations

import re

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<EMAIL>"),
    (
        re.compile(
            r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
            r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
            r"|192\.168\.\d{1,3}\.\d{1,3})\b"
        ),
        "<PRIV_IP>",
    ),
    (re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "<JWT>"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "<AWS_KEY>"),
    (
        re.compile(r"(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]+"),
        "Authorization: Bearer <TOKEN>",
    ),
    (
        re.compile(r"(?i)(?:password|passwd|pwd)[\"\s:=]+[^\s,;\"]+"),
        "password=<REDACTED>",
    ),
]


def redact(text: str) -> str:
    out = text
    for pat, repl in _PATTERNS:
        out = pat.sub(repl, out)
    return out
