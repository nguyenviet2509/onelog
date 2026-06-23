"""
Auth stub middleware — defers real auth (OIDC / email-pass) per phase plan.

Every request gets `request.state.user_id = "sysadmin"`. Interface preserved
so swap-in of `oidc_verify` later changes one module, not callers.
"""
from __future__ import annotations

from fastapi import Request


async def attach_user(request: Request, call_next):  # type: ignore[no-untyped-def]
    request.state.user_id = "sysadmin"
    return await call_next(request)
