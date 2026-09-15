# SDK Convention — Cross-SDK consistency (Node ↔ Python)

> **Status**: TODO Phase 2 (plan 260915-1317-central-rbac-client-suite).
> Ensures Node.js and Python SDKs expose same conceptual API,
> idiomatic to each language.

## Placeholder outline

- **API surface table**: method names + params mapping (camelCase ↔ snake_case)
- **Env vars universal**: `CENTRAL_URL`, `APP_SLUG`, `CENTRAL_RBAC_TOKEN`, etc.
- **Error codes shared**: `RBAC_SDK_CONFIG_ERROR`, `RBAC_SDK_TIMEOUT`, etc.
- **Version alignment**: both SDKs bump same semver per Central release
- **Framework adapter naming**: `requirePermission` / `require_permission`
- **Case convention rule**: camelCase Node, snake_case Python — concept keyword identical
