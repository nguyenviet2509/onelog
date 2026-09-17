# OneMCP Tool Bridge — Runbook

On-call reference for tool bridge operations. See `onemcp-tool-bridge-guideline.md` for design decisions.

---

## Register new bridge

1. **Prepare upstream** — confirm: base URL, HTTP method, param schema, bearer token, timeout expectation
2. **Admin UI** → `https://oneconnector.000nethost.com/admin/tool-bridges`
3. **New Upstream**:
   - Name: `<app_slug>` (e.g. `osh_admin`)
   - Base URL: upstream base (e.g. `http://mock-osh-admin:8080` for dev, `https://...` for prod)
   - Bearer: paste token → saved encrypted automatically
   - Timeout ms: recommend `10000` (adjust per upstream SLA)
   - Response max bytes: recommend `1048576` (1MB)
4. **New Bridge** (repeat per tool):
   - Name: snake_case verb_noun (e.g. `create_waf`)
   - Upstream: select from step 3
   - Method + Path: e.g. `POST /waf/rules`
   - Description: follow guideline template
   - param_schema: paste validated JSON Schema (`additionalProperties:false`, all required fields explicit)
   - Permission: `<app_slug>:tool.<name>` (must exist in Central RBAC first)
   - Enabled: **leave OFF** until test-call passes
5. **Test-call dry-run**: use "Test Call" in bridge detail page → send valid params → verify 2xx from upstream
6. **Enable** bridge → assign permission to role in Central RBAC UI → notify users

---

## Prod swap procedure

> Trigger: dev osh_admin confirms real endpoint ready (P5d).

1. Verify exposure model with upstream team:
   - Internal docker network → IP whitelist sufficient
   - Public gateway → HMAC signing required before swap (escalate, adds ~1-2d)
2. Obtain bearer token via secure channel (Bitwarden/1Password) — not chat/email
3. Admin UI → Upstreams → `osh_admin` → Edit:
   - `base_url`: `http://mock-osh-admin:8080` → prod URL
   - `bearer`: replace with real token → Save (encrypted automatically)
4. For each bridge — confirm param_schema matches prod endpoint contract:
   - If diff: edit bridge param_schema → save
5. Test-call dry-run each bridge → verify 2xx from prod upstream
6. Run smoke TC-1, TC-2, TC-3 from `onemcp-tool-bridge-smoke-plan.md` against prod
7. Comment out or remove `mock-osh-admin` service from `docker-compose.dev.yml` (keep for regression if desired)
8. Record commit hash + prod URL in plan journal

---

## Rotate bearer token

1. Obtain new token from upstream team via secure channel
2. Admin UI → Upstreams → `<upstream>` → Edit → paste new bearer → Save
3. Test-call any one bridge → verify 2xx (confirms new token accepted)
4. Confirm old token revoked by upstream team
5. Note rotation date in upstream description field

---

## Tool debug via correlation_id

Every OneMCP tool call emits a `X-Onemcp-Correlation-Id` UUID forwarded to the upstream.

**Find correlation ID** — from Claude's error message or OneMCP audit log:
```bash
# OneMCP backend logs
docker logs onemcp-backend-1 2>&1 | grep '<correlation_id>'

# Mock upstream logs (dev)
docker logs mock-osh-admin 2>&1 | grep '<correlation_id>'

# Real upstream logs (prod) — share correlation_id with upstream team,
# they grep their own logs for the same ID
```

**Trace a failed call**:
```bash
# Get last 50 tool-bridge log lines
docker logs onemcp-backend-1 2>&1 | grep -E 'tool_bridge|correlation' | tail -50

# Filter by specific tool
docker logs onemcp-backend-1 2>&1 | grep 'create_waf' | tail -20
```

---

## Permission denied unexpected (403 from upstream)

User reports tool returns "permission denied" when they should have access.

**Checklist**:

1. Confirm user's sub is correct:
   ```bash
   # OneMCP audit log shows user_sub forwarded
   docker logs onemcp-backend-1 2>&1 | grep 'user_sub' | tail -5
   ```

2. Check Central RBAC role assignment:
   - Admin UI Central RBAC → Users → find user → verify role assigned
   - Verify role includes permission `<app_slug>:tool.<name>`

3. Check permission name typo — must match exactly:
   - Bridge config: Admin UI → Bridge → permission field
   - Central RBAC: permission slug must be identical character-for-character

4. Check upstream RBAC gate (if upstream does distributed check):
   - Share user's sub with upstream team → confirm allowMap entry
   - For mock: check `allowMap` in `mock-osh-admin/server.js`

5. If Central RBAC manifest was recently updated: trigger re-sync:
   - Admin UI → Apps → `<app>` → Manifest → Fetch + Apply

---

## Tool success rate low {#tool-success-rate-low}

> Alert anchor: `onemcp_bridge_tool_calls_total{status="error"}` rate spike

**Triage steps**:

1. Identify which bridge is failing:
   ```bash
   docker logs onemcp-backend-1 2>&1 | grep -E '"status":"error"|tool_bridge_error' | tail -30
   ```

2. Check upstream health directly:
   ```bash
   # Dev mock
   curl http://localhost:8080/health

   # Prod (replace URL)
   curl https://<upstream>/health
   ```

3. Check OneMCP → upstream network:
   ```bash
   docker exec onemcp-backend-1 wget -qO- http://mock-osh-admin:8080/health
   ```

4. Common causes:
   - Upstream restarted and bearer changed → rotate bearer (see above)
   - Upstream URL changed → update base_url in Admin UI
   - Response > cap → increase `response_max_bytes` or investigate upstream bloat
   - Upstream returning 5xx consistently → contact upstream team with correlation IDs

5. If upstream is down and calls are queuing: **soft-disable bridge** (see rollback below) to stop user-facing errors while upstream recovers

---

## Rollback procedure (soft disable)

Disables a bridge without deleting config. Zero downtime, reversible.

1. Admin UI → Tool Bridges → select bridge
2. Toggle `enabled` → **Off** → Save
3. Verify: test-call from Claude returns "tool not found" or similar (tool no longer listed in MCP tools)
4. When upstream recovers: toggle `enabled` → **On** → test-call → confirm

For full upstream disable (all bridges for one upstream):
- Disable each bridge individually (no bulk disable in current UI)
- Or: change upstream `base_url` to `http://localhost:1` (unreachable) → all bridges fail-fast with connection error instead of hanging

---

## Emergency: bearer leaked

If `dev-fixed-token` or a prod bearer is exposed publicly:

1. **Immediate**: contact upstream team → revoke token NOW
2. Admin UI → Upstreams → `<upstream>` → Edit → clear bearer field → Save (disables bridge)
3. Rotate: obtain new token → re-enter → test-call
4. Audit: grep OneMCP logs for the leaked token pattern to confirm scope of use:
   ```bash
   # Bearer is NOT logged in OneMCP logs by design — confirm with log audit
   docker logs onemcp-backend-1 2>&1 | grep -c 'dev-fixed-token'
   # Should be 0 (bearer never logged)
   ```
5. For `dev-fixed-token` specifically: it has no real capability — risk is low, but rotate anyway and update `MOCK_BEARER` env in `docker-compose.dev.yml`
