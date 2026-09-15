"""django_example.py — Django views + settings snippet using Central RBAC SDK.

This is a snippet — real Django apps have `settings.py`, `urls.py`, etc.
Below shows the RBAC-relevant integration only.

## settings.py additions

    RBAC_CLIENT_CONFIG = {
        "central_url": os.environ["CENTRAL_URL"],
        "app_slug": os.environ["APP_SLUG"],
        "central_rbac_token": os.environ["CENTRAL_RBAC_TOKEN"],
    }

    MIDDLEWARE = [
        # ... your auth middleware (sets request.user_sub) ...
        "onelog_central_rbac.adapters.django.CentralRbacMiddleware",
        # ...
    ]

## Custom middleware to set user_sub from JWT

    class JwtAuthMiddleware:
        def __init__(self, get_response):
            self.get_response = get_response

        def __call__(self, request):
            token = request.headers.get("Authorization", "").removeprefix("Bearer ")
            # Real: verify + decode JWT. Demo: use header directly.
            request.user_sub = request.headers.get("x-demo-user-sub")
            return self.get_response(request)

## views.py — apply decorator
"""
from __future__ import annotations

from django.http import HttpRequest, JsonResponse  # type: ignore[import-untyped]

from onelog_central_rbac.adapters.django import require_permission


@require_permission("helpdesk:tickets.read")
def list_tickets(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"tickets": ["TCK-1", "TCK-2"]})


@require_permission("helpdesk:tickets.reply", tenant_id_from="query.dept")
def reply_ticket(request: HttpRequest, ticket_id: str) -> JsonResponse:
    return JsonResponse({"ticket": ticket_id, "status": "replied"})


# Async view example — same decorator works.
async def list_tickets_async(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"tickets": ["TCK-1", "TCK-2"]})


list_tickets_async = require_permission("helpdesk:tickets.read")(list_tickets_async)


# urls.py
"""
    from django.urls import path
    from . import views

    urlpatterns = [
        path("tickets/", views.list_tickets),
        path("tickets/<str:ticket_id>/reply", views.reply_ticket),
    ]
"""
