# Phase 1 — Compat + network + auth prep

## Priority
Critical — gate cho toàn bộ plan. Nếu network không reachable → xoay hướng deployment.

**Decision update (2026-07-23 13:24):** Chọn Path B (OpenWebUI Function + Action) → bỏ mcpo compat check. Lý do: user identity passthrough (`X-Onemcp-User = real user email`) yêu cầu per-request header, mcpo chỉ hỗ trợ static header.

## Requirements

### Verify tasks (theo thứ tự, dừng nếu fail)
1. **URL OneMCP** — xác định endpoint chính thức (`https://onemcp.local/api/mcp` hay IP:port khác). Ping/curl từ máy dev.
2. **Reachable từ OneLog Docker network** — chạy `docker compose --profile chat exec openwebui sh -c "wget -qO- --header='X-Onemcp-User: openwebui-bot' <URL>/health"`. Nếu fail → fix DNS (`extra_hosts` docker-compose) hoặc route host.
3. **CIDR whitelist** — trong OneMCP `.env` (`USER_ALLOW_CIDR`), thêm subnet của host chạy OneLog stack (openwebui container IP outbound).
4. **User provisioning trong OneMCP** — 2 phương án:
   - **(preferred)** Bulk pre-create team member usernames trong OneMCP (khớp OpenWebUI login) với role `contributor`
   - **(fallback)** Bot user `openwebui-bot` role contributor — dùng khi user chưa có trong OneMCP (Function fallback header)
5. **Test manual identity passthrough**: `curl -sk -H "X-Onemcp-User: <real_username>" $ONEMCP_URL/api/me` → 200 với đúng user.

## Files to modify
- (nếu cần DNS injection) `infra/docker-compose.yml` — mcpo service, thêm `extra_hosts: ["onemcp.local:<IP>"]`
- `infra/.env.example` — thêm `ONEMCP_URL`, `ONEMCP_BOT_USER`
- OneMCP `.env` (bên project OneMCP) — CIDR update (ghi note không commit vì khác repo)

## Todo
- [ ] Xác nhận ONEMCP_URL + ghi vào `.env.example`
- [ ] Curl `/health` từ host dev → PASS
- [ ] Curl `/health` từ openwebui container → PASS
- [ ] Curl `POST /api/mcp {tools/list}` với header X-Onemcp-User → 8 tools trả về
- [ ] Pre-create OneMCP users khớp OpenWebUI team login (hoặc chỉ bot fallback nếu team nhỏ)
- [ ] Whitelist CIDR host OneLog trong OneMCP env
- [ ] Test identity: curl với header username thật → OneMCP xác nhận đúng user

## Success criteria
- Từ `docker compose exec openwebui sh`: `wget -qO- --header='X-Onemcp-User: openwebui-bot' <ONEMCP_URL>/api/mcp -X POST -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` trả JSON có `result.tools[].name` = 8 tools
- OneMCP audit log ghi bot user

## Validation-derived hard gates (V1, V2 — 2026-07-23)
1. **V1 STOP gate — OpenWebUI Action modal**: Test `__event_call__ type:input` trên OpenWebUI 0.10.2 (deploy 1 test Action đơn giản, click, xem modal có hiện + form field editable + return data không). Nếu **KHÔNG support** → **DỪNG Phase 2**, brainstorm lại UX (submit-no-preview hoặc portal redirect) trước khi tiếp.
2. **V2 TLS + CA cert**: Lấy OneMCP CA cert (`/ops/nginx/tls/ca.crt` bên OneMCP host) → commit vào `infra/openwebui/onemcp-ca.crt` (hoặc mount qua secret). Docker-compose openwebui service: `volumes: [".../onemcp-ca.crt:/usr/local/share/ca-certificates/onemcp.crt:ro"]` + entrypoint `update-ca-certificates`. Verify: `openwebui exec curl -v https://192.168.122.56/health` không lỗi cert.

## Risks
- **DNS `.local`** không resolve trong Docker: fix bằng `extra_hosts` với IP tĩnh
- **HTTPS self-signed** — mcpo có thể reject cert. Options: (a) HTTP internal endpoint, (b) mount CA cert vào mcpo, (c) skip TLS verify (chỉ lab)
- **CIDR update** cần restart OneMCP nginx

## Security
- Bot user role = contributor (KHÔNG maintainer/admin) — chỉ submit pending, không auto-publish
- Không commit ONEMCP_URL với IP thật ra public repo nếu nhạy cảm — dùng env

## Next
Phase 2: chọn bridge mechanism dựa trên kết quả compat test.
