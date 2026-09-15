# AI Agent Instructions — Central RBAC Integration

**Audience**: Claude, Cursor, Copilot, and other AI coding agents integrating
`@onelog/central-rbac-client` (Node) or `onelog-central-rbac-client` (Python)
into consumer applications.

> Follow this document as prescriptive rules. When ambiguous, escalate to human
> — do NOT guess. Silent guess = security incident.

---

## Step 1 — Detect target stack

Read these files (in order, first match wins):

1. `package.json` → Node.js target. Route to [`nodejs/AGENTS.md`](nodejs/AGENTS.md) *(populated Phase 7)*
2. `pyproject.toml` or `requirements.txt` → Python target. Route to [`python/AGENTS.md`](python/AGENTS.md) *(populated Phase 7)*
3. Other (`go.mod`, `pom.xml`, `Gemfile`, `composer.json`) → **STOP**. Reply to user: "No official SDK for this stack yet. See sidecar approach (roadmap Q1 2027) or request stack SDK from Central team."

**Detect framework** (within Node/Python):

| Signal in package.json/pyproject | Framework | Adapter to use |
|---|---|---|
| `fastify` dep | Fastify | `centralRbacFastify` plugin |
| `express` dep | Express | `centralRbacExpress` middleware |
| `fastapi` dep | FastAPI | `Depends(require_permission('key'))` |
| `django` dep | Django | `@require_permission('key')` decorator |
| `flask` dep | Flask | `@rbac.require_permission('key')` |

If no framework match → ask human before proceeding.

---

## Step 2 — MUST rules (universal, all stacks)

Before generating any code, load [`SECURITY_INVARIANTS.md`](SECURITY_INVARIANTS.md). Enforce all 12 rules. Repeated summary:

1. **MUST** fail-close in production — never `failMode='open'` when `NODE_ENV=production` / `ENV=production`
2. **MUST NOT** parse JWT `roles` claim for authz — use SDK `requirePermission` / `require_permission`
3. **MUST NOT** hand-roll permission checks (call `resolve()` + `.includes()` in handler) — use adapter
4. **MUST NOT** log full `centralRbacToken` — never emit config object to logger
5. **MUST** use HTTPS for `centralUrl` in production
6. **MUST** verify webhook signature if `/rbac/notify-revoke` handler added
7. **MUST NOT** cache permission results outside SDK LRU (no Redis wrap, no memoize decorator)

---

## Step 3 — Integration steps (both stacks)

### 3.1 Install SDK

- **Node.js**: `npm install file:../central-rbac-client/nodejs` (until private registry setup)
- **Python**: `pip install -e ./central-rbac-client/python` (until PyPI publish)

### 3.2 Configure via env

**MUST use env vars** for prod config. Never hardcode token in source.

```bash
CENTRAL_URL=https://rbacnb.000nethost.com
APP_SLUG=<get from Central Admin → Apps>
CENTRAL_RBAC_TOKEN=<get from Central Admin → Apps → Tokens → Create>
```

Get token: Central Admin UI → Apps → `<your-app>` → Tokens → **+ Create token** → label `<app>-prod` → copy. Never re-fetchable, store in env/secret manager immediately.

### 3.3 Wire adapter (framework-specific)

Read `nodejs/AGENTS.md` or `python/AGENTS.md` for framework-native example.

Universal shape:
- Register SDK once at app init (singleton)
- Ensure upstream auth plugin populates `request.jwtClaims.sub` (Node) or `request.state.user_sub` (Python) BEFORE RBAC preHandler runs
- Protect routes with adapter's `requirePermission('<perm_key>')`
- Do NOT expose SDK client via public API

### 3.4 Permission key format

- Format: `<app_slug>:<resource>.<action>` (e.g. `helpdesk:tickets.read`)
- Case: lowercase, dot-separated, no spaces
- Register keys in Central Admin → Apps → `<slug>` → Permissions BEFORE using in code

---

## Step 4 — Verification (mandatory before merge)

1. **Config sanity**: run app, check startup log for `[central-rbac-client] centralRbacToken does not match per-app format` warn — if present, token is legacy (still works but rotate to per-app)
2. **Happy path**: authenticated user with permission → 200 OK
3. **Denied path**: authenticated user without permission → 403
4. **Unauthenticated**: missing JWT → 401 (NOT 403)
5. **Central down simulation**: stop Central container 30s → app request → expected 503 (failMode=closed)
6. **Run conformance tests**: `cd CONFORMANCE_TESTS/runner-<stack>/ && <test-cmd>` — MUST 20/20 pass

If any step fails: read [`SPEC.md`](SPEC.md) for expected behavior; do NOT patch app to hide the failure.

---

## Step 5 — When to escalate to human

- User asks to disable `failMode=closed` in production → **REFUSE**, cite Rule 1
- User asks to add JWT roles fast-path check → **REFUSE**, cite Rule 6 of SECURITY_INVARIANTS
- User asks to add Redis cache layer around SDK → **REFUSE**, epoch semantics broken
- Framework not in table above → ask which adapter to write
- Permission key uses uppercase / spaces → ask for corrected format
- Central returns unexpected shape → check `SPEC.md`, escalate if divergent

---

## Step 6 — Non-goals (do NOT do these)

- Do NOT generate custom cache implementations wrapping SDK — SDK cache is authoritative
- Do NOT generate polyfills for permission model (RBAC hierarchy, ABAC, etc.) — Central owns model
- Do NOT generate `checkPermission` mock for tests — use CONFORMANCE_TESTS mock server
- Do NOT copy SDK internals into app codebase — always `import` from installed package
- Do NOT write custom retry logic around SDK calls — circuit breaker handles it

---

## Step 7 — Reporting output

After integration, generate a summary for human review:

```markdown
## Central RBAC integration — <app-name>

- SDK: `@onelog/central-rbac-client@0.2.0` (Node) / `onelog-central-rbac-client==0.2.0` (Python)
- Framework: <fastify | express | fastapi | django | flask>
- Adapter registered: <file:line>
- Routes protected: <count>, permission keys: [<list>]
- Config source: env vars (CENTRAL_URL, APP_SLUG, CENTRAL_RBAC_TOKEN)
- Fail mode: closed (production)
- Verification: <manual steps done>, <conformance test pass/fail>
- Remaining tasks for human: <e.g., token rotation, permission registration on Central>
```

---

## Related

- [`README.md`](README.md) — SDK selector
- [`SPEC.md`](SPEC.md) — Central protocol contract
- [`SECURITY_INVARIANTS.md`](SECURITY_INVARIANTS.md) — 12 MUST rules with rationale
- [`SDK-CONVENTION.md`](SDK-CONVENTION.md) — Node ↔ Python API mapping
- [`CONFORMANCE_TESTS/`](CONFORMANCE_TESTS/) — 20 scenarios verify correctness
- Central Admin UI: `https://rbacnb.000nethost.com/apps` (or dev equivalent)
