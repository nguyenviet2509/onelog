# OpenResty proxy 000nethost — Zitadel + Central RBAC cần fix

Tài liệu tổng hợp gửi admin quản lý OpenResty tại `202.92.5.103` để check config proxy cho 2 domain public.

**Cập nhật:** 2026-09-07 10:00 (đã re-verify state sau khi VPN authway-vps up lại).

## Kiến trúc luồng request

```
Browser (HTTPS 443)
   │
   ▼
OpenResty (202.92.5.103)   ← TLS terminate, upstream HTTP
   │
   │  proxy_pass → http://10.200.0.125:80
   │  Host header giữ nguyên: zitadel.000nethost.com | rbacnb.000nethost.com
   ▼
authway-vps (10.200.0.125, private VPN only — không có public IP)
   │
   ▼
Traefik container (bind :80 và :443)
   │
   ├── zitadel.000nethost.com                                → container zitadel:8080         (Zitadel v4 backend)
   ├── zitadel.000nethost.com + PathPrefix `/ui/v2/login`    → container zitadel-login:3000   (Next.js login sidecar)
   ├── rbacnb.000nethost.com  + PathPrefix `/v1`             → container central-rbac:8083   (Fastify backend)
   ├── rbacnb.000nethost.com  + PathPrefix `/.well-known/rbac-permissions-schema` → central-rbac:8083
   └── rbacnb.000nethost.com  (catch-all)                    → container central-rbac-ui:80  (Angular SPA + nginx)
```

**Ghi chú quan trọng:** authway-vps là VM private (chỉ IP `10.200.0.125` trên VPN mesh 10.200.0.0/24). OpenResty là host duy nhất reach được từ public internet. Nếu OpenResty không proxy được request nào, request đó không đến được backend.

## Domain public

| Domain | Backend | Cert |
|---|---|---|
| `zitadel.000nethost.com` | authway-vps `10.200.0.125:80` | Sectigo wildcard `*.000nethost.com` |
| `rbacnb.000nethost.com` | authway-vps `10.200.0.125:80` | Sectigo wildcard `*.000nethost.com` |

Cả 2 domain trỏ chung upstream `10.200.0.125:80`. Traefik nội bộ route theo Host header.

## Endpoint hiện tại — trạng thái qua OpenResty

Test từ máy dev qua public HTTPS (2026-09-07 10:00):

### `zitadel.000nethost.com`

| Path | HTTP | Content-Type | Trạng thái |
|---|---|---|---|
| `/` | 302 | text/html | ✅ redirect login |
| `/ui/console/` | 200 | text/html | ✅ |
| `/ui/console/assets/environment.json` | 200 | text/plain (JSON) | ✅ `api` + `issuer` = HTTPS |
| `/ui/v2/login/` | 308 | — | ✅ redirect |
| `/oauth/v2/keys` | 200 | application/json | ✅ (JWKS) |
| `/oauth/v2/authorize` | 400 | application/json | ✅ (thiếu params) |
| **`/.well-known/openid-configuration`** | **404** | **text/html (150B nginx default)** | ❌ **KHÔNG proxy** |

### `rbacnb.000nethost.com`

| Path | HTTP | Content-Type | Trạng thái |
|---|---|---|---|
| `/` | 200 | text/html | ✅ Central UI |
| `/v1/health` | 200 | application/json | ✅ |
| **`/.well-known/rbac-permissions-schema`** | **404** | **text/html** | ❌ **KHÔNG proxy** (cùng bug) |

**Kết luận:** Cả 2 domain đều bị **cùng bug OpenResty** — bất cứ path `.well-known/*` nào đều 404 dù backend serve OK.

## Root cause bug `.well-known/*`

### Bằng chứng

```bash
# Qua OpenResty:
curl -sI https://zitadel.000nethost.com/.well-known/openid-configuration
# HTTP/1.1 404 Not Found
# Server: openresty
# Content-Type: text/html
# Content-Length: 150       ← nginx default 404 HTML

# Bypass OpenResty, hit thẳng Traefik authway-vps (từ trong VPN):
curl -sk --resolve zitadel.000nethost.com:443:10.200.0.125 \
  https://zitadel.000nethost.com/.well-known/openid-configuration
# HTTP/2 200
# Content-Type: application/json
# {"issuer":"https://zitadel.000nethost.com","authorization_endpoint":"...", ...}
```

→ Backend Zitadel serve `.well-known/openid-configuration` **đúng**. Path bị chặn tại tầng OpenResty.

### Suy luận

Các path khác của cùng vhost (`/oauth/v2/keys`, `/ui/console/*`, v.v.) đều 200 → OpenResty **CÓ** `proxy_pass` cho `location /` chung. Chỉ path `.well-known/*` bị 404.

Nghi ngờ trong config vhost có block đặc biệt như:

```nginx
location ~ ^/\.well-known/ {
    allow all;              # chỉ mở access-control
    # ❌ THIẾU proxy_pass → nginx fall through về default → 404
}
```

Block này **shadow** path `.well-known/*` khỏi `location /` chung (nơi có `proxy_pass`), khiến nginx thử serve static file từ document root → không tồn tại → trả nginx default 404 HTML.

