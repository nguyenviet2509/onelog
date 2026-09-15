"""adapters/django.py — Django middleware + view decorator.

Usage (sync + async views supported):
    # settings.py
    RBAC_CLIENT_CONFIG = { ... }   # or use env
    MIDDLEWARE = [..., 'onelog_central_rbac.adapters.django.CentralRbacMiddleware', ...]

    # views.py
    from onelog_central_rbac.adapters.django import require_permission

    @require_permission('helpdesk:tickets.read')
    def list_tickets(request):
        return JsonResponse([...])

Middleware initializes SDK client singleton on first request (lazy).
Decorator supports both sync and async views (asgiref bridges).

User_sub extraction: reads `request.user_sub` (attribute set by auth middleware).
Override via subclassing CentralRbacMiddleware.
"""
from __future__ import annotations

import asyncio
from functools import wraps
from typing import Any, Awaitable, Callable, Optional

from asgiref.sync import async_to_sync, iscoroutinefunction
from django.conf import settings                  # type: ignore[import-untyped]
from django.http import HttpRequest, HttpResponse, JsonResponse  # type: ignore[import-untyped]

from ..client import CentralRbacClient
from ..errors import CentralRbacError
from ..types import CentralRbacClientConfig
from ..util.tenant_id import make_extractor

_client_singleton: Optional[CentralRbacClient] = None


def _get_or_build_client() -> CentralRbacClient:
    global _client_singleton
    if _client_singleton is not None:
        return _client_singleton
    cfg = getattr(settings, "RBAC_CLIENT_CONFIG", None)
    if cfg is None:
        _client_singleton = CentralRbacClient(CentralRbacClientConfig.from_env())
    else:
        _client_singleton = CentralRbacClient(CentralRbacClientConfig(**cfg))
    return _client_singleton


def _default_extract_user_sub(request: HttpRequest) -> Optional[str]:
    return getattr(request, "user_sub", None)


class CentralRbacMiddleware:
    """Django middleware attaching SDK client + extractor to request.

    Subclass to override extract_user_sub().
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        self._client = _get_or_build_client()

    def __call__(self, request: HttpRequest) -> HttpResponse:
        request.rbac_client = self._client
        request.rbac_extract_user_sub = self.extract_user_sub
        return self.get_response(request)

    def extract_user_sub(self, request: HttpRequest) -> Optional[str]:
        return _default_extract_user_sub(request)


def _get_client_from_request(request: HttpRequest) -> CentralRbacClient:
    client = getattr(request, "rbac_client", None)
    if client is None:
        return _get_or_build_client()
    assert isinstance(client, CentralRbacClient)
    return client


def _get_extractor(request: HttpRequest) -> Callable[[HttpRequest], Optional[str]]:
    extractor: Optional[Callable[[HttpRequest], Optional[str]]] = getattr(
        request, "rbac_extract_user_sub", None
    )
    if extractor is None:
        return _default_extract_user_sub
    return extractor


async def _check_permission_async(
    request: HttpRequest,
    permission_key: str,
    tenant_id_from: Optional[str],
) -> Optional[JsonResponse]:
    """Return response nếu deny/error, else None (allow)."""
    user_sub = _get_extractor(request)(request)
    if not user_sub:
        return JsonResponse(
            {"error": "Unauthorized", "reason": "missing user_sub"}, status=401
        )

    tenant_id: Optional[str] = None
    if tenant_id_from is not None:
        tenant_id = make_extractor(
            tenant_id_from,
            get_query=lambda k: request.GET.get(k),
            get_param=lambda k: (request.resolver_match.kwargs.get(k)
                                 if request.resolver_match else None),
            get_header=lambda k: request.headers.get(k),
            get_body_key=lambda _k: None,           # body already consumed for POST parsers
        )

    client = _get_client_from_request(request)
    try:
        check = await client.check_permission(user_sub, permission_key, tenant_id)
    except CentralRbacError as err:
        return JsonResponse(
            {
                "error": "Service Unavailable",
                "detail": "Central RBAC unreachable (fail_mode=closed)",
                "code": err.code,
            },
            status=503,
        )

    if not check.granted:
        return JsonResponse(
            {
                "error": "Forbidden",
                "permission": permission_key,
                "reason": check.reason,
            },
            status=403,
        )
    return None


def require_permission(
    permission_key: str,
    *,
    tenant_id_from: Optional[str] = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator supporting both sync and async views.

    Async view → await SDK directly.
    Sync view → asyncio.run() per-request bridge (acceptable for MVP).
    """

    def decorator(view_fn: Callable[..., Any]) -> Callable[..., Any]:
        if iscoroutinefunction(view_fn):
            @wraps(view_fn)
            async def async_wrapper(request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
                deny = await _check_permission_async(request, permission_key, tenant_id_from)
                if deny is not None:
                    return deny
                response: HttpResponse = await view_fn(request, *args, **kwargs)
                return response
            return async_wrapper

        @wraps(view_fn)
        def sync_wrapper(request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
            deny = async_to_sync(_check_permission_async)(request, permission_key, tenant_id_from)
            if deny is not None:
                return deny
            response: HttpResponse = view_fn(request, *args, **kwargs)
            return response
        return sync_wrapper

    return decorator
