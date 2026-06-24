# Phase 01 — MCP production-ready

## Context
- Plan: [plan.md](plan.md)
- Decision report: [brainstorm-260623-1644-ops-mcp-only-decision](../reports/brainstorm-260623-1644-ops-mcp-only-decision.md)
- Existing MVP: phase-08-mcp-server.md trong plan `260622-1056-rag-logserver-victorialogs`

## Overview
- Priority: P0
- Status: pending
- Effort: ~2.0 ngày-người
- Mục tiêu: 2 MCP server (mcp-vl official + mcp-semantic custom) chạy stable, có auth Bearer, audit log, URL VMUI clickable trong tool response. Chưa onboard user — phase này là server-side ready.

## Key insights
- mcp-vl official: image `victoriametrics/mcp-victorialogs:latest` không có trên Docker Hub theo note compose → build từ source GitHub Go repo, pin version vX.Y.Z
- mcp-semantic đã scaffold xong (mcp-semantic/src/...), chỉ cần bỏ profile `mcp` opt-in
- Auth Bearer: hardcode 5 token `.env` đủ cho 5 user, **skip Postgres api_tokens table** (overkill, theo YAGNI)
- Audit log: append-only file `/var/log/onelog-audit/mcp-{vl,semantic}.log` JSON Lines, không cần DB

## Architecture
```
Caddy (TLS + IP whitelist VPN/office)
  ├── /mcp/vl/*       → mcp-vl:8000      (Bearer verify, audit)
  └── /mcp/semantic/* → mcp-semantic:9000 (Bearer verify, audit)
        │                       │
        ▼                       ▼
   VictoriaLogs             Qdrant + embedder
```

## Related files
**Modify:**
- `infra/docker-compose.yml` — uncomment `mcp-vl`, đổi image path build, mcp-semantic bỏ `profiles: [mcp]`
- `infra/caddy/Caddyfile` — verify route `/mcp/vl/*` + IP whitelist
- `mcp-semantic/src/mcp_semantic/main.py` — enforce Bearer khi `MCP_BEARER` set, audit log writer
- `mcp-semantic/src/mcp_semantic/main.py` — tool response: thêm field `vmui_url` format sẵn
- `infra/.env.example` — thêm `MCP_BEARER_TOKENS=user1:sk-xxx,user2:sk-yyy,...`

**Create:**
- `infra/mcp-vl/Dockerfile` (nếu cần build từ source) hoặc compose `build: context: ../mcp-victorialogs`
- `mcp-semantic/src/mcp_semantic/audit.py` — JSON Lines writer
- `mcp-semantic/src/mcp_semantic/auth.py` — Bearer verify từ env multi-token map
- `infra/scripts/rotate-mcp-tokens.sh` — gen token + restart container

## Implementation steps

### Step 1 — Fix mcp-vl image (0.5d)
1. Clone `https://github.com/VictoriaMetrics/mcp-victorialogs` vào folder ngang hàng (vd `../mcp-victorialogs/`) hoặc dùng `ghcr.io/victoriametrics/mcp-victorialogs:vX.Y.Z` nếu có
2. Test build: `docker build -t mcp-vl-local ./mcp-victorialogs`
3. Verify chạy: `docker run -e VL_INSTANCE_ENTRYPOINT=http://victorialogs:9428 -p 8001:8000 mcp-vl-local`
4. Smoke `curl -N http://127.0.0.1:8001/sse`
5. Update `infra/docker-compose.yml` uncomment block mcp-vl, set `build: ../mcp-victorialogs` hoặc `image: ghcr.io/...:vX.Y.Z` pin version

### Step 2 — Bỏ profile mcp opt-in (0.1d)
1. Trong `infra/docker-compose.yml`, xóa `profiles: [mcp]` ở service `mcp-semantic` và `mcp-vl`
2. Verify `docker compose up -d` start cả 2 không cần `--profile mcp`

### Step 3 — Bearer multi-token (0.5d)
1. Tạo `mcp-semantic/src/mcp_semantic/auth.py`:
   - Parse `MCP_BEARER_TOKENS` env format `user1:sk-aaa,user2:sk-bbb`
   - Hàm `verify(authorization_header) -> user_id | None`
2. Wire vào FastMCP middleware/dependency (FastMCP hỗ trợ auth handler)
3. mcp-vl official: dùng `MCP_PASSTHROUGH_HEADERS=Authorization`, Caddy preserve Bearer; verify ở **Caddy layer** bằng `forward_auth` về 1 endpoint mcp-semantic `/auth/verify` (hoặc thêm Caddy basic_auth simple)
4. Update `infra/.env.example` + tạo `infra/scripts/gen-mcp-tokens.sh` sinh 5 token random

### Step 4 — Audit log (0.5d)
1. Tạo `mcp-semantic/src/mcp_semantic/audit.py`:
   - `write(user, tool, query, result_size, status, error?)`
   - Output: JSON Lines `/var/log/onelog-audit/mcp-semantic.log`
   - Volume mount trong compose: `./data/audit:/var/log/onelog-audit`
