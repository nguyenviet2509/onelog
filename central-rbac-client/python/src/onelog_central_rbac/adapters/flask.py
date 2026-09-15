"""adapters/flask.py — Flask decorator integration.

Usage:
    from flask import Flask
    from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig
    from onelog_central_rbac.adapters.flask import init_rbac, require_permission

    app = Flask(__name__)
    rbac_client = CentralRbacClient(CentralRbacClientConfig.from_env())
    init_rbac(app, rbac_client)

    @app.get("/tickets")
    @require_permission("helpdesk:tickets.read")
    def list_tickets():
        return jsonify([...])

Flask is sync-first — decorator uses asyncio.run() per-request to bridge
to async SDK. For high-throughput async apps, prefer FastAPI.

User_sub extraction: reads `flask.g.user_sub` set by upstream auth
handler (before_request). Override via init_rbac(..., extract_user_sub=fn).
"""
from __future__ import annotations

import asyncio
from functools import wraps
from typing import Any, Callable, Optional

from flask import Flask, current_app, g, jsonify, request

from ..client import CentralRbacClient
from ..errors import CentralRbacError
from ..util.tenant_id import make_extractor

ExtractUserSub = Callable[[], Optional[str]]


def _default_extract_user_sub() -> Optional[str]:
    return getattr(g, "user_sub", None)


def init_rbac(
    app: Flask,
    client: CentralRbacClient,
    *,
    extract_user_sub: ExtractUserSub = _default_extract_user_sub,
) -> None:
    """Attach SDK client to Flask app extensions.

    Registers teardown_appcontext to close SDK on shutdown. Call once at
    app factory time.
    """
    app.extensions.setdefault("rbac", {})
    app.extensions["rbac"]["client"] = client
    app.extensions["rbac"]["extract_user_sub"] = extract_user_sub

    @app.teardown_appcontext
    def _teardown(_exc: BaseException | None) -> None:   # noqa: ARG001
        # SDK is app-lifetime singleton; do not close per-request.
        # Explicit shutdown via app.extensions['rbac']['client'].close() at exit.
        pass


def _get_client() -> CentralRbacClient:
    client = current_app.extensions.get("rbac", {}).get("client")
    if client is None:
        raise RuntimeError(
            "central-rbac: client not bound. Call init_rbac(app, client) at startup."
        )
    assert isinstance(client, CentralRbacClient)
    return client


def _get_extractor() -> ExtractUserSub:
    extractor: ExtractUserSub = current_app.extensions.get("rbac", {}).get(
        "extract_user_sub", _default_extract_user_sub
    )
    return extractor


def require_permission(
    permission_key: str,
    *,
    tenant_id_from: Optional[str] = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator enforcing permission_key on route handler."""

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            user_sub = _get_extractor()()
            if not user_sub:
                return jsonify({"error": "Unauthorized", "reason": "missing user_sub"}), 401

            tenant_id: Optional[str] = None
            if tenant_id_from is not None:
                tenant_id = make_extractor(
                    tenant_id_from,
                    get_query=lambda k: request.args.get(k),
                    get_param=lambda k: kwargs.get(k),
                    get_header=lambda k: request.headers.get(k),
                    get_body_key=lambda k: (request.get_json(silent=True) or {}).get(k),
                )

            client = _get_client()
            try:
                check = asyncio.run(
                    client.check_permission(user_sub, permission_key, tenant_id)
                )
            except CentralRbacError as err:
                return jsonify({
                    "error": "Service Unavailable",
                    "detail": "Central RBAC unreachable (fail_mode=closed)",
                    "code": err.code,
                }), 503

            if not check.granted:
                return jsonify({
                    "error": "Forbidden",
                    "permission": permission_key,
                    "reason": check.reason,
                }), 403

            return fn(*args, **kwargs)

        return wrapper

    return decorator
