# OneMCP Tool Bridge — Smoke Test Plan

**Version**: 2026-09-17 | **Scope**: P5b — mock osh_admin E2E

## Prerequisites

```bash
# Start mock + backend
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Verify mock healthy
curl http://localhost:8080/health
# Expected: {"status":"healthy","version":"mock-1.0"}

# Tail mock logs in separate terminal
docker logs -f mock-osh-admin
```

Upstream registered in OneMCP DB:
- `base_url`: `http://mock-osh-admin:8080`
- `bearer`: `dev-fixed-token`
- `timeout_ms`: 10000

3 bridges registered: `create_waf`, `create_rate_limit`, `query_access_log`

---

## Test Cases

### TC-1 — Happy path: create_waf (user-x, all perms)

**Setup**: Claude Desktop logged in as `test-user-x` (sub forwarded by OneMCP)

**Prompt**: "Chặn IP 1.2.3.4 trên domain foo.com"

**Expected**:
- LLM selects `create_waf` tool
- OneMCP forwards `X-Onemcp-User-Sub: test-user-x` + `X-Onemcp-Correlation-Id: <uuid>`
- Mock responds 201 `{"status":"created","waf_id":"waf-mock-..."}`
- Claude shows confirmation

**Verify**:
```bash
# Mock stdout shows allow
docker logs mock-osh-admin 2>&1 | grep '"path":"/waf/rules"' | tail -1
# Expected: "outcome":"allow"

# OneMCP audit log shows tool_call success
docker logs onemcp-backend-1 2>&1 | grep 'create_waf' | tail -1
```

---

### TC-2 — Happy path: create_rate_limit (user-x)

**Prompt**: "Giới hạn 100 req/s cho domain foo.com"

**Expected**: `create_rate_limit` called → 201 `{"status":"created","policy_id":"rl-mock-..."}`

**Verify**:
```bash
docker logs mock-osh-admin 2>&1 | grep '"path":"/rate-limits"' | tail -1
```

---

### TC-3 — Happy path: query_access_log (user-x)

**Prompt**: "Xem access log 5 phút gần đây cho foo.com"

**Expected**: `query_access_log` called → 200 array of log entries, Claude summarizes

**Verify**:
```bash
docker logs mock-osh-admin 2>&1 | grep '"path":"/access-logs"' | tail -1
# Confirm correlation_id present in log entry
```

---

### TC-4 — Negative: user-y (no permissions)

**Setup**: Claude Desktop logged in as `test-user-y`

**Prompt**: "Chặn IP 5.5.5.5 trên domain bar.com"

**Expected**:
- Mock returns 403 `{"error":"forbidden","missing_permission":"osh_admin:tool.create_waf"}`
- OneMCP propagates 403 to Claude
- Claude reports permission denied (no bearer token leaked in message)

**Verify**:
```bash
docker logs mock-osh-admin 2>&1 | grep '"outcome":"deny"' | tail -1
# Confirm missing_permission in log

# Confirm bearer NOT in Claude response (check Claude Desktop UI)
```

---

### TC-5 — Timeout: scenario=slow (10s OneMCP abort)

**Setup**: Modify bridge `query_access_log` description to include `?scenario=slow` in base path temporarily, OR call via OneMCP test-call API if supported.

**Direct curl alternative** (verify mock behavior directly):
```bash
curl -s --max-time 12 \
  -H "Authorization: Bearer dev-fixed-token" \
  -H "X-Onemcp-User-Sub: test-user-x" \
  "http://localhost:8080/access-logs?domain=foo.com&scenario=slow"
# Mock hangs 15s; OneMCP should abort at 10s

# Check OneMCP log for timeout error
docker logs onemcp-backend-1 2>&1 | grep -i 'timeout\|abort' | tail -3
```

**Expected**: OneMCP returns 504/timeout to caller after ~10s; Claude sees error.

---

### TC-6 — Retry: scenario=5xx (1x retry on 5xx GET)