Nguyên nhân block xuất hiện thường là:
- 宝塔 (BT.CN) / cPanel / DirectAdmin panel auto-generate rule cho Let's Encrypt scan
- Admin thêm sẵn khi setup vhost để trigger LE cert renewal

## Fix đề xuất

### Option 1 (khuyến nghị — đơn giản nhất)

**Xoá luôn block `location ~ ^/\.well-known/`** trong CẢ HAI vhost:
- `zitadel.000nethost.com`
- `rbacnb.000nethost.com`

Để request `.well-known/*` rơi vào `location /` chung đã có `proxy_pass` sẵn. Reload nginx.

### Option 2 (giữ block, thêm proxy_pass)

Nếu Option 1 vẫn 404 (có nghĩa còn rule deny khác), sửa block thành:

```nginx
location ~ ^/\.well-known/ {
    proxy_pass http://10.200.0.125:80;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}
```

Header `Host $host` + `X-Forwarded-Proto $scheme` **BẮT BUỘC** — backend cần biết domain public + scheme HTTPS để render URL đúng.

## Verify sau khi fix

```bash
# Zitadel
curl -sI https://zitadel.000nethost.com/.well-known/openid-configuration
# expect: HTTP/2 200, content-type: application/json

# Central RBAC
curl -sI https://rbacnb.000nethost.com/.well-known/rbac-permissions-schema
# expect: HTTP/2 200, content-type: application/json
```

Sau đó browser mở `https://rbacnb.000nethost.com/` → login qua Zitadel → không còn snackbar `[object Object]` ở Console.

## Header forward yêu cầu (chung cho cả 2 vhost)

Vhost `zitadel.000nethost.com` và `rbacnb.000nethost.com` cần forward:

```nginx
proxy_set_header Host $host;                              # zitadel.000nethost.com / rbacnb.000nethost.com
proxy_set_header X-Forwarded-Proto $scheme;               # https
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Backend Traefik trên authway-vps sẽ pass các header này xuống Zitadel / Central RBAC. Backend đã bật trust proxy (`ZITADEL_INSTANCEHOSTHEADERS: x-forwarded-host,x-zitadel-instance-host`).

## Bug phụ đã fix xong — cache Login V2 URI trong DB

Trước đó khi admin test qua hosts local, sau login redirect ra `http://10.200.0.125/ui/v2/login/login?authRequest=V2_...` → 404.

Root cause: DB projection `projections.instance_features5` còn giữ URL từ setup lần đầu (khi ExternalDomain còn là `10.200.0.125`). Env `ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI` chỉ apply cho instance CHƯA tồn tại.

**Đã fix backend (2026-09-07 11:05):**
1. `UPDATE projections.instance_features5` — set `login_v2.base_uri.{Scheme,Host}` sang `https` + `zitadel.000nethost.com`
2. `UPDATE projections.instance_domains` — flip `is_primary=true` cho `zitadel.000nethost.com` (thay vì `10.200.0.125`)
3. `docker compose restart zitadel` — verify DB persist qua restart

Verified: `curl https://zitadel.000nethost.com/oauth/v2/authorize?...` (bypass OpenResty) → redirect đúng `https://zitadel.000nethost.com/ui/v2/login/login?authRequest=V2_...` (HTTPS + domain, không còn IP).

Admin OpenResty **chỉ cần lo fix `.well-known/*` block**. Backend đã sẵn sàng.

## Path file config phía backend (tham khảo)

Trên authway-vps `/opt/authway/infra/authway-vps/`:
- `docker-compose.yml` — Traefik + Zitadel + Zitadel-login + Postgres + Vector
- `traefik.yml` — Traefik static config (entrypoints `web:80`, `websecure:443`, `rbac-review:8082`)
- `dynamic/certs-000nethost.yml` — TLS store default cert
- `certs/000nethost/{fullchain.pem, privkey.pem}` — Sectigo wildcard cert (renew Feb 2027, manual)
- `zitadel-config.yaml` (template) + `zitadel-config.runtime.yaml` (envsubst rendered)
- `.env` — `ZITADEL_EXTERNAL_DOMAIN=zitadel.000nethost.com`

Trên authway-vps `/opt/central-rbac/`:
- `docker-compose.prod.yml` — postgres + redis + central-rbac backend + central-rbac-ui
- `.env` — `VITE_ZITADEL_ISSUER=https://zitadel.000nethost.com`

## Contact / escalate

- Ai maintain OpenResty 000nethost: đội hạ tầng 000nethost
- Ai maintain backend Zitadel + Central: đội authway/onelog nội bộ (`trihd@inet.vn`)

Sau khi fix `.well-known/*` phía OpenResty, backend **không cần restart** — Zitadel + Central sẽ serve JSON discovery đúng cho browser ngay lập tức.

## Unresolved

- Nếu Option 1 (xoá block) vẫn không work → có thể còn rule deny khác trong config OpenResty (VD từ 宝塔 panel auto-generate). Cần admin grep toàn bộ config vhost tìm rule đề cập `.well-known`.
- Sectigo wildcard cert `*.000nethost.com` renew Feb 2027 — manual (LE unusable vì DC block :80 international). Đội hạ tầng 000nethost cần track ngày renew.
