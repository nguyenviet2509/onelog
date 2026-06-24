"""Bearer-token verification for MCP requests.

Two layers gate the MCPs in onelog:
  1. Caddy IP whitelist (LAN/VPN CIDRs) — coarse network boundary.
  2. Bearer-token table here — per-user identity for audit.

The same token table guards both mcp-semantic (this service) and the official
mcp-vl: Caddy's `forward_auth` directive hits /auth/verify, this module decides.

Safety: fail-closed by default. Empty MCP_BEARER_TOKENS denies every request
unless MCP_ALLOW_ANON=true is also set (explicit dev opt-in). Production cannot
silently fail-open by forgetting the env var.
"""
from __future__ import annotations

import hashlib
import hmac
from functools import lru_cache

from mcp_semantic.config import settings


def _parse_token_table(raw: str) -> dict[str, str]:
    """Parse `user1:sk-aaa,user2:sk-bbb` → {token: user}.

    Token is the lookup key, user is the audit id. Malformed entries are
    skipped silently — we trust ops to fix .env vs crashing the MCP at boot.
    """
    table: dict[str, str] = {}
    if not raw:
        return table
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry or ":" not in entry:
            continue
        user, token = entry.split(":", 1)
        user = user.strip()
        token = token.strip()
        if user and token:
            table[token] = user
    return table


# Token table is loaded once at first call and cached. Rotation = restart the
# container (5-user internal scale; no hot-reload needed).
@lru_cache(maxsize=1)
def _load_tokens() -> dict[str, str]:
    tokens = _parse_token_table(settings.mcp_bearer_tokens)
    legacy = settings.mcp_bearer.strip()
    if legacy and legacy not in tokens:
        tokens[legacy] = "legacy"
    return tokens


def _verify_token(token: str, table: dict[str, str]) -> str | None:
    """Constant-time-ish lookup: compare against every key with hmac.compare_digest
    so timing doesn't leak which slot matched. Returns the user id on match."""
    matched: str | None = None
    for stored_token, user in table.items():
        if hmac.compare_digest(token, stored_token):
            matched = user
            # Don't break — keep timing roughly constant across the table.
    return matched


def verify_bearer(auth_header: str | None) -> str | None:
    """Return the user id for a valid Bearer header, otherwise None.

    Anon mode requires BOTH empty table AND MCP_ALLOW_ANON=true. Without the
    explicit flag an empty table fails closed.
    """
    table = _load_tokens()
    if not table:
        return "anon" if settings.mcp_allow_anon else None
    if not auth_header:
        return None
    parts = auth_header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return _verify_token(parts[1].strip(), table)


def is_auth_enabled() -> bool:
    """True when at least one token is configured. Used at startup to emit a
    visible warning if the operator left auth disabled."""
    return bool(_load_tokens())


def token_fingerprint(auth_header: str | None) -> str:
    """8-char SHA256 hex prefix for audit/log lines on failed auth. Avoids
    storing or echoing the secret while still letting ops correlate denials
    to a specific (leaked) token."""
    if not auth_header:
        return "-"
    parts = auth_header.split(None, 1)
    if len(parts) != 2:
        return "malformed"
    return hashlib.sha256(parts[1].strip().encode("utf-8", "ignore")).hexdigest()[:8]
