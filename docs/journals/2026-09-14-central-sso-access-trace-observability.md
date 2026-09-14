# 2026-09-14 — Central SSO login access/trace observability shipped

**Plan:** `260913-1708-central-sso-access-trace-observability`
**Scope:** Central RBAC + Zitadel SSO login trace via VictoriaLogs + Grafana. No new UI.

## Ship

- **onelog** `f898a6e` — Fastify pino access log + `request.log.child()` for `{sub, user_email, session_id, user_id, event_type, app_id}` in auth-jwt, webhook-pre-token, zitadel-event-webhook
- **onelog** `776c99d` — Grafana dashboard `sso-login-trace` (4 panels) + runbook `docs/deployment-central-rbac-observability.md`
- **authway** `40b4ed4` — Vector allowlist: add `central-rbac` + `central-rbac-ui` to docker_logs `include_containers`

Deploy: rebuild central-rbac on authway-vps (`docker compose up -d --build`), Vector restart on authway-vps, git pull + provisioning re-scan on onelog-vps.

## Verification

- `curl -sG VL/select/logsql/query 'service:central-rbac _time:5m'` returns parsed JSON with `req.method`, `req.url`, `res.statusCode`, `responseTime`, `reqId` — end-to-end pipeline confirmed.
- Central test suite 14 failed / 242 passed = exact baseline (0 regression, guards on `request.log.child` protect unit tests that use bare mock request or `Fastify({logger:false})`).
- Grafana `/etc/grafana/dashboards/sso-login-trace.json` mounted, provisioning `finished` without error.

## Key finding — Zitadel v4 does NOT emit `sid` claim

Verified via `curl https://zitadel.000nethost.com/.well-known/openid-configuration` → `claims_supported` lists sub, aud, exp, iat, iss, auth_time, nonce, acr, amr, c_hash, at_hash, act, scopes, client_id, azp, preferred_username, name, email, email_verified, phone — **no `sid`**. Sessions DO exist server-side in `projections.sessions8` and Zitadel event webhook carries `event_payload.session_id` — but access token JWT does not.

**Pivot** (approved during cook): use `sub` (Zitadel user UUID, stable) + `user_email` (human label) as primary correlation, `session_id` present only on zitadel-event-webhook logs. Grafana dashboard variable = `user_email`, OR-joins `user_email` + `actor_email` field names since central-rbac emits the former and zitadel-event enrichment emits the latter. Saved ~1h effort vs writing a Zitadel Action just for observability.

## Deliberately deferred

- **Phase 3** — Vector `_stream=sso-trace` tách retention. Waiting on baseline: chỉ làm nếu >10M logs/ngày sau 1 tuần.
- **App-side blindspot** — apps sau khi nhận token có thể tự reject; không ship app log về VL trong scope này. Nếu app critical (Grafana, QLTS), thêm phase ship log riêng sau.
- **GitLab-side blindspot** — GitLab external IdP log không accessible. Workaround document: khi Zitadel log `IdP intent failed` → hỏi team GitLab + timestamp + user_email.

## Gotchas learned

- **Vector `include_containers` allowlist** — mặc định chỉ có `authway-prod-*`; container không có prefix (`central-rbac`, `central-rbac-ui`) bị filter out silent. Không có log = log driver không bị tồn tại. Debug: `docker inspect ... LogConfig.Type` show json-file (OK) → check Vector config chứ không phải Docker.
- **Fastify `logger: false` trong test** = no-op logger without `.child()` method. Guard `if (request.log && typeof request.log.child === 'function')` cần cả 2 check (existence + type) vì auth-jwt unit tests inject bare mock request không có `.log` field.
- **Central RBAC deploy trên authway-vps** = source push (không phải git-tracked). Use `tar czf - src/ | ssh authway-vps sudo tar xzf - -C /opt/central-rbac/` để đồng bộ, sau đó `docker compose build --up -d`.
- **Vector remap** `.service = replace(container_name, "authway-prod-", "")` → container without prefix giữ nguyên `container_name` làm `.service`. `_stream_fields: [service, host]` tự động dedup stream.

## Ops handoff

Runbook `docs/deployment-central-rbac-observability.md` covers:
- Field taxonomy per endpoint (JWT paths vs HMAC webhook paths)
- Quick workflow: user báo lỗi → hỏi email+timestamp → mở dashboard → filter → đọc timeline
- 5 VMUI query snippets sẵn sao chép (5xx, p95, brute-force, single-reqId trace, timeline)
- 3 OpenWebUI chat prompt examples

## Next actions (not in this plan)

- Đo baseline log volume 1 tuần → quyết định Phase 3.
- Nếu Grafana v2 login flow break, verify dashboard tự surface qua Panel 1 `service:central-rbac req.url:/v1/webhooks/pre-token`.
- Consider ship Grafana + QLTS logs về VL sau — nếu vào scope, add phase riêng.
