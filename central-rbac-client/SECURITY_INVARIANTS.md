# Security Invariants — MUST rules for all Central RBAC SDKs

**Audience**: SDK maintainers + AI agents generating integration code.
**Rule**: Violation = security hole. No exceptions. No "just this once".

> Any SDK/adapter/app integration MUST honor every rule in this doc. Deviations
> without documented compensating control are treated as security incidents.

---

## Rule 1 — MUST fail-close in production

**Rule**: SDK constructor MUST reject `failMode='open'` khi `NODE_ENV=production` (Node) hoặc `ENV=production` (Python). Hardcoded, no override, no env var escape hatch.

**Why**: `failMode=open` returns empty permissions on Central down = allow all requests through (any perm check returns "denied"). App relying on `require_permission` might interpret that as "no restrictions" if adapter wired wrong. Even correctly wired = complete availability degradation for a fixable outage.

**How to apply**:
- Reference: `nodejs/src/client.ts:73-80` (constructor guard)
- If user needs "app open even Central down": fix Central HA, don't bypass RBAC
- Dev/local override: run with `NODE_ENV=development`, never bypass in staging

**Violation example**:
```typescript
// ❌ WRONG — never expose env override
if (process.env.RBAC_ALLOW_FAIL_OPEN_PROD === '1') { skip guard }

// ❌ WRONG — softening to warning
if (process.env.NODE_ENV === 'production' && failMode === 'open') {
  console.warn('failMode=open in prod'); // still allow
}

// ✅ CORRECT
if (process.env.NODE_ENV === 'production' && failMode === 'open') {
  throw new CentralRbacError('RBAC_SDK_CONFIG_ERROR', 'failMode=open is DEV ONLY');
}
```

---

## Rule 2 — MUST include epoch-derived invalidation in cache

**Rule**: Cache invalidation MUST tie to Central epoch. Either (a) include epoch in cache key OR (b) run epoch poller that flushes cache on epoch change. Reference impl uses (b).

**Why**: Without epoch link, admin revoke → SDK cache serves stale grant for full TTL window (60s default). Attacker with revoked role retains access up to TTL.

**How to apply**:
- Poller interval ≤10s default → max staleness = 10s worst case
- Never cache indefinitely (no `ttl=0` = infinite)
- Cache key MUST NOT be only `user_sub` — MUST include `app_slug` + `tenant_id`

**Violation example**:
```python
# ❌ WRONG — no epoch tie, no TTL
cache[user_sub] = perms  # forever

# ❌ WRONG — key too broad, cross-tenant leak
cache_key = user_sub  # tenant A grant leaks to tenant B lookup

# ✅ CORRECT
cache_key = sha256(f"{user_sub}|{app_slug}|{tenant_id or 'NULL'}").hexdigest()
```

---

## Rule 3 — MUST NOT log full X-Rbac-Token

**Rule**: SDK MUST NOT log/emit/serialize full token value. Max prefix = 8 chars. Never full value in error messages, debug logs, telemetry, or exception `cause`.

**Why**: Logs often shipped to central log aggregator (Grafana, ELK, VictoriaLogs). Token in log = credential in log aggregator = exposed to anyone with log-read. Per-app token can be rotated via Central Admin but rotation window = incident.

**How to apply**:
- Never `logger.info({ config: this.config })` (would include token)
- Sanitize error messages: `Central 401 at ${url}` NOT `Central 401 for token ${token}`
- If debugging needed: log first 8 chars only (`rbac_ab12cd34_***`)

**Violation example**:
```typescript
// ❌ WRONG — full token in error
throw new Error(`Auth failed with token ${this.config.centralRbacToken}`);

// ❌ WRONG — full config dump
this.logger.debug({ config: this.config }, 'init');

// ✅ CORRECT
this.logger.warn({ appSlug: this.config.appSlug }, 'legacy token detected');
```

---

## Rule 4 — MUST timeout requests ≤500ms default

**Rule**: HTTP calls to Central MUST have explicit timeout. Default 500ms. Config max 5000ms. MUST use `AbortController` (Node) / `httpx.Timeout` (Python).

**Why**: No timeout = slow Central = app request queues indefinitely = OOM / thread exhaustion / cascading failure. 500ms is human-imperceptible on cache miss, aggressive enough to trip circuit breaker on real outage.

**How to apply**:
- Use undici `signal: controller.signal` (Node) or `httpx.AsyncClient(timeout=0.5)` (Python)
- Timeout counts as circuit breaker failure
- User override allowed up to 5000ms; refuse > 5000ms in config validation

---

## Rule 5 — MUST verify X-Api-Version response header

**Rule**: Every Central response MUST have `X-Api-Version: 2`. SDK MUST throw `RBAC_MANIFEST_MISMATCH` if header exists and ≠ `'2'`. Absence = accept (rollout window).

**Why**: Prevents SDK 0.2 from calling Central v1 (schema mismatch = silent role bypass). If ops accidentally rolls Central back to v1, SDK MUST fail loudly, not silently mis-interpret response.

**How to apply**: Reference `nodejs/src/client.ts:260-268`.

---

## Rule 6 — MUST NOT parse JWT roles claim for authz

