# Node runner — Central RBAC conformance

Runs [`../scenarios.md`](../scenarios.md) 20 scenarios against `@onelog/central-rbac-client` Node SDK.

## Install + run

```bash
cd runner-nodejs
npm install
npm test
```

## Expected output

```
✓ Group A: Authentication (4 tests)
✓ Group B: Cache (5 tests)
✓ Group C: Circuit breaker (4 tests)
✓ Group D: Security (4 tests)
✓ Group E: Behavior (3 tests)
Test Files  1 passed (1)
     Tests  20 passed (20)
```

Total time: <30s.

## Files

- `mock-central-server.ts` — Fastify mock Central for isolated testing
- `run-conformance.test.ts` — Vitest suite mapping each scenario A1..E3
- `package.json` — deps: SDK (file:), Fastify, Vitest

## Debugging

Use `npm run test:watch` for iterative dev. Set `DEBUG=1` env var to unmute mock server logs.
