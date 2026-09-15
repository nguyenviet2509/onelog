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

import os

from fastapi import Request


async def attach_user(request: Request, call_next):  # type: ignore[no-untyped-def]
    # Pilot 2026-09-15 (Phase 8 plan 260915-1317): user_sub sourced from
    # PILOT_USER_SUB env var so Central RBAC pilot can grant a real Zitadel
    # user without embedding identity in code. Default 'sysadmin' preserved
    # for existing prod. Real JWT verify (Zitadel introspect) replaces this
    # module in next iteration.
    sub = os.environ.get("PILOT_USER_SUB", "sysadmin")
    request.state.user_sub = sub
    request.state.user_id = sub        # legacy alias — keep during migration
    return await call_next(request)
