"""
Auth stub middleware — defers real auth (OIDC / email-pass) per phase plan.

Every request gets `request.state.user_sub = "sysadmin"` (also aliased as
user_id for legacy handlers). Interface preserved so swap-in of `oidc_verify`
later changes one module, not callers.

Convention: user_sub matches Central RBAC SDK contract (per SPEC.md).
Real JWT middleware must populate request.state.user_sub from validated
`sub` claim before RBAC preHandler runs.
"""
from __future__ import annotations

from fastapi import Request


async def attach_user(request: Request, call_next):  # type: ignore[no-untyped-def]
    request.state.user_sub = "sysadmin"
    request.state.user_id = "sysadmin"       # legacy alias — keep during migration
    return await call_next(request)
