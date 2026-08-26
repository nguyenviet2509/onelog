# Log forwarding convention — OneLog ecosystem

## Host label convention

Mỗi VPS trong ecosystem có 1 host label cố định, hardcode ở Vector transform để nhất quán khi query VictoriaLogs. Docker container short-ID auto-inject không dùng.

| VPS | `.host` label | Nguồn ingest | Ghi chú |
|---|---|---|---|
| onelog-vps | `logserver` | `docker_logs` (litellm only) + `exec` (openwebui-db, disk) + syslog | Legacy naming — giữ compat với dashboards & vmalert rules đã hardcode `host="logserver"` |
| authway-vps | `authway` | `docker_logs` (zitadel/postgres/traefik/zitadel-login) → HTTP sink → VL onelog-vps | Plan 260821-1013 |
| onemcp-vps | `onemcp` (TBD) | Chưa deploy | Kế hoạch tương lai |
| Fleet remote hosts | (real hostname) | syslog/rsyslog inbound | Giữ hostname thật để trace back |

**Naming rule:** short name (`logserver`, `authway`, `onemcp`) — không `-vps` suffix. Parallel với legacy `logserver`.

## OneLog Vector — thực tế ingest (2026-08-21)

OneLog Vector KHÔNG forward toàn bộ docker container logs. Chỉ 3 pipeline emit `host="logserver"`:

1. `tag_litellm_cost` (line 209): filter LiteLLM json_logs → tag `service="litellm_cost"`, `host="logserver"`.
2. `openwebui_db_parse` (line 283): exec probe SQLite size mỗi 5m → `service="openwebui-db-monitor"`.
3. `logserver_disk_parse` (line 301): exec probe df /opt/onelog/infra/data → `service="logserver-disk-monitor"`.

Syslog input (UDP 514, TCP 6514) đi qua transform `enrich` (line 94-95) dùng `.host = .hostname || "unknown"` → giữ hostname client thật, KHÔNG override `logserver`.

Nghĩa là: query VMUI `host:"logserver"` chỉ trả về 3 service trên (mỗi cái stream riêng do `_stream_fields: service,host`). Đây là design chủ ý — không phải gap.

## Authway-vps — pattern mới (plan 260821-1013)

Ngược với onelog-vps, authway-vps forward TẤT CẢ container logs qua Vector agent local → HTTP sink tới VL onelog-vps:9428. Tất cả tagged `host="authway"`. Reason:
- Authway là edge auth service — cần log 100% để audit/troubleshoot.
- Container không nhiều (4 con) → volume manageable.

## Vector remap pattern (chung)

```yaml
transforms.enrich:
  type: remap
  inputs: [docker_source]
  source: |
    .host = "<vps-label>"                                # override container short-ID
    .service = replace(string!(.container_name), "authway-prod-", "")  # strip stack prefix
```

## Query VMUI

- Container logs theo VPS: `host:"authway"` hoặc `host:"logserver"`
- Theo service (cross-VPS): `service:"zitadel"` (dùng service ngắn gọn, không stack prefix)
- Combined: `host:"authway" service:"zitadel" _msg:*error*`
- Đếm service phân biệt: `host:"<label>" | stats by (service) count()`

## Deduplication field — `.dedup_count` (plan 260826-0932)

NATS branch events carry a `.dedup_count` field (only when sourced from Vector `reduce_dupes` transform):

- **Field:** `.dedup_count: <int>` (1–10,000)
- **Meaning:** Count of deduplicated raw events aggregated into this event over the 30s dedup window
- **Indexer behavior:** Drain3 `.add(message, count=dedup_count)` iterates cluster matching × `dedup_count` times (capped at 10k to prevent DoS)
- **Legacy compatibility:** Events without `.dedup_count` default to weight=1 (non-reduced syslog or pre-dedup Vector config)

**Example NATS event:**
```json
{
  "host": "srv-01",
  "_msg": "Authentication failed",
  "severity": "warn",
  "service": "sshd",
  "dedup_count": 47,  // 47 identical messages aggregated in the window
  "_time": "2026-08-26T10:30:15Z"
}
```

Consumers of NATS stream can filter by presence/absence of `.dedup_count` or use it for telemetry (e.g., "47 SSH auth failures seen as 1 cluster in Drain3").

## Convention drift guard

Nếu ai đó sửa Vector config đổi `.host = "logserver"` → cái khác (VD `onelog-vps`) sẽ break:
- Grafana dashboards có filter cứng `host="logserver"`
- Vmalert rules query `host="logserver"` (rules đĩa openwebui db size, disk)
- Historical query VMUI dùng label này

Trước khi đổi convention: grep toàn codebase (`infra/`, `docs/`) tìm dependency cứng, apply cùng lúc.
