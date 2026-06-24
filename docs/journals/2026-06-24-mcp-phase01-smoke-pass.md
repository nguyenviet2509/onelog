---
date: 2026-06-24
title: Phase 01 MCP production-ready — smoke pass on logserver
tags: [mcp, phase-01, smoke-test, fastmcp, caddy, audit]
---

# 2026-06-24 — Phase 01 MCP production-ready: smoke 6/6 pass

## Tóm tắt
Phase 01 (plan `260623-2041-mcp-only-rollout`) code complete + smoke 6/6 pass trên logserver-01. Branch `feat/mcp-phase01` (HEAD `9a327ac`) sẵn sàng merge master.

## Smoke result
```
✓ Test 1: GET /healthz direct → 200 (Caddy gates /healthz too — fallback)
✓ Test 2: GET /mcp/semantic/sse no Bearer → 401 (fail-closed)
✓ Test 3: GET /mcp/semantic/sse bad Bearer → 401
✓ Test 4: GET /mcp/semantic/mcp valid Bearer → 400 (endpoint reachable past auth)
✓ Test 5: GET /mcp/vl/sse valid Bearer → 200
✓ Test 6: audit log non-empty với auth.deny/auth.allow + auth_hint + user attribution
```

Audit log sample:
```
{"event":"auth.deny","user":"unknown","path":"/sse","auth_hint":"-"}
{"event":"auth.deny","user":"unknown","path":"/sse","auth_hint":"76e89819"}
{"event":"auth.allow","user":"smoke","path":"/mcp"}
{"event":"auth.allow","user":"smoke","path":"/sse"}
```

## Iterations debug (4 vòng commit)
1. **`fdfa4bb`** initial code (Bearer table, audit, vmui, Caddy forward_auth, mcp-vl ghcr image)
2. **`b574636`** explicit Starlette Mount cho /healthz + /auth/verify (vì decorator FastMCP custom_route ban đầu 404)
3. **`41789c6`** FastMCP 3.x dropped `sse_app()` → switch sang `mcp.http_app()` Streamable HTTP transport
4. **`5c650f4`** mcp-vl env name fix `MCP_TRANSPORT` → `MCP_SERVER_MODE` (image v1.9.0 không nhận tên cũ → stdio crashloop)
5. **`9a327ac`** smoke Test 5 hang vì SSE long-lived → `--max-time 3` tolerate curl exit 28

## Pitfalls để tránh sau này
- **FastMCP 3.x bỏ SSE**: dùng `http_app()` + Streamable HTTP. Claude Desktop config endpoint `/mcp` thay vì `/sse`
- **Docker compose env propagation**: `docker compose up -d` KHÔNG auto-restart container khi `.env` thay đổi — phải `restart` hoặc `--force-recreate`
- **Caddyfile reload**: file mount `:ro` đổi nội dung không trigger reload Caddy → `docker compose restart caddy`
- **mcp-victorialogs v1.9.0**: env `MCP_SERVER_MODE` (stdio|sse|http), `MCP_LISTEN_ADDR=":8000"`. README chính thức là nguồn duy nhất đúng — đừng đoán

## Acceptance criteria pass
- ✅ Caddy forward_auth gate `/mcp/vl/*` + `/mcp/semantic/*` qua mcp-semantic `/auth/verify`
- ✅ Fail-closed: empty MCP_BEARER_TOKENS + no MCP_ALLOW_ANON = deny tất cả
- ✅ Bearer multi-token lookup constant-time (hmac.compare_digest)
- ✅ Audit log JSON Lines persistent qua volume `./data/audit:/var/log/onelog-audit`
- ✅ VMUI URL field trong tool response (verified code; chưa chạy semantic search end-to-end vì Qdrant collection trống)
- ✅ mcp-vl v1.9.0 expose /sse + /message, Caddy proxy work
- ✅ X-Mcp-User header propagate từ /auth/verify → upstream service

## Non-blocking follow-ups (cho commit polish riêng)
- `/healthz` public route (k8s/lb probe needs no Bearer)
- Test với real Qdrant collection (currently empty cho mock smoke)
- Streamable HTTP cho mcp-vl khi upstream support (giảm SSE buffering quirks)

## Next
- Merge `feat/mcp-phase01` → `master` (user approval pending)
- Restore `.env` trên logserver từ `.env.smoke.bak`
- Phase 02 onboard ops + deprecate web — blocked bởi subscription type verify
