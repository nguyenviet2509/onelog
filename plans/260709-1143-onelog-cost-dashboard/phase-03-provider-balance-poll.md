# Phase 03 · Provider balance poll script

## Context
- Plan: [../plan.md](../plan.md)
- Mockup: [../../mockups/onelog-cost-dashboard.html](../../mockups/onelog-cost-dashboard.html) (section "Provider balance cards")
- Prereq: Phase 01 xong (Grafana + Vector + VL đang chạy). Phase 02 parallel được.

## Overview
- Priority: MED · deliver "Phase B" — ground truth từ provider
- Deliverable: bash script poll 3 provider (DeepSeek · OpenAI · Anthropic) mỗi 15 phút, emit JSON vào syslog, Vector nuốt → VL với `service: provider_cost`.

## Key insights
- **Admin API key** khác project API key cho OpenAI + Anthropic. Phải tạo mới trong dashboard org owner.
- DeepSeek dùng chính key đang có (`DEEPSEEK_API_KEY` trong `.env.llm`) — không cần key mới.
- Gemini AI Studio **không có** usage API — skip. Dashboard sẽ dùng LiteLLM estimate cho Gemini.
- Cost API OpenAI/Anthropic có rate limit khắt (~few req/min) → poll 15 phút safe.
- Script phải fail-soft: 1 provider fail không được kill toàn cron.

## Requirements

### Functional
- Cron chạy `poll-provider-cost.sh` mỗi 15 phút
- Query 3 endpoint, parse response, emit JSON syslog per provider
- Vector route JSON tag `service:provider_cost`
- Schema thống nhất với LiteLLM cost stream (xem plan.md section Schema)

### Non-functional
- Fail-soft: script exit 0 kể cả khi 1-2 provider fail (log warning)
- Timeout 10s per API call
- Không cache — mỗi run gọi fresh
- Log stderr → `/var/log/onelog-provider-cost.log` (host) cho debug

## Architecture

```
cron */15 * * * *  root  bash /home/xxx/onelog/infra/scripts/poll-provider-cost.sh
                             │
                             ├─► curl DeepSeek /user/balance     ─┐
                             ├─► curl OpenAI  /organization/costs ├─► JSON syslog
                             └─► curl Anthropic /usage_report    ─┘   │
                                                                       ▼
                                                              logger -t provider_cost
                                                                       │
                                                                       ▼
                                                             rsyslog → Vector :6514
                                                                       │
                                                                       ▼
                                                                 VictoriaLogs
```

## Related files

### Create
- `infra/scripts/poll-provider-cost.sh` — main script
- `infra/litellm/.env.cost` — admin keys (chmod 0400 root:root)
- `infra/litellm/.env.cost.example` — template
- `docs/runbook-rotate-admin-keys.md` — key rotation SOP (viết chi tiết ở Phase 05)

### Modify
- `infra/.env.example` — reference `.env.cost` path (không dup key)
- `infra/vector/vector.yaml` — thêm transform tag `service:provider_cost` cho syslog tag `provider_cost`
- Crontab của root: thêm entry 15 phút

### Reference
- `infra/litellm/.env.llm` — pattern chmod 0400 · file mount tách biệt
- `infra/scripts/snapshot-daily.sh` — reference pattern bash script + logging

## Implementation steps

1. **Tạo admin API keys** (bước manual, 1 lần):
   - **OpenAI**: platform.openai.com → Organization → Admin keys → Create. Scope: `costs.read`, `usage.read`. Lưu ngay (chỉ hiện 1 lần).
   - **Anthropic**: console.anthropic.com → Organization Settings → API Keys → Admin Key. Scope: Usage & Cost Reports.
   - **DeepSeek**: không cần key mới, dùng `DEEPSEEK_API_KEY` sẵn có.

2. **`.env.cost`** (chmod 0400 root:root):
   ```env
   # Admin keys for cost polling — NEVER commit
   OPENAI_ADMIN_KEY=sk-admin-...
   ANTHROPIC_ADMIN_KEY=sk-ant-admin-...
   # DeepSeek reuse provider key
   DEEPSEEK_API_KEY=sk-... (source từ .env.llm)
   ```

