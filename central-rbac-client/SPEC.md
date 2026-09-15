# Central RBAC Protocol Specification

> **Status**: TODO Phase 2 (plan 260915-1317-central-rbac-client-suite).
> Formal contract for Central RBAC v2 endpoints + SDK behavior.
> Reference for both Node.js and Python SDK implementations.

## Placeholder outline

- Central protocol endpoints:
  - `POST /v2/resolve` — request/response schema, error codes
  - `GET /v2/epoch/:app_slug` — response schema, cache semantics
  - `POST /rbac/notify-revoke` (app-side webhook) — payload, HMAC signature
- SDK behavior contracts:
  - Cache key format: `sha256(user_sub + '|' + tenant_id + '|' + epoch)`
  - Epoch invalidation semantics
  - Circuit breaker 3-state machine
  - Fail-close policy in production
  - Timeout defaults (500ms)
- Error taxonomy (shared codes both SDKs)
- Version compatibility (Central v2.x ↔ SDK 0.x)
