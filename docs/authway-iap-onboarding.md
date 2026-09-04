# Authway IAP app onboarding

Hướng dẫn onboard app mới sau Authway (Zitadel v4) OIDC với 2 pattern:
**oauth2-proxy sidecar** (app không có OIDC native) hoặc **native OIDC** (Grafana/OpenWebUI).

**Related plans:**
- Plan `260810-1021-sso` — oauth2-proxy IAP baseline
- Plan `260819-1628` — Grafana native OIDC dual-mode
- Plan `260903-1330-zitadel-gitlab-idp-grafana-verify` — GitLab IdP verify
- Plan `260904-0951-authway-gitlab-sso-prod-hardening` — this doc

## Prerequisites

- App HTTP endpoint sẵn sàng (container hoặc bare metal)
- Zitadel admin console access — tạo Application trong project
- Reverse proxy trước app support forward_auth (Caddy) hoặc app native OIDC support

## 1. Zitadel side — tạo Application

1. Console → **Projects → OneLog** (hoặc project tương ứng) → **New Application**
2. Type: **Web** (native OIDC)
3. Auth method:
   - **PKCE** — SPA / app support PKCE (Grafana)
   - **Basic** — server-to-server, có client_secret
4. **Redirect URIs** (EXACT match với URL browser thấy):
   - oauth2-proxy sidecar: `http://<APP_HOST>/oauth2/callback`
   - Native OIDC (Grafana pattern): `http://<APP_HOST>/<app-path>/login/generic_oauth`
5. **Post logout redirect URI:** `http://<APP_HOST>/`
6. Copy: **Client ID** (numeric snowflake) + **Client Secret** (nếu Basic)

## 2. OneLog `infra/.env` — add app vars

Nếu chưa có block chung Authway, add:

```env
# ── Authway Zitadel (shared by all IAP apps) ──
ZITADEL_ISSUER=http://10.200.0.125
ZITADEL_HOST=10.200.0.125

# ── <APP> OIDC (client from Zitadel Console) ──
<APP>_OIDC_CLIENT_ID=<snowflake_from_console>
<APP>_OIDC_CLIENT_SECRET=<secret_from_console>  # bỏ nếu PKCE
```

**KHÔNG hardcode** `http://10.200.0.125/...` trực tiếp vào compose.

## 3. Compose block pattern

### Option A — oauth2-proxy sidecar (app KHÔNG có OIDC native)

Xem [infra/docker-compose.yml](../infra/docker-compose.yml) `oauth2-proxy` service (~line 675-690) + [Caddyfile](../infra/caddy/Caddyfile) `handle /grafana*` forward_auth pattern (line 165-178).

Flow: browser → Caddy → forward_auth oauth2-proxy → app + inject `X-Auth-Request-Email`. App tin header (VD Grafana `GF_AUTH_PROXY_ENABLED=true`, OpenWebUI `WEBUI_AUTH_TRUSTED_EMAIL_HEADER`).

### Option B — Native OIDC (Grafana pattern)

Copy env block, thay `<APP>` + tên biến app:

```yaml
    environment:
      # === OIDC — Zitadel Authway ===
      # URL derived from ZITADEL_ISSUER — HTTPS migration đổi 1 chỗ
      <APP>_OIDC_ENABLED: "true"
      <APP>_OIDC_CLIENT_ID: ${<APP>_OIDC_CLIENT_ID}
      <APP>_OIDC_CLIENT_SECRET: ${<APP>_OIDC_CLIENT_SECRET}
      <APP>_OIDC_ISSUER: ${ZITADEL_ISSUER}
      <APP>_OIDC_AUTH_URL: ${ZITADEL_ISSUER}/oauth/v2/authorize
      <APP>_OIDC_TOKEN_URL: ${ZITADEL_ISSUER}/oauth/v2/token
      <APP>_OIDC_USERINFO_URL: ${ZITADEL_ISSUER}/oidc/v1/userinfo
      <APP>_OIDC_JWKS_URL: ${ZITADEL_ISSUER}/oauth/v2/keys
      <APP>_OIDC_END_SESSION_URL: ${ZITADEL_ISSUER}/oidc/v1/end_session
      <APP>_OIDC_SCOPES: "openid email profile"
      <APP>_OIDC_USE_PKCE: "true"
```

**Bắt buộc:** dùng `${ZITADEL_ISSUER}/...` — KHÔNG hardcode `http://10.200.0.125/...`.

## 4. Caddy route (nếu behind Caddy)

Xem `handle /grafana*` pattern trong [Caddyfile](../infra/caddy/Caddyfile) làm mẫu. Sub-path apps cần app config `SERVE_FROM_SUB_PATH` + `ROOT_URL` (VD Grafana `GF_SERVER_SERVE_FROM_SUB_PATH=true`).

## 5. Onboarding checklist

- [ ] Zitadel Application tạo, Client ID + Secret copy
- [ ] Redirect URI trong Zitadel EXACT match — scheme + host + port + path
- [ ] `.env` add app vars, KHÔNG hardcode Zitadel URL
- [ ] Compose block dùng `${ZITADEL_ISSUER}`
- [ ] Verify no hardcode:
  ```bash
  grep "10.200.0.125" infra/docker-compose.yml | grep -v "^ *#"
  # Chỉ được thấy dòng ZITADEL_HOST var, không phải URL hardcode.
  ```
- [ ] Restart app: `docker compose up -d <app>`
- [ ] Run smoke: `./infra/scripts/smoke-oidc.sh --verbose`
- [ ] Browser incognito → full flow login OK
- [ ] Sign out → land về Zitadel login (session cleared) — verify SIGNOUT_REDIRECT_URL chain

## 6. Role mapping (nếu app support)

Zitadel emit claim `urn:zitadel:iam:org:project:roles` = object `{roleKey: {orgId: orgDomain}}`.

Extract role qua JMESPath (Grafana pattern) — xem [infra/docker-compose.yml](../infra/docker-compose.yml) line 806.

**Role catalog + convention** — xem `docs/authway-role-catalog.md` (nếu có).

## Common issues

| Symptom | Root cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` | Zitadel Redirect URI không khớp URL app emit | Update Console → App → Redirect URIs. **EXACT** match scheme+host+port+path. |
| Cookie oversize (>4KB) | User có 10+ UserGrant → JWT `roles` claim quá lớn | Xem plan `260904-0820-jwt-roles-claim-size-fix` — scope-limit per-project |
| Login OK nhưng no roles | Role claim path sai / project settings "Return user roles" OFF | Verify claim path JMESPath; bật "Return user roles" trong project settings |
| PKCE fail on HTTP+IP LAN | `crypto.subtle` require secure context (HTTPS hoặc localhost) | Dùng SSH tunnel localhost cho dev; prod dùng HTTPS |
| Login fail post-restart Zitadel | `strip-hsts-login` / `fix-idps-scheme` middleware missing | Chạy `smoke-oidc.sh` để catch drift |
| Sign-out không clear IdP session | `SIGNOUT_REDIRECT_URL` không chain end_session | Xem OpenWebUI pattern compose:619 |

## References

- Zitadel v4 OIDC docs — https://zitadel.com/docs/apis/openidoauth/endpoints
- oauth2-proxy config — https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview
- Runbook drift check — `infra/scripts/smoke-oidc.sh --verbose`
