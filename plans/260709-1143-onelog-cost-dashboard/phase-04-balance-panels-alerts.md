# Phase 04 · Balance panels + vmalert cost rules

## Context
- Plan: [../plan.md](../plan.md)
- Mockup: [../../mockups/onelog-cost-dashboard.html](../../mockups/onelog-cost-dashboard.html) (sections "Provider balance cards" + "Alert thresholds")
- Prereq: Phase 02 (LogsQL panels + dashboard file exists) + Phase 03 (provider_cost stream đang flow vào VL)

## Overview
- Priority: MED · deliver "Phase B full picture"
- Deliverable: (1) 4 panel balance/quota trong dashboard "OneLog · LLM Cost", (2) 5-6 vmalert rule fire Telegram khi vượt threshold.

## Key insights
- Balance card = query `last()` từ provider_cost stream — không aggregate
- Gemini không có provider_cost → panel hiển thị placeholder "Estimate from LiteLLM" · dùng cost tính từ LiteLLM logs như Phase 02
- vmalert đã hoạt động cho `alerts` profile → reuse Alertmanager + Telegram route
- Alert threshold = biến `.env` để dễ tune sau khi ops có feel

## Requirements

### Functional
- Panel "DeepSeek balance" — realtime, big number USD + progress bar, ước lượng ngày hết
- Panel "OpenAI monthly" — cost tháng vs cap · progress
- Panel "Anthropic monthly" — cost + token in/out + cache split
- Panel "Gemini estimate" — LiteLLM sum + warning badge
- vmalert: 5 rule (DeepSeek balance low · OpenAI daily cap · Anthropic monthly · fallback rate · per-user daily)

### Non-functional
- Alert cool-down 30 phút (không spam)
- Threshold configurable qua `.env` (dễ tune)
- Panel fail-soft khi provider_cost stream trống 30 phút (thay vì show 0) → hiển thị "stale"

## Related files

### Modify
- `infra/grafana/dashboards/llm-cost-overview.json` — thêm 4 panel balance
- `infra/vmalert/rules.yml` — thêm group `llm_cost` với 5 rule
- `infra/alertmanager/alertmanager.yml` — route (dùng route sẵn có nếu match label `team=llm-cost`)
- `infra/.env.example` — thêm 5 threshold var

### Reference
- `infra/vmalert/rules.yml` (rule sẵn có) — copy pattern group/expr
- `infra/alertmanager/alertmanager.yml` (route + template hiện tại)

## Implementation steps

1. **Grafana panels** — mở dashboard "OneLog · LLM Cost" trong Phase 02, add 4 panel:

   **DeepSeek balance card:**
   ```logsql
   service:provider_cost provider:deepseek _time:1h
     | fields _time, balance_usd, granted, topped_up
     | sort by (_time) desc
     | limit 1
   ```
   Visualization: Stat · unit USD · thresholds green >10 / yellow 5-10 / red <5

   **OpenAI monthly card:**
   ```logsql
   service:provider_cost provider:openai _time:1h
     | fields _time, cost_usd_day
     | sort by (_time) desc
     | limit 1
   ```
   Custom: aggregate 30 điểm cuối = monthly (hoặc dùng OpenAI monthly endpoint).

   **Anthropic monthly + cache:**
   ```logsql
   service:provider_cost provider:anthropic _time:30d
     | stats sum(cost_usd_day) as month,
             sum(tokens_in)    as tin,
             sum(tokens_out)   as tout,
             sum(cache_read)   as cache
   ```

   **Gemini estimate (fallback từ LiteLLM):**
   ```logsql
   service:litellm_cost _time:30d model:gemini*
     | stats sum(response_cost) as estimate
   ```
   Panel description: "⚠ Estimate — no Gemini usage API"

2. **Export dashboard JSON** — cập nhật `infra/grafana/dashboards/llm-cost-overview.json`.

3. **vmalert rules** — append vào `infra/vmalert/rules.yml`:
   ```yaml
   groups:
     - name: llm_cost
       type: vlogs
       interval: 60s
       rules:
         - alert: DeepSeekBalanceLow
           expr: |
             service:provider_cost provider:deepseek _time:30m
               | stats last(balance_usd) as b
               | filter b < 5
           for: 0m
           labels: { severity: warning, team: llm-cost }
           annotations:
             summary: "DeepSeek balance còn {{ $labels.b }} USD"
             description: "Balance < $5. Top up trước khi hết."

         - alert: OpenAIDailyCostHigh
           expr: |
             service:provider_cost provider:openai _time:1h
               | stats last(cost_usd_day) as c
               | filter c > 3
           for: 0m
           labels: { severity: warning, team: llm-cost }
           annotations:
             summary: "OpenAI hôm nay đã tiêu {{ $labels.c }} USD (cap $3)"

         - alert: AnthropicMonthlyNearCap
           expr: |
             service:provider_cost provider:anthropic _time:30d
               | stats sum(cost_usd_day) as m
               | filter m > 14
           for: 15m
           labels: { severity: warning, team: llm-cost }
           annotations:
             summary: "Anthropic tháng {{ $labels.m }} USD > 70% cap $20"

         - alert: FallbackRateHigh
           expr: |
             service:litellm_cost fallback:true _time:1d
               | stats count() as n
               | filter n > 20
           for: 5m
           labels: { severity: warning, team: llm-cost }
           annotations:
             summary: "Fallback events 24h = {{ $labels.n }} (> 20). Provider unstable."

         - alert: UserDailyBudgetExceeded
           expr: |
             service:litellm_cost _time:1d user_api_key_alias:*
               | stats by (user_api_key_alias) sum(response_cost) as spent
               | filter spent > 2
           for: 5m
           labels: { severity: info, team: llm-cost }
           annotations:
             summary: "User {{ $labels.user_api_key_alias }} spent {{ $labels.spent }} USD hôm nay"

         - alert: AnthropicCacheHitLow
           expr: |
             service:litellm_cost model:claude* _time:1d
               | stats sum(cache_read_input_tokens) as cr, sum(prompt_tokens) as pt
               | math (cr / pt) * 100 as pct
               | filter pct < 40
           for: 30m
           labels: { severity: info, team: llm-cost }
           annotations:
             summary: "Anthropic cache hit {{ $labels.pct }}% < 40% — kiểm tra prompt caching header"
   ```

