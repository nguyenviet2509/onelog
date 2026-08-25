# Phase 02 Day 1 Webhook Deploy — Checkpoint Report

**Date:** 2026-08-24 | **Agent:** fullstack-developer | **Status:** BLOCKED (awaiting signing key from user)

---

## Files Created

```
central-rbac/spike/
├── spike-webhook.ts          (168 LOC) — Fastify server, HMAC verify, append_claims
├── Dockerfile                (20 LOC)  — node:22-alpine, tsx ESM runner
├── docker-compose.spike.yml  (42 LOC)  — joins authway-prod_internal (external: true)
└── package.json              (22 LOC)  — fastify + tsx deps only
```

`.gitignore` updated: `central-rbac/spike/.env` + `central-rbac/spike/node_modules/` excluded.

---

## Deploy Transcript

```
# SCP to authway-vps
ssh authway-vps mkdir -p /opt/spike-webhook
scp central-rbac/spike/* authway-vps:/opt/spike-webhook/   ✓

# Build + start
docker compose -f docker-compose.spike.yml up -d --build
  → Built spike-spike-webhook:latest
  → Container spike-webhook Started

# Startup log confirmed
{"msg":"[SPIKE] spike-webhook listening on :3999","signingKeyConfigured":false}

# Network: spike-webhook joined authway-prod_internal at 172.18.0.9
# Zitadel container at 172.18.0.4 — same network, DNS spike-webhook resolves

# Health check (from vector container on same network)
docker exec authway-prod-vector-1 wget -qO- http://spike-webhook:3999/spike/health
→ {"ok":true,"ts":"2026-08-24T07:59:06.813Z"}   ✓

# Docker healthcheck
docker ps --filter name=spike-webhook → Up (healthy)  ✓
```

**SPIKE_SIGNING_KEY not yet set** — container runs with `signingKeyConfigured: false`. Signature result will log `no_key_set`. Payload logging and append_claims injection work without it.

---

## Console Setup Instructions for User

**Prerequisite:** Open SSH tunnel to Zitadel Console:

```bash
ssh -L 8080:10.200.0.125:8080 authway-vps -N &
```

Then open: **http://localhost:8080/ui/console**

---

### Step 1 — Create Target `spike-target`

1. Login to Console (admin credentials)
2. **Make sure you are in org `spike-test`** (top-left org selector → switch to `spike-test`)
3. Left sidebar → **Actions** → **Targets** → click **+ New**
4. Fill in:
   - **Name:** `spike-target`
   - **Type:** `Call` (NOT Webhook — Call processes response body for append_claims)
   - **Endpoint URL:** `http://spike-webhook:3999/spike/pre-token`
   - **Timeout:** `5s`
5. Click **Create**
6. **CRITICAL:** After creation, Console displays a **Signing Key** once. **Copy it immediately** — it is NOT shown again.
7. Give the signing key back to this agent (or set it via the env update below).

---

### Step 2 — Set Signing Key in Container

After you have the signing key from Console:

```bash
ssh authway-vps
cd /opt/spike-webhook

# Create .env file (never committed — in .gitignore)
echo "SPIKE_SIGNING_KEY=<paste-key-here>" > /opt/spike-webhook/.env

# Restart with new env
docker compose -f docker-compose.spike.yml up -d --force-recreate
docker logs spike-webhook 2>&1 | tail -5
# Should show: "signingKeyConfigured":true
```

---

### Step 3 — Create Execution

1. Console → **Actions** → **Executions** → click **+ New**
2. Fill in:
   - **Condition type:** `Request`
   - **Method/Trigger:** search for `preAccessToken` (or `PreAccessTokenCreation`)
   - **Target:** select `spike-target` created above
3. Click **Create**

---

### Step 4 — Trigger Test Login (S4 payload capture)

Once execution is created, trigger a token issuance to capture the payload:

```bash
# From authway-vps or any machine with access to Zitadel on port 8080
# Replace CLIENT_ID with the spike-project client ID from Console
# (Console → Projects → spike-project → Applications → copy Client ID)

CLIENT_ID="<spike-project-client-id>"
REDIRECT_URI="http://localhost:9999/callback"

# Option A: Use Zitadel's built-in PKCE flow via browser
# Navigate to: http://localhost:8080/oauth/v2/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&scope=openid%20profile&code_challenge=...
# Login as spike-user@spike-test.local / SpikeTest2026!

# Option B: Simpler — use client_credentials grant if spike-project has it enabled
curl -s -X POST http://localhost:8080/oauth/v2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&username=spike-user@spike-test.local&password=SpikeTest2026!&client_id=$CLIENT_ID&scope=openid"
```

After login, check spike-webhook logs:

```bash
ssh authway-vps docker logs spike-webhook 2>&1 | grep SPIKE-PAYLOAD
```

**S4 pass criteria:** log shows `user.grants[].roles` array, `userId`, `amr` fields.

---

### Step 5 — S3 Chaos Tests (after S4 confirmed)

After S4 payload shape confirmed, run 3 chaos scenarios:

```bash
ssh authway-vps

# Test 1: Webhook stopped (container down)
docker stop spike-webhook
# → Try login in browser → observe: does Zitadel block or issue token without claims?
# → Check Zitadel logs: docker logs authway-prod-zitadel-1 2>&1 | tail -30

# Test 2: Return 500 (restart first, then inject fault)
docker start spike-webhook
# Temporarily modify to always 500 — simplest: use iptables or test endpoint
# OR: add env var SPIKE_FORCE_500=true and redeploy
# → Login → observe Zitadel behavior

# Test 3: Return malformed JSON
# Similar — SPIKE_FORCE_MALFORMED=true
# → Login → observe

docker start spike-webhook  # restore
```

Results to document in `plans/reports/gate-260826-s3-fail-mode.md` and `gate-260826-s4-payload-shape.md`.

---

## What User Needs to Give Back

1. **Signing key** from Zitadel Console after creating `spike-target` (Step 1 above)
2. **Confirmation** that Execution was created (Step 3)
3. **spike-project Client ID** for the token endpoint test (Step 4)

Once those are received, a follow-up agent run will:
- Set `SPIKE_SIGNING_KEY` in container env
- Trigger test login via OIDC
- Capture + decode JWT, verify `spike_test=ok` claim
- Run S3 chaos tests
- Write final gate reports `gate-260826-s4-payload-shape.md` + `gate-260826-s3-fail-mode.md`

---

## Deployed State Summary

| Item | State |
|------|-------|
| `spike-webhook` container | Running (healthy) on authway-vps |
| Network | `authway-prod_internal` — `spike-webhook:3999` reachable by Zitadel |
| Signing key | NOT yet configured (`signingKeyConfigured: false`) |
| Zitadel Target | NOT yet created (requires Console UI) |
| Zitadel Execution | NOT yet created (requires Console UI) |
| S4 payload capture | Pending |
| S3 chaos tests | Pending |