**Rule**: SDK MUST NOT extract roles/permissions from JWT (Zitadel `urn:zitadel:iam:org:project:roles` claim). Authorization decisions MUST come from `check_permission()` only.

**Why**:
1. JWT roles are snapshot at token issuance — 8h+ stale window even after Central revoke
2. JWT roles are Zitadel project roles, NOT Central-resolved effective_roles (missing inheritance, tenant scope, delegation)
3. Central `/v2/resolve` is source of truth; JWT is only for auth (proving identity)

**How to apply**:
- Adapter reads `request.jwtClaims.sub` ONLY (identity)
- Never `request.jwtClaims.roles.includes('admin')` for authz gate
- If user needs offline authz: use `getEpoch()` to detect connectivity, still call SDK

**Violation example**:
```typescript
// ❌ WRONG — bypass SDK using JWT claim
if (req.jwtClaims.roles?.includes('helpdesk.admin')) {
  return handler(req);
}

// ✅ CORRECT
app.get('/admin', {
  preHandler: app.rbac.requirePermission('helpdesk:admin.access'),
}, handler);
```

---

## Rule 7 — MUST use SDK requirePermission for enforcement

**Rule**: Route protection MUST use SDK adapter (`requirePermission` / `require_permission` / decorator). MUST NOT call `resolve()` and hand-roll permission check in handler.

**Why**: Adapter enforces: user_sub extraction, tenant_id extraction, error → 401/403/503 mapping, logging. Hand-rolled = missing at least one, likely all.

**How to apply**:
- Fastify: `preHandler: app.rbac.requirePermission('key')`
- FastAPI: `Depends(require_permission('key'))`
- Django: `@require_permission('key')` decorator
- Flask: `@rbac.require_permission('key')`

**Violation example**:
```typescript
// ❌ WRONG — hand-rolled
app.get('/tickets', async (req, reply) => {
  const perms = await rbac.resolve(req.user.sub);
  if (!perms.permissions.includes('helpdesk:tickets.read')) {
    reply.code(403).send('nope');
  }
  return ticketsList();
});
```

Reason: forgot 503-on-Central-down handling, forgot tenant_id, forgot logging.

---

## Rule 8 — MUST validate token format at init

**Rule**: SDK MUST test token against per-app regex `^rbac_[a-z0-9]{8}_[a-z0-9]{24}$` at construct time. Non-match = log warn (not throw) with legacy sunset date `2028-01-01`.

**Why**: Gives app owners visibility of legacy tokens without breaking deploys. Central still accepts legacy until sunset date. Warn == "you should migrate", not "you must".

---

## Rule 9 — MUST NOT expose SDK config via API

**Rule**: SDK MUST NOT provide `getConfig()` / `.config` public accessor exposing `centralRbacToken`. Config is init-time only, private field.

**Why**: Any accessor = eventual accidental log dump.

---

## Rule 10 — MUST use HTTPS in production for centralUrl

**Rule**: `centralUrl` MUST be `https://` in production. SDK MUST warn (not throw) if `http://` + `NODE_ENV=production`.

**Why**: Token in header over plain HTTP = interceptable. Zero trust environments assume network-level compromise.

**How to apply**:
```typescript
if (process.env.NODE_ENV === 'production' && this.config.centralUrl.startsWith('http://')) {
  this.logger.warn({ centralUrl: this.config.centralUrl }, 'HTTP URL in production — use HTTPS');
}
```

---

## Rule 11 — MUST verify webhook signature (if webhook enabled)

**Rule**: `/rbac/notify-revoke` handler MUST verify `X-Rbac-Notify-Signature` HMAC-SHA256 before acting. Invalid signature = 401, no cache flush.

**Why**: Without verification, attacker POST arbitrary revoke → force cache flush → DoS via constant cache miss + Central load spike.

**How to apply**:
```typescript
const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
const actual = req.headers['x-rbac-notify-signature']?.replace('sha256=', '');
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
  reply.status(401).send();
  return;
}
```

Use `timingSafeEqual` — never `===` (timing attack).

---

## Rule 12 — MUST NOT cache permission denials to bypass Central

**Rule**: Negative results (permission denied) MUST also flow through Central. MUST NOT special-case "user has NO roles → skip Central for N minutes".

**Why**: User just-granted role would wait for negative-cache TTL before seeing access. Confusing UX + violates least-surprise. Trust epoch invalidation.

---

## Auditor checklist

Before merging any SDK code change:

- [ ] All new methods checked against Rules 1-12
- [ ] No new log statement includes `token`, `centralRbacToken`, or `config` object
- [ ] Constructor changes preserve production fail-open guard
- [ ] Cache key format unchanged (or migration justified)
- [ ] Timeout default not raised above 500ms
- [ ] New error path uses existing `ErrorCode` union (no ad-hoc codes)

---

## Related

- [`SPEC.md`](SPEC.md) — protocol contract SDK MUST implement
- [`SDK-CONVENTION.md`](SDK-CONVENTION.md) — Node ↔ Python API surface
- [`CONFORMANCE_TESTS/`](CONFORMANCE_TESTS/) — automated verification of these rules
