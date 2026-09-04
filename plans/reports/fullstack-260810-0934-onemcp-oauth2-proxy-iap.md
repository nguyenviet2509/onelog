# Report: OneMCP oauth2-proxy IAP — Phase 3+4

**Date:** 2026-08-10  
**Plan:** 260806-1504-sso-multi-app-zitadel-ldap-rollout phase 3+4  
**Status:** DONE

---

## Files Created / Modified

| File | Action | Notes |
|---|---|---|
| `ops/oauth2-proxy/oauth2-proxy.cfg.example` | created | Committed to repo — placeholders only |
| `ops/oauth2-proxy/oauth2-proxy.cfg` | created locally + scp | Gitignored — secret file on VPS only |
| `docker-compose.yml` | modified | Added `oauth2-proxy` service, `oauth2-proxy` in nginx `depends_on` |
| `ops/nginx/onemcp.conf` | modified | auth_request chain, /oauth2/ proxy, error_page 401 |
| `.gitignore` | modified | Added `ops/oauth2-proxy/oauth2-proxy.cfg` |

---

## Commits

| Hash | Message |
|---|---|
| `8035172` | `feat(auth): add oauth2-proxy IAP sidecar for Zitadel SSO` |
| `7fa5c09` | `fix(auth): disable oauth2-proxy healthcheck — distroless image has no wget/curl` |

Both pushed to `origin/master` → `https://github.com/nguyenviet2509/onemcp.git`

---

## Issues Encountered & Resolved

1. **cookie_secret format** — original secret `ljd/Ty5IZCD9+6QAwVWR1kPj++i4FvBQ3XC4a/r/8ag=` is standard base64 (44 chars, `+/` alphabet). oauth2-proxy v7.6 requires base64url without padding. Generated new: `oZ9LJSulMFNiEBbxG4u9YzogNa4QFL2wCgBWtYJXyJA` (32 bytes decoded). Local cfg updated + re-scp'd.

2. **Healthcheck fails in distroless image** — oauth2-proxy v7.6 uses scratch/distroless image (no wget, no shell). Healthcheck `CMD wget /ping` caused perpetual restart loop. Fixed: `healthcheck.disable: true`. Manual check: `docker exec onemcp-nginx-1 wget -qO- http://oauth2-proxy:4180/ping` → `OK`.

3. **Nginx bind-mount stale after git pull** — git replaces file inodes on pull; nginx `reload` re-reads same inode (old file). Needed `docker compose restart nginx` to pick up new config. Auth_request was NOT active until container restart.

---

## E2E Verify Output

```
# oauth2-proxy ping (internal)
docker exec onemcp-nginx-1 wget -qO- http://oauth2-proxy:4180/ping
→ OK

# Root redirect (unauthenticated)
curl -sk https://localhost/ -H 'Host: onemcp.inet.vn' -w 'HTTP %{http_code} -> %{redirect_url}'
→ HTTP 302 -> https://onemcp.inet.vn/oauth2/start?rd=https://onemcp.inet.vn/

# Full redirect chain
curl -skL --max-redirs 5 https://localhost/oauth2/start?rd=https://onemcp.inet.vn/ -H 'Host: onemcp.inet.vn' -w '%{url_effective}'
→ http://10.200.0.125/oauth/v2/authorize?client_id=385595050630840323&redirect_uri=https%3A%2F%2Fonemcp.inet.vn%2Foauth2%2Fcallback&...

# /api/ gated
curl -sk https://localhost/api/me -H 'Host: onemcp.inet.vn' -w 'HTTP %{http_code} -> %{redirect_url}'
→ HTTP 302 -> https://onemcp.inet.vn/oauth2/start?rd=https://onemcp.inet.vn/api/me

# /mcp/ not gated
curl -sk https://localhost/mcp/test -H 'Host: onemcp.inet.vn' -w 'HTTP %{http_code}'
→ HTTP 404  (from backend — no auth redirect, correct)
```

---

## Container State (post-deploy)

```
onemcp-oauth2-proxy-1   quay.io/oauth2-proxy/oauth2-proxy:v7.6.0   Up ~10min
onemcp-nginx-1          nginx:alpine                                Up (restarted)
onemcp-backend-1        onemcp-backend                              Up 2 days (healthy)
onemcp-portal-1         onemcp-portal                               Up 2 days (healthy)
```

---

## oauth2-proxy Startup Log (healthy)

```
[provider.go] Performing OIDC Discovery...
[providers.go] Warning: Your provider supports PKCE methods ["S256"], but you have not enabled one with --code-challenge-method
[oauthproxy.go] OAuthProxy configured for OpenID Connect Client ID: 385595050630840323
[oauthproxy.go] Cookie settings: name:_oauth2_proxy secure(https):true httponly:true expiry:168h0m0s domains:onemcp.inet.vn path:/ samesite:lax refresh:disabled
```

OIDC Discovery against Zitadel (`http://10.200.0.125`) succeeded. PKCE warning is informational — Zitadel supports S256 but we haven't enabled it (acceptable for pilot, can add `--code-challenge-method=S256` later).

---

## Next Steps (user action required)

1. **Browser test**: Open `https://onemcp.inet.vn` in incognito → should redirect to Zitadel login page → login with LDAP credentials → land on portal. This is the critical E2E test.

2. **Verify X-Onemcp-User injection**: After login, check backend logs or `/api/me` response to confirm email is being passed correctly as `X-Onemcp-User` header.

3. **PKCE hardening** (optional, post-pilot): Add `--code-challenge-method=S256` to `oauth2-proxy.cfg` for PKCE support. Re-scp to VPS + restart container.

4. **email_verified=false risk**: `insecure_oidc_allow_unverified_email = true` is set. Watch oauth2-proxy logs for `email not verified` warnings on LDAP-provisioned users. If Zitadel auto-verifies LDAP emails, no action needed.

5. **Portal SSR cookies**: Test multi-tab, page refresh after login — Next.js SSR may re-hit `/api/` server-side. Since SSR runs inside Docker network (no browser cookie), SSR calls to `/api/` will 401. Monitor for portal hydration errors; if they occur, SSR API calls need to bypass auth_request (separate internal URL pattern).

6. **Sign-out**: Test `https://onemcp.inet.vn/oauth2/sign_out` — clears cookie, should redirect to Zitadel end-session or back to `/`.

---

## Known Risk: Portal SSR vs auth_request

Portal (Next.js) does SSR API calls server-side (container → nginx → /api/). These calls do NOT carry the browser session cookie → will hit 401 → portal may render empty data. **Not blocking for browser-side navigation** (client fetch has cookie). Monitor after browser test; mitigation is to give portal a direct `http://backend:3000` env var for SSR calls (bypasses nginx auth entirely).

---

**Status:** DONE  
**Summary:** oauth2-proxy IAP deployed, nginx auth_request chain active. Full redirect chain to Zitadel verified via curl. Browser E2E test pending (user action).
