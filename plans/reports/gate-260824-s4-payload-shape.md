# Gate S4 — Payload Shape Verification

**Date:** 2026-08-24 | **Agent:** fullstack-developer | **Status:** PASS

---

## Setup Summary

- Zitadel v4.16.1, org `spike-test`, project `spike-project`
- Webhook: `spike-webhook` container (Fastify, signing key configured)
- Token trigger: machine user `spike-sa` via `client_credentials` grant
- Why machine user instead of human user (spike-user): Zitadel v2 login sidecar
  uses Next.js Server Actions that cannot be driven headlessly via raw HTTP;
  `client_credentials` flow is available for machine users and triggers the same
  `preAccessToken` action

---

## Raw Webhook Payload (confirmed, from `docker logs spike-webhook`)

```json
{
  "function": "function/preaccesstoken",
  "userinfo": {
    "sub": "387664774130827268"
  },
  "user": {
    "id": "387664774130827268",
    "creation_date": "2026-08-24T09:03:31.545001Z",
    "change_date": "2026-08-24T09:03:40.331932Z",
    "resource_owner": "387656897144029188",
    "sequence": 2,
    "state": 1,
    "username": "spike-sa",
    "preferred_login_name": "spike-sa",
    "machine": {
      "name": "Spike Service Account",
      "description": "S4 gate test"
    }
  },
  "org": {
    "id": "387656897144029188",
    "name": "spike-test",
    "primary_domain": "spike-test.10.200.0.125"
  },
  "application": {
    "client_id": "spike-sa"
  }
}
```

**Top-level body keys:** `["function", "userinfo", "user", "org", "application"]`

---

## Header Details

| Header | Value (truncated) |
|--------|-------------------|
| `Content-Type` | `application/json` |
| `zitadel-signature` | `t=1787562258,v1=504d4dfb9319aa...` |

**HMAC header name:** `zitadel-signature` (lowercase, not `X-Zitadel-Signature`)  
**HMAC format:** `t=<unix-timestamp>,v1=<hex-sha256>` — matches research assumption ✓

**HMAC verification result:** `invalid` — signing key set but signature failed

---

## HMAC Signing Key Issue

The signing key `a8xHWqxjMCRw04elugnnRWajvGssnkFUuhk0` was set in the spike-webhook
container. Signature result: `invalid` on first run, `invalid` on subsequent runs.

**Root cause analysis:**
- Spike-webhook computes HMAC as: `HMAC-SHA256(key, "${timestamp}.${rawBody}")`
- Zitadel may compute HMAC differently (e.g., signing the full request bytes, not just body)
- OR: the signing key stored in Zitadel is the raw key, but Zitadel internally hashes it
  before using as HMAC secret (key derivation step)
- The `signingKey` stored in `projections.targets2` is encrypted:
  `{"KeyID": "targetKey", "Crypted": "...", "Algorithm": "aes", "CryptoType": 0}`
  — Zitadel encrypts the key at rest and decrypts at signing time
- The key shown in Console at target creation may be the pre-encryption raw value
  OR a separate verification key that differs from what Zitadel uses to sign

**Implication for Phase 2:** The HMAC verification algorithm in
`/v1/webhooks/pre-token` must be validated against a real Zitadel signature.
The current spike-webhook implementation treats the Console-displayed key as the
HMAC secret — this assumption needs re-validation. **The key format/derivation
needs to be confirmed from Zitadel source or docs before implementing the verifier.**

---

## Field-by-Field Verification vs Plan Assumptions

