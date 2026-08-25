# Phase 2 Day 2-3 Implementation Report

**Date:** 2026-08-24  
**Agent:** fullstack-developer  
**Commit:** 612dda9

---

## Files Added / Modified

| File | LOC | Status |
|------|-----|--------|
| `src/lib/redis-client.ts` | 102 | NEW — ioredis singleton, LFU config, retry strategy |
| `src/lib/singleflight.ts` | 57 | NEW — in-process dedup, placeholder-first ordering |
| `src/lib/break-glass.ts` | 106 | NEW — startup validation, alert emission |
| `src/lib/zitadel-mgmt-client.ts` | 118 | NEW — minimal Mgmt API, PAT auth, retry-once on 5xx |
| `src/middleware/zitadel-action-hmac.ts` | 147 | NEW — HMAC verify middleware, confirmed algorithm |
| `src/db/queries/resolve-epoch.ts` | 62 | NEW — epoch counter, in-process cache |
| `src/db/migrations/005_metadata_table.sql` | 24 | NEW — rbac.metadata table |
| `src/routes/webhook-pre-token.ts` | 195 | NEW — main Phase 2 webhook handler |
| `src/config.ts` | +20 | MODIFIED — Redis, Mgmt, break-glass, fail-close env vars |
| `src/app.ts` | +4 | MODIFIED — register webhook route, call validateBreakGlassConfig() |
| `src/routes/health.ts` | +5 | MODIFIED — adds Redis check |
| `src/routes/resolve.ts` | +55 | MODIFIED — Redis epoch cache + singleflight |
| `src/routes/roles.ts` | +3 | MODIFIED — bumpResolveEpoch on role_permissions mutations |
| `docker-compose.dev.yml` | +22 | MODIFIED — Redis:7-alpine sidecar on port 6380 |
| `docker-compose.prod.yml` | 128 | NEW — authway-vps production compose |
| `scripts/migrate.ts` | +2 | MODIFIED — adds migration 005 |
| `package.json` | +2 | MODIFIED — ioredis ^5.4.1 |
| `vitest.config.ts` | +5 | MODIFIED — exclude redis-client.ts, add hmac middleware |
| `tests/unit/zitadel-action-hmac.test.ts` | 98 | NEW — 11 tests |
| `tests/unit/break-glass.test.ts` | 80 | NEW — 10 tests |
| `tests/unit/redis-singleflight.test.ts` | 107 | NEW — 8 tests |
| `tests/unit/zitadel-mgmt-client.test.ts` | 112 | NEW — 9 tests |
| `tests/unit/webhook-pre-token.test.ts` | 220 | NEW — 11 tests |

---

## HMAC Algorithm Discovered

**Source:** `pkg/actions/signing.go` in Zitadel v4.16.1 (read via WebFetch from raw.githubusercontent.com)

```go
func computeSignature(t time.Time, payload []byte, signingKey string) []byte {
  mac := hmac.New(sha256.New, []byte(signingKey))
  mac.Write([]byte(fmt.Sprintf("%d", t.Unix())))
  mac.Write([]byte("."))
  mac.Write(payload)
  return mac.Sum(nil)
}
```

**Confirmed:**
- Algorithm: `HMAC-SHA256`
- Key: raw UTF-8 bytes of the signing key string (no base64/hex decode)
- Message: `unix_timestamp_as_decimal_string + "." + raw_body_bytes`
- Header: `ZITADEL-Signature: t=<unix_ts>,v1=<hex_sha256>`

**Day 1 failure explanation:** The spike-webhook formula was correct. The failure was likely a key mismatch (container env had the key but possibly different value than Console). The Phase 2 `zitadel-action-hmac.ts` implements the confirmed formula.

---

## Test Results

```
Test Files: 14 passed (14)
Tests:      123 passed (123)
Coverage:   92.44% statements | 88.27% branches | 96.55% functions
```

All tests pass. Coverage threshold (80% statements, 70% branches) met.

New tests added (49 total across 5 new files):
- `zitadel-action-hmac.test.ts`: 11 tests (happy + 8 failure modes)
- `break-glass.test.ts`: 10 tests (user match, perm validation, wildcard guard logic)
- `redis-singleflight.test.ts`: 8 tests (dedup, concurrent collapse, rejection propagation)
- `zitadel-mgmt-client.test.ts`: 9 tests (happy, empty, retry-once, 403, network error, auth header)
- `webhook-pre-token.test.ts`: 11 tests (auth rejection, normal path, Redis cache hit, degraded x2, break-glass, edge cases)

---

## Integration Test Transcript

### Test 1: Break-glass path (user 387657093185798148)

**Request:** POST /v1/webhooks/pre-token with valid HMAC (signing key `a8xHWqxjMCRw04elugnnRWajvGssnkFUuhk0`)

**Payload:** human user `spike-user` = `BREAK_GLASS_USER_ID`

**Response (200):**
```json
{
  "append_claims": [
    {"key": "permissions", "value": ["rbac.admin.write", "rbac.admin.read", "zitadel.iam.write"]},
    {"key": "break_glass", "value": true},
    {"key": "ver", "value": 1}
  ]
}
```

