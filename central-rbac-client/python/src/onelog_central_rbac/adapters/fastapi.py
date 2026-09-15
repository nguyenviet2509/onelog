"""adapters/fastapi.py — FastAPI integration via Depends().

Usage:
    from fastapi import FastAPI
    from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig
    from onelog_central_rbac.adapters.fastapi import bind_client, require_permission

    app = FastAPI()
    rbac_client = CentralRbacClient(CentralRbacClientConfig.from_env())
    bind_client(app, rbac_client)

    @app.get("/tickets", dependencies=[require_permission("helpdesk:tickets.read")])
    async def list_tickets():
        return [...]

User_sub extraction: reads from `request.state.user_sub` (populated by auth middleware).
Override via `bind_client(..., extract_user_sub=custom)`.

MUST NOT be used to bypass Rule 6 of SECURITY_INVARIANTS.md
(never authorize from JWT roles claim — SDK owns authorization).
"""
from __future__ import annotations

from typing import Awaitable, Callable, Optional

from fastapi import Depends, FastAPI, HTTPException, Request

from ..client import CentralRbacClient
from ..errors import CentralRbacError
from ..util.tenant_id import make_extractor

ExtractUserSub = Callable[[Request], Awaitable[Optional[str]] | Optional[str]]


async def _default_extract_user_sub(request: Request) -> Optional[str]:
    """Default: read request.state.user_sub set by upstream auth middleware.

    App auth middleware MUST set `request.state.user_sub` after verifying JWT.
    SDK does not verify tokens — only reads identity claim.
    """
    return getattr(request.state, "user_sub", None)


def bind_client(
    app: FastAPI,
    client: CentralRbacClient,
    *,
    extract_user_sub: ExtractUserSub = _default_extract_user_sub,
) -> None:
    """Attach SDK client + user_sub extractor to app.state.

    Call once at app startup. Registers shutdown hook to close SDK cleanly.
    """
    app.state.rbac_client = client
    app.state.rbac_extract_user_sub = extract_user_sub

    @app.on_event("shutdown")
    async def _close_rbac() -> None:
        await client.close()


def _get_client(request: Request) -> CentralRbacClient:
    client = getattr(request.app.state, "rbac_client", None)
    if client is None:
        raise RuntimeError(
            "central-rbac: client not bound. Call bind_client(app, client) at startup."
        )
    assert isinstance(client, CentralRbacClient)
    return client


async def _resolve_user_sub(request: Request) -> Optional[str]:
    extractor: ExtractUserSub = getattr(
        request.app.state, "rbac_extract_user_sub", _default_extract_user_sub
    )
    result = extractor(request)
    if hasattr(result, "__await__"):
        awaited = await result  # type: ignore[misc]
        return awaited if awaited is None else str(awaited)
    return result if result is None else str(result)


def require_permission(
    permission_key: str,
    *,
    tenant_id_from: Optional[str] = None,
) -> object:
    """Return FastAPI dependency enforcing permission_key.

    tenant_id_from: 'query.dept' | 'params.dept' | 'headers.x-tid' | 'body.dept'.
      body extraction not supported (FastAPI body already parsed at Depends time
      only if declared in signature — keep body-based tenant_id in handler).
    """
    async def dependency(request: Request) -> None:
        user_sub = await _resolve_user_sub(request)
        if not user_sub:
            raise HTTPException(
                status_code=401,
                detail={"error": "Unauthorized", "reason": "missing user_sub"},
            )

        tenant_id: Optional[str] = None
        if tenant_id_from is not None:
            tenant_id = make_extractor(
                tenant_id_from,
                get_query=lambda k: request.query_params.get(k),
                get_param=lambda k: request.path_params.get(k),
                get_header=lambda k: request.headers.get(k),
                get_body_key=lambda _k: None,   # not supported at Depends
            )

        client = _get_client(request)
        try:
            check = await client.check_permission(user_sub, permission_key, tenant_id)
        except CentralRbacError as err:
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "Service Unavailable",
                    "detail": "Central RBAC unreachable (fail_mode=closed)",
                    "code": err.code,
                },
            ) from err

        if not check.granted:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "Forbidden",
                    "permission": permission_key,
                    "reason": check.reason,
                },
            )

    return Depends(dependency)
