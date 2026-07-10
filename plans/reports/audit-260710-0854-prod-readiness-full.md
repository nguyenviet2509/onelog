---
name: OneLog Production Readiness Audit
date: 2026-07-10 08:54 UTC+7
scope: full-repo review (agent, web, indexer, mcp-semantic, infra, docs)
---

# OneLog — Production Readiness Audit

## TL;DR

Repo **~85% prod-ready**. Không có secret leak, không có mock data lẫn vào prod path (mock services có tag rõ ràng, mock flags default = false). Blockers chủ yếu ở tầng **auth** (stub hardcode `sysadmin`) và **config discipline** (fallback URL sang container name, `:latest` image tags).

Bảng ưu tiên xử lý:

| # | Hạng mục | Severity | Loại | Action ngay? |
|---|---|---|---|---|
| B1 | Auth stub hardcode sysadmin, admin routes không có middleware | BLOCKER | Architectural | Cần quyết định (OIDC vs giữ IP-allowlist) |
| B2 | `auto_https off` Caddy — chỉ hợp lệ LAN `app.local` | BLOCKER (nếu prod domain) | Config | Bật lại khi có domain thật |
| B3 | `:latest` tags: victoria-logs, qdrant, vmalert, alertmanager | BLOCKER | Config | Pin version — SAFE cleanup |
| B4 | Env fallback `http://agent:8080`, `http://web:3000` — im lặng khi thiếu env | SHOULD-FIX | Config | Fail-fast — SAFE cleanup |
| B5 | Mock timestamp `2026-06-23T04:00:00Z` stale trong `llm_client.py` | SHOULD-FIX | Dev-artifact | Fix động — SAFE cleanup |
| B6 | Không có top-level `README.md` | SHOULD-FIX | Docs | Tạo — SAFE cleanup |
| B7 | Dockerfile agent thiếu `HEALTHCHECK` | SHOULD-FIX | Ops | Thêm — SAFE cleanup |
| B8 | `sqlite-web` bind `0.0.0.0` (dù có Caddy chặn) | SHOULD-FIX | Config | Chuyển `127.0.0.1` — SAFE cleanup |
| B9 | `HOST: 0.0.0.0` agent/mcpo containers | NICE | Config | Giữ (Docker network) |
| B10 | mock-* service tags trong vmalert rules | SHOULD-FIX | Rules | Bổ sung rule cho service thật khi có |
| B11 | `docs/journals/`, `plans/`, `mockups/` committed | LOW | Repo hygiene | User quyết định (nhiều thứ vẫn dùng runtime) |

---

## 1. Agent service (`agent/`)

**Status:** Production-ready, 1 architectural blocker, 3 cleanups.

### Blocker
- `src/agent/auth_stub.py:12-14` — mọi request set `user_id = "sysadmin"`, không có OIDC. Admin routes không có route guard.

### Should-fix (dev-artifact cleanup)
- `src/agent/routes/alert.py:33` — `WEB_URL` default `http://web:3000` → nên fail-fast nếu env miss.
- `src/agent/llm_client.py:271` — mock citation timestamp cứng `2026-06-23T04:00:00Z`.
- `Dockerfile` — thiếu `HEALTHCHECK` (endpoint `/health` có sẵn).

### Clean
- pyproject.toml sạch. Structured logging (structlog) đúng chuẩn. Không có `print()` debug. Không có secret hardcode.

---

## 2. Web frontend (`web/`)

**Status:** 4 blocker (auth + env), 6 should-fix.

### Blockers
- `src/lib/auth-stub.ts:12-14` + `src/db/bootstrap.ts:62-64` — mọi user render dưới danh nghĩa `sysadmin@local` role admin. `/admin/*`, `/api/admin/*`, `/api/internal/*` **không có auth trong code**, chỉ dựa Caddy IP allowlist ở edge.
- `/api/internal/audit` — POST không auth, tin tưởng Docker network.
- `/trace` iframe VictoriaLogs UI không sandbox — bất cứ ai vào được `/trace` xem log toàn hệ thống.
- Env fallback URL cứng (`http://agent:8080`, `http://victorialogs:9428`, `http://qdrant:6333`) — không fail khi env vắng.

### Should-fix
- `Dockerfile:5` dùng `--legacy-peer-deps` (silence peer conflicts) — audit deps trước prod.
- `package.json` thiếu `engines` (Next.js 14 cần Node 18+).
- Thiếu CSP / X-Frame-Options / HSTS headers (không có `headers()` trong `next.config.mjs`).
- `console.error("chat.persist_failed")` — DB persist fail bị swallow, client không biết.
- `@ts-expect-error` cho `duplex: "half"` không có doc lý do.
- Không có rate-limit ở `/api/chat`.

### Nice-to-have
- Dead code minor (comment-only lines trong `route.ts`).
- `/src/app/page.tsx` chỉ redirect — có thể chuyển sang `redirects()` config.

---

## 3. Indexer (`indexer/`)

**Status:** Production-ready, 2 should-fix, không blocker thật sự.

- `config.py:24` — `openai_api_key=""` default; im lặng chuyển mock vector nếu miss key. Nên fail-fast trừ khi `EMBED_MOCK=true`.
- `Dockerfile` — chạy root với bind `/data/drain_state`. Blast radius lớn hơn cần.
- `nats_consumer.py:56-62` — auto-create stream on connect. OK dev, prod nên pre-provision.

---

## 4. MCP-semantic (`mcp-semantic/`)

**Status:** 3 should-fix (auth/config gaps chấp nhận được ở scale <5 user).

