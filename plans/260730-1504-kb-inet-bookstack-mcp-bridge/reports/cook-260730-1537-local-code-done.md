# Cook Report — Local code changes done, handoff for deploy

Date: 2026-07-30 15:37
Mode: interactive (autonomous per user rule)

## Scout finding (invalidates prior validation)

Comment ở `infra/docker-compose.yml:519-520`:
> "OpenWebUI doesn't read mcp-config.json natively"

→ File `infra/openwebui/mcp-config.json` là **legacy/unused**. Wiring thật:
```
OpenWebUI (OpenAPI) → mcpo (proxy MCP→OpenAPI) → bookstack-mcp → kb.inet.vn
```
Plan phase-04 đã update lại.

## Files modified (local, ready to commit)

| File | Change |
|---|---|
| `infra/docker-compose.yml` | + service `bookstack-mcp` (profile chat), + mcpo depends_on, + healthcheck list `bookstack` |
| `infra/mcpo/config.template.json` | + upstream `bookstack` → `http://bookstack-mcp:8080/mcp` |
| `infra/.env.example` | + `KB_INET_BASE_URL`, `KB_INET_TOKEN_ID`, `KB_INET_TOKEN_SECRET` |
| `docs/openwebui-kb-routing.md` | NEW — wiring diagram + system prompt backup + team onboarding 1-pager |

## Files ready in plan

| File | Status |
|---|---|
| `plans/.../plan.md` | updated with validation notes + non-goals |
| `phase-01-bookstack-prep.md` | audit KB size steps, ACL simplified |
| `phase-02-deploy-container.md` | updated deploy commands (correct compose location + mcpo re-discover) |
| `phase-03-caddy-route.md` | deferred (docker internal đủ) |
| `phase-04-openwebui-routing.md` | mcpo wiring, prompt scope thu hẹp |
| `phase-05-verify-observability.md` | diacritic test + whitelist test |
| `reports/validate-260730-1513-plan-review.md` | validation findings |

## Handoff — cần user thao tác

### 1. Phase 1 (BookStack admin, không code)
- Login kb.inet.vn admin
- Tạo bot user `onemcp-bot@inet.vn` role Viewer
- Tạo API token, copy ID + Secret
- Run 3 curl audit (script trong phase-01 step 6)
- Note kết quả vào `plans/.../notes/kb-audit.md`

### 2. Commit local + push VPS
- Review diff: `git diff infra/docker-compose.yml infra/mcpo/config.template.json infra/.env.example`
- Commit → push origin/master
- SSH onelog-vps → `cd /opt/onelog && git pull`
- Edit `/opt/onelog/infra/.env` set `KB_INET_TOKEN_*` (KHÔNG commit .env)

### 3. Phase 2 deploy
```bash
cd /opt/onelog/infra
docker compose --profile chat up -d bookstack-mcp
# wait healthy
docker compose --profile chat up -d --force-recreate mcpo
docker compose logs -f bookstack-mcp mcpo
curl -sS -H "Authorization: Bearer $MCPO_API_KEY" \
  http://127.0.0.1:8091/bookstack/openapi.json | jq '.paths | keys | length'
# expect >= 15
```

### 4. Phase 4 (OpenWebUI UI)
- OpenWebUI Admin → Settings → Tools → Add Connection:
  - URL: `http://mcpo:8080/bookstack`
  - Auth: Bearer `$MCPO_API_KEY`
  - Name: `bookstack`
- Workspace → Models → chọn model team engineering → paste System Prompt từ `docs/openwebui-kb-routing.md`

### 5. Phase 5 smoke test
Chạy 7 query trong `phase-05-verify-observability.md` §5.1.
Note kết quả vào `plans/.../notes/smoke-test-day0.md`.

## Risks phát sinh trong cook

1. **[FIXED 15:52]** mcpo healthcheck ban đầu include bookstack → nếu KB.inet down / token expire thì mcpo kill-loop kéo cả log tools chết. **Xử lý**: revert healthcheck về chỉ `('onelog-vl','onelog-semantic')` essential, add comment giải thích intent. bookstack fail = degraded (mất KB search), không broken.

2. **mcpo discovers tools ONCE at startup**: sau khi add bookstack upstream phải `--force-recreate mcpo`, không chỉ restart.

3. **`profile: chat` filter**: bookstack-mcp chỉ start khi `--profile chat`. Nếu VPS đang chạy stack thiếu profile này → bookstack-mcp không lên. Verify `docker compose ps` sau deploy.

## Success criteria phase code (đã đạt)

- [x] docker-compose service definition passes yaml parse
- [x] mcpo config.template.json valid JSON
- [x] .env.example có placeholder rõ ràng, comment giải thích
- [x] docs/openwebui-kb-routing.md có prompt đầy đủ + onboard section
- [x] Plan phase files updated with correct wiring

## Unresolved

- Cần user confirm profile `chat` vẫn active trên VPS trước khi deploy.
- Cần user verify `MCPO_API_KEY` chưa expire, còn dùng được cho registration mới.
- Nếu Phase 1 audit KB có >5000 pages hoặc no diacritic-fold, cần điều chỉnh system prompt trước khi apply cho model.
