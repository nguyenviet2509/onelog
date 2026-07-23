---
type: kb
tags: [litellm, deepseek, fallback, cost-dashboard]
service: litellm-proxy
source: plans/reports/vps-patch-litellm-fallback.sh
---

# Title
LiteLLM: deepseek chỉ fallback `gpt-4-mini` (no key) → thêm gemini-flash

## Problem / symptoms
Cost dashboard báo request `deepseek` fail sau khi upstream deepseek quota hết. LiteLLM log: `fallback model gpt-4-mini has no api_key`. Không có model backup khả dụng → chat bên OpenWebUI trả 500.

Grep config: `fallbacks: - deepseek: ["gpt-4-mini"]` — thiếu gemini-flash.

## Solution
Sửa `/opt/onelog/infra/litellm/config.yaml`:

```yaml
fallbacks:
  - deepseek: ["gemini-flash", "gpt-4-mini"]
```

Restart LiteLLM:
```bash
cd /opt/onelog/infra
docker compose --profile llm restart litellm
```

Verify:
```bash
docker compose logs litellm --tail=30 | grep -i fallback
# Chat test qua OpenWebUI với model deepseek + force quota hit (nếu có script)
```

## Related
- Cost dashboard: `docs/cost-dashboard.md`
- LLM provider ops: `docs/llm-provider-ops.md`
- Original patch script: `plans/reports/vps-patch-litellm-fallback.sh`
