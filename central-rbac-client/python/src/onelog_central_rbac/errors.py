"""errors.py — Error taxonomy mirror @onelog/central-rbac-client (10 codes).

See ../../../SPEC.md §3 for shared semantics.
"""
from __future__ import annotations

from typing import Literal

ErrorCode = Literal[
    "RBAC_SDK_CONFIG_ERROR",      # Bad config (incl. production+fail_mode=open guard)
    "RBAC_CENTRAL_UNREACHABLE",   # HTTP timeout / network error
    "RBAC_CENTRAL_5XX",           # Central 5xx response
    "RBAC_CENTRAL_4XX",           # Central 4xx (non-401/404)
    "RBAC_CIRCUIT_OPEN",          # Circuit breaker opened, request rejected
    "RBAC_MANIFEST_MISMATCH",     # X-Api-Version response header != "2"
    "RBAC_INVALID_TOKEN",         # 401 invalid X-Rbac-Token
    "RBAC_APP_NOT_FOUND",         # 404 app_slug not registered
    "RBAC_PERMISSION_DENIED",     # check_permission returned False
    "RBAC_INTERNAL_ERROR",        # Unknown/unexpected
]


class CentralRbacError(Exception):
    """Sole exception type raised by the SDK.

    Attributes:
        code: 1 of ErrorCode.
        http_status: HTTP status when triggered by HTTP response.
    """

    code: ErrorCode
    http_status: int | None

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status

    def __repr__(self) -> str:
        return f"CentralRbacError(code={self.code!r}, message={self.args[0]!r})"
