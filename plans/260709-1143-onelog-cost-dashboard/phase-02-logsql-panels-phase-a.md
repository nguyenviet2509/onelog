# Phase 02 · LogsQL panels — Phase A quick win

## Context
- Plan: [../plan.md](../plan.md)
- Mockup: [../../mockups/onelog-cost-dashboard.html](../../mockups/onelog-cost-dashboard.html)
- Prereq: Phase 01 (Grafana + datasource lên)
- LiteLLM `json_logs: true` đã emit từ ngày enable (xem `infra/litellm/config.yaml:53`)

## Overview
- Priority: HIGH · deliver "Phase A" ship được ngay
- Deliverable: 1 Grafana dashboard "OneLog · LLM Cost" với 4 panel core dùng data LiteLLM logs sẵn có

## Key insights
- LiteLLM json_logs schema (verify trước): `model`, `user_api_key_alias`, `response_cost`, `total_tokens`, `prompt_tokens`, `completion_tokens`, `cache_read_input_tokens`, `metadata.status`
- Vector đã sink tất cả container stdout vào VL → LiteLLM logs có ngay ở field `service:litellm` (verify tag)
- LogsQL support `stats by (field) sum(...)` — đủ cho aggregation
- Grafana VictoriaLogs plugin có time-range picker tự động

## Requirements

### Functional
- Panel 1: **KPI row** — 5 số (cost tháng · cost hôm nay · token 24h · cache hit % · fallback count)
- Panel 2: **Cost 30d trend** — line chart, group by model
- Panel 3: **Per-user cost 7d** — bar horizontal, group by `user_api_key_alias`
- Panel 4: **Fallback events 24h** — table với time · primary → fallback · reason
- Panel 5: **Model split 7d** — donut chart cost %

### Non-functional
- Dashboard load < 3s (data 30d với ~50k requests/tháng)
- Refresh mặc định 1 phút
- Export/import JSON để version control trong repo

## Architecture (data path)

```
LiteLLM proxy container
  │  stdout JSON (json_logs: true)
  ▼
Vector docker_logs source
  │  transform: tag service=litellm
  ▼
VictoriaLogs (retention 7-30d cho stream cost)
  │
  ▼
Grafana panel · LogsQL stats query
```

## Related files

### Create
- `infra/grafana/dashboards/llm-cost-overview.json` — dashboard JSON export
- `plans/reports/logsql-litellm-schema-260709.md` — schema verification (recon)

### Modify
- `infra/vector/vector.yaml` — verify litellm container stdout được route đúng (add transform nếu cần tag `service: litellm_cost`)

### Reference
- `infra/litellm/config.yaml` line 48-61 (litellm_settings block)
- `infra/litellm/callbacks/custom_callbacks.py` (custom cost field nếu có)

## Implementation steps

1. **Verify LiteLLM log schema** — bắt buộc trước khi query:
   ```bash
   # Fire 1 test call qua LiteLLM
   curl -s http://localhost:4000/v1/chat/completions \
     -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"gemini-flash","messages":[{"role":"user","content":"hi"}]}'

   # Sau ~5s check VL
   curl -s 'http://localhost:9428/select/logsql/query' \
     --data-urlencode 'query=service:litellm* _time:5m' | jq . | head -50
   ```
   Note tên field thật (có thể là `response_cost` hoặc `spend` hoặc nested `metadata.usage.cost`) → điền vào query bên dưới.

2. **Vector routing** — nếu chưa có tag `litellm_cost`, thêm transform:
   ```yaml
   transforms:
     tag_litellm:
       type: remap
       inputs: [docker_logs]
       source: |
         if .container_name == "ragstack-litellm" {
           .service = "litellm_cost"
         }
   ```