4. **Alertmanager route** — verify route sẵn có match label `team=llm-cost` → Telegram. Nếu chưa có, thêm route con:
   ```yaml
   route:
     routes:
       - match: { team: llm-cost }
         receiver: telegram-onelog
         group_wait: 30s
         group_interval: 5m
         repeat_interval: 30m
   ```

5. **`.env.example`** — thêm threshold placeholders (nếu muốn param hoá sau — MVP hardcode expr trước):
   ```env
   # Phase 04 · LLM cost thresholds
   COST_ALERT_DEEPSEEK_BALANCE_MIN=5
   COST_ALERT_OPENAI_DAILY_MAX=3
   COST_ALERT_ANTHROPIC_MONTHLY_SOFT=14
   COST_ALERT_FALLBACK_DAILY_MAX=20
   COST_ALERT_USER_DAILY_MAX=2
   ```

6. **Apply**:
   ```bash
   dc restart vmalert
   dc up -d --force-recreate alertmanager  # nếu sửa alertmanager.yml
   dc up -d --force-recreate grafana        # provisioning dashboard mới
   ```

7. **Smoke test alert**:
   ```bash
   # Fake DeepSeek balance thấp trong test env (tạm sửa .env.cost mock value)
   # Hoặc tạm tune COST_ALERT_DEEPSEEK_BALANCE_MIN=100 để trigger dễ

   # Check vmalert đã eval rule
   curl -s http://localhost:8880/api/v1/alerts | jq '.data.alerts[] | select(.labels.team=="llm-cost")'

   # Wait 60s, check Alertmanager
   curl -s http://localhost:9093/api/v2/alerts | jq '.[] | select(.labels.team=="llm-cost")'

   # Telegram phải nhận message
   ```

## Todo list

- [ ] Grafana UI: add 4 panel balance vào dashboard "OneLog · LLM Cost"
- [ ] Panel DeepSeek stat với threshold màu
- [ ] Panel Anthropic có breakdown token in/out/cache
- [ ] Panel Gemini có description warning "estimate"
- [ ] Export dashboard JSON, update `llm-cost-overview.json` in-place
- [ ] Add group `llm_cost` vào `vmalert/rules.yml` với 5-6 rule
- [ ] Verify Alertmanager route match `team=llm-cost` → Telegram
- [ ] Restart vmalert · force-recreate alertmanager · force-recreate grafana
- [ ] Smoke test: tune threshold thấp giả, wait 1 phút, verify Telegram nhận alert
- [ ] Reset threshold về giá trị thật
- [ ] Screenshot dashboard đầy đủ cho runbook

## Success criteria
- 4 panel balance render đúng số (cross-check với curl provider API thủ công 1 lần)
- Panel Gemini hiển thị warning badge, không mislead user
- `curl vmalert/api/v1/alerts` liệt kê 5-6 rule LLM cost, tất cả eval OK (không parse error)
- Smoke test: 1 rule fire → Telegram bot nhận message trong 90s
- Reboot logserver → cả dashboard + alert rule vẫn còn (persistence check)

## Risk assessment

| Risk | Mitigation |
|---|---|
| vmalert LogsQL syntax mới không support `math` operator | Test trên `curl VL /select/logsql/query` trước · fallback dùng recording rule chain |
| Provider_cost stream chưa flow (Phase 03 chưa xong) → panel empty | Guard panel bằng "stale > 30m" indicator · document Phase 03 phải xong trước |
| Threshold quá nhạy → alert spam | `group_interval: 5m`, `repeat_interval: 30m` · start conservative rồi tune |
| Fallback rate rule fire cả khi provider outage lớn (spike hợp lý) | Kèm annotation link runbook để ops biết cần check trước khi action |
| User alias trống với OpenWebUI → rule per-user sai bucket | Filter `user_api_key_alias:*` (exclude empty) · alert riêng cho "unknown" bucket |
| Sửa alertmanager.yml không recreate → rule mới không active | Note vào runbook: alertmanager placeholder render sed lúc start, phải `--force-recreate` |

## Security considerations
- Alert message KHÔNG expose API key (dù rare, jq template có thể leak nếu ẩu)
- vmalert `-external.url` set đúng để link "View rule" trong Telegram → admin subdomain, không public URL

## Next steps
- Phase 05: Docs + runbook (rotate admin key, add panel mới, tune threshold)
