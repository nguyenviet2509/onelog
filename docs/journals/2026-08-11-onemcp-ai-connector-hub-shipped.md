---
date: 2026-08-11
title: OneMCP AI Connector Hub — shipped end-to-end
tags: [onemcp, oauth2.1, mcp, claude-desktop, milestone]
plan: 260805-0852-onemcp-ai-connector-hub
---

# OneMCP AI Connector Hub — shipped

Kết thúc plan `260805-0852-onemcp-ai-connector-hub` sau ~6 ngày dev + 1 ngày rollout. Claude Desktop cắm được vào OneMCP MCP Gateway qua OAuth 2.1 chuẩn spec, live tại `https://oneconnector.000nethost.com`.

## Ship checklist

- ✅ OAuth 2.1 AS: DCR (RFC 7591) + PKCE S256 + authorization code + refresh rotation
- ✅ `.well-known/oauth-authorization-server` + `oauth-protected-resource` metadata (RFC 8414 + 9728)
- ✅ MCP Streamable HTTP transport + Bearer auth (`MCP_AUTH_MODE=required`)
- ✅ Portal `/oauth-consent` — user Allow/Deny AI client sau login Zitadel
- ✅ Multi-project skills registry: project entity + per-project webhook + BullMQ queue + git-sync worker (done 2026-08-10)
- ✅ RBAC 3-layer visibility filter + audit log expand
- ✅ Domain + TLS: `oneconnector.000nethost.com` + Sectigo wildcard
- ✅ Claude Desktop verified — running với 8 tools
- ✅ Docs: onboarding, troubleshoot, admin runbook, Prometheus alerts

## Bugs hit + fix (hôm nay)

### 1. LE HTTP-01 fail — DC block :80 international
Test từ 6 nodes worldwide (VN + US + TR + RU + IR + ES) → 6/6 timeout. Chỉ ISP VN vào được :80. LE Boulder validator không authenticate được. **Fix:** Sectigo wildcard cert `*.000nethost.com` (manual renew Feb 2027, ~180 ngày cycle). Memory `onemcp-connector-domain.md` ghi renewal procedure.

### 2. Nginx `/mcp/*` → 404
Backend NestJS có global prefix `/api` (setGlobalPrefix trong main.ts). Nginx `location /mcp/` proxy_pass thẳng backend → backend nhận `/mcp/rpc` → 404. **Fix:** thêm `rewrite ^/mcp/(.*)$ /api/mcp/$1 break;` trong nginx (commit `fcb3733`). Sau đó phát hiện `set $var` phải TRƯỚC `rewrite` vì `break` reset variable context → commit `8e3699a`.

### 3. DCR race — 2 mcp-remote processes tạo 2 client_id
Claude Desktop spawn `mcp-remote` 2 lần khi init. Cả 2 process gọi `POST /api/oauth/register` trong ~17ms, backend tạo 2 client khác nhau. Process A authorize với client A → consent lưu code kèm client A. Process B tokens.json overwrite → khi callback về, mcp-remote token exchange với client B → `client_id mismatch` → 401.

**Fix (commit `635a166`)**: dedup DCR trong 60s cho public clients (auth=none) — nếu `client_name + sorted redirect_uris` match existing < 60s → return existing `client_id`. Verified: 2 curl `/register` liên tiếp cùng payload trả về SAME client_id.

### 4. Windows TIME_WAIT khiến mcp-remote EADDRINUSE
Fixed callback port `33418` trong Claude Desktop config → mỗi retry trong ~2 min (Windows default TcpTimedWaitDelay) sẽ fail listen. **Fix:** bỏ fixed port, để mcp-remote pick random. Nhưng random cũng có thể trúng port TIME_WAIT — solution cuối cùng là giữ nguyên `tokens.json` để mcp-remote skip OAuth flow trên retry (không cần callback server).

