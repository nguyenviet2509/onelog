# Gate S3 — Fail Mode Chaos Tests

**Date:** 2026-08-24 | **Agent:** fullstack-developer | **Status:** PASS

---

## Test Configuration

- Zitadel v4.16.1
- spike-target: `http://spike-webhook:3999/spike/pre-token`, timeout=10s, `interruptOnError: false`
- Token subject: machine user `spike-sa` (client_credentials grant)
- Baseline: healthy webhook → token issued in ~60ms, JWT contains `spike_test: "ok"`

---

## S3 Test Matrix

| Scenario | Duration | Token Issued? | Spike Claims Present? | HTTP Status | Zitadel Log |
|----------|----------|--------------|----------------------|-------------|-------------|
| Healthy (baseline) | ~60ms | YES | YES (`spike_test: ok`) | 200 | activity log only |
| S3.1 Webhook down | 79ms | YES | NO | 200 | `error calling target: dial tcp: lookup spike-webhook ... server misbehaving` |
| S3.2 Webhook 500 | 35ms | YES | NO | 200 | `error calling target: ... Errors.Execution.Failed` |
| S3.3 Malformed JSON | 31ms | YES | NO | 200 | (no error logged — treated same as 500 path) |
| S3.4 Slow 15s (timeout=10s) | 10,040ms | YES | NO | 200 | `error calling target: context deadline exceeded` |

---

## Per-Scenario Detail

### S3.1 — Webhook Down (container stopped)

- **Action:** `docker stop spike-webhook`
- **Login result:** Token issued immediately (79ms) — DNS resolution failure returned fast
- **JWT claims:** Standard Zitadel claims only, no spike/custom claims
- **Zitadel log:**
  ```
  level=error msg="error calling target"
  error="Post \"http://spike-webhook:3999/spike/pre-token\": dial tcp: lookup spike-webhook on 127.0.0.11:53: server misbehaving"
  target=387661870112178180
  ```
- **Verdict: FAIL-OPEN** — token issued silently, no indication to client

---

### S3.2 — Webhook Returns HTTP 500

- **Action:** Replaced spike-webhook with stub returning `HTTP 500 {"error": "forced_500"}`
- **Login result:** Token issued (35ms)
- **JWT claims:** Standard Zitadel claims only, no custom claims
- **Zitadel log:**
  ```
  level=error msg="error calling target"
  error="ID=EXEC-dra6yamk98 Message=Errors.Execution.Failed"
  target=387661870112178180
  ```
- **Verdict: FAIL-OPEN** — 500 treated as non-fatal, token still issued

---

### S3.3 — Webhook Returns Malformed JSON (200 OK)

- **Action:** Stub returns HTTP 200 with body `not-json-at-all{{{broken`, Content-Type: application/json
- **Login result:** Token issued (31ms)
- **JWT claims:** Standard Zitadel claims only, no custom claims
- **Zitadel log:** No execution error logged (Zitadel silently dropped bad response)
- **Verdict: FAIL-OPEN** — malformed JSON silently discarded, token issued without claims

---

### S3.4 — Webhook Slow (15s delay, target timeout=10s)

- **Action:** Stub sleeps 15s before responding; Zitadel target configured with 10s timeout
- **Login result:** Token issued after **10,040ms** (10.04s) — matches configured timeout exactly
- **JWT claims:** Standard Zitadel claims only, no custom claims
- **Zitadel log:**
  ```
  level=error msg="error calling target"
  error="Post \"http://spike-webhook:3999/spike/pre-token\": context deadline exceeded"
  target=387661870112178180
  ```
- **Timeout hard limit:** 10s (matches target config: `timeout: 10000000000` nanoseconds = 10s)
- **Verdict: FAIL-OPEN after timeout** — Zitadel waits full timeout then issues token

---

## Discovered Fail Policy

**Zitadel v4 default policy: FAIL-OPEN (silent)**

- `interruptOnError: false` on spike-target confirms this is the configured policy
- Every failure mode (down, 500, malformed, timeout) resulted in token issuance
- No failure mode blocked or returned an error to the token requester
- No `error` field added to JWT indicating degraded state
- All failures logged at `level=error` in Zitadel logs only — invisible to token consumer

**Fail-close IS possible:** Set `interruptOnError: true` on the target in Zitadel Console.
With `interruptOnError: true`, any target error (500, timeout, network) would cause
Zitadel to abort token issuance and return an error to the client.

---

## Timeout Hard Limit

- **Configured:** 10s (set in Console at target creation)
- **Observed:** 10,040ms — matches exactly
- **Configurable:** Yes, per-target in Console
- **Recommendation:** 3s for production (fast backend) with fail-close for admin roles

---

## Decision Impact for Phase 2

