# Python runner — Central RBAC conformance

Runs [`../scenarios.md`](../scenarios.md) 20 scenarios against `onelog-central-rbac-client` Python SDK.

## Install + run

```bash
cd runner-python
pip install -e ../../python           # install SDK from local mono-repo
pip install -e .                      # install runner deps
pytest test_conformance.py -v
```

## Expected output

```
Group A — Authentication ..... 4 passed
Group B — Cache .............. 5 passed
Group C — Circuit breaker .... 4 passed
Group D — Security ........... 4 passed
Group E — Behavior ........... 3 passed
20 passed
```

## Design

Uses [`respx`](https://lundberg.github.io/respx/) to intercept SDK httpx calls
at the transport layer — no port binding, no subprocess. Same SDK code path
executes as production; only OS sockets are stubbed.

**Trade-off vs Node runner** (Fastify mock on real port):
- Faster (no HTTP server startup, ~3s total)
- Deterministic (no port race, no async server shutdown)
- Doesn't exercise real TCP/timeout at OS level (SDK-level timeout still tested)

Both runners implement the same 20 scenarios from `scenarios.md`. Any
divergence between runners = SDK bug or SPEC ambiguity.
