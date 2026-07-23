# Phase 4 — Metrics + Grafana + seed data + stale cron + docs

## Context
Phases 1-3 xong = functional. Phase này = observability + adoption + longevity.

## Priority
Medium — không blocking release, nhưng thiếu thì không chứng minh được ROI + KB sẽ decay.

## Requirements

### Functional
- Prometheus metrics endpoint `/metrics` trên mcp-kb port 9001:
  - `mcp_kb_search_total{result="hit_verified"|"hit_draft"|"miss"}` counter
  - `mcp_kb_save_total{dedup="created"|"merged"}` counter
  - `mcp_kb_verify_total` counter
  - `mcp_kb_stale_total{source="manual"|"auto_cron"}` counter
  - `mcp_kb_search_duration_seconds` histogram
  - `mcp_kb_entries_total{status="verified"|"draft"|"stale"}` gauge (refresh every 60s)
- VictoriaMetrics scrape target thêm mcp-kb:9001/metrics
- Grafana panel mới trong dashboard hiện có (hoặc dashboard riêng `kb-adoption.json`):
  - Hit rate (%) 7d rolling
  - Entries count by status
  - Top verified entries by hit_count (table)
  - Estimated tokens saved: `sum(rate(mcp_kb_search_total{result=~"hit_.*"}[1d])) * AVG_TOKENS_PER_MISS_QUERY` (constant ~2000, adjust từ LiteLLM history)
- Stale cron: script `mcp-kb/scripts/stale-sweep.py` chạy hàng ngày qua host cron (hoặc `docker exec` schedule):
  - Mark stale: verified entries với `last_hit_at < now - 90d` AND `hit_count == 0`
  - Warn: entries có log signature tái xuất hiện trong VictoriaLogs > 3 lần sau `resolved_at` (query mcp-vl API)
- Seed 5-10 entries thủ công từ postmortem/journal cũ

### Non-functional
- Metrics scrape < 100ms
- Stale cron chạy < 30s cho tới 1000 entries

## Files to modify
- `mcp-kb/src/mcp_kb/main.py` — thêm `/metrics` endpoint (prometheus_client)
- `mcp-kb/pyproject.toml` — thêm `prometheus-client>=0.20`
- `infra/victoriametrics/scrape.yml` — thêm target `mcp-kb:9001`
- `infra/grafana/dashboards/` — thêm `kb-adoption.json`
- `docs/mcp-setup-guide.md` — thêm section mcp-kb
- `docs/ops-cheatsheet.md` — thêm `/kb` UI link + `/verify` workflow
- `docs/deployment-guide.md` — thêm mcp-kb service vào bảng service, env vars mới
- `README.md` — cập nhật service table

## Files to create
- `mcp-kb/scripts/stale-sweep.py` — Python script gọi Qdrant + mcp-vl API
- `mcp-kb/scripts/seed-entries.py` — nhập từ file YAML `seed/incidents.yaml`
- `mcp-kb/seed/incidents.yaml` — 5-10 entries thật (rút từ journal `plans/reports/journal-*` hoặc chat log cũ)
- `docs/kb-user-guide.md` — team-facing: how to save, verify, when to trust
- `infra/grafana/dashboards/kb-adoption.json`
- (host) crontab entry: `0 3 * * * docker exec ragstack-mcp-kb python /app/scripts/stale-sweep.py`

## Implementation steps
1. Thêm `prometheus_client` + `@mcp.custom_route("/metrics")` return `generate_latest()`. Wire counters/histograms trong Phase 2/3 tools.
2. Gauge `mcp_kb_entries_total`: background task `asyncio.create_task` chạy mỗi 60s → count qua Qdrant `count(filter)`
3. VM scrape config: 1 job entry, interval 30s
4. Grafana dashboard: 4 panels (hit rate, entries by status, top verified table, tokens saved). Export JSON, commit.
5. `stale-sweep.py`:
   - Qdrant scroll verified + last_hit_at
   - Tính stale candidates → `update_payload(stale=true, stale_reason="no_hits_90d", source="auto_cron")`
   - Log kết quả ra stdout (docker logs pickup)
6. `seed-entries.py`:
   - Đọc YAML `[{question, resolution, fix_commands, verify_logsql, tags, resolved_by}]`
   - Gọi `save_resolution_draft` + `verify_resolution` cho mỗi entry
   - Idempotent (signature dedup lo)
7. Thu thập seed: nhặt 5-10 case từ history team (nhờ user chỉ nguồn — có thể là chat logs cũ, journal entries, hoặc user tự nhập)
8. Docs update:
   - README service table thêm row `mcp-kb`
   - deployment-guide: env vars mới (SUMMARIZER_MODEL, KB_CURATOR_TOKEN, MCP_KB_LITELLM_KEY)
   - mcp-setup-guide: OpenAPI endpoint URL cho mcpo
   - kb-user-guide (new): screenshot flow verify, khi nào trust draft vs verified
   - ops-cheatsheet: 3-4 line quick reference
9. Cron entry vào deployment runbook

## Todo
- [ ] /metrics endpoint + counters wired
- [ ] Entries gauge background task
- [ ] VM scrape config
- [ ] Grafana dashboard JSON
- [ ] stale-sweep.py + host cron
- [ ] seed-entries.py + incidents.yaml (5-10 entries)
- [ ] Run seed → verify UI show verified entries
- [ ] Docs: README + deployment + mcp-setup + kb-user-guide + ops-cheatsheet
- [ ] Update `mockups/onelog-services-detail.html` + `mockups/onelog-system-explainer.html` per update-services-detail rule

## Success criteria
- `curl http://mcp-kb:9001/metrics` → prometheus format với 5 metric families
- Grafana panel hiển thị đầy đủ, sau 1 tuần sử dụng có data
- Stale cron chạy 1 lần dry-run → log liệt kê candidates chính xác
- 5-10 seed entries live, verified, tìm được qua chat
- Docs merged: docs/kb-user-guide.md exist, README service table updated

## Risks
- **Tokens saved estimate lệch**: constant AVG_TOKENS_PER_MISS_QUERY chỉ gần đúng. Mitigate — log actual token usage của mỗi câu miss trong 1 tuần đầu → refine constant → hoặc bỏ metric này nếu lệch quá.
- **Stale cron mark oan entries chưa dùng nhưng còn đúng**: mitigate — warn 30d trước, chỉ stale sau 90d + 0 hit
- **Seed data chứa info cũ đã sai**: mitigate — verify với team trước khi commit YAML

## Security
- Metrics endpoint mở nội mạng (như mcp-semantic hiện tại), không lộ payload
- Seed YAML kiểm tra secret trước commit (gitleaks hoặc `git-secrets`)

## Next
- Sau 4 tuần: đo `kb_hit_rate` + token saved → quyết định tiếp:
  - Nếu ROI rõ: build sidebar auto-suggest realtime trong OpenWebUI
  - Nếu adoption thấp: điều tra prompt vs tool_choice enforcement
- Có thể merge với plan `260723-0924-log-rule-contract-anti-flap` (rules xử lý lỗi lặp)
