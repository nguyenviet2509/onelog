# Test guide — VictoriaMetrics observability (Phase 01-04)

Verify scrape + rule + alert routing hoạt động đúng sau khi cook 3 commit:
- `13763df` — edge + AM scrape targets
- `634ee11` — gitignore caddy runtime
- `b479e06` — cAdvisor + NATS exporter

**Truy cập:**
- Grafana: `http://10.200.0.30/grafana/` (dashboards → OneLog VPS Host)
- VMUI: SSH tunnel `ssh -L 8428:127.0.0.1:8428 onelog-vps` → `http://127.0.0.1:8428/vmui/`
- vmalert-metrics UI: SSH tunnel `-L 8881:127.0.0.1:8881` → `http://127.0.0.1:8881`

---

## 1. Smoke test — scrape health (2 phút)

Chạy trên onelog-vps:

```bash
# All 13 targets phải up=1
docker exec ragstack-vm wget -qO- 'http://127.0.0.1:8428/api/v1/query?query=up' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(r["metric"].get("job","?").ljust(24), r["value"][1]) for r in sorted(d["data"]["result"], key=lambda x:x["metric"].get("job",""))]'
```

**Pass:** 13 dòng, tất cả cột 2 = `1`.
**Fail:** dòng nào `0` → `docker logs ragstack-<component>` + check network alias trong `docker inspect`.

## 2. Rule loading (1 phút)

```bash
docker exec ragstack-vmalert-metrics wget -qO- 'http://127.0.0.1:8881/api/v1/rules' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(g["name"].ljust(28), len(g["rules"])) for g in d["data"]["groups"]]'
```

**Expected 9 groups / 28 rules:**

| Group | Rules |
|---|---|
| alertmanager-health | 2 |
| container-health | 3 |
| edge-health | 4 |
| host-capacity | 6 |
| host-disk | 3 |
| host-network | 2 |
| nats-health | 3 |
| qdrant-log-templates | 2 |
| scrape-health | 3 |

## 3. Firing check (baseline)

```bash
docker exec ragstack-vmalert-metrics wget -qO- 'http://127.0.0.1:8881/api/v1/alerts' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); a=[x for x in d["data"]["alerts"] if x["state"]=="firing"]; print(len(a),"firing"); [print(" ",x["labels"].get("alertname"),x["labels"].get("severity")) for x in a]'
```

**Expected:** 0-1 firing (previously `QdrantTemplateGrowthHigh` — theo dõi xem còn không).
**Nếu > 5 firing sau 10 phút:** rule bị noisy, quay lại tune threshold.

## 4. Query test — data đã vào VM

Trong VMUI (VictoriaMetrics UI), thử từng query — mỗi query phải trả về ≥1 series:

| Component | Query | Kỳ vọng |
|---|---|---|
| Caddy | `caddy_http_requests_total` | Request count từ khi restart |
| Grafana | `grafana_build_info` | 1 series với version label |
| oauth2-proxy | `oauth2_proxy_requests_total` | Auth check count |
| Alertmanager | `alertmanager_notifications_total` | Notification count |
| cAdvisor | `container_memory_usage_bytes{name!=""}` | ~30 container × 1 series |
| NATS | `gnatsd_varz_connections` | Số active connection |
| NATS JS | `gnatsd_varz_jetstream_storage` | JetStream storage bytes |

## 5. Alert trigger test (chọn 1-2 phát bắn thử)

**⚠ Chỉ chạy khi có window bảo trì. Mỗi test = short outage của service đó.**

### Test 5a — GrafanaDown (warning, 3m)

```bash
docker stop ragstack-grafana
# Chờ 3-4 phút, check firing:
docker exec ragstack-vmalert-metrics wget -qO- 'http://127.0.0.1:8881/api/v1/alerts' \
  | python3 -c 'import sys,json,re; d=json.load(sys.stdin); print([x["labels"].get("alertname") for x in d["data"]["alerts"] if x["state"]==\"firing\"])'
# Expected: GrafanaDown xuất hiện
# → Alertmanager route → Telegram (check topic)
docker start ragstack-grafana
# Chờ 3m nữa, alert resolve → Telegram gửi resolved
```

### Test 5b — AlertmanagerDown (critical, 2m) — silence-of-silence