3. **LogsQL queries** (điền vào Grafana panel):

   **KPI cost tháng:**
   ```logsql
   service:litellm_cost _time:month
     | stats sum(response_cost) as total
   ```

   **KPI cost hôm nay:**
   ```logsql
   service:litellm_cost _time:1d
     | stats sum(response_cost) as today, count() as reqs
   ```

   **Token 24h:**
   ```logsql
   service:litellm_cost _time:24h
     | stats sum(prompt_tokens) as tin,
             sum(completion_tokens) as tout
   ```

   **Cache hit rate (Anthropic only):**
   ```logsql
   service:litellm_cost _time:24h model:claude*
     | stats sum(cache_read_input_tokens) as cached,
             sum(prompt_tokens) as total
     | math (cached / total) * 100 as hit_pct
   ```

   **Cost 30d per model (time-series):**
   ```logsql
   service:litellm_cost _time:30d
     | stats by (_time:1d, model) sum(response_cost) as cost
   ```

   **Per-user 7d:**
   ```logsql
   service:litellm_cost _time:7d user_api_key_alias:*
     | stats by (user_api_key_alias)
             sum(response_cost) as spent,
             count() as reqs
     | sort by (spent) desc
   ```

   **Fallback events 24h:**
   ```logsql
   service:litellm_cost _time:24h fallback:true
     | fields _time, model, fallback_model, exception_type
     | sort by (_time) desc
     | limit 50
   ```

4. **Build dashboard trong Grafana UI**:
   - Create → Dashboard → Add panel × 5
   - Datasource: VictoriaLogs
   - Điền query, chọn visualization (stat / timeseries / bargauge / table / piechart)
   - Set time-range default: Last 30 days · refresh 1m
   - Save as "OneLog · LLM Cost"

5. **Export JSON** để version-control:
   - Dashboard settings → JSON model → copy
   - Lưu vào `infra/grafana/dashboards/llm-cost-overview.json`
   - Provisioning tự load ở lần restart tiếp theo

6. **Recreate Grafana để provisioning apply**:
   ```bash
   dc up -d --force-recreate grafana
   ```

## Todo list

- [ ] Fire test LiteLLM call, verify log arrives ở VL
- [ ] Verify exact field names (`response_cost`? `spend`?), document trong reports/
- [ ] Update `vector.yaml` nếu cần tag `litellm_cost`
- [ ] Reload Vector (`dc kill -s HUP vector`)
- [ ] Grafana UI: tạo 5 panel với LogsQL query
- [ ] Test panel — số hợp lý không? Cross-check bằng curl LogsQL thủ công
- [ ] Save dashboard "OneLog · LLM Cost"
- [ ] Export JSON → `infra/grafana/dashboards/llm-cost-overview.json`
- [ ] `dc up -d --force-recreate grafana` — verify provisioning load lại được
- [ ] Screenshot dashboard, đính vào runbook Phase 05

## Success criteria
- 5 panel render số hợp lý (không empty, không error red)
- Cross-check 1 số: manual LogsQL sum = số hiển thị panel (delta < 1%)
- Dashboard load < 3s trên browser admin
- JSON dashboard checked in, reload container vẫn có dashboard
- Test 1 user: fire 5 request qua LiteLLM, panel per-user tăng đúng

## Risk assessment

| Risk | Mitigation |
|---|---|
| Field name khác giả định | Step 1 verify trước bằng test call — không guess |
| Cost field null cho request lỗi | Filter `response_cost:*` trong query · treat missing as 0 |
| Time range 30d quá nhiều rows → slow | Downsample nếu cần: `stats by (_time:1h, model)` cho trend, không per-request |
| User field trống với OpenWebUI (không có alias) | Fallback show "openwebui" bucket · document trong panel legend |
| LiteLLM log dạng plain text không JSON | Verify `json_logs: true` set · nếu không, PR sửa config.yaml |

## Security considerations
- LiteLLM logs KHÔNG chứa prompt content (đã disable `set_verbose: false`) — chỉ metadata cost/token
- Grafana query permission: Viewer role đủ, không cần Editor

## Next steps
- Phase 04: Bổ sung panel balance từ provider API (sau khi Phase 03 poll xong)
- Alert rules sẽ dùng LogsQL query tương tự → prep tốt cho vmalert
