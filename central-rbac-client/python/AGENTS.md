# AI Agent Instructions — Python SDK Integration

**Audience**: Claude, Cursor, Copilot generating Python integrations for
`onelog-central-rbac-client`.

**Load first**: [`../AGENTS.md`](../AGENTS.md) (top-level, universal MUST rules)
+ [`../SECURITY_INVARIANTS.md`](../SECURITY_INVARIANTS.md) (12 rules).

This file adds Python-specific prescriptions on top of those.

---

## Detection

Read `pyproject.toml` or `requirements.txt`. Route by dep:

| Signal | Framework | Import path |
|---|---|---|
| `fastapi` | FastAPI | `from onelog_central_rbac.adapters.fastapi import bind_client, require_permission` |
| `flask` | Flask | `from onelog_central_rbac.adapters.flask import init_rbac, require_permission` |
| `django` | Django | `from onelog_central_rbac.adapters.django import CentralRbacMiddleware, require_permission` |
| Other | — | STOP. Ask human. |

Install matching extras:
```bash
pip install "onelog-central-rbac-client[fastapi]"    # or [flask] / [django]
```

---

## MUST rules (Python-specific)

1. **MUST use `CentralRbacClientConfig.from_env()`** — don't hardcode config in code
2. **MUST call `await client.close()`** in shutdown hook (FastAPI `on_event("shutdown")`, Flask atexit, Django `AppConfig.ready` teardown)
3. **MUST await** all SDK client methods — client is fully async
4. **MUST create client ONCE** at app init (singleton). Never per-request
5. **MUST populate user_sub** via auth middleware BEFORE RBAC dependency runs:
   - FastAPI: `request.state.user_sub`
   - Flask: `flask.g.user_sub`
   - Django: `request.user_sub`
6. **MUST NOT** authorize from JWT roles claim — call `require_permission` only (Rule 6 of SECURITY_INVARIANTS)
7. **MUST NOT** wrap SDK in Redis/memcache — SDK cache is authoritative
8. **MUST NOT** patch `_client._http` or other private attrs
9. **MUST set** at least one of `ENV`/`PYTHON_ENV`/`APP_ENV` = `production` in prod deploy — activates fail-open hard guard

---

## Integration recipe — FastAPI

```python
from fastapi import FastAPI, Request
from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig
from onelog_central_rbac.adapters.fastapi import bind_client, require_permission

app = FastAPI()
rbac_client = CentralRbacClient(CentralRbacClientConfig.from_env())
bind_client(app, rbac_client)                            # shutdown hook auto-registered

# Wire auth BEFORE RBAC dependency
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # decode JWT here; DO NOT trust claim without signature verify
    request.state.user_sub = decoded_sub
    return await call_next(request)

# Protect routes
@app.get("/tickets", dependencies=[require_permission("helpdesk:tickets.read")])
async def list_tickets(): ...

@app.post("/tickets/{tid}/reply",
          dependencies=[require_permission("helpdesk:tickets.reply", tenant_id_from="query.dept")])
async def reply_ticket(tid: str): ...
```

---

## Integration recipe — Flask

```python
from flask import Flask, g, request
from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig
from onelog_central_rbac.adapters.flask import init_rbac, require_permission

def create_app() -> Flask:
    app = Flask(__name__)
    client = CentralRbacClient(CentralRbacClientConfig.from_env())
    init_rbac(app, client)

    @app.before_request
    def auth() -> None:
        g.user_sub = decode_jwt_and_get_sub(request)

    @app.get("/tickets")
    @require_permission("helpdesk:tickets.read")
    def list_tickets(): ...

    return app
```

---

## Integration recipe — Django

```python
# settings.py
import os
RBAC_CLIENT_CONFIG = {
    "central_url": os.environ["CENTRAL_URL"],
    "app_slug": os.environ["APP_SLUG"],
    "central_rbac_token": os.environ["CENTRAL_RBAC_TOKEN"],
}
MIDDLEWARE = [
    "myapp.auth.JwtAuthMiddleware",                                    # sets request.user_sub
    "onelog_central_rbac.adapters.django.CentralRbacMiddleware",
    # ...
]

# views.py
from onelog_central_rbac.adapters.django import require_permission

@require_permission("helpdesk:tickets.read")
def list_tickets(request): ...

@require_permission("helpdesk:tickets.reply", tenant_id_from="query.dept")
def reply_ticket(request, ticket_id): ...
```

Sync + async views both supported — decorator dispatches via `iscoroutinefunction`.

---

## Response contract (all 3 frameworks identical)

| Condition | Status | Body shape |
|---|---|---|
| `user_sub` missing | 401 | `{"error": "Unauthorized", "reason": "missing user_sub"}` |
| Permission denied | 403 | `{"error": "Forbidden", "permission": "...", "reason": "..."}` |
| Central down (fail_mode=closed) | 503 | `{"error": "Service Unavailable", "detail": "...", "code": "RBAC_..."}` |
| Success | 200 | (handler response) |

Do NOT change these — apps rely on stable error shape.

---

## Verification workflow

Before merging Python integration:

```bash
# 1. Type check
mypy --strict src/                                      # or your project src dir

# 2. Conformance
cd /path/to/central-rbac-client/CONFORMANCE_TESTS/runner-python
pytest test_conformance.py -v                           # 20/20 MUST pass

# 3. Manual smoke
curl -H "Authorization: Bearer <jwt>" http://localhost:8000/tickets
# 200 → OK. 403 → user lacks perm. 401 → JWT wiring broken. 503 → Central down.
```

If conformance fails → SDK bug or app misuse. Do NOT patch tests to hide.

---

## Escalation triggers

Ask human, do NOT guess when:
- Project uses async Flask + Quart hybrid → adapter not tested there
- Custom JWT middleware doesn't set standard `user_sub` — need custom `extract_user_sub`
- Multi-tenant app with tenant_id in body — `body.dept` not supported by FastAPI adapter (already parsed by Depends)
- User asks to disable `fail_mode='closed'` for "resilience" — REFUSE, cite Rule 1 of SECURITY_INVARIANTS
- Framework not in table above (Sanic, Tornado, Starlette-only, etc.)

---

## Non-goals

- Do NOT write custom cache decorators around SDK methods
- Do NOT write JWT-based fast path bypassing SDK
- Do NOT expose `rbac_client` via HTTP endpoint
- Do NOT create per-request client instances
- Do NOT catch and swallow `CentralRbacError` in handlers — adapter maps to 503

---

## Related

- [`README.md`](README.md) — SDK usage
- [`examples/`](examples/) — copy-paste ready per framework
- [`../SPEC.md`](../SPEC.md) — protocol
- [`../SECURITY_INVARIANTS.md`](../SECURITY_INVARIANTS.md) — 12 MUST rules
- [`../SDK-CONVENTION.md`](../SDK-CONVENTION.md) — Node ↔ Python mapping
- [`../CONFORMANCE_TESTS/runner-python/`](../CONFORMANCE_TESTS/runner-python/) — verification
