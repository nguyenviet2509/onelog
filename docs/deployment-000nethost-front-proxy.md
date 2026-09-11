# 000nethost front proxy — Zitadel + Central RBAC deploy notes

Doc mô tả kiến trúc proxy 2 tầng cho `zitadel.000nethost.com` + `rbacnb.000nethost.com`, các bug đã gặp và cách debug.

**Cập nhật:** 2026-09-11 — front proxy 000nethost đã đổi từ OpenResty (Sep 7 state) sang **nginx/1.24.0 (Ubuntu)**. `.well-known/*` bug cũ tự khỏi. Doc thêm section bug DNS alias collision phát hiện 2026-09-11.

## Kiến trúc luồng request

```
Browser (HTTPS 443)
   │
   ▼
Front proxy 000nethost (nginx/1.24.0 Ubuntu, IP 202.92.5.103)   ← TLS terminate, upstream HTTP
   │
   │  proxy_pass → http://10.200.0.125:80
   │  Host header giữ nguyên: zitadel.000nethost.com | rbacnb.000nethost.com
   ▼
authway-vps (10.200.0.125, private VPN only — không có public IP)
   │
   ▼
Traefik container (bind :80 và :443)
   │
   ├── zitadel.000nethost.com                                → container authway-prod-zitadel-1:8080   (Zitadel v4 backend)
   ├── zitadel.000nethost.com + PathPrefix `/ui/v2/login`    → container authway-prod-zitadel-login-1:3000   (Next.js login sidecar)
   ├── rbacnb.000nethost.com  + PathPrefix `/v1`             → container central-rbac:8083   (Fastify backend)
   ├── rbacnb.000nethost.com  + PathPrefix `/.well-known/rbac-permissions-schema` → central-rbac:8083
   └── rbacnb.000nethost.com  (catch-all)                    → container central-rbac-ui:80  (Angular SPA + nginx)
```

**Ghi chú:** authway-vps là VM private (IP `10.200.0.125` trên VPN mesh 10.200.0.0/24). Front proxy 000nethost là host duy nhất reach được từ public internet.

## Domain public

| Domain | Backend | Cert |
|---|---|---|
| `zitadel.000nethost.com` | authway-vps `10.200.0.125:80` | Sectigo wildcard `*.000nethost.com` |
| `rbacnb.000nethost.com` | authway-vps `10.200.0.125:80` | Sectigo wildcard `*.000nethost.com` |

## Endpoint status (2026-09-11)

| Endpoint | HTTP | Note |
|---|---|---|
| `zitadel.000nethost.com/` | 302 | ✅ redirect login |
| `zitadel.000nethost.com/ui/console/` | 200 | ✅ |
| `zitadel.000nethost.com/oauth/v2/keys` | 200 | ✅ JWKS |
| `zitadel.000nethost.com/.well-known/openid-configuration` | 200 | ✅ OIDC discovery |
| `rbacnb.000nethost.com/` | 200 | ✅ Central UI |
| `rbacnb.000nethost.com/v1/health` | 200 | ✅ backend health |
| `rbacnb.000nethost.com/.well-known/rbac-permissions-schema` | 404* | ✅ backend JSON 404 (endpoint chưa implement) |

\* Response 404 nhưng `Content-Type: application/json; charset=utf-8` = backend Fastify default 404, KHÁC nginx 404 HTML. Proxy hoạt động OK.

## Bug playbook

### Bug #1: OpenResty `.well-known/*` 404 (HISTORICAL — Sep 7 2026, resolved)

**Trạng thái:** Đã hết sau khi 000nethost đổi stack từ OpenResty → nginx 1.24.0 (Ubuntu). Giữ lại section để tham khảo.

**Cũ:** OpenResty vhost có block `location ~ ^/\.well-known/` không có `proxy_pass` → nginx fall through về default 404 HTML (Content-Length ~150B, `Server: openresty`).