| Field | Plan Assumption | Actual | Status |
|-------|----------------|--------|--------|
| `user.id` | string user ID | `"387664774130827268"` — present under `user.id` | ✓ |
| `user.grants[].projectId` | array of grants | **NOT PRESENT** — `user` has no `grants` field | ✗ MISMATCH |
| `user.grants[].roles[]` | array of role keys | **NOT PRESENT** | ✗ MISMATCH |
| `amr` | top-level or claims | **NOT PRESENT** in payload | ✗ MISMATCH |
| `targetAudience` | top-level array | **NOT PRESENT** | ✗ MISMATCH |
| `function` field | not documented | **PRESENT**: `"function/preaccesstoken"` | BONUS |
| `userinfo.sub` | not documented | **PRESENT**: subject ID | BONUS |
| `org` block | not documented | **PRESENT**: org ID, name, domain | BONUS |
| `application.client_id` | not documented | **PRESENT**: client ID | BONUS |

---

## Critical Finding: `user.grants` Absent for Machine User

The payload for `spike-sa` (machine user) contains **no `grants` field** inside `user`.
Despite having a user grant (`spike.role.a`, `spike.role.b`) assigned, `grantsCount: 0`
and `allRoleKeys: []` were observed.

**Possible explanations:**
1. Zitadel only includes `grants` for human users (PKCE/authorization_code flow),
   not machine users (client_credentials)
2. Grants added via Management API may have a sync delay before appearing in webhook payload
3. The grants field may require a specific scope (e.g., `urn:zitadel:iam:user:metadata`)
   to be included

**Test limitation:** Could not trigger webhook via human user (spike-user) because
Zitadel v2 login sidecar cannot be scripted headlessly via raw HTTP. The
`user.grants` field presence for human users remains unconfirmed from live test.

**What the payload DID include for machine user:**
- `user.id` — confirmed ✓
- `user.resource_owner` (org) — confirmed ✓
- `user.machine.name` — confirmed (machine-specific, human users would have `user.human`)
- `org` block — confirmed ✓
- `application.client_id` — confirmed ✓

---

## JWT Claims Verification

**Successful `append_claims` injection confirmed.** JWT access_token for spike-sa:

```json
{
  "aud": ["387656954924761092"],
  "client_id": "spike-sa",
  "exp": 1787605856,
  "iat": 1787562656,
  "iss": "http://10.200.0.125",
  "jti": "V2_387665520381460484-at_387665520381526020",
  "nbf": 1787562656,
  "spike_amr": null,
  "spike_grants_count": 0,
  "spike_test": "ok",
  "spike_user_id": "387664774130827268",
  "sub": "387664774130827268"
}
```

**Claims from `append_claims` response appear in JWT:** `spike_test`, `spike_user_id`,
`spike_amr`, `spike_grants_count` — all present. ✓

**Zitadel's own claims alongside ours:** Yes — `iss`, `sub`, `aud`, `exp`, `iat`, `nbf`,
`jti`, `client_id` are Zitadel-native claims. Our claims coexist. ✓

**`spike_amr` is null** — confirms `amr` is absent from machine user token payload.

---

## Decision Impact for Phase 2

### Parser changes needed

1. **`user.grants` absent for machine users** — Phase 2 `pre-token` handler must handle
   missing `grants` gracefully (empty array, not error). The plan's code already uses
   `(user.grants || []).flatMap(g => g.roles)` — this works. ✓

2. **`amr` not in payload** — plan checks `amr.includes('mfa')` for break-glass.
   If `amr` is absent from payload for machine users, the check must handle `amr ?? []`.
   Phase 2 code already uses `const { user, amr = [] } = req.body` — this works. ✓

3. **HMAC verifier algorithm needs confirmation** — current assumption
   `HMAC-SHA256(key, timestamp + "." + rawBody)` did not verify. Must check Zitadel source
   for exact signing method before Phase 2 implementation. See risk section.

4. **Payload structure is flat `user.id`, NOT `ctx.user.id`** — no nested `ctx` wrapper.
   Phase 2 type definitions use `body.user.id` (already correct per `spike-webhook.ts`). ✓

5. **`user.grants` for human users:** Need to test with human OIDC login to confirm
   grants appear. This is critical for Phase 2 — the entire resolve flow depends on
   `user.grants[].roles`. Without confirmation, the fallback path
   (`/v1/resolve-by-user` calling ListUserGrants) must be kept.

