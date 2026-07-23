# Phase 4 — Alertmanager webhook → OneMCP

## Priority
Medium. Nice-to-have giúp alert context-aware (attach runbook link) — không blocking chat flow.

## Context
- OneMCP P7 đã có endpoint `/api/webhooks/alerts` (Bearer auth, dedup, 202 async, Slack integration).
- OneLog Alertmanager hiện gửi Telegram (`infra/alertmanager/*.yml`).
- Mục tiêu: add 1 receiver mới trỏ về OneMCP → OneMCP đối chiếu alert với runbook KB → notify (Slack/Telegram) kèm link runbook nếu match.

## Requirements

### Functional
- Alertmanager có thêm receiver `onemcp-webhook` type `webhook`
- URL: `${ONEMCP_URL}/api/webhooks/alerts`
- Auth: Bearer token (từ OneMCP `.env`, có sẵn)
- Route: mọi alert severity=critical|warning → gửi cả Telegram (như hiện tại) + OneMCP (parallel, không thay thế)
- OneMCP-side: verify P7 config đúng (Slack channel/Telegram optional)

### Non-functional
- OneMCP xử lý webhook < 500ms (đã 202 async)
- Nếu OneMCP down → Alertmanager không retry vô hạn (default retry 1)

## Files to modify
- `infra/alertmanager/config.yml` (hoặc file config chính) — thêm receiver + route
- `infra/.env.example` — thêm `ONEMCP_ALERT_WEBHOOK_TOKEN`
- OneMCP `.env` (bên ngoài repo) — confirm `ALERTMANAGER_WEBHOOK_TOKEN` khớp

## Todo
- [ ] Đọc `docs/alertmanager-integration.md` bên OneMCP (đã có, đọc trước để lấy đúng format)
- [ ] Thêm receiver `onemcp-webhook` vào Alertmanager config
- [ ] Route parallel: cùng alert gửi cả 2 receivers (dùng `continue: true` trong route)
- [ ] Reload alertmanager: `docker compose exec alertmanager kill -HUP 1` hoặc restart
- [ ] Trigger 1 alert test (vmalert manual fire hoặc chờ alert thật)
- [ ] Verify OneMCP audit log có event webhook nhận

## Success criteria
- Alertmanager reload không lỗi
- Test alert → cả Telegram (như cũ) + OneMCP webhook nhận được (audit log)
- Nếu có runbook match → notification kèm link portal artifact

## Risks
- **Token mismatch** → 401 silent — check log OneMCP
- **Payload format khác** — OneMCP P7 expect Alertmanager v2 format, verify version alertmanager dùng
- **Double notify** cho team — mitigate: routing OneMCP notify chỉ khi runbook match; nếu không match thì im lặng

## Security
- Bearer token rotate quarterly, không log
- OneMCP webhook endpoint whitelist source IP nếu cần (Alertmanager container IP)

## Next
Phase 5: smoke test end-to-end + docs.
