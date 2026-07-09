---
name: onelog-cost-dashboard
title: OneLog LLM Cost Dashboard — 5 ops · 4 providers
slug: onelog-cost-dashboard
date: 2026-07-09
status: implementation-complete-awaiting-deploy
owner: trihd@inet.vn
mode: --auto
uiApproach: grafana
blockedBy: []
blocks: []
relatedPlans:
  - plans/260701-1544-llm-provider-abstraction
  - plans/260624-1417-observability-integration
relatedMockups:
  - mockups/onelog-cost-dashboard.html
---

# Plan · OneLog Cost Dashboard

## Mục tiêu
Cho 1-2 ops lead xem được **realtime "ai xài bao nhiêu" + "còn quota bao nhiêu"** across 4 LLM provider (Anthropic · OpenAI · Gemini · DeepSeek). Alert khi balance thấp hoặc user vượt budget.

## Bối cảnh
- LiteLLM proxy đã emit `json_logs` → Vector → VictoriaLogs. Data cost/token/latency **đã có** từ day-1.
- Chưa có UI xem — phải LogsQL curl thủ công. 5 ops không biết ai đang burn quota.
- Team dùng OpenWebUI (chat) + không có Grafana. Cost dashboard = service mới, tách khỏi chat.
- Domain quyết định: **`admin.webui.local`** (subdomain riêng, strict CIDR, bearer, Grafana login) — không share với `webui.local`.

Xem mockup: [mockups/onelog-cost-dashboard.html](../../mockups/onelog-cost-dashboard.html)

## Approach
**2 nguồn cross-check:**
1. **LiteLLM json_logs** (realtime, đã có) — per-request cost, per-user, per-model
2. **Provider Balance/Cost API** (poll 15 phút) — ground truth cho balance DeepSeek + cost tháng OpenAI/Anthropic. Gemini skip (không có API).

UI: **Grafana OSS** container mới trong compose, mount sau Caddy `admin.webui.local`. Panels dùng LogsQL query VictoriaLogs qua plugin `victoriametrics-logs-datasource`.

## Phases

| # | Phase | Effort | Status | File |
|---|---|---|---|---|
| 01 | Grafana container + Caddy admin subdomain | 0.5 ngày | code-ready | [phase-01-grafana-container-admin-subdomain.md](phase-01-grafana-container-admin-subdomain.md) |
| 02 | LogsQL panels — Phase A quick win | 0.5 ngày | code-ready (dashboard JSON scaffolded, field name verify pending) | [phase-02-logsql-panels-phase-a.md](phase-02-logsql-panels-phase-a.md) |
| 03 | Provider balance poll script | 0.5 ngày | code-ready (admin keys pending) | [phase-03-provider-balance-poll.md](phase-03-provider-balance-poll.md) |
| 04 | Balance panels + vmalert cost rules | 0.5 ngày | code-ready (1 rule disabled — math pipe unverified) | [phase-04-balance-panels-alerts.md](phase-04-balance-panels-alerts.md) |
| 05 | Docs + runbook | 0.25 ngày | code-ready | [phase-05-docs-runbook.md](phase-05-docs-runbook.md) |

**Tổng effort:** ~2.25 ngày.

## Dependencies

- Phase 01 độc lập, phải chạy trước tất cả (foundation).
- Phase 02 depend 01 (cần Grafana lên).
- Phase 03 độc lập với 02 — có thể chạy song song sau 01.
- Phase 04 depend 02 + 03 (cần cả 2 nguồn data).
- Phase 05 depend 04.

Order: `01` → `02 || 03` → `04` → `05`.

## Split Phase A / Phase B (theo mockup)
- **Phase A quick win** = Phase 01 + 02 = ~1 ngày. Ship được ngay, dùng data LiteLLM có sẵn.
- **Phase B full picture** = thêm Phase 03 + 04 = ~1 ngày. Cần admin key OpenAI + Anthropic mới.

Team có thể ship Phase A rồi dừng đó, quyết Phase B sau khi có admin key.

## Success criteria (toàn plan)

