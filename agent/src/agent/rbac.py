"""rbac.py — Central RBAC SDK wiring (feature-flagged).

Off by default (rbac_enable=false) → routes stay open, auth_stub sets
user_sub='sysadmin'. Flip via env RBAC_ENABLE=true after Central Admin
registers `onelog-agent` app + tokens issued.

Rollout: see plans/reports/pilot-python-sdk-agent.md.
"""
from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, Request

from agent.config import settings
from agent.logging_setup import log

_client: Optional[object] = None       # CentralRbacClient | None (import lazy)


def is_enabled() -> bool:
    return settings.rbac_enable


def init(app: FastAPI) -> None:
    """Initialize SDK + bind_client to FastAPI app.

    No-op nếu rbac_enable=False. Idempotent on repeated calls.
    """
    global _client
    if not settings.rbac_enable:
        log.info("rbac.disabled", reason="RBAC_ENABLE=false; sysadmin stub active")
        return
    if _client is not None:
        return

    # Import lazily so SDK not required at import time when feature-off.
    from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig
    from onelog_central_rbac.adapters.fastapi import bind_client

    cfg = CentralRbacClientConfig(
        central_url=settings.central_url,
        app_slug=settings.app_slug,
        central_rbac_token=settings.central_rbac_token,
    )
    _client = CentralRbacClient(cfg)
    bind_client(app, _client, extract_user_sub=_extract_user_sub)   # type: ignore[arg-type]
    log.info(
        "rbac.enabled",
        central_url=settings.central_url,
        app_slug=settings.app_slug,
    )


async def _extract_user_sub(request: Request) -> Optional[str]:
    """Read user_sub set by auth_stub (or upstream real JWT middleware)."""
    return getattr(request.state, "user_sub", None)


def require(permission_key: str, *, tenant_id_from: Optional[str] = None) -> object:
    """Route dependency — no-op passthrough nếu RBAC off, real check nếu on.

    Return type intentionally `object` so FastAPI accepts it in
    `dependencies=[...]` regardless of RBAC state.
    """
    if not settings.rbac_enable:
        # Passthrough dependency so decorator stays valid at import time.
        from fastapi import Depends

        async def _noop() -> None:
            return None

        return Depends(_noop)

    from onelog_central_rbac.adapters.fastapi import require_permission
    return require_permission(permission_key, tenant_id_from=tenant_id_from)
