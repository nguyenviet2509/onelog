"""fastapi_example.py — minimal FastAPI app using Central RBAC SDK.

Run:
    export CENTRAL_URL=https://rbacnb.000nethost.com
    export APP_SLUG=helpdesk
    export CENTRAL_RBAC_TOKEN=rbac_ab12cd34_efgh5678ijkl9012mnop3456
    uvicorn fastapi_example:app --reload

Auth middleware (JWT verification) is out of scope — this example sets
request.state.user_sub manually via a fake header for demonstration. In prod,
plug your JWT middleware BEFORE the RBAC dependency runs.
"""
from __future__ import annotations

from fastapi import FastAPI, Request

from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig
from onelog_central_rbac.adapters.fastapi import bind_client, require_permission

app = FastAPI(title="Central RBAC — FastAPI example")

rbac_client = CentralRbacClient(CentralRbacClientConfig.from_env())
bind_client(app, rbac_client)


@app.middleware("http")
async def fake_auth_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Demo-only: set user_sub from header. Replace with real JWT verify."""
    request.state.user_sub = request.headers.get("x-demo-user-sub")
    return await call_next(request)


@app.get(
    "/tickets",
    dependencies=[require_permission("helpdesk:tickets.read")],
)
async def list_tickets() -> dict[str, list[str]]:
    return {"tickets": ["TCK-1", "TCK-2"]}


@app.post(
    "/tickets/{ticket_id}/reply",
    dependencies=[
        require_permission("helpdesk:tickets.reply", tenant_id_from="query.dept"),
    ],
)
async def reply_ticket(ticket_id: str) -> dict[str, str]:
    return {"ticket": ticket_id, "status": "replied"}


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
