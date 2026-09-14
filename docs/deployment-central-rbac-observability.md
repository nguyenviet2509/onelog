# Central RBAC observability & SSO login trace

Runbook để trace 1 login SSO qua Central + Zitadel khi member báo lỗi. Dùng **VMUI** (bookmark URLs với query embed sẵn) + OpenWebUI chat. Grafana dashboard đã bị bỏ (2026-09-14) — VMUI đủ dùng cho use case single-user trace, đỡ 1 lớp abstraction.

## Kiến trúc

```
authway-vps (Vector agent — /opt/authway/infra/authway-vps/vector.yaml)
├─ zitadel               → service=zitadel     ┐
├─ zitadel-login         → service=zitadel-login│
├─ postgres (Zitadel DB) → service=postgres    ├─ HTTP sink → VL onelog-vps :9428
├─ traefik               → service=traefik    │   host=authway
├─ central-rbac          → service=central-rbac│   _stream_fields: host, service
└─ central-rbac-ui       → service=central-rbac-ui ┘
```

Central RBAC (Fastify) emit structured JSON per request:
```json
{"level":30,"time":...,"service":"central-rbac","reqId":"<uuid>",
 "req":{"method":"POST","url":"/v1/webhooks/pre-token","hostname":"...","remoteAddress":"..."},
 "res":{"statusCode":200},"responseTime":11.7,
 "sub":"<zitadel-user-uuid>","user_email":"alice@inet.vn",
 "session_id":"<zitadel-session-uuid>","event_type":"oidc_session.added",
 "msg":"request completed"}
```

Không phải mọi field đều xuất hiện — tuỳ endpoint:

| Endpoint | Populated context |
|---|---|
| `/v1/resolve`, `/v1/admin/*` (JWT auth) | `sub`, `user_email` |
| `/v1/webhooks/pre-token` (Zitadel Action HMAC) | `user_id`, `user_email`, `app_id`, `org_id` |
| `/v1/webhooks/zitadel-event` (Zitadel Actions v2 HMAC) | `session_id`, `event_type`, `user_id`, `client_id` |
| `/v1/health`, others | Chỉ `reqId` + `req.*` + `res.*` |

## Sự kiện ↔ correlation key

Zitadel v4 access token **KHÔNG** carry `sid` claim (đã verify OIDC discovery 2026-09-14). Cross-service join:

- **Primary:** `user_email` — có ở cả Central JWT log, pre-token webhook (từ `body.user.human.email`), zitadel-event enrichment (`actor_email`). Query VMUI OR-join 2 field name.
- **Secondary:** `sub` / `user_id` (Zitadel user UUID) — stable, unique. Dùng khi user không có email (service account).
- **Zitadel-only:** `session_id` — chỉ có trong Zitadel event webhook payload (`event_payload.session_id`). Dùng để dedup events cùng session.
- **Fallback:** timestamp bucket ±5s + `user_email` — probabilistic, cho case join với log không có bất kỳ ID chung.

## Quick ops workflow — user báo lỗi login

1. Hỏi user: **email + timestamp lỗi** (làm tròn phút).
2. Mở VMUI bookmark **"SSO login timeline"** (dưới) — sửa email trong URL, chỉnh time range ±15 phút quanh timestamp.
3. Đọc timeline theo thứ tự thời gian:
   - `service:zitadel event_type:auth_request.added` → user click login
   - `service:zitadel event_type:user.human.password.check.succeeded|failed` → mật khẩu
   - `service:zitadel event_type:user.human.mfa.otp.check.*` → MFA
   - `service:central-rbac req.url:/v1/webhooks/pre-token` → Central resolve permissions
   - `service:zitadel event_type:oidc_session.added` → token issued
4. Nếu error ở Central pre-token: xem `msg:"resolve failed"` payload chi tiết
5. Nếu error ở Zitadel: check bookmark "Central 5xx" + Zitadel container log level=WARN|ERROR trong cùng window

## VMUI bookmark URLs (paste + sửa email/time)

Thay `<VL_HOST>` = domain VL của bạn (VD `10.200.0.30:9428` LAN hoặc `vl.internal` DNS). Query string đã URL-encoded sẵn.

**Timeline user** (sửa `alice@inet.vn` → email thật):
```
http://<VL_HOST>/select/vmui/?g0.query=host%3Aauthway+AND+%28service%3Acentral-rbac+OR+service%3Azitadel%29+AND+%28user_email%3A%22alice%40inet.vn%22+OR+actor_email%3A%22alice%40inet.vn%22%29&g0.range_input=30m
```

**Central 5xx last 1h**:
```
http://<VL_HOST>/select/vmui/?g0.query=host%3Aauthway+AND+service%3Acentral-rbac+AND+res.statusCode%3A%3E%3D500&g0.range_input=1h
```

