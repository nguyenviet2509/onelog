# Central RBAC Client SDKs

Mono-repo for Central RBAC v2 client SDKs. Both SDKs share protocol,
security invariants, and conformance test suite.

## Which SDK do I need?

Detect your app stack:

| Stack | Directory | Install | Package name |
|---|---|---|---|
| Node.js 20+ | [`nodejs/`](nodejs/) | `npm install file:../central-rbac-client/nodejs` | `@onelog/central-rbac-client` |
| Python 3.11+ | [`python/`](python/) | `pip install -e ./central-rbac-client/python` | `onelog-central-rbac-client` |
| Other (Go, Java, PHP) | — | See sidecar approach (roadmap Q1 2027) | — |

## Both SDKs share

- **Protocol contract**: [`SPEC.md`](SPEC.md) — Central endpoints, schemas, error codes
- **Security invariants**: [`SECURITY_INVARIANTS.md`](SECURITY_INVARIANTS.md) — MUST rules
- **API convention**: [`SDK-CONVENTION.md`](SDK-CONVENTION.md) — cross-SDK consistency
- **AI agent instructions**: [`AGENTS.md`](AGENTS.md) — for AI-assisted integration
- **Conformance tests**: [`CONFORMANCE_TESTS/`](CONFORMANCE_TESTS/) — 20 scenarios verify correctness
- **Version alignment**: 2 SDKs bump same semver aligned with Central release

## Version status

- Node SDK: `0.2.0` (stable, prod-verified 2026-09-14)
- Python SDK: TBD (planned Q4 2026)

## For app developers

1. Pick your SDK based on stack
2. Read `nodejs/README.md` or `python/README.md` for install + quickstart
3. AI-assisted integration: point Claude/Cursor to top-level `AGENTS.md`
4. Verify: run conformance tests from `CONFORMANCE_TESTS/runner-<stack>/`

## For Central RBAC platform team

- Bump BOTH SDKs same version when Central protocol changes
- Update `SPEC.md` + `CHANGELOG.md` with each release
- Run conformance tests both stacks before tagging release

## Related

- Central RBAC backend: [`../central-rbac/`](../central-rbac/)
- App template: [`../central-rbac-app-template/`](../central-rbac-app-template/)
- Plans: [`../plans/260910-1334-central-rbac-v2-refactor/`](../plans/260910-1334-central-rbac-v2-refactor/) + [`../plans/260915-1317-central-rbac-client-suite/`](../plans/260915-1317-central-rbac-client-suite/)
