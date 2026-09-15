"""onelog_central_rbac — Python SDK for Central RBAC v2.

Public API:
    CentralRbacClient       — main client class
    CentralRbacClientConfig — config dataclass
    CentralRbacError        — error class with `.code`
    ResolveResponse         — resolve() return type
    PermissionCheck         — check_permission() return type
    ErrorCode               — Literal type of 10 error codes

Mirror of @onelog/central-rbac-client (Node.js). See ../SDK-CONVENTION.md.
"""
from .client import CentralRbacClient
from .errors import CentralRbacError, ErrorCode
from .types import (
    CentralRbacClientConfig,
    PermissionCheck,
    ResolveResponse,
)

__all__ = [
    "CentralRbacClient",
    "CentralRbacClientConfig",
    "CentralRbacError",
    "ErrorCode",
    "PermissionCheck",
    "ResolveResponse",
]

__version__ = "0.2.0"