2. mcp-vl official: dùng access log Caddy `/mcp/vl/*` → `data/audit/mcp-vl-access.log`
3. Test: gọi tool, verify entry xuất hiện trong file

### Step 5 — VMUI URL formatter (0.3d)
1. Trong `mcp-semantic/src/mcp_semantic/main.py` `search_log_templates`:
   - Mỗi hit thêm field `vmui_url` = `https://app.local/select/vmui/?g0.expr={LogsQL}&g0.range_input=...`
   - LogsQL build từ `service:"X" AND host:"Y" AND _time:[t1, t2]`
2. mcp-vl official: native trả raw, không cần format thêm — Claude tự build URL từ field timestamp/service

### Step 6 — Caddy hardening (0.3d)
1. Verify `infra/caddy/Caddyfile` route `/mcp/vl/*` + `/mcp/semantic/*` có IP whitelist:
   ```caddy
   @ops_ips remote_ip 10.0.0.0/8 192.168.0.0/16 <office_cidr>
   handle_path /mcp/* {
     @ops_ips reverse_proxy ...
     respond 403
   }
   ```
2. TLS cert: tự ký nội bộ hoặc Let's Encrypt nếu domain public (probably internal DNS)

## Todo
- [x] mcp-vl image pinned `ghcr.io/victoriametrics/mcp-victorialogs:v1.9.0`
- [x] Bỏ profile mcp opt-in, default up
- [x] auth.py multi-token Bearer + lru_cache + constant-time hmac compare + fail-closed default
- [x] audit.py JSON Lines writer + thread-safe singleton + volume mount `./data/audit:/var/log/onelog-audit`
- [x] vmui_url field trong tool response + `vmui.py` builder (LogsQL escape)
- [x] Caddy `forward_auth` cho cả `/mcp/vl/*` và `/mcp/semantic/*` → `mcp-semantic:9000/auth/verify` (copy_headers X-Mcp-User)
- [x] `.env.example` cập nhật + `infra/scripts/gen-mcp-tokens.sh` (openssl/urandom fallback)
- [x] Code review pass — fixes H1 (MCP_ALLOW_ANON explicit), H2 (lru_cache), M2 (singleton lock), M1 (token fingerprint in deny audit), L7 (drop dead ContextVar)
- [x] **End-to-end smoke trên Linux deploy box** — 6/6 test pass (2026-06-24, branch `feat/mcp-phase01` commit `9a327ac`). Audit log capture auth.deny/auth.allow với user attribution + auth_hint fingerprint, path, method.

## Smoke iterations (debug history)
1. `mcp.sse_app()` AttributeError — FastMCP 3.x dropped SSE → migrated to `mcp.http_app()` + Streamable HTTP (commit `41789c6`)
2. `MCP_TRANSPORT=sse` không hiệu lực với mcp-vl v1.9.0 → đúng tên env là `MCP_SERVER_MODE=sse` (commit `5c650f4`)
3. Caddyfile mới mount nhưng Caddy không reload tự động → cần `docker compose restart caddy` (no code change)
4. curl Test 5 hang vì SSE long-lived → thêm `--max-time 3` tolerate exit 28 (commit `9a327ac`)

## Known follow-ups (non-blocking)
- `/healthz` hiện cũng bị forward_auth gate → smoke fallback dùng direct port. Production muốn k8s/lb probe hit `/healthz` không Bearer → expose 1 dedicated Caddy handle cho `/mcp/semantic/healthz` trước block forward_auth. Phase polish, tách commit riêng.
- Test 4 trả 400 thay vì 200 vì GET trên Streamable HTTP — chấp nhận vì xác nhận endpoint reachable past auth. Real MCP traffic dùng POST JSON-RPC sẽ 200.
- Docker compose env propagation: `docker compose up -d` không auto-restart container khi `.env` đổi (chỉ khi compose file thay đổi). Smoke đã workaround bằng up trước restart sau. Production rotate token = `docker compose restart mcp-semantic`.
- Caddyfile reload: same rule — phải `docker compose restart caddy` sau khi đổi file dù `:ro` mount.

## Success criteria
- `docker compose up -d` (không profile) start cả mcp-vl + mcp-semantic
- `curl -H "Authorization: Bearer sk-xxx" https://app.local/mcp/semantic/sse` → SSE event stream
- Gọi `search_log_templates` → response có `vmui_url` clickable
- Audit file có entry với user_id từ token
- Request thiếu Bearer / IP ngoài whitelist → 401/403

## Risks
- mcp-vl Go build cần Go toolchain → cân nhắc multi-stage Dockerfile để CI/CD đơn giản
- FastMCP auth hook API có thể đổi giữa version → pin `fastmcp==X.Y.Z` trong `pyproject.toml`
- Caddy `forward_auth` thêm latency mỗi request → measure, nếu >100ms switch sang in-process verify

## Security notes
- Token `.env` không commit → `.env` đã trong `.gitignore` (verify)
- Audit log immutable: append-only mode, weekly rotate, không xóa <90 ngày
- VictoriaLogs đọc-only qua mcp-vl (`MCP_DISABLED_TOOLS` chặn write tool nếu có)

## Next
→ Phase 02 onboard user khi server-side ready