**Central p95 latency per URL last 1h**:
```
http://<VL_HOST>/select/vmui/?g0.query=host%3Aauthway+AND+service%3Acentral-rbac+AND+responseTime%3A*+%7C+stats+by+%28req.url%29+quantile%280.95%2C+responseTime%29+as+p95_ms&g0.range_input=1h
```

**Trace 1 request cụ thể** (sửa `reqId` value):
```
http://<VL_HOST>/select/vmui/?g0.query=reqId%3A%226dad128f-d023-4c08-bec2-2670e6ced681%22&g0.range_input=6h
```

**Pre-token webhook fail per app** (sửa `app_id`):
```
http://<VL_HOST>/select/vmui/?g0.query=service%3Acentral-rbac+AND+req.url%3A%22%2Fv1%2Fwebhooks%2Fpre-token%22+AND+app_id%3A%22qlts%22+AND+level%3A%3E%3D50&g0.range_input=1h
```

**Brute-force detect Zitadel password fail (>5 in 15m)**:
```
http://<VL_HOST>/select/vmui/?g0.query=service%3Azitadel+AND+_msg%3A*%22password.check.failed%22*+%7C+stats+by+%28ip%2C+actor_email%29+count%28%29+as+fails+%7C+filter+fails%3A%3E5&g0.range_input=15m
```

## Query VMUI trực tiếp (raw LogsQL)

Ví dụ tiện lấy nhanh:

```logsql
# Timeline user trong 30 phút
host:authway AND (user_email:"alice@inet.vn" OR actor_email:"alice@inet.vn") _time:30m

# Central 5xx last hour
host:authway AND service:central-rbac AND res.statusCode:>=500 _time:1h

# Central latency p95 per URL
host:authway AND service:central-rbac AND responseTime:* _time:1h
  | stats by (req.url) quantile(0.95, responseTime) as p95_ms

# Trace 1 request cụ thể bằng reqId
reqId:"6dad128f-d023-4c08-bec2-2670e6ced681"

# Pre-token webhook fail cho 1 app
service:central-rbac AND req.url:"/v1/webhooks/pre-token" AND app_id:"qlts" AND level:>=50 _time:1h

# Brute-force per IP (Zitadel password fail)
service:zitadel AND _msg:*"password.check.failed"* _time:15m
  | stats by (ip, actor_email) count() as fails | filter fails:>5
```

## Query OpenWebUI chat

VMUI backing của OpenWebUI đã wire — hỏi natural language:

- "Trace login của alice@inet.vn 30 phút qua, tóm tắt lỗi nếu có"
- "Có request nào tới Central RBAC bị 500 last 1h không?"
- "Ai đang cố login sai password nhiều nhất hôm nay?"

## Đo baseline volume (trước Phase 3 tách stream sso-trace)

Mục tiêu quyết định có cần `_stream=sso-trace` riêng không. Chạy sau 1 tuần deploy:

```logsql
service:central-rbac _time:7d | stats count() as total_logs
service:central-rbac _time:1d | stats count() as logs_per_day
```

Nếu >10M/ngày → xem xét Phase 3 (dedicated stream để retention riêng). <10M/ngày → dùng default stream.

## Blindspot (known limitations)

1. **GitLab-side** (external IdP): khi Zitadel log `IdP intent failed`, không thấy reason từ GitLab. Workaround: hỏi team GitLab + timestamp + user_email → check GitLab production.log.
2. **App-side sau khi login thành công**: nếu app tự reject (role không đủ, session invalid) không thấy trong VL. Workaround: ship app log về VL (out of scope hiện tại).
3. **Zitadel session_id** không có trong access token JWT → Central `/v1/resolve` log không carry `session_id`, chỉ `sub`. Join qua `user_email` trong Grafana.

## Update Vector allowlist — khi thêm container mới trên authway-vps

Edit `d:\Vietnt\Project\authway\infra\authway-vps\vector.yaml` → `sources.docker.include_containers` → add tên container → commit authway repo → SSH authway-vps → `git pull && docker restart authway-prod-vector-1`.

## Ref

- Plan: `plans/260913-1708-central-sso-access-trace-observability/`
- Brainstorm: `plans/reports/brainstorm-260913-1708-central-sso-access-trace-observability.md`
- Log convention: `docs/observability-log-forwarding-convention.md`
- Central RBAC code: [central-rbac/src/lib/logger.ts](../central-rbac/src/lib/logger.ts), [central-rbac/src/app.ts](../central-rbac/src/app.ts), [central-rbac/src/middleware/auth-jwt.ts](../central-rbac/src/middleware/auth-jwt.ts)
