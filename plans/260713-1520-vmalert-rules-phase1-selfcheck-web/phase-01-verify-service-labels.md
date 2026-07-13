# Phase 01 — Verify service labels + Vector sources

**Priority:** Blocker (Phase 02 + 06 phụ thuộc)
**Effort:** ~20m
**Status:** pending

## Red-team update 2026-07-13

C2 finding: Vector hiện chỉ scrape `docker_litellm` (1 container), không scrape Docker daemon events → DockerRestartLoop dead → drop khỏi Phase 1a. Cần verify Vector sources đầy đủ tại phase này.

Cũng cần verify `service:auditd` (Phase 06 dependency) — chưa confirmed.

## Mục tiêu

Confirm `service:` label thực tế của 4 nguồn log trước khi viết rule matcher. Nếu label khác dự đoán → sai matcher → rule Inactive vĩnh viễn.

## Labels cần verify

| Rule | Label dự đoán | Fallback |
|---|---|---|
| VictoriaLogsSelfError | `service:victorialogs` | `service:vlogs`, `service:vl` |
| DockerContainerRestartLoop | `service:docker` | `service:dockerd`, `_msg:"docker"` |
| WebServer4xxFlood (OLS) | `service:litespeed` | `service:openlitespeed`, `service:ols`, `service:httpd` |
| PhpFpmWorkerExhaustion | `service:php-fpm` | `service:lsphp`, `_msg:"pm."` pattern |
| LsphpSegfault | `service:lsphp` | `service:litespeed` (OLS log lsphp segfault vào error log riêng) |

## Steps

Chạy trên LogServer (hoặc port-forward VL 9428):

```bash
# 1. VictoriaLogs self-log
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:victorialogs | limit 5' \
  --data-urlencode 'start=1h'

# Nếu empty → check các label khác
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=_msg:"victoria" OR _msg:"VictoriaLogs" | limit 5' \
  --data-urlencode 'start=1h'

# 2. Docker daemon events
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:docker | limit 5' \
  --data-urlencode 'start=1h'

# Fallback: docker container events pattern
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=_msg:"container died" OR _msg:"exited with code" | limit 5' \
  --data-urlencode 'start=6h'

# 3. OpenLitespeed
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=(service:litespeed OR service:openlitespeed OR service:ols OR service:httpd) | limit 5' \
  --data-urlencode 'start=1h'

# 4. php-fpm / lsphp
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=(service:php-fpm OR service:lsphp OR service:phpfpm) | limit 5' \
  --data-urlencode 'start=1h'

# 5. Bonus: liệt kê distinct service values đang có trong VL 1h qua
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=* | stats by (service) count() as n | filter n:>0' \
  --data-urlencode 'start=1h' | python3 -m json.tool
```

## Deliverable

Cập nhật bảng dưới đây trong plan (edit phase file này) trước khi sang Phase 02:

```markdown
| Rule | Label CONFIRMED |
|---|---|
| VictoriaLogsSelfError | service:__________ |
| DockerContainerRestartLoop | service:__________ hoặc pattern match |
| WebServer4xxFlood | service:__________ |
| PhpFpmWorkerExhaustion | service:__________ |
| LsphpSegfault | service:__________ |
```

## Todo

- [ ] Query 5 patterns trên LogServer
- [ ] Update bảng CONFIRMED trong file này
- [ ] Nếu Docker events không có trong VL → check Vector source, quyết định: (a) add Docker source vào Vector, hoặc (b) drop R3 Docker rule khỏi Phase 02
- [ ] Nếu OLS access log không forward vào VL → drop R4 hoặc thêm Vector tail source
- [ ] Nếu php-fpm/lsphp log không forward → drop R6/R7 hoặc thêm Vector source

## Rủi ro

- **Vector chưa scrape source cần thiết** → rule không có data → false negative silent. Buộc phải extend Vector config (nằm ngoài scope Phase 01, nhưng phát hiện ở đây).

## Success

Bảng CONFIRMED có đủ label cho 5 rules dependent. R1 (HostLogSilent) + R5 (FDExhaustion) không cần verify vì match `*` / message pattern generic.

## Next phase

→ [phase-02-add-rules.md](phase-02-add-rules.md)
