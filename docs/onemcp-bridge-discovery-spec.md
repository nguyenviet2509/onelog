# OneMCP Bridge Live Discovery Spec

For dev osh_admin to expose a discovery endpoint. Plans: `260918-0953-onemcp-bridge-live-discovery`.

---

## Purpose

Enable dev osh_admin to maintain a **live, dynamic tools list** without requiring OneMCP admin to manually register each bridge. When a new endpoint is added to osh_admin, it appears in Claude automatically (≤60s) — zero handoff friction.

**Workflow**:
1. Admin OneMCP: register upstream with `discovery_url` → one-time setup
2. Dev osh_admin: add endpoint + expose via `/tools/list` → deploy
3. OneMCP: fetches tools every 60s → bridges auto-visible in Claude
4. LLM calls tool: OneMCP dispatches same as manual bridge

---

## Endpoint Contract

### Request

```
GET https://{base_url}/tools/list
Authorization: Bearer {token}
```

**Fields**:
- `base_url`: upstream base (e.g. `https://osh-admin.domain` prod, `http://mock-osh-admin:8080` dev)
- Path: configurable per-upstream; recommended `/tools/list` (set via `discovery_url` in upstream config)
- Bearer: same token as tool calls (osh_admin verifies — not public endpoint)

**Timeout**: OneMCP waits max **10 seconds**.

**HTTPS required** except when `DEV_ALLOW_HTTP_DISCOVERY=true` env set (dev only).

---

### Response (200 OK)

```json
{
  "app_slug": "osh_admin",
  "version": "1.0.0",
  "tools": [
    {
      "name": "create_waf",
      "method": "POST",
      "path": "/waf/rules",
      "description": "Create WAF rule blocking IP/domain",
      "permission_id": "osh_admin:tool.create_waf",
      "param_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["domain"],
        "properties": {
          "domain": {
            "type": "string",
            "description": "Target domain (FQDN). Required."
          },
          "ip": {
            "type": "string",
            "description": "IP or CIDR to block (optional)."
          }
        }
      }
    }
  ]
}
```

**Schema constraints** (Zod-validated by OneMCP):

| Field | Constraint | Example |
|---|---|---|
| `app_slug` | 1–64 chars | `osh_admin` |
| `version` | semver x.y.z | `1.0.0` |
| `tools` | array, max 100 items | — |
| `name` | snake_case, 1–64 chars, regex `/^[a-z_][a-z0-9_]*$/` | `create_waf` |
| `method` | GET \| POST \| PUT \| DELETE | `POST` |
| `path` | starts `/`, 1–512 chars | `/waf/rules` |
| `description` | min 1 char, non-empty | "Creates WAF rule…" |
| `permission_id` | format `app_slug:permission.name`, regex `/^[a-z_][a-z0-9_]*:[a-z_][a-z0-9_.]*$/` | `osh_admin:tool.create_waf` |
| `param_schema` | JSON Schema `{type:"object", properties, required[], additionalProperties:bool}` | see examples |

**Response size limit**: max **100KB**. Responses exceeding this are rejected; consider splitting across multiple apps.

**Example with multiple tools**:

```json
{
  "app_slug": "osh_admin",
  "version": "1.0.0",
  "tools": [
    {
      "name": "create_waf",
      "method": "POST",
      "path": "/waf/rules",
      "description": "Create WAF rule blocking IP/domain. Use when blocking malicious traffic.",
      "permission_id": "osh_admin:tool.create_waf",
      "param_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["domain"],
        "properties": {
          "domain": {"type": "string", "description": "Target domain (FQDN)."},
          "ip": {"type": "string", "description": "IP or CIDR to block (optional)."}
        }
      }
    },
    {
      "name": "list_wafs",
      "method": "GET",
      "path": "/waf/rules",
      "description": "List all active WAF rules. Use for audit or troubleshooting.",
      "permission_id": "osh_admin:tool.list_wafs",
      "param_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": [],
        "properties": {
          "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max results (default 50)."}
        }
      }
    },
    {
      "name": "query_access_log",
      "method": "GET",
      "path": "/access-logs",
      "description": "Query access log entries for a domain. Use for incident triage and analytics.",
      "permission_id": "osh_admin:tool.query_access_log",
      "param_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["domain"],
        "properties": {
          "domain": {"type": "string", "description": "Domain to query."},
          "minutes": {"type": "integer", "minimum": 1, "maximum": 1440, "description": "Time window in minutes (default 30)."},
          "status_code": {"type": "integer", "description": "Optional HTTP status filter (e.g. 403, 200)."}
        }
      }
    }
  ]
}
```

---

## Cache Behavior

**OneMCP caches discovered tools in process memory** with these rules:

- **TTL**: 60 seconds per upstream
- **Stale-serve grace period**: 5 minutes if fetch fails (e.g. timeout, 5xx)
  - Tools remain visible in Claude if endpoint is temporarily down
  - After 5 min grace expires, bridges disappear from tools/list
