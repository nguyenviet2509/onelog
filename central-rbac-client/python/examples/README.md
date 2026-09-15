# Python SDK examples

Copy-paste ready snippets for FastAPI / Flask / Django.

## Common setup

```bash
pip install "onelog-central-rbac-client[fastapi]"    # or [flask] / [django]
export CENTRAL_URL=https://rbacnb.000nethost.com
export APP_SLUG=<your-slug>
export CENTRAL_RBAC_TOKEN=rbac_ab12cd34_efgh5678ijkl9012mnop3456
```

## Files

| File | Framework | Run |
|---|---|---|
| [`fastapi_example.py`](fastapi_example.py) | FastAPI | `uvicorn fastapi_example:app --reload` |
| [`flask_example.py`](flask_example.py) | Flask | `flask --app flask_example run` |
| [`django_example.py`](django_example.py) | Django (snippet) | See file — real project needs `settings.py`/`urls.py` |

## Try requests (FastAPI + Flask)

```bash
# Demo user sub via header (real apps: JWT middleware populates)
curl http://localhost:5000/tickets \
  -H "x-demo-user-sub: 389119343390097411"

# Expect: 200 with tickets if user has helpdesk:tickets.read
#         403 Forbidden if not granted
#         401 Unauthorized if x-demo-user-sub missing
#         503 Service Unavailable if Central down (fail_mode=closed)
```

## Auth middleware note

Examples set `user_sub` from `x-demo-user-sub` header (**demo only**). Production
apps MUST wire JWT verification middleware BEFORE the RBAC dependency runs, and
populate:
- FastAPI: `request.state.user_sub = <sub-from-jwt>`
- Flask: `flask.g.user_sub = <sub-from-jwt>`
- Django: `request.user_sub = <sub-from-jwt>`

The SDK does NOT verify JWTs. It reads `sub` claim only. See top-level
[`../../SECURITY_INVARIANTS.md`](../../SECURITY_INVARIANTS.md) Rule 6.

## Next

- [`../AGENTS.md`](../AGENTS.md) — AI-assisted integration prompts
- [`../README.md`](../README.md) — SDK API reference
- [`../../CONFORMANCE_TESTS/`](../../CONFORMANCE_TESTS/) — verify integration