**Cách phân biệt (nếu gặp lại):**
- Response body = **HTML** ~150 bytes + `Server: openresty` → front proxy vhost block bug (fix ở front proxy)
- Response body = **plain text 19B** `"404 page not found"` → request tới Traefik nhưng no router match (bug backend, xem Bug #2)
- Response body = **JSON** với 4xx → backend serve chính thức (không phải bug)

**Fix cũ:** trong vhost `zitadel.000nethost.com` và `rbacnb.000nethost.com`:
```nginx
# Option 1: xoá block, để rơi vào location /
# Option 2: thêm proxy_pass vào block .well-known
location ~ ^/\.well-known/ {
    proxy_pass http://10.200.0.125:80;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### Bug #2: Traefik router disabled — stale Docker labels (2026-09-11)

**Symptom:** `zitadel.000nethost.com/*` (trừ `/ui/v2/login`) → 404, response body plain text `"404 page not found"` (19 bytes, Content-Type: text/plain), `Server: nginx/1.24.0`. Central RBAC login báo "Lỗi xác thực: Failed to fetch" vì OIDC discovery fail.

**Root cause:** Traefik reads Docker container labels khi container CREATED. `docker compose restart` KHÔNG re-apply label changes. Sửa `compose.yml` labels + `restart` → container giữ label CŨ.

Sep 7 case: middleware `fix-idps-scheme` xoá khỏi `dynamic/middlewares.yml` (không cần trong HTTPS pilot) + compose label bỏ. Chỉ `docker compose restart zitadel` → container vẫn reference `middlewares=ratelimit-auth@file,fix-idps-scheme@file`. Traefik: `router.status="disabled", error="middleware fix-idps-scheme@file does not exist"`.

**Debug:**
```bash
# Check router status
curl -s http://127.0.0.1:8088/api/http/routers/zitadel-https@docker | python3 -m json.tool
# → "status": "enabled" hoặc "disabled" + "error": [...]

# Check container labels
docker inspect authway-prod-zitadel-1 --format '{{index .Config.Labels "traefik.http.routers.zitadel-https.middlewares"}}'
# → nếu khác với compose.yml → stale label
```

**Fix:**
```bash
cd /opt/authway/infra/authway-vps
docker compose up -d zitadel  # auto-recreate khi label diff
# Nếu init container fail: docker compose up -d --no-deps zitadel
```

### Bug #3: DNS alias collision `postgres` (2026-09-11)

**Symptom:** `zitadel-init` container intermittent SASL auth fail:
```
initialize ZITADEL failed: failed to connect to `user=zitadel database=zitadel`: 172.18.0.11:5432 (postgres): failed SASL auth
```

Zitadel main container HEALTHY dù cùng env vì lucky-hit đúng target lúc startup (172.18.0.3), giữ pool ấm indefinitely.

**Root cause:** `authway-prod-postgres-1` (172.18.0.3) và `central-rbac-postgres` (172.18.0.11) cùng có alias `postgres` trên network `authway-prod_internal` (do compose service name = `postgres` ở CẢ 2 stack). Docker DNS round-robin → zitadel-init đôi khi hit `.11` (central-rbac postgres, creds hoàn toàn khác) → auth fail.

**Debug:**
```bash
# Check ALL containers on internal network + IPs
docker network inspect authway-prod_internal --format '{{json .Containers}}' | \
  python3 -c "import json,sys;c=json.load(sys.stdin);[print(v['Name'],'->',v['IPv4Address']) for v in c.values()]"

# Check aliases per container
docker inspect central-rbac-postgres --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}  aliases: {{.Aliases}}{{end}}'

# Test DNS resolution — run 5x, không được round-robin
docker run --rm --network authway-prod_internal alpine getent hosts postgres
```

**Fix:** Rename service `postgres` → `central-rbac-db` trong `central-rbac/docker-compose.prod.yml`. `container_name: central-rbac-postgres` giữ nguyên, backend đã ref `central-rbac-postgres` (container_name) → không impact. Deploy: `scp` + `docker compose up -d --remove-orphans` (cần `docker stop && rm central-rbac-postgres` trước nếu conflict container_name).

## Header forward yêu cầu (chung cho cả 2 vhost front proxy)

```nginx
proxy_set_header Host $host;                              # zitadel.000nethost.com / rbacnb.000nethost.com
proxy_set_header X-Forwarded-Proto $scheme;               # https
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Backend Traefik pass các header xuống Zitadel / Central RBAC. Zitadel v4 đã bật trust proxy: `ZITADEL_INSTANCEHOSTHEADERS: x-forwarded-host,x-zitadel-instance-host`.

## Login V2 base URI persist trong DB (fixed Sep 7 2026)

DB projection `projections.instance_features5` giữ URL từ setup lần đầu (`10.200.0.125` là ExternalDomain cũ). Env `ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI` chỉ apply cho instance CHƯA tồn tại → không self-heal.

**Đã fix (2026-09-07):**
1. `UPDATE projections.instance_features5` → HTTPS + `zitadel.000nethost.com`
2. `UPDATE projections.instance_domains SET is_primary = true WHERE domain = 'zitadel.000nethost.com'`
3. `docker compose restart zitadel` — verify DB persist

## Path config backend (tham khảo)

Trên authway-vps `/opt/authway/infra/authway-vps/` (state clean, git-tracked master):
- `docker-compose.yml` — Traefik + Zitadel (+init, +setup) + Zitadel-login + Postgres + Vector + step-ca + node-exporter + cadvisor + mailhog
- `traefik.yml` — Traefik static config
- `dynamic/certs-000nethost.yml` — TLS store default cert
- `dynamic/middlewares.yml` — ratelimit-auth (rate limit login endpoints)
- `certs/000nethost/{fullchain.pem, privkey.pem}` — Sectigo wildcard cert (renew Feb 2027, manual)
- `zitadel-config.yaml` (template) + `zitadel-config.runtime.yaml` (envsubst rendered)
- `.env` — `ZITADEL_EXTERNAL_DOMAIN=zitadel.000nethost.com`

Trên authway-vps `/opt/central-rbac/`:
- `docker-compose.prod.yml` — central-rbac-db (postgres) + redis + central-rbac backend + central-rbac-ui
- `.env` — `VITE_ZITADEL_ISSUER=https://zitadel.000nethost.com`

## Contact

- Front proxy 000nethost: đội hạ tầng 000nethost
- Backend Zitadel + Central: đội authway/onelog nội bộ (`trihd@inet.vn`)
- Sectigo wildcard cert renew Feb 2027 — manual (LE unusable vì DC block :80 international)
