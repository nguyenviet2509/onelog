"""flask_example.py — minimal Flask app using Central RBAC SDK.

Run:
    export CENTRAL_URL=https://rbacnb.000nethost.com
    export APP_SLUG=helpdesk
    export CENTRAL_RBAC_TOKEN=rbac_ab12cd34_efgh5678ijkl9012mnop3456
    flask --app flask_example run

Auth: real apps must wire JWT verify + populate flask.g.user_sub BEFORE
require_permission runs. This demo populates from x-demo-user-sub header.
"""
from __future__ import annotations

from typing import Any

from flask import Flask, g, jsonify, request

from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig
from onelog_central_rbac.adapters.flask import init_rbac, require_permission


def create_app() -> Flask:
    app = Flask(__name__)

    rbac_client = CentralRbacClient(CentralRbacClientConfig.from_env())
    init_rbac(app, rbac_client)

    @app.before_request
    def fake_auth() -> None:
        # Demo-only: real apps decode JWT + set g.user_sub here.
        g.user_sub = request.headers.get("x-demo-user-sub")

    @app.get("/tickets")
    @require_permission("helpdesk:tickets.read")
    def list_tickets() -> Any:
        return jsonify(tickets=["TCK-1", "TCK-2"])

    @app.post("/tickets/<ticket_id>/reply")
    @require_permission("helpdesk:tickets.reply", tenant_id_from="query.dept")
    def reply_ticket(ticket_id: str) -> Any:
        return jsonify(ticket=ticket_id, status="replied")

    @app.get("/health")
    def health() -> Any:
        return jsonify(status="ok")

    return app


app = create_app()