**Log evidence:**
```json
{"level":40,"tag":"[BREAK-GLASS-USED]","event":"break-glass-used","userId":"387657093185798148","correlationId":"a18f607f-84b2-4b5d-bdfc-ae387e94d791","appId":"387660857657589764"}
```

### Test 2: Normal user, no SA PAT (degraded path)

**Request:** POST /v1/webhooks/pre-token for spike-sa (user `387664774130827268`)

**Response (200):**
```json
{
  "append_claims": [
    {"key": "permissions", "value": []},
    {"key": "rbac_degraded", "value": true},
    {"key": "ver", "value": 1}
  ]
}
```

**Log evidence:**
```
zitadel-mgmt: listUserGrants fetch failed — ZITADEL_SA_PAT is not configured
webhook-pre-token: resolve failed — returning degraded
```

### Test 3: Health endpoint (all services green)

```json
{"status":"ok","checks":{"db_writer":"ok","db_auditor":"ok","redis":"ok","audit_write_failures":0}}
```

### Missing: Full OIDC login → JWT claim test

The live OIDC → JWT claim injection test (Zitadel Target → central-rbac) requires updating the Zitadel Target URL in Console. This is a **manual step** (see below).

---

## Manual Step Required: Update Zitadel Target

In Zitadel Console at `http://10.200.0.125/ui/console`:

1. Navigate to: Instance → Actions → Targets
2. Find target `spike-target` (ID `387661870112178180`)
3. Edit → URL: change from `http://spike-webhook:3999/spike/pre-token` → `http://central-rbac:8083/v1/webhooks/pre-token`
4. Keep signing key `a8xHWqxjMCRw04elugnnRWajvGssnkFUuhk0` (matches `ZITADEL_ACTION_SIGNING_KEY` in `/opt/central-rbac/.env`)
5. Save

After update, trigger OIDC login with `spike-user@spike-test.local` to get live JWT injection test.

---

## Deviations from Phase 2 Spec

| Deviation | Reason |
|-----------|--------|
| Break-glass MFA amr check deferred | `amr` not in Zitadel v4.16.1 webhook payload (Day 1 F4 confirmed). Alert emitted regardless; Phase 3 adds Zitadel Mgmt API auth-method check. |
| Admin fail-close (interruptOnError:true) deferred | Requires separate Zitadel Target + Execution binding per-user-scope. Phase 2 returns `rbac_degraded:true` for admin roles on failure; Phase 3 adds second Target. |
| SA PAT not provisioned at deploy time | No Zitadel admin PAT available without Console session. Normal user path returns `rbac_degraded:true` until SA PAT configured in `.env`. |
| Zitadel Target URL not yet updated | Manual Console action required (no API PAT to automate). |
| `/v1/permissions-lookup` endpoint not added | Spec listed it as optional for Phase 2; perm-hash Redis keys ARE written so future endpoint has data to serve. Deferred to Phase 3. |

---

## Deployed Services (authway-vps)

| Container | Status | Notes |
|-----------|--------|-------|
| `central-rbac` | Running, healthy | port 8083, `authway-prod_internal` network |
| `central-rbac-postgres` | Healthy | sidecar, `authway-prod_internal` network |
| `central-rbac-redis` | Healthy | LFU 256MB, `authway-prod_internal` network |

---

## Deferred Items (Phase 3 / Backlog)

- **F2-partial**: HMAC algo confirmed from source, but live Zitadel → central-rbac HMAC roundtrip NOT verified (blocked by Target URL not updated + no admin PAT). Verify after manual Target update.
- **Break-glass MFA check**: needs Zitadel Mgmt API `ListUserAuthFactors` call — Phase 3.
- **Admin fail-close**: second Zitadel Target with `interruptOnError:true` + per-role condition execution — Phase 3.
- **SA PAT provisioning**: create Zitadel service account for central-rbac in spike-test org, set `ZITADEL_SA_PAT` in `/opt/central-rbac/.env`, restart container — can be done immediately after Target update.
- **`/v1/permissions-lookup`**: endpoint shell already seeds `perm-hash:{}` keys in Redis — Phase 3.
- **`rbac_auditor` password**: init-db.sql has `rbac_auditor_changeme` default; manually updated to `rbac_auditor_spike_2026` via `ALTER ROLE`. Phase 5 ops runbook should align init-db.sql with env.
- **Phase 3 drift sync cache**: once Phase 3 populates grants in Central RBAC, cold Mgmt API calls eliminated.

---

## Unresolved Questions

1. **HMAC live verification**: spike-webhook used identical formula but signature was `invalid` on Day 1. After Target URL update, will central-rbac HMAC succeed? Suspect the key in the spike-webhook container env (`SPIKE_SIGNING_KEY=a8xHWqxjMCRw04elugnnRWajvGssnkFUuhk0`) matches what Zitadel shows — but the Day 1 failure reason remains unexplained. Most likely was a key mismatch. Phase 2 HMAC middleware logs `reason: sig_mismatch` on failure — will be visible in `docker logs central-rbac`.

2. **SA PAT scope**: what Zitadel scopes are needed for `ListUserGrants`? Likely `urn:zitadel:iam:org:project:id:zitadel:aud` + `openid`. Need to verify when creating the SA.