```bash
docker stop ragstack-alertmanager
# 2-3 phút sau, check:
docker exec ragstack-vmalert-metrics wget -qO- 'http://127.0.0.1:8881/api/v1/alerts' \
  | grep -o 'AlertmanagerDown'
# Expected: state=firing (nhưng KHÔNG có Telegram vì AM chính là kẻ chết)
# Grafana panel "Component up{}" sẽ show alertmanager DOWN — signal fallback
docker start ragstack-alertmanager
```

### Test 5c — ContainerRestartLoop (warning, 5m)

```bash
# Simulate crash loop bằng cách restart nhanh 4 lần
for i in 1 2 3 4; do docker restart ragstack-sqlite-web 2>/dev/null || true; sleep 30; done
# Sau ~15 phút, rule sẽ fire vì changes(container_start_time_seconds) > 3
```

### Test 5d — NatsDown (critical, 2m)

**⚠ Đây là data-path — nếu stop NATS, indexer/ingest sẽ dừng.**
Skip test này trừ khi user chủ động muốn verify. Rule sẽ fire khi thật sự có sự cố.

## 6. Grafana visual check

1. Login `http://10.200.0.30/grafana/`
2. Menu → Dashboards → **OneLog VPS Host** (đã có sẵn từ trước)
3. Trong Explore → chọn datasource **VictoriaMetrics** → paste query từ mục 4 → thấy đồ thị
4. Alert rules: Menu → Alerting → Alert rules → filter datasource **VictoriaMetrics** → nên thấy 28 rule
5. (Nếu muốn) tạo panel mới cho Caddy request rate:
   ```
   rate(caddy_http_requests_total{job="onelog-caddy"}[5m])
   ```
6. cAdvisor top 5 container theo RAM:
   ```
   topk(5, container_memory_usage_bytes{name!=""})
   ```

## 7. Cardinality watch (sau 24h)

```bash
docker exec ragstack-vm wget -qO- 'http://127.0.0.1:8428/api/v1/status/tsdb' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin)["data"]; print("Total series:", d.get("totalSeries",\"?\")); print("Top 5 metrics by series:"); [print(" ",x[\"name\"],x[\"value\"]) for x in d.get("seriesCountByMetricName\",[])[:5]]'
```

**Pass:** total series < 15k (từ 5.6k trước → tăng < 3× là healthy).
**Fail:** > 20k → check cAdvisor label bloat (`container_*` metrics), có thể cần thêm `metric_relabel_configs`.

## 8. VM disk check (sau 7 ngày)

```bash
du -sh /opt/onelog/infra/data/victoriametrics
```

**Pass:** < 200MB sau 7 ngày (từ 92MB trước).
**Fail:** > 500MB → cardinality explosion, cần điều tra.

---

## Troubleshooting cheatsheet

| Symptom | Root cause | Fix |
|---|---|---|
| `up{job="onelog-cadvisor"} == 0` | cAdvisor container chưa healthy | `docker logs ragstack-cadvisor \| tail -30` — thường do bind mount permission |
| `up{job="onelog-nats"} == 0` | nats-exporter chưa chạy hoặc mất connectivity | `docker restart ragstack-nats-exporter` |
| `up{job="onelog-caddy"} == 0` | Caddy admin API chưa enable | Verify `admin :2019` trong Caddyfile, `docker exec ragstack-caddy wget -qO- http://127.0.0.1:2019/metrics` |
| Cardinality tăng vọt sau deploy cAdvisor | container_label_* series | Đã set `--store_container_labels=false`. Nếu còn cao → thêm `metric_relabel_configs: drop` trên regex `container_labels?_.*` |
| `AlertmanagerNotificationFailing` firing false | Telegram 429 rate limit | Check AM logs, xem có burst notification không |

## Rollback

Nếu cần disable observability nhanh (VD cardinality nổ):

```bash
cd /opt/onelog/infra
docker compose stop cadvisor nats-exporter
# Hoặc revert git:
git revert b479e06  # cAdvisor + NATS
# Push local + reset VPS:
```

---

## Unresolved

- Baseline tune threshold sau 7d observed data (Phase 05 — chờ đủ history)
- Grafana dashboard riêng cho edge/container chưa tạo (dùng Explore tạm)
- Alertmanager route matcher cho `component: caddy|cadvisor|nats` — hiện dùng default receiver
- MCP servers (mcp-vl, mcp-semantic, mcpo) có `/metrics` native không → verify sau, có thể thêm scrape target Phase 06