- [ ] `http://admin.webui.local/` mở Grafana, cần bearer + login
- [ ] 4 panel core: cost 30d per-model · per-user 7d · fallback events 24h · KPI row
- [ ] 3 panel balance: DeepSeek realtime · OpenAI monthly · Anthropic monthly cache split
- [ ] Alert Telegram khi: DeepSeek < $5 · OpenAI daily > $3 · Anthropic month > 70% cap · per-user daily > $2
- [ ] `docs/cost-dashboard.md` runbook: add panel, rotate admin key, disable Gemini estimate
- [ ] Zero downtime khi enable — không đụng chat flow

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Admin API key OpenAI/Anthropic leak → xem billing tổ chức | chmod 0400 root · lưu trong `infra/litellm/.env.cost` riêng · rotate 90d |
| Cost API delay 15-30 phút → hiển thị stale | Label panel rõ "delay ~15m" · vmalert dựa LiteLLM logs (realtime) không phải provider API |
| Gemini blackout (no API) | Chấp nhận LiteLLM estimate · warning badge trong UI · document rõ trong runbook |
| Grafana bind port conflict | Bind loopback `127.0.0.1:3000` · chỉ qua Caddy |
| LiteLLM pricing table lệch → cost hiển thị sai vài % | Cross-check với provider API (Phase B) → detect drift, log warning |
| Ops accidental click vào admin subdomain | Strict CIDR khác chat CIDR + bearer + login |

## Out of scope

- Custom Next.js/FastAPI UI riêng trong `agent/` (dùng Grafana OSS đủ)
- Auto-kill virtual key khi vượt cap (chỉ alert)
- Multi-day retention beyond 30d cost stream (default VL retention đủ dùng)
- Cost per organization / department (5 ops = flat, không cần hierarchy)
- LiteLLM Enterprise upgrade
- Vertex AI migration để lấy Gemini usage API (overkill)

## Unresolved

1. Admin API key OpenAI/Anthropic: ai tạo, ai giữ, rotate cadence?
2. Grafana OSS free đủ hay muốn OIDC (Keycloak/Google Workspace)?
3. Retention stream cost trong VL: 30d default hay bump 90d cho quarterly review?
4. Alert threshold ($5/$3/$2) có phù hợp không? Chờ ops confirm sau Phase A.

## Deploy verification checklist (post-cook)

Implementation done (code + config), deploy trên logserver + verify:

- [ ] Set `.env` vars: `ADMIN_ALLOW_CIDR`, `ADMIN_STRICT_CIDR`, `COST_DASHBOARD_TOKEN`, `GRAFANA_ADMIN_PASSWORD`
- [ ] `mkdir -p ~/onelog/infra/data/grafana && sudo chown 472:472 ~/onelog/infra/data/grafana`
- [ ] `docker compose --profile dashboard up -d grafana` — verify `Up (healthy)`
- [ ] Add `admin.webui.local` → logserver IP in `/etc/hosts` của máy admin
- [ ] `curl -H "Authorization: Bearer $COST_DASHBOARD_TOKEN" http://admin.webui.local/api/health` → 200
- [ ] **Verify LiteLLM log field name** — fire test call, check VL query: field là `response_cost` hay khác? Nếu khác, sửa dashboard JSON + vmalert rules.
- [ ] **Verify Vector tag** — sau reload, LiteLLM stdout có được tag `service:litellm_cost` không?
- [ ] `curl VL query service:litellm_cost _time:5m` → có records
- [ ] Grafana UI: 9 panel core render (Balance panels sẽ empty đến khi Phase B poll chạy)
- [ ] **Phase B**: create admin key OpenAI + Anthropic, `chmod 0400 .env.cost`, add cron */15
- [ ] Chạy manual `bash poll-provider-cost.sh`, verify 3 record vào VL trong 5s
- [ ] Verify vmalert group `llm_cost` load OK: `curl vmalert:8880/api/v1/alerts | jq '.data.groups[] | select(.name=="llm_cost")'`
- [ ] Smoke test alert: tune threshold thấp giả (VD `COST_ALERT_DEEPSEEK_BALANCE_MIN=100`), wait 60s, Telegram nhận message
- [ ] Reset thresholds về giá trị prod
- [ ] Enable `AnthropicCacheHitLow` nếu vmui test `math` pipe work

## Implementation notes (auto-cook 2026-07-09)

- Cook session `/ck:cook --auto` completed 2026-07-09.
- 3 parallel implementation workers (infra, backend, alerts) + docs worker + code reviewer.
- Code review score **8.5/10** — 2 critical + 5 warnings + 3 nits. All critical fixed post-review:
  - C1/C2: added `environment:` block to caddy service with `${VAR:?}` fail-fast guards
  - W5: replaced `{{ $labels.X }}` with `{{ $value }}` in 6 alert annotations
  - W3: disabled `AnthropicCacheHitLow` rule (math pipe unverified) — enable when vmui test passes
  - W2: dropped `2>&1` on curl in poll script — stderr stays out of jq input
- Full review report: `plans/260709-1143-onelog-cost-dashboard/reports/code-reviewer-260709-1324-cost-dashboard-implementation.md`