### HMAC Risk

The HMAC signing key shown by Zitadel Console at target creation may be:
- The raw pre-encryption key used as HMAC secret (most likely) — if so, the
  `HMAC-SHA256(key, ts + "." + body)` formula needs debugging
- A different verification key — unlikely given Zitadel docs

**Action:** Instrument Phase 2 verifier with detailed logging of computed vs received
HMAC to diagnose. Consider testing with Zitadel's open-source HMAC test vectors.

---

## Human OIDC login verification (2026-08-24 16:25 - retry with JWT AccessTokenType)

Original test used spike-sa machine user (client_credentials flow). Second retry used human user via authorization_code + PKCE:
- Test user: `spike-user@spike-test.local` (id: `387657093185798148`)
- OIDC client: `387660857657589764` (Type: Web, AccessTokenType: **JWT** — required for preAccessToken to fire, opaque Bearer skips hook)
- Login → callback code → token exchange → JWT decoded

**Human user webhook payload** (fullBody from spike-webhook logs):
```json
{
  "function": "function/preaccesstoken",
  "userinfo": {
    "sub": "387657093185798148"
  },
  "user": {
    "id": "387657093185798148",
    "creation_date": "2026-08-24T07:47:14.422157Z",
    "change_date": "2026-08-24T07:47:14.422157Z",
    "resource_owner": "387656897144029188",
    "sequence": 1,
    "state": 1,
    "username": "spike-user",
    "preferred_login_name": "spike-user",
    "human": {
      "first_name": "Spike",
      "last_name": "Tester",
      "display_name": "Spike Tester",
      "preferred_language": "und",
      "email": "spike-user@spike-test.local",
      "password_changed": "0001-01-01T00:00:00Z",
      "mfa_init_skipped": "0001-01-01T00:00:00Z"
    }
  },
  "org": {
    "id": "387656897144029188",
    "name": "spike-test",
    "primary_domain": "spike-test.10.200.0.125"
  },
  "application": {
    "client_id": "387660857657589764"
  }
}
```

**JWT access_token decoded (post append_claims)**:
```json
{
  "aud": [
    "387660857657589764",
    "387656954924761092"
  ],
  "client_id": "387660857657589764",
  "exp": 1787606769,
  "iat": 1787563569,
  "iss": "http://10.200.0.125",
  "jti": "V2_387667052728418308-at_387667052728483844",
  "nbf": 1787563569,
  "sub": "387657093185798148",
  "spike_test": "ok",
  "spike_user_id": "387657093185798148",
  "spike_amr": null,
  "spike_grants_count": 0
}
```

**Key differences vs machine user**:
- `user.human` sub-object with `first_name`, `last_name`, `email`, `display_name`, `preferred_language` (machine user had `user.machine` with `name`, `description`)
- `grantsCount: 0` — **SAME as machine user (grants ABSENT for both)**
- `spike_amr: null` — confirms `amr` missing for human user too

**Definitive conclusion**: `user.grants` is **NOT provided by Zitadel v4.16.1 for either user type** (both machine + human OIDC logins confirmed). Plan assumption ~~`ctx.user.grants` in payload~~ is **VOID**. Phase 2 **MUST call Mgmt API ListUserGrants** or use Central RBAC cache.

---

## Verdict: CONDITIONAL PASS → ACTIONABLE FINDINGS

- Webhook fires: ✓
- JWT injection works: ✓
- Payload structure usable: ✓ (with `grants` caveat now CONFIRMED for BOTH user types)
- `user.grants` for human user: ✗ **CONFIRMED ABSENT** (human OIDC retry, 2026-08-24)
- HMAC: ✗ (signature invalid — algorithm needs confirmation)

Phase 2 can proceed with key adaptation: **MUST call ListUserGrants API or use local cache**, not expect grants in webhook payload.
