# SSO Deploy Report — oauth2-proxy IAP + Zitadel + Caddy forward_auth

**Date:** 2026-08-10
**Commit:** `9d929b4` — `feat(sso): add oauth2-proxy IAP + Caddy forward_auth for Zitadel SSO`

---

## Files Changed

| File | Change |
|---|---|
| `infra/oauth2-proxy/oauth2-proxy.cfg` | Created (gitignored, SCP'd to VPS) |
| `infra/oauth2-proxy/oauth2-proxy.cfg.example` | Created + committed |
| `infra/caddy/Caddyfile` | Rewrote :80 block — add SSO gates, split /select/vmui/* |
| `infra/docker-compose.yml` | +oauth2-proxy service, +OpenWebUI SSO env, +Grafana auth_proxy env |
| `.gitignore` | +`infra/oauth2-proxy/oauth2-proxy.cfg` exclusion |

---

## Compose Services + Env Additions

### New service: `ragstack-oauth2-proxy`
```yaml
image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
container_name: ragstack-oauth2-proxy
restart: unless-stopped
command: ["--config=/etc/oauth2-proxy.cfg"]
volumes:
  - ./oauth2-proxy/oauth2-proxy.cfg:/etc/oauth2-proxy.cfg:ro
networks:
  default:
    aliases: [oauth2-proxy]
```
No host port. Caddy reaches via docker DNS `oauth2-proxy:4180`.

### OpenWebUI — env additions
```
WEBUI_AUTH_TRUSTED_EMAIL_HEADER: X-Auth-Request-Email
WEBUI_AUTH_TRUSTED_NAME_HEADER: X-Auth-Request-User
```
Auto-provisions user on first SSO login. ENABLE_SIGNUP=false blocks direct form.

### Grafana — env additions
```
GF_AUTH_PROXY_ENABLED: "true"
GF_AUTH_PROXY_HEADER_NAME: X-Auth-Request-Email
GF_AUTH_PROXY_HEADER_PROPERTY: username
GF_AUTH_PROXY_AUTO_SIGN_UP: "true"
GF_AUTH_PROXY_HEADERS: "Email:X-Auth-Request-Email Name:X-Auth-Request-User"
GF_AUTH_PROXY_ENABLE_LOGIN_TOKEN: "true"
GF_AUTH_PROXY_WHITELIST: "172.16.0.0/12,10.0.0.0/8"
GF_AUTH_BASIC_ENABLED: "false"
GF_AUTH_DISABLE_LOGIN_FORM: "true"
```

---

## Caddyfile Path Matrix

| Path | Auth | Upstream |
|---|---|---|
| `/oauth2/*` | **Bypass** (no auth — must be first) | oauth2-proxy:4180 |
| `/.well-known/*` | Bypass | Static JSON 404 |
| `/` (catch-all) | **forward_auth SSO** → 302 Zitadel on 401 | openwebui:8080 |
| `/grafana*` | **forward_auth SSO** | grafana:3000 |
| `/select/vmui/*` | **forward_auth SSO** | victorialogs:9428 |
| `/cookbook` | **forward_auth SSO** | file_server (mockups) |
| `/select/*` (non-vmui) | None (machine API) | victorialogs:9428 |
| `/insert/*` | None | victorialogs:9428 |
| `/health`, `/metrics` | None | victorialogs:9428 |
| `/mcp/vl/*`, `/mcp/semantic/*` | Bearer (mcp-semantic /auth/verify) | mcp-vl / mcp-semantic |
| `/message*` | Bearer (mcp-semantic /auth/verify) | mcp-vl:8000 |
| `/llm/*` | None (LiteLLM master key) | litellm-proxy:4000 |
| `/mcpo/*` | None (MCPO_API_KEY) | mcpo:8080 |

---

## Verify Output (curl on VPS)

```
# oauth2-proxy ping from Caddy container
ragstack-caddy$ wget -qO- http://oauth2-proxy:4180/ping  →  OK

# SSO redirect chain — root
GET /  →  302 /oauth2/start?rd=/  →  302 http://10.200.0.125/oauth/v2/authorize?...

# SSO redirect chain — Grafana
GET /grafana  →  302 /oauth2/start?rd=/grafana

# SSO redirect chain — VMUI
GET /select/vmui/  →  302 /oauth2/start?rd=/select/vmui/

# SSO redirect chain — cookbook
GET /cookbook  →  302 /oauth2/start?rd=/onelog-vmui-queries.html

# Machine API — no redirect (400 = missing required params, not 302)
GET /select/logsql/query  →  400
GET /health  →  200
GET /insert/opentelemetry  →  400
```

All results confirmed live on VPS.

---

## Manual Browser Test Steps

### Pre-condition
- Browser NOT logged into Zitadel (use Incognito or clear cookies for `10.200.0.30`)
- Zitadel running at `http://10.200.0.125` with user account ready

### Test 1 — OpenWebUI SSO + auto-provision
1. Incognito → `http://10.200.0.30/`
2. Expect: redirect chain → Zitadel login page at `10.200.0.125`
3. Login with Zitadel credentials (LDAP or local user)
4. Expect: redirect back to `http://10.200.0.30/` → OpenWebUI loads
5. OpenWebUI auto-creates account with email from Zitadel token
6. Verify: no separate OpenWebUI login form shown

### Test 2 — Grafana SSO (silent after Test 1)
1. Same tab (Zitadel session cookie live) → `http://10.200.0.30/grafana`
2. Expect: NO Zitadel redirect (session valid) → Grafana dashboard loads directly
3. Verify: Grafana shows username = Zitadel email, no login form
4. If first visit: Grafana auto-provisions user (GF_AUTH_PROXY_AUTO_SIGN_UP=true)

### Test 3 — VMUI SSO (silent)
1. `http://10.200.0.30/select/vmui/` in same session
2. Expect: loads VictoriaLogs UI immediately (no redirect)
3. No per-user identity in VMUI — just access gate

### Test 4 — Sign out
1. `http://10.200.0.30/oauth2/sign_out`
2. Expect: Zitadel session terminated; revisit `/` → redirects to Zitadel again

### Test 5 — Machine paths unaffected
1. `http://10.200.0.30/health` → `{"status":"ok"}` (no redirect)
2. MCP endpoint: still requires Bearer token (unchanged)

---

## Caddy Version
`v2.11.4` — `handle_response` + `copy_headers` syntax fully supported.

---

## Unresolved

1. **VMUI no per-user identity** — SSO gates access but VictoriaLogs VMUI has no auth concept; all authenticated users see all logs. Acceptable for ops team; revisit if multi-tenant needed.
2. **OpenWebUI first admin bootstrap** — if DB is empty, OpenWebUI shows "Create Admin" form before trusted-header kicks in. After first admin created, SSO takes over. Admin must manually set role=admin for Zitadel-provisioned users if elevated perms needed.
3. **Grafana admin role** — GF_AUTH_PROXY_AUTO_SIGN_UP provisions role=Viewer by default. Promote specific users to Admin via Grafana UI or `GF_AUTH_PROXY_ROLE_HEADER` (requires Zitadel to emit a claim).
4. **cookie_secure=false** — HTTP-only deploy. When TLS enabled on VPS, set `cookie_secure = true` in oauth2-proxy.cfg + SCP updated file.
5. **webui.local hostname SSO** — forward_auth added to `http://webui.local` block too; requires hosts entry on client machine pointing to `10.200.0.30`.
6. **Zitadel `offline_access` scope** — requires Zitadel application to allow refresh tokens; verify in Zitadel console if token refresh fails after 1h.
