# Central RBAC Client Suite — CHANGELOG

Shared changelog for `nodejs/` and `python/` SDKs. Both bump same semver per Central release.

## Unreleased

- Restructure repo to mono-repo layout (nodejs/ + python/ subdirs)
- Populate top-level shared docs — SPEC.md (protocol contract), SECURITY_INVARIANTS.md (12 MUST rules), SDK-CONVENTION.md (Node↔Python mapping), AGENTS.md (AI integration guide)
- Reserve python/ for upcoming Python SDK (plan 260915-1317)

## 0.2.0 (2026-09-15)

**nodejs/** — [see nodejs/CHANGELOG.md](nodejs/CHANGELOG.md)
- Legacy shared token warn on init (per-app format `rbac_<prefix>_<secret>`)
- Non-breaking, config API unchanged

**python/** — not yet released

## 0.1.0 (2026-09-14)

**nodejs/**
- Initial release. Consumes Central RBAC v2 endpoints (/v2/resolve, /v2/epoch).
