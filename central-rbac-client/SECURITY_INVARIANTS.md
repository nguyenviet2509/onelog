# Security Invariants — MUST rules for all Central RBAC SDKs

> **Status**: TODO Phase 2 (plan 260915-1317-central-rbac-client-suite).
> Prescriptive rules both Node.js and Python SDKs MUST follow.
> Violation = security hole. No exceptions.

## Placeholder outline

- MUST fail-close in production (hardcoded reject `failMode=open` when NODE_ENV/ENV=production)
- MUST include epoch in cache key
- MUST NOT log full token (prefix 8 chars only)
- MUST timeout requests ≤500ms default
- MUST verify X-Api-Version response header = "2"
- MUST NOT parse JWT roles claim for authz decisions
- MUST use SDK requirePermission/require_permission only for enforcement
- MUST validate token format (`rbac_[a-z0-9]{8}_[a-z0-9]{24}`) and warn if legacy

Each rule includes: rationale, violation example, mitigation.