### 5. Cert CRLF (Windows)
`fullchain.pem` scp từ Windows → nginx `PEM_read_bio_X509_AUX() failed: bad end line`. Concat `cat leaf + rootca` sinh dòng `-----END CERTIFICATE----------BEGIN CERTIFICATE-----` (dính liền, thiếu newline). **Fix:** rebuild qua Python regex, đảm bảo `\n` giữa 2 certs, ghi file mode `newline='\n'`, `sed -i 's/\r$//'` post-scp trên VPS.

### 6. Docker bind mount inode
`git reset --hard` trên VPS thay file `onemcp.conf` (new inode) → nginx container vẫn thấy OLD content (bind mount giữ deleted inode). **Fix:** `docker compose up -d --force-recreate nginx` sau mọi conf change (không dùng `restart` hoặc `reload`).

## Timeline

| Time (ICT) | Milestone |
|---|---|
| 09:34 | User cấp domain `oneconnector.000nethost.com` |
| 09:52 | DNS + Zitadel redirect URI configured (manual) |
| 10:00 | LE HTTP-01 test fail (DC block :80) |
| 10:41 | User cấp Sectigo wildcard cert |
| 10:47 | Cert deploy + HTTPS live |
| 10:52 | `MCP_AUTH_MODE=optional` → nginx `/mcp/*` rewrite |
| 10:56 | Portal `/oauth-consent` deployed |
| 11:02 | Claude Desktop config wired |
| 11:14 | First test — token exchange fail |
| 11:24 | DCR dedup fix deployed |
| 11:31 | TIME_WAIT diagnosis + random port config |
| ~12:30 | User confirmed `running` ✅ |
| 13:07 | Docs + rollup, plan status=completed |

## Commits (OneMCP repo, master branch)

- `d067826` feat: wire domain + LE certbot flow
- `a8dc0f9` feat: Sectigo wildcard cert path
- `3777daf` feat: portal `/oauth-consent` screen
- `fcb3733` fix: nginx `/mcp/*` → `/api/mcp/*` rewrite
- `8e3699a` fix: set upstream var before rewrite
- `050e6ab` chore: debug logs
- `635a166` **fix: DCR dedup 60s for public clients** ⭐
- `daf887a` chore: PKCE debug branch
- `834957a` chore: remove debug logs — verified working

## What's left (non-blocker)

- **Cert auto-renewal**: hiện manual mỗi ~6 tháng. Nếu chuyển provider có LE support → auto. Alternative: DC unlock :80 international → LE HTTP-01 work.
- **Refresh token rotation verify với mcp-remote SDK**: chưa test refresh sau 1h expire. Backend đã impl rotation (RFC 6749 §6), cần smoke.
- **Batch smoke test** Claude Desktop → gọi cả 8 tools qua chat prompt để verify từng cái.
- **Prometheus scrape config**: alerts YAML đã có (`ops/monitoring/alerts-ai-connector.yaml`) nhưng chưa wire vào Prometheus scrape config trên VPS. Deferred đến khi có Prometheus stack chính thức.
- **Cursor + ChatGPT MCP Connector test** (Q1 phase-05 rollout-pilot): chưa test client khác ngoài Claude Desktop.

## Learnings

1. **Docker bind mount + git reset** = classic inode gotcha. Luôn `--force-recreate` sau conf changes qua git.
2. **PKCE flow debug** trên OAuth 2.1 requires structured logging của tất cả branch (code lookup, client match, redirect_uri match, PKCE verify). Đã có, tạm để log warn cho PKCE FAIL để dễ trace future.
3. **DCR race** là bug phổ biến của MCP client SDKs — Claude Desktop, Cursor có thể có same behavior. Backend nên dedup as defensive measure (không tin client behavior).
4. **Free hosting DNS** (`000nethost.com`) không có API → không LE DNS-01. Nếu cần LE thật cho AI connector, cần domain có DNS API (Cloudflare, Route53, ...).
5. **Vietnam DC firewall :80 international** — recurring pattern (đã hit ở kb.inet.vn với 宝塔 WAF). Cần verify inbound :80 policy TRƯỚC khi commit LE workflow.
