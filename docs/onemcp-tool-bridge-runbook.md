# OneMCP Tool Bridge — Runbook

On-call reference for tool bridge operations. See `onemcp-tool-bridge-guideline.md` for design decisions.

---

## Discovery fetch failed troubleshoot {#discovery-failed}

Symptom: bridges from an upstream suddenly disappear from Claude after a few minutes.

**Root causes + fixes**:

| Error | Cause | Fix |
|---|---|---|
| Timeout (≥10s) | osh_admin down or endpoint slow | Check osh_admin health. Optimize `/tools/list` (serve static list, avoid heavy compute). OneMCP waits 10s max. |
| HTTP 404 | Endpoint not deployed or wrong path | Dev osh_admin: verify `/tools/list` route exposed. Test: `curl -H "Authorization: Bearer $TOKEN" https://osh-admin.domain/tools/list` |
| HTTP 401 | Bearer token mismatch | Verify bearer in OneMCP upstream config matches osh_admin's expected token. Check env var setup in osh_admin. |
| Schema validation error | osh_admin response format incorrect | Check response vs spec (`onemcp-bridge-discovery-spec.md`). Common: missing `app_slug`, `version`, or `tools` array. Check OneMCP backend logs for Zod validation error. |
| HTTPS mismatch | URL configured as `http://` in prod | Update upstream config → HTTPS only (unless `DEV_ALLOW_HTTP_DISCOVERY=true` env set in OneMCP — dev only). |
| Response > 100KB | Too many tools | Reduce tools count or split across multiple app registrations. Max 100 items per response. |
| Cache grace period expired (>5min) | Upstream down longer than grace window | Bridges disappear after 5 min stale-serve window. OneMCP stops serving old cache. When upstream recovers, manually click "Refresh cache" or wait 60s for next auto-fetch. |

**Immediate recovery**:
1. OneMCP Admin UI → Upstreams → find upstream row
2. Click **"Refresh cache"** button → forces immediate fetch next time Claude calls tools/list
3. Verify: Claude Desktop → MCP settings → tools/list → see bridge?

**Debug**:
```bash
# OneMCP backend logs
docker logs onemcp-backend-1 2>&1 | grep -E 'discovery|fetch' | tail -20

# Check if bearer is configured
docker exec onemcp-backend-1 psql -U postgres onemcp -c \
  "SELECT name, base_url, discovery_url FROM tool_upstreams WHERE name = 'osh_admin';"
```

---

## Tool visible in OneMCP but not in Claude Desktop session {#claude-session-stale}

Symptom: after dev deploys new tool, OneMCP `/api/admin/tool-bridges/discovered` shows the new tool, but Claude Desktop chat doesn't offer it — LLM doesn't know it exists.

**Root cause**: Claude Desktop calls MCP `tools/list` **once at session startup** and caches the tools list for the rest of that session. New tools added mid-session are not picked up. This is a client-side design limitation of the MCP client, not an OneMCP bug.

**Two-layer cache flow**:

```
Dev deploys new endpoint
    ↓
osh_admin /tools/list now returns new tool
    ↓
OneMCP cache TTL expires (≤60s) OR admin clicks Refresh cache
    ↓
OneMCP McpToolsService.listDefinitions() now includes new tool ✓
    ↓
BUT — Claude Desktop already has tools list from session startup ✗
    ↓
User must trigger new tools/list call from Claude Desktop side
```

**User workaround** (2 options, both instant):

1. **Open new chat** (Ctrl+N in Claude Desktop) — starts new MCP session → Claude Desktop calls tools/list again → LLM sees new tool.
2. **Restart Claude Desktop** — System tray → Quit → reopen. Slower (~5s) but forces full re-init.

**Verify tool is server-side ready** (before telling user to workaround):
```bash
# Verify OneMCP knows about the tool
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://oneconnector.000nethost.com/api/admin/tool-bridges/discovered | \
  jq '.[] | .name'

# Should list new tool. If not:
#   - Cache stale? → click "Refresh cache" in portal
#   - osh_admin /tools/list broken? → see "Discovery fetch failed troubleshoot" above
```

**When to consider fixing server-side** (currently deferred):
- Users complain ≥3 times/month about missing new tools mid-session
- osh_admin deployment frequency increases to >10/day (CI/CD auto-deploy)
- Business need for real-time tool availability without user action

**Server-side fix approach** (~1-2d effort, defer until needed):
- OneMCP emit MCP `notifications/tools/list_changed` when `BridgeDiscoveryService` cache invalidates
- Claude Desktop should honor this notification and refetch tools/list automatically
- **Risk**: MCP spec allows this but Claude Desktop implementation may not honor — verify manually before committing effort. Test: send fake notification from a mock MCP server, observe Claude Desktop behavior.

**Preventive practice** (recommend to dev osh_admin):
- Deploy new tools **outside business hours** (evening/weekend) → users naturally start new session next morning → see new tool without interrupt.
- Announce in team chat when deploying: "New tool `xxx` deployed at HH:MM — reopen your Claude Desktop chat to use it."

---

## Refresh cache manually {#refresh-cache}

Trigger immediate cache invalidation without waiting 60s TTL.

**When to use**:
- Dev just deployed new tool in osh_admin, need to test immediately
- Troubleshooting: suspect cache stale, want fresh fetch
- Admin changed discovery_url, want verify working

**Steps**:
1. Open OneMCP Admin UI: `https://oneconnector.000nethost.com/admin/tool-bridges`
2. Upstreams tab
3. Find upstream row (e.g. `osh_admin`)
4. Click **🔄 Refresh cache** button (appears only if discovery_url is set)
5. Toast notification: "Cache invalidated" → confirms triggered
6. Next Claude tools/list call will fetch fresh from osh_admin (no cache hit)
7. Verify: bridge appear in Claude after ≤2s (fresh fetch)

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