- `config.py:38` — `vmui_base_url` default `http://app.local` cứng. Không validate URL.
- `main.py:285-296` — `mcp_allow_anon=true` chỉ warning, không fail-closed.
- `auth.py:47-52` — token cache `lru_cache(maxsize=1)` không rotate khi runtime; muốn thu hồi cred phải restart container.
- `embed.py` — thiếu retry (khác với indexer's embed_client). 1 transient OpenAI fail = crash tool.
- `audit.py:57` — fallback `print(...)` thay vì structlog (inconsistent).

---

## 5. Infra (`infra/`)

**Status:** Config-level cleanups nhiều, 3 blocker cho public-domain deploy.

### Blockers (chỉ nếu deploy public domain, không phải LAN app.local)
- `docker-compose.yml:10, 31, 152, 186` — `:latest` tags cho victoria-logs, qdrant, vmalert, alertmanager. **Rủi ro silent-break khi redeploy.**
- `caddy/Caddyfile:7` — `auto_https off`. Chỉ đúng cho LAN `app.local`, phải xóa khi có prod domain.
- Hardcode `app.local` + LAN CIDR (Caddyfile:13,114 / compose:139 / .env.example:4,94,111,120) → migrate cần multi-file edit.

### Should-fix
- `docker-compose.yml:521` — `sqlite-web` bind `0.0.0.0:8085` (dù Caddy chặn). Chuyển `127.0.0.1:8085`.
- `vmalert/rules.yml:79,89,109,122` — rule bám vào `mock-sshd`, `mock-mysql`, `mock-nginx`. Khi real service tên khác phải sửa/nhân đôi rules.
- `docker-compose.yml:141, 292, 421` — `HOST: 0.0.0.0` cho agent/mcpo. OK trong Docker network nhưng có thể ràng buộc `127.0.0.1` + Caddy proxy.
- Thiếu healthcheck cho: qdrant, mcp-semantic, mcp-vl, openwebui, indexer.
- Alertmanager reload không idempotent (render `/tmp/alertmanager.yml` lúc start, không bind-mount source).
- Grafana `cookie_secure = false` — đúng cho HTTP LAN, bật khi HTTPS.

### Nice
- Vector pin `0.40.0` (Jan 2025) — check CVE, cân upgrade.
- `.env.example` dày (50 `CHANGE_ME`) — có thể tách profile.

---

## 6. Docs + repo hygiene

### Clean ✓
- `.gitignore` chuẩn (env, venv, __pycache__, node_modules).
- Không có `.env` / `.pem` / `credentials.json` committed.
- `docs/*.md` đầy đủ, deploy guide chi tiết.

### Missing / dev-artifact ở repo root
- **Không có top-level `README.md`** — clone repo không có entry point.
- `docs/journals/` (4 file dev decision logs) — nội bộ, cân nhắc chuyển `plans/reports/` hoặc gitignore.
- `mockups/*.html` — design/documentation artifacts, không cần cho deploy. **Lưu ý:** skill `update-services-detail` update mockups sau mỗi `/ck:cook` — nếu gitignore sẽ mất tracking.
- `plans/` (10 phase dir + reports) — dev planning. Cân nhắc gitignore hoặc chuyển private wiki.

---

## Recommended action plan

### Wave 1 — Safe cleanup (execute ngay, không breaking)
1. Tạo top-level `README.md` link deploy guide.
2. Pin image tags trong `docker-compose.yml` (thay `:latest` bằng version hiện chạy).
3. `docker-compose.yml:521` — bind `sqlite-web` `127.0.0.1:8085`.
4. `llm_client.py:271` — mock timestamp `datetime.now(UTC).isoformat()`.
5. Thêm `HEALTHCHECK` cho agent Dockerfile.
6. Fail-fast trong `web/src/app/api/chat/route.ts` và `web/src/app/api/admin/health/route.ts` khi env miss (throw thay vì fallback string).
7. Fail-fast `indexer/config.py` khi `openai_api_key=""` và `EMBED_MOCK=false`.
8. `web/package.json` thêm `"engines": {"node": ">=18"}`.

### Wave 2 — Cần user quyết định
- **Auth strategy**: (a) triển khai OIDC ngay, (b) giữ IP-allowlist + add rate limit + document, (c) chấp nhận rủi ro internal.
- **Public domain deploy**: nếu có, bật lại `auto_https`, sed thay `app.local`, bật `grafana cookie_secure`.
- **Repo hygiene**: gitignore `plans/`, `mockups/`, `docs/journals/` — hay giữ vì skills đang tracking?

### Wave 3 — Post-deploy hardening
- CSP/HSTS/X-Frame headers cho web.
- Rate-limit `/api/chat`.
- Sandbox iframe `/trace`.
- Sentry/error tracking web.
- Correlation ID propagate BFF → agent.
- Structured logger web (thay `console.error`).
- MCP-semantic embed retry.
- Alertmanager idempotent config reload.
- Healthcheck cho qdrant/mcp/openwebui/indexer.

---

## Unresolved questions

1. Deploy target là LAN `app.local` tiếp tục hay có prod domain? — quyết định Caddy `auto_https` và các hardcode `app.local`.
2. Auth: giữ IP-allowlist tạm hay OIDC production sprint này?
3. `plans/` + `mockups/` + `docs/journals/` — có gitignore không (skill runtime đang dùng mockups)?
4. Có acceptance với việc reset user data khi remove `sysadmin@local` bootstrap seed không?
5. Cost dashboard threshold DeepSeek $5 (đã revert commit 1662580) — giữ prod value hay điều chỉnh theo actual traffic?