**Direct curl** (verify mock):
```bash
curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer dev-fixed-token" \
  -H "X-Onemcp-User-Sub: test-user-x" \
  "http://localhost:8080/access-logs?domain=foo.com&scenario=5xx"
# Expected: 502
```

**Via OneMCP**: Trigger `query_access_log` with scenario=5xx injected.

**Verify**:
```bash
# Mock should receive 2 requests (original + 1 retry on GET)
docker logs mock-osh-admin 2>&1 | grep '"/access-logs"' | wc -l
# Expect: 2 if retry implemented; 1 if not (note actual retry behavior)

docker logs onemcp-backend-1 2>&1 | grep -i 'retry\|5xx\|502' | tail -5
```

---

### TC-7 — Response cap: scenario=large (2MB → truncate marker)

**Direct curl**:
```bash
curl -s \
  -H "Authorization: Bearer dev-fixed-token" \
  -H "X-Onemcp-User-Sub: test-user-x" \
  "http://localhost:8080/access-logs?domain=foo.com&scenario=large" | wc -c
# Expected: ~2MB from mock
```

**Via OneMCP**: Trigger tool call with scenario=large.

**Expected**: OneMCP truncates response, Claude sees `[...TRUNCATED: X bytes omitted]` marker or error indicating large response.

**Verify**:
```bash
docker logs onemcp-backend-1 2>&1 | grep -i 'truncat\|cap\|large' | tail -5
```

---

### TC-8 — Malformed upstream response: scenario=malformed

**Direct curl**:
```bash
curl -s \
  -H "Authorization: Bearer dev-fixed-token" \
  -H "X-Onemcp-User-Sub: test-user-x" \
  "http://localhost:8080/access-logs?domain=foo.com&scenario=malformed"
# Expected: '{bad json :::'
```

**Via OneMCP**: Trigger tool call with malformed scenario.

**Expected**: OneMCP parse error → returns structured error to Claude (not raw bad JSON).

**Verify**:
```bash
docker logs onemcp-backend-1 2>&1 | grep -i 'parse\|malform\|json' | tail -5
```

---

### TC-9 — Partial permission: user-partial (read-only)

**Setup**: Claude Desktop as `test-user-partial`

**Test A** — allowed: "Xem access log cho foo.com"
- Expected: `query_access_log` succeeds (partial user has this perm)

**Test B** — denied: "Chặn IP 9.9.9.9 trên domain foo.com"
- Expected: `create_waf` → 403 from mock

**Verify**:
```bash
docker logs mock-osh-admin 2>&1 | tail -20
# Check: query_access_log = outcome:allow, create_waf = outcome:deny
```

---

### TC-10 — Correlation ID propagation

**Run TC-1** (create_waf happy path), note the `X-Onemcp-Correlation-Id` UUID.

**Verify**:
```bash
# Find correlation ID in OneMCP audit log
docker logs onemcp-backend-1 2>&1 | grep 'correlation' | tail -3

# Find same ID in mock log
docker logs mock-osh-admin 2>&1 | grep '<correlation_id_from_above>'
```

**Expected**: Same UUID appears in both OneMCP and mock stdout logs.

---

## Pass/Fail Criteria

| TC | Pass condition |
|---|---|
| TC-1..3 | 201/200 response, mock log outcome=allow |
| TC-4 | 403 propagated, no bearer in Claude message |
| TC-5 | OneMCP returns error after ~10s, not hanging |
| TC-6 | 502 handled gracefully, retry evidence in logs |
| TC-7 | Truncate marker or error — Claude context not crashed |
| TC-8 | Parse error returned cleanly — no raw bad JSON to Claude |
| TC-9 | Split allow/deny per permission correctly |
| TC-10 | Same correlation ID in both log streams |

---

## Notes

- **Circuit-open smoke** (stop central-rbac, verify 503 + Alertmanager) is **N/A** — Phase 2 Central RBAC circuit-breaker was removed from MVP scope.
- Scenarios TC-5..TC-8 can be driven via OneMCP `POST /admin/tool-bridges/<id>/test-call` API if it supports injecting query params into the upstream URL, otherwise drive directly via curl against mock on port 8080.
