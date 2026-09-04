# Deployment — Central RBAC + Zitadel domain swap

Runbook chuyển Central RBAC + Zitadel từ VPN IP (`10.200.0.125`) sang public domain qua upstream TLS proxy 000nethost.

## Domains

| Component | Domain public | Traefik entrypoint (authway-vps) |
|---|---|---|
| Central RBAC UI + API | `rbacnb.000nethost.com` | `web` (:80) |
| Zitadel Console + login sidecar | `zitadel.000nethost.com` | `web` (:80) |

Upstream 000nethost proxy terminates TLS, forwards HTTP đến authway-vps public IP :80 với `Host` header giữ nguyên.

## Golden rules

- **Zitadel `ExternalDomain` chỉ có 1 giá trị** → swap là all-or-nothing. VPN IP `10.200.0.125` hết dùng làm URL truy cập khi swap xong (backend container vẫn gọi được vì Zitadel accept x-forwarded-host, nhưng URL browser phải dùng domain mới).
- **Rebuild central-rbac-ui BẮT BUỘC** sau khi đổi `VITE_ZITADEL_ISSUER` — Vite bake vào JS bundle lúc build.
- **Zitadel PUT OIDC config = full-replace** — luôn preserve field cũ khi thêm URI mới.

## Prep đã xong (commit trước swap)

- [x] Compose `VITE_ZITADEL_ISSUER` parameterized qua `.env`
- [x] Traefik routers cho `rbacnb.000nethost.com` (UI + API) trên entrypoint `web`
- [x] nginx CSP `connect-src` thêm `https://zitadel.000nethost.com`
- [x] Zitadel OIDC client `central-rbac` add redirect URIs: `https://rbacnb.000nethost.com/callback` + post-logout
- [x] Zitadel OIDC client bật `devMode: true` — tắt cảnh báo Compliance

## Quick swap (execute khi DNS + upstream proxy sẵn sàng)

### 1. Verify DNS + proxy

```bash
# Từ máy dev (ngoài VPN):
curl -sI https://rbacnb.000nethost.com/         # expect 200 HTML
curl -sI https://rbacnb.000nethost.com/v1/health  # expect 200 JSON
curl -sI https://zitadel.000nethost.com/         # expect 302 (redirect login sidecar)
```

Nếu 404: upstream proxy chưa forward đúng Host header. Fix upstream trước khi tiếp.

### 2. Update authway-vps `.env`

```bash
ssh authway-vps
cd /opt/authway/infra/authway-vps
cp .env .env.bak-$(date +%Y%m%d)

# Sửa:
sed -i 's|^ZITADEL_EXTERNAL_DOMAIN=.*|ZITADEL_EXTERNAL_DOMAIN=zitadel.000nethost.com|' .env
```

### 3. Update Zitadel compose env

Sửa `/opt/authway/infra/authway-vps/docker-compose.yml` mục `zitadel:` env:
```yaml
ZITADEL_EXTERNALPORT: 443       # was 80
ZITADEL_EXTERNALSECURE: "true"  # was "false"
ZITADEL_OIDC_DEFAULTLOGINURLV2: https://${ZITADEL_EXTERNAL_DOMAIN}/ui/v2/login/login?authRequest=
ZITADEL_OIDC_DEFAULTLOGOUTURLV2: https://${ZITADEL_EXTERNAL_DOMAIN}/ui/v2/login/logout?post_logout_redirect=
ZITADEL_SAML_DEFAULTLOGINURLV2: https://${ZITADEL_EXTERNAL_DOMAIN}/ui/v2/login/login?samlRequest=
```

Và `zitadel-login:` env:
```yaml
ZITADEL_API_URL: https://${ZITADEL_EXTERNAL_DOMAIN}
CUSTOM_REQUEST_HEADERS: "Host:${ZITADEL_EXTERNAL_DOMAIN},X-Forwarded-Host:${ZITADEL_EXTERNAL_DOMAIN},X-Forwarded-Proto:https"
```

### 4. Update central-rbac `.env`

```bash
cd /opt/central-rbac
echo 'VITE_ZITADEL_ISSUER=https://zitadel.000nethost.com' >> .env
echo 'VITE_REVIEW_MODE=false' >> .env   # optional — tắt banner review
```

### 5. Restart + rebuild

```bash
# Zitadel + login sidecar restart (không cần rebuild — chỉ env change)
cd /opt/authway/infra/authway-vps
docker compose up -d --force-recreate zitadel zitadel-login

# Central RBAC UI rebuild (Vite bake issuer vào bundle)
cd /opt/central-rbac
docker compose -f docker-compose.prod.yml up -d --force-recreate --build central-rbac-ui
```

### 6. Smoke test

```bash
# Zitadel discovery từ ngoài:
curl -s https://zitadel.000nethost.com/.well-known/openid-configuration | jq .issuer
# expect: "https://zitadel.000nethost.com"

# Central UI load:
curl -sI https://rbacnb.000nethost.com/
# expect: 200, CSP header có https://zitadel.000nethost.com

# Login flow: mở browser → https://rbacnb.000nethost.com → bấm Login → redirect Zitadel → login → callback OK
```

## Rollback

Nếu login/backend fail sau swap:

```bash
ssh authway-vps
cd /opt/authway/infra/authway-vps
mv .env.bak-YYYYMMDD .env
# revert docker-compose.yml zitadel env (ExternalPort/Secure/LoginURL)
docker compose up -d --force-recreate zitadel zitadel-login

cd /opt/central-rbac
# xóa 2 dòng VITE_ đã thêm khỏi .env
docker compose -f docker-compose.prod.yml up -d --force-recreate --build central-rbac-ui
```

VPN access `http://10.200.0.125:8082` sẽ hoạt động lại. Rollback safe vì URIs domain vẫn còn trong Zitadel OIDC client (không xoá cái cũ).

## Troubleshooting

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| 404 "Instance not found" | Zitadel không nhận Host domain mới | Verify `ZITADEL_EXTERNAL_DOMAIN` env đã đổi + container đã restart |
| Mixed Content block ở browser Console | CSP thiếu `connect-src` domain Zitadel | Verify nginx CSP header có `https://zitadel.000nethost.com` |
| OIDC discovery 404 khi login | JWKS URL trong bundle chưa update | Rebuild central-rbac-ui, xoá cache browser (Ctrl+Shift+R) |
| Login redirect về `http://` thay vì `https://` | `ZITADEL_EXTERNALSECURE=false` chưa đổi | Set `"true"` + restart zitadel |
| Backend fail verify JWT | `ZITADEL_EXTERNAL_HOST` env central-rbac cũ | Cập nhật `.env` central-rbac `ZITADEL_EXTERNAL_HOST=zitadel.000nethost.com` + restart |

## Unresolved

- Zitadel v4 Add Instance Domain qua API cần system JWT (không PAT). Không đăng ký được secondary domain — chấp nhận swap all-or-nothing.
- Backend `ZITADEL_MGMT_URL` giữ `http://10.200.0.125` hay đổi sang `https://zitadel.000nethost.com` — chưa quyết. Giữ IP → không phụ thuộc DNS public, nhưng Zitadel sẽ 404 nếu Host header không match ExternalDomain. Nếu Zitadel dùng `x-forwarded-host` (đã bật) thì Traefik router match theo Host → forward. Cần smoke test sau swap.
