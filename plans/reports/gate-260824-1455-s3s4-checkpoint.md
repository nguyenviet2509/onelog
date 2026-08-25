# Gate S3+S4 Checkpoint — Phase 02 Day 1

**Date:** 2026-08-24 | **Status:** BLOCKED — awaiting signing key + Console setup

---

## What Is Deployed

| Component | Location | State |
|-----------|----------|-------|
| `spike-webhook` container | authway-vps `/opt/spike-webhook/` | Running (healthy) |
| Endpoint | `http://spike-webhook:3999/spike/pre-token` | POST — logs payload, returns append_claims |
| Health | `http://spike-webhook:3999/spike/health` | `{"ok":true}` confirmed |
| Network | `authway-prod_internal` (172.18.0.9) | Same network as Zitadel (172.18.0.4) |
| DNS | `spike-webhook` resolves inside `authway-prod_internal` | Confirmed via vector container |
| Signing key | `signingKeyConfigured: false` | Needs Console key handoff |

---

## Console Setup — User Must Do This

**Open tunnel first:**
```bash
ssh -L 8080:10.200.0.125:8080 authway-vps -N &
# Then: http://localhost:8080/ui/console
```

### A. Create Target

Console → switch org to **spike-test** → **Actions → Targets → + New**

| Field | Value |
|-------|-------|
| Name | `spike-target` |
| Type | **Call** (not Webhook — Call processes response body) |
| Endpoint URL | `http://spike-webhook:3999/spike/pre-token` |
| Timeout | `5s` |

After Create: **copy the Signing Key displayed** — shown only once.

### B. Set Signing Key in Container

```bash
ssh authway-vps
echo "SPIKE_SIGNING_KEY=<paste-key>" > /opt/spike-webhook/.env
cd /opt/spike-webhook
docker compose -f docker-compose.spike.yml up -d --force-recreate
docker logs spike-webhook 2>&1 | tail -3
# Expect: "signingKeyConfigured":true
```

### C. Create Execution

Console → **Actions → Executions → + New**

| Field | Value |
|-------|-------|
| Condition type | `Request` |
| Trigger | `preAccessToken` (search for it) |
| Target | `spike-target` |

---

## What User Needs to Give Back

1. **Signing key** string from Console (Step A)
2. **Confirmation** Execution created (Step C)
3. **spike-project Client ID** — Console → Projects → spike-project → Applications

---

## Next Agent Run Will Do

Once user provides signing key + client ID confirmation:

1. Verify `signingKeyConfigured: true` in logs
2. Trigger OIDC login for `spike-user@spike-test.local`
3. Grep `[SPIKE-PAYLOAD]` log — capture full payload JSON → save `gate-260826-s4-payload-shape.md`
4. Decode JWT → verify `spike_test=ok`, `spike_user_id`, `spike_grants_count` claims appear
5. S3 chaos tests:
   - Stop container → login → observe Zitadel behavior (block or silent fail-open)
   - Restart; force 500 → same observation
   - Force malformed JSON → same observation
6. Save `gate-260826-s3-fail-mode.md`
7. Gate decision: continue Day 2 or adjust fail-open/fail-close strategy

---

## Files Created This Run

- `central-rbac/spike/spike-webhook.ts`
- `central-rbac/spike/Dockerfile`
- `central-rbac/spike/docker-compose.spike.yml`
- `central-rbac/spike/package.json`
- `.gitignore` updated (spike .env + node_modules excluded)
- `plans/reports/fullstack-developer-260824-1451-phase-02-day1-webhook-deploy.md`
- `plans/reports/gate-260824-1455-s3s4-checkpoint.md` (this file)
