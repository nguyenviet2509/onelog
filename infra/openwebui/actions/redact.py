"""
Redact secrets từ chat transcript trước khi đẩy vào summarizer LLM + OneMCP DB.

Phase 2 (plan 260723-1200), validation V3:
- Hard block (raise RedactBlocked): private keys, AWS/GCP creds, JWT-shaped tokens, OpenAI sk-*
- Soft redact (replace by <REDACTED_*>): IPs public/private, emails ngoài @inet.vn,
  path chứa .env / id_rsa / credentials.json

Áp dụng thứ tự: hard block trước → nếu clean thì soft redact → truyền vào summarizer.
"""

import re
from dataclasses import dataclass


class RedactBlocked(Exception):
    """Raised when transcript chứa secret pattern KHÔNG cho phép submit."""

    def __init__(self, pattern_name: str, sample: str = ""):
        self.pattern_name = pattern_name
        self.sample = sample[:40]
        super().__init__(f"Blocked by {pattern_name} pattern (sample: {self.sample!r})")


# --- Hard-block patterns (raise ngay khi match) ---
HARD_BLOCK_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("pem_private_key", re.compile(r"-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----")),
    ("ssh_rsa_key", re.compile(r"ssh-rsa AAAA[A-Za-z0-9+/=]{200,}")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("gcp_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    (
        "jwt_token",
        re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b"),
    ),
]

# --- Soft redact patterns (replace inline) ---
# Order matters: check specific patterns before general ones.
SOFT_REDACT_RULES: list[tuple[str, re.Pattern, str]] = [
    # Private IPv4 first (10.x, 172.16-31.x, 192.168.x)
    (
        "private_ip",
        re.compile(
            r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b"
        ),
        "<REDACTED_PRIVATE_IP>",
    ),
    # Public IPv4 (any other IP)
    (
        "public_ip",
        re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
        "<REDACTED_IP>",
    ),
    # Emails ngoài @inet.vn
    (
        "external_email",
        re.compile(r"\b[a-zA-Z0-9._%+-]+@(?!inet\.vn\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b"),
        "<REDACTED_EMAIL>",
    ),
    # Sensitive paths
    (
        "sensitive_path",
        re.compile(r"(?:/[\w.-]+)*/(?:\.env(?:\.\w+)?|id_rsa(?:\.pub)?|credentials\.json)\b"),
        "<REDACTED_PATH>",
    ),
]


@dataclass
class RedactResult:
    text: str
    hits: dict[str, int]  # pattern_name → count

    @property
    def touched(self) -> bool:
        return any(v > 0 for v in self.hits.values())


def check_hard_block(text: str) -> None:
    """Raise RedactBlocked nếu match pattern hard-block. Không mutate text."""
    for name, pat in HARD_BLOCK_PATTERNS:
        m = pat.search(text)
        if m:
            raise RedactBlocked(name, m.group(0))


def soft_redact(text: str) -> RedactResult:
    """Replace soft patterns bằng placeholder. Trả text mới + count per pattern."""
    hits: dict[str, int] = {}
    out = text
    for name, pat, placeholder in SOFT_REDACT_RULES:
        new_out, n = pat.subn(placeholder, out)
        if n > 0:
            hits[name] = n
            out = new_out
    return RedactResult(text=out, hits=hits)


def redact(text: str) -> RedactResult:
    """Full pipeline: hard-block check → soft redact.

    Raises:
        RedactBlocked: nếu text chứa secret không cho phép submit.
    """
    check_hard_block(text)
    return soft_redact(text)