- **Cache invalidation**:
  - Auto: TTL 60s expire
  - Manual: Admin OneMCP portal → Upstreams → click "Refresh cache" button → force immediate refetch next tools/list call
- **Collision handling**: if tool name collides with static tool or manual bridge, static wins (lookup order: static → legacy manual → live-discovered)

**For dev**: new endpoint added to osh_admin → changes visible in Claude within ≤60s OR click Refresh to see immediately.

---

## Best Practices

### 1. Build Tools List Dynamically

**Do NOT hardcode** tools array. Instead, inspect router/handler registry at runtime:

**Express example**:
```typescript
app.get('/tools/list', bearerAuth, (req, res) => {
  const tools = [];
  // Iterate app._router.stack (or use a registry you maintain)
  app._router.stack.forEach((middleware) => {
    if (middleware.route && middleware.route.path === '/waf/rules') {
      tools.push({
        name: 'create_waf',
        method: 'POST',
        path: '/waf/rules',
        description: '...',
        permission_id: 'osh_admin:tool.create_waf',
        param_schema: {...},
      });
    }
    // ... inspect other routes
  });
  res.json({ app_slug: 'osh_admin', version: '1.0.0', tools });
});
```

**Benefit**: when you add a new endpoint, tools list auto-syncs — zero maintenance.

### 2. Bump Version When Breaking

- `param_schema` adds new required field → bump minor (e.g. 1.0.0 → 1.1.0)
- `permission_id` changes format → bump major (e.g. 1.0.0 → 2.0.0)
- Description-only changes → no version bump

**Why**: OneMCP logs version for audit. Breaking change = developers notified via changelog.

### 3. Test Endpoint Before Deploy

```bash
# Fetch tools list
curl -H "Authorization: Bearer $YOUR_BEARER_TOKEN" \
  https://osh-admin.domain/tools/list | jq .

# Validate response
# - app_slug, version, tools array present
# - Each tool has: name, method, path, description, permission_id, param_schema
# - name matches snake_case pattern
# - method is GET|POST|PUT|DELETE
# - path starts with /
# - permission_id format: app_slug:tool.<name>
```

---

## Example Implementations

### Express (Node.js)

```typescript
import express from 'express';

const app = express();

// Middleware: verify bearer token
function bearerAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (token !== process.env.OSH_ADMIN_BEARER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Endpoint: serve tools list
app.get('/tools/list', bearerAuth, (req, res) => {
  res.json({
    app_slug: 'osh_admin',
    version: '1.0.0',
    tools: [
      {
        name: 'create_waf',
        method: 'POST',
        path: '/waf/rules',
        description: 'Create WAF rule blocking IP/domain.',
        permission_id: 'osh_admin:tool.create_waf',
        param_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['domain'],
          properties: {
            domain: { type: 'string', description: 'Target FQDN.' },
            ip: { type: 'string', description: 'IP or CIDR (optional).' },
          },
        },
      },
    ],
  });
});

app.listen(8080, () => console.log('osh_admin listening :8080'));
```

### NestJS

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BearerTokenGuard } from './guards/bearer-token.guard';

@Controller('tools')
export class ToolsController {
  @Get('list')
  @UseGuards(BearerTokenGuard)
  getToolsList() {
    return {
      app_slug: 'osh_admin',
      version: '1.0.0',
      tools: [
        {
          name: 'create_waf',
          method: 'POST',
          path: '/waf/rules',
          description: 'Create WAF rule blocking IP/domain.',
          permission_id: 'osh_admin:tool.create_waf',
          param_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['domain'],
            properties: {
              domain: { type: 'string', description: 'Target FQDN.' },
              ip: { type: 'string', description: 'IP or CIDR (optional).' },
            },
          },
        },
      ],
    };
  }
}
```

### Go (Gin)

```go
package main

import (
	"github.com/gin-gonic/gin"
	"net/http"
)

func bearerAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("Authorization")
		if token != "Bearer "+os.Getenv("OSH_ADMIN_BEARER_TOKEN") {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			c.Abort()
			return
		}
		c.Next()
	}
}

func main() {
	r := gin.Default()

	r.GET("/tools/list", bearerAuth(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"app_slug": "osh_admin",
			"version":  "1.0.0",
			"tools": []gin.H{
				{
					"name":            "create_waf",
					"method":          "POST",
					"path":            "/waf/rules",
					"description":     "Create WAF rule blocking IP/domain.",
					"permission_id":   "osh_admin:tool.create_waf",
					"param_schema": gin.H{
						"type":                  "object",
						"additionalProperties": false,
						"required":              []string{"domain"},
						"properties": gin.H{
							"domain": gin.H{"type": "string", "description": "Target FQDN."},
							"ip":     gin.H{"type": "string", "description": "IP or CIDR (optional)."},
						},
					},
				},
			},
		})
	})

	r.Run(":8080")
}
```

### Python (FastAPI)

```python
from fastapi import FastAPI, Header, HTTPException
import os