### 1. `rbac_degraded` claim strategy — CONFIRMED REQUIRED

Since Zitadel default is fail-open and provides **no indication** in the JWT that the
Action failed, the `rbac_degraded: true` claim is the only way apps can detect a
degraded token. Phase 2 must:

1. Return `{"append_claims": [{"key": "rbac_degraded", "value": true}, ...]}` when
   the RBAC resolve fails
2. Apps must **reject or degrade** when `rbac_degraded: true` is present
3. For tokens without any rbac claims at all (webhook totally down), apps must treat
   missing claims as degraded (defensive default)

### 2. Admin fail-close strategy — REQUIRES `interruptOnError: true`

The plan's strategy of returning HTTP 500 from the webhook to block admin logins
**ONLY WORKS** if the Zitadel target has `interruptOnError: true`. With `false`
(the current spike config), a 500 from the webhook is ignored and token is issued.

**Phase 2 action:** For the production Central RBAC Action target, set
`interruptOnError: true`. This means ANY error (including normal fail-open degradation)
blocks ALL logins. Then the webhook must NEVER return 5xx for normal users — only for
admin-role users when RBAC is down.

**Alternative strategy (safer):** Keep `interruptOnError: false` (fail-open), but have
the webhook always return `rbac_degraded: true` on error. For admin roles, return 200
with `{"append_claims": [{"key": "rbac_degraded", "value": true}]}` and have the admin
portal explicitly reject tokens with `rbac_degraded: true`. This avoids blocking all
logins if the webhook has transient errors.

**Recommendation:** Use `interruptOnError: false` with `rbac_degraded: true` for all
users including admins. Admin portal checks `rbac_degraded` and displays an error.
This is more resilient than fail-close which risks locking out all admins during
a Central RBAC service restart.

### 3. Timeout configuration for production

- Current spike: 10s (too high for synchronous token path)
- Recommendation: 3s (matches Phase 2 SLA of p99 < 500ms cache miss + buffer)
- If Redis cache hit: p99 < 100ms — well within 3s
- If resolve fails within 3s, Zitadel times out, webhook returns 5xx → `rbac_degraded`

### 4. Detection of "totally missing claims" scenario (S3.1)

When webhook is completely unreachable (DNS failure), Zitadel issues token with NO
custom claims. Apps receive a valid JWT with no `permissions_hash`, no `roles`,
no `rbac_degraded`. Apps must treat **absence of all rbac claims** as degraded:

```typescript
// Consumer app validation
if (!token.permissions_hash && !token.rbac_degraded) {
  // Either old token format OR webhook was totally down
  // Treat as degraded — apply minimum permissions
  return { degraded: true, reason: 'no_rbac_claims' };
}
```

---

## Cleanup Checklist (execute after Phase 2 Day 2-3 implementation + integration tests complete)

Steps to clean up spike sandbox after Phase 2 integration tests complete:

**On authway-vps (SSH):**
```bash
# 1. Restore default HTTPClient DenyList (re-enable SSRF protection)
ssh authway-vps
rm /opt/authway/infra/authway-vps/docker-compose.override.yml
cd /opt/authway/infra/authway-vps
docker compose up -d zitadel  # restart with defaults

# 2. Verify DenyList restored (target creation should fail again for private IPs)
docker exec authway-prod-zitadel-1 env 2>/dev/null | grep -i deny  # should be empty

# 3. Stop + remove spike-webhook
cd /opt/spike-webhook
docker compose -f docker-compose.spike.yml down
cd / && rm -rf /opt/spike-webhook
```

**In Zitadel Console (http://10.200.0.125/ui/console/instance?id=actions):**
- Delete Execution `function/preaccesstoken`
- Delete Target `spike-target`
- Switch org to `spike-test` → Organization → Delete (removes org + project + users)
- Or keep spike-test for Phase 3 spike (S1 idempotency) — Phase 3 will also need sandbox

**On local:**
- `central-rbac/spike/` is gitignored — can `rm -rf central-rbac/spike/` when done
- No git commit needed for spike code

---

## Verdict: PASS — Proceed to Day 2

Both gates answered:

- **S4 (payload shape):** Webhook fires, JWT injection confirmed, payload structure
  understood. Critical caveat: `user.grants` absent for machine user — must validate
  for human user during Day 2. HMAC verifier algorithm needs debugging.

- **S3 (fail policy):** Zitadel default is **FAIL-OPEN silent**. Confirmed behavior for
  all 4 failure modes. Timeout = configured target timeout (10s tested, 3s recommended
  for production). `rbac_degraded` claim + consumer-side "absent claims = degraded"
  logic are both required.

**Gate decision: PROCEED to Day 2 implementation with adjustments noted above.**