3. **`infra/scripts/poll-provider-cost.sh`**:
   ```bash
   #!/usr/bin/env bash
   # Poll LLM provider balance/cost APIs → emit JSON syslog.
   # Cron: */15 * * * * bash infra/scripts/poll-provider-cost.sh
   set -uo pipefail

   ENV_FILE="${ENV_FILE:-/home/$USER/onelog/infra/litellm/.env.cost}"
   # shellcheck disable=SC1090
   source "$ENV_FILE"

   TS=$(date -Is)
   emit() {
     local provider="$1" json="$2"
     logger -t provider_cost --tag "onelog-cost" \
       "$(echo "$json" | jq -c --arg ts "$TS" --arg p "$provider" \
          '. + {_time: $ts, service: "provider_cost", provider: $p}')"
   }
   fail() {
     local provider="$1" msg="$2"
     logger -t provider_cost -p user.warn \
       "provider=$provider status=fail msg=\"$msg\""
   }

   # DeepSeek — /user/balance
   if r=$(curl -fsS --max-time 10 https://api.deepseek.com/user/balance \
            -H "Authorization: Bearer $DEEPSEEK_API_KEY"); then
     emit deepseek "$(echo "$r" | jq '{
       balance_usd: (.balance_infos[0].total_balance | tonumber),
       granted:     (.balance_infos[0].granted_balance | tonumber),
       topped_up:   (.balance_infos[0].topped_up_balance | tonumber)
     }')"
   else fail deepseek "curl failed"; fi

   # OpenAI — /organization/costs (last 24h)
   START=$(date -d 'yesterday' +%s)
   if r=$(curl -fsS --max-time 10 \
            "https://api.openai.com/v1/organization/costs?start_time=$START" \
            -H "Authorization: Bearer $OPENAI_ADMIN_KEY"); then
     emit openai "$(echo "$r" | jq '{
       cost_usd_day: [.data[].amount.value] | add,
       currency: (.data[0].amount.currency // "USD")
     }')"
   else fail openai "curl failed"; fi

   # Anthropic — /organizations/usage_report/messages (last 24h)
   if r=$(curl -fsS --max-time 10 \
            "https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=$(date -d 'yesterday' -Is)" \
            -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
            -H "anthropic-version: 2023-06-01"); then
     emit anthropic "$(echo "$r" | jq '{
       tokens_in:    [.data[].usage.input_tokens] | add,
       tokens_out:   [.data[].usage.output_tokens] | add,
       cache_read:   [.data[].usage.cache_read_input_tokens] | add,
       cost_usd_day: [.data[].cost.amount] | add
     }')"
   else fail anthropic "curl failed"; fi

   exit 0
   ```

4. **`vector.yaml`** — verify syslog tag `provider_cost` được parse:
   ```yaml
   transforms:
     tag_provider_cost:
       type: remap
       inputs: [syslog_source]
       source: |
         if .appname == "provider_cost" || contains(string!(.tag), "provider_cost") {
           # Parse JSON body vào flat fields
           parsed, err = parse_json(.message)
           if err == null { . = merge!(., parsed) }
           .service = "provider_cost"
         }
   ```

5. **Cron entry** (root crontab):
   ```cron
   */15 * * * * ONELOG_USER=trihd bash /home/trihd/onelog/infra/scripts/poll-provider-cost.sh >> /var/log/onelog-provider-cost.log 2>&1
   ```

6. **Test manual trước khi enable cron**:
   ```bash
   bash ~/onelog/infra/scripts/poll-provider-cost.sh
   # Check syslog
   tail -20 /var/log/syslog | grep provider_cost
   # Check VL
   sleep 5
   curl -s 'http://localhost:9428/select/logsql/query' \
     --data-urlencode 'query=service:provider_cost _time:2m' | jq .
   ```

## Todo list

- [ ] Tạo OpenAI admin key trong platform, scope costs.read + usage.read
- [ ] Tạo Anthropic admin key trong console org settings
- [ ] Create `infra/litellm/.env.cost` với 3 key, chmod 0400 root:root
- [ ] Create `infra/litellm/.env.cost.example` template (không commit .env.cost)
- [ ] Write `infra/scripts/poll-provider-cost.sh` với 3 provider block + fail-soft
- [ ] `chmod +x poll-provider-cost.sh`
- [ ] Update `vector.yaml` transform tag_provider_cost
- [ ] Reload Vector: `dc kill -s HUP vector`
- [ ] Test manual: chạy script, verify 3 record vào VL trong 5s
- [ ] Add cron entry root */15
- [ ] Wait 30 phút, verify 2 lần poll ghi vào VL đầy đủ
- [ ] Test fail-soft: tạm invalidate 1 key, verify 2 provider còn lại vẫn emit

## Success criteria
- `curl VL service:provider_cost _time:1h | stats by (provider) count()` → 3 provider × 4 lần = 12 records/giờ
- Test fail-soft: 1 key sai → script exit 0, `provider=xxx status=fail` trong syslog, 2 provider khác vẫn có data
- Cron log `/var/log/onelog-provider-cost.log` không có `set -e` traceback
- Không leak key vào syslog message (grep syslog cho `sk-` phải empty)

## Risk assessment

| Risk | Mitigation |
|---|---|
| Admin key API schema đổi (OpenAI/Anthropic đang evolving) | Script bao curl bằng `if r=...; then` · fail-soft · log raw response khi parse fail |
| Rate limit hit (Anthropic ~5 req/min) | 15 phút = 4 req/giờ · safe · alert khi 429 xuất hiện |
| jq không có trên host | `apt install jq` trong Phase 05 runbook · check `command -v jq \|\| { echo "jq required"; exit 2; }` |
| Cron chạy dưới root nhưng đọc file user home | Set `ENV_FILE` absolute path · test với `sudo -u root bash script` trước |
| Key leak qua syslog / stderr | Không echo key · `set -u` để catch undef · redirect stderr chỉ path/curl status |
| Endpoint deprecate (OpenAI có `/dashboard/billing` cũ deprecated) | Dùng endpoint mới `/organization/costs` · reference docs.openai.com Sept 2024+ |

## Security considerations
- `.env.cost` chmod 0400 root:root → chỉ root đọc được → cron chạy root
- Admin key rotate cadence 90d (documented Phase 05)
- Key KHÔNG được commit git · added to `.gitignore` explicitly
- Log rotation: `/var/log/onelog-provider-cost.log` add logrotate config trong Phase 05

## Next steps
- Phase 04: Grafana panel dùng data provider_cost + vmalert cho balance/quota threshold
