# Central RBAC SDK Conformance Tests

**Purpose**: Verify SDK implementations honor [`../SPEC.md`](../SPEC.md) contract.
20 scenarios, 2 runners (Node, Python).

## Layout

```
CONFORMANCE_TESTS/
├── scenarios.md              # 20 scenarios (source of truth, plain English)
├── README.md                 # this file
├── runner-nodejs/            # Vitest suite against @onelog/central-rbac-client
│   ├── package.json
│   ├── mock-central-server.ts
│   ├── run-conformance.test.ts
│   └── README.md
└── runner-python/            # pytest suite (Phase 6)
    └── README.md
```

## Run

**Node**:
```bash
cd runner-nodejs
npm install
npm test
# Expected: 20/20 pass, <30s
```

**Python** *(Phase 6)*:
```bash
cd runner-python
pip install -e .
pytest
```

## What if a scenario fails?

1. Check if scenario matches [`../SPEC.md`](../SPEC.md) description
2. If yes: SDK is buggy → fix SDK, re-run
3. If no: SPEC + scenarios out of sync → open issue, don't patch runner to hide

## For app teams

Consume as part of your CI:

**Node CI**:
```yaml
- name: Central RBAC conformance
  run: |
    cd node_modules/@onelog/central-rbac-client
    npm run test:conformance   # to be added Phase 3.5
```

*(Consumer conformance runner is a future goal — Phase 3 ships internal runner only.)*

## Scenarios summary

| Group | Count | Focus |
|---|---|---|
| A - Auth | 4 | Token format, invalid, missing, legacy |
| B - Cache | 5 | Miss/hit, tenant scope, epoch flush, manual flush |
| C - Circuit breaker | 4 | Open, reject, half-open, close |
| D - Security | 4 | Prod fail-open guard, fail-close, token log leak, X-Api-Version |
| E - Behavior | 3 | Poller, response shape, close semantics |

Total: **20**.
