---
type: kb
tags: [victoriametrics, scrape, qdrant, env-expansion]
service: victoriametrics
source: plans/reports/vps-fix-vm-and-qdrant-scrape.sh
---

# Title
VictoriaMetrics: env expansion flag `-promscrape.config.expandEnv` không tồn tại version này

## Problem / symptoms
Thêm `QDRANT_API_KEY` vào scrape config qua `${QDRANT_API_KEY}` reference + flag `-promscrape.config.expandEnv=true` → VM crash-loop với error `unknown flag`. Container restart liên tục, dashboard mất metrics Qdrant.

## Solution
Không dùng env-expansion flag (không tồn tại). Inline-substitute value trực tiếp vào scrape.yml:

1. Xoá command override `-promscrape.config.expandEnv=true` khỏi `docker-compose.override.yml`
2. Sửa `infra/victoriametrics/scrape.yml` — render `QDRANT_API_KEY` inline:
```yaml
- job_name: qdrant
  bearer_token: <ACTUAL_KEY_HERE>  # KHÔNG commit key — dùng sed entrypoint như alertmanager pattern
```
3. Hoặc dùng sed entrypoint pattern:
```yaml
# docker-compose.yml victoriametrics service:
entrypoint: ["/bin/sh", "-c", "sed 's|__QDRANT_KEY__|'$$QDRANT_API_KEY'|' /etc/vm/scrape.tmpl.yml > /etc/vm/scrape.yml && exec /victoria-metrics-prod ..."]
```
4. Restart: `docker compose restart victoriametrics`

## Verify
```bash
docker compose logs victoriametrics --tail=20 | grep -i 'flag\|error'
curl -s http://127.0.0.1:8428/api/v1/targets | jq '.data.activeTargets[] | select(.labels.job=="qdrant")'
```

## Related
- Storage decom postmortem: `plans/reports/audit-260713-1017-storage-decom-and-silent-pipeline-regression.md`
- Original fix script: `plans/reports/vps-fix-vm-and-qdrant-scrape.sh`