app = FastAPI()

@app.get("/tools/list")
async def get_tools_list(authorization: str = Header(None)):
    bearer_token = os.getenv("OSH_ADMIN_BEARER_TOKEN")
    if not authorization or authorization != f"Bearer {bearer_token}":
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    return {
        "app_slug": "osh_admin",
        "version": "1.0.0",
        "tools": [
            {
                "name": "create_waf",
                "method": "POST",
                "path": "/waf/rules",
                "description": "Create WAF rule blocking IP/domain.",
                "permission_id": "osh_admin:tool.create_waf",
                "param_schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["domain"],
                    "properties": {
                        "domain": {"type": "string", "description": "Target FQDN."},
                        "ip": {"type": "string", "description": "IP or CIDR (optional)."},
                    },
                },
            },
        ],
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
```

---

## FAQ

### Q: When does a new tool appear in Claude?

**A**: Within **60 seconds** of deployment (cache TTL). Or immediately if admin clicks "Refresh cache" in OneMCP portal.

Workflow:
1. Dev commits + deploys osh_admin (includes update to `/tools/list` response)
2. OneMCP cache expires in ≤60s
3. Next `tools/list` call from Claude Desktop → OneMCP fetches fresh
4. Claude sees new bridge → available for LLM to call

Manual refresh: OneMCP portal → Upstreams tab → click "Refresh cache" button on upstream row → next tools/list call fetches immediately.

---

### Q: What if the discovery endpoint isn't ready yet?

**A**: OneMCP falls back to **stale cache** (up to 5 minutes old) while waiting for the endpoint to recover. Bridges remain visible + usable.

- Timeout/5xx from osh_admin → log error, serve stale from cache
- After 5 min grace expires → bridges disappear
- When osh_admin recovers → next tools/list call refetches → bridges reappear

This is intentional — better to serve old tools than none if endpoint is briefly down.

---

### Q: How do I delete a tool?

**A**: Remove it from the `/tools/list` response in osh_admin code. Deploy.

OneMCP doesn't store discovered bridges — they're ephemeral. Within 60s, the deleted tool vanishes from Claude's tools/list.

Cleanup: no manual step needed. If you want to delete immediately, admin clicks "Refresh cache" in OneMCP portal.

---

### Q: What about rollback?

**A**: Git revert in osh_admin repo → redeploy.

OneMCP caches the last-fetched response. Rollback strategy:
1. Identify commit to revert (e.g. bad param_schema or removed tool)
2. `git revert <commit>` in osh_admin
3. Deploy
4. OneMCP fetches new response ≤60s (or admin clicks Refresh for immediate)

---

### Q: How is the `/tools/list` endpoint authenticated?

**A**: Same **bearer token** as tool calls. Not public.

OneMCP admin registers upstream with bearer → OneMCP sends bearer in `Authorization: Bearer <token>` header when fetching `/tools/list`. Your osh_admin backend must verify the token before returning tools.

**Important**: Because this bearer is sent by OneMCP, **you must trust it**. If OneMCP is compromised, tokens leak. In prod with public endpoint exposure, escalate to security team for HMAC signing review.

---

### Q: Can multiple OneMCP instances share cache?

**A**: MVP: **No**. Each OneMCP process has its own in-memory cache (TTL 60s).

If scaling OneMCP horizontally: each instance independently fetches + caches. No cache invalidation synchronization across instances. If admin clicks "Refresh cache" on one instance, others continue with old cache until TTL expires.

Future (P2): Redis shared cache + webhook push from osh_admin for real-time invalidation.

---

### Q: What happens if response exceeds 100KB?

**A**: OneMCP rejects it. Error logged. No tools imported from that upstream.

**Fix**: Reduce tools count (split across multiple apps) or optimize response (remove unnecessary fields).

---

### Q: Version field — do I need to bump it?

**A**: Only if schema breaking changes. OneMCP ignores version field in MVP (doesn't validate semver compatibility).

Bump version to signal downstream developers:
- Minor bump (1.0.0 → 1.1.0): new optional fields, new tool, description-only changes
- Major bump (1.0.0 → 2.0.0): permission_id format change, required field added, tool deleted

OneMCP logs version in audit for historical context.

---

## Troubleshooting

See `onemcp-tool-bridge-runbook.md` → `Discovery fetch failed troubleshoot` for:
- Timeout / 404 / 401 / schema validation errors
- HTTPS requirement errors
- Response size exceeded

---

## Related

- Parent plan: `260918-0953-onemcp-bridge-live-discovery`
- Guideline: `onemcp-tool-bridge-guideline.md`
- Runbook: `onemcp-tool-bridge-runbook.md` → procedures + troubleshooting
- MVP journal: `journals/2026-09-17-onemcp-osh-admin-bridge-mvp-shipped.md` — existing bridge design (manual bridges using same dispatcher)
