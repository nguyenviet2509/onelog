# Changelog

## 0.2.0 (2026-09-15)

**Non-breaking**. SDK config API unchanged.

Added:
- Warning log at constructor if `centralRbacToken` does not match per-app
  format `^rbac_[a-z0-9]{8}_[a-z0-9]{24}$`. Nudges devs to migrate from
  legacy shared `CENTRAL_RBAC_RESOLVE_TOKEN` to per-app tokens.

Migration notes:
- Apps using legacy shared token continue working during 3-month grace
  period (cutoff 2028-01-01 on Central backend).
- To adopt per-app token: get token from Central Admin UI at
  `/apps/<slug>/tokens` or from wizard reveal when registering new app.
  Set as `CENTRAL_RBAC_TOKEN` env var. No SDK code change required.

Docs:
- `docs/central-rbac-app-onboarding.md` step 4 updated with rbac_token
  wizard reveal flow.
- `docs/central-rbac-operator-runbook.md` adds "Manage app tokens" section.
- `docs/central-rbac-why-sdk.md` FAQ extended with per-app token rationale.

## 0.1.0 (2026-09-14)

Initial release. Consumes Central RBAC v2 endpoints (/v2/resolve, /v2/epoch).
