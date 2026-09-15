# onelog-central-rbac-client (Python)

Python SDK cho Central RBAC v2.
Mirror của [`../nodejs/`](../nodejs/) — same protocol, same behavior, snake_case idiomatic.

## Install

```bash
pip install -e ./central-rbac-client/python
# hoặc từ git:
pip install "onelog-central-rbac-client @ git+ssh://git@github.com/inet/onelog.git#subdirectory=central-rbac-client/python"
```

Optional framework adapters (Phase 5):

```bash
pip install "onelog-central-rbac-client[fastapi]"
pip install "onelog-central-rbac-client[django]"
pip install "onelog-central-rbac-client[flask]"
```

## Quickstart

```python
import asyncio
from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig

async def main():
    client = CentralRbacClient(CentralRbacClientConfig(
        central_url="https://rbacnb.000nethost.com",
        app_slug="helpdesk",
        central_rbac_token="rbac_ab12cd34_efgh5678ijkl9012mnop3456",
    ))
    try:
        result = await client.resolve("user-sub-123", tenant_id="dept-hr")
        print(result.permissions)

        check = await client.check_permission("user-sub-123", "helpdesk:tickets.read")
        print(check.granted)
    finally:
        await client.close()

asyncio.run(main())
```

## Env config (recommended)

```bash
export CENTRAL_URL=https://rbacnb.000nethost.com
export APP_SLUG=helpdesk
export CENTRAL_RBAC_TOKEN=rbac_ab12cd34_efgh5678ijkl9012mnop3456
```

```python
from onelog_central_rbac import CentralRbacClient, CentralRbacClientConfig
client = CentralRbacClient(CentralRbacClientConfig.from_env())
```

## Contract

Xem [`../SPEC.md`](../SPEC.md), [`../SECURITY_INVARIANTS.md`](../SECURITY_INVARIANTS.md), [`../SDK-CONVENTION.md`](../SDK-CONVENTION.md).

Node ↔ Python mapping:

| Node (camelCase) | Python (snake_case) |
|---|---|
| `checkPermission` | `check_permission` |
| `centralUrl` | `central_url` |
| `flushCache` | `flush_cache` |

## Dev

```bash
pip install -e ".[dev]"
mypy --strict src/
pytest
```

Conformance: [`../CONFORMANCE_TESTS/`](../CONFORMANCE_TESTS/) — Python runner in Phase 6.
