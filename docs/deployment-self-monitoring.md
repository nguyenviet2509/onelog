# OneLog self-monitoring

VictoriaMetrics scrapes `/metrics` from OneLog components → Grafana dashboards + vmalert rules cover pipeline health.

Components: [victoriametrics](../infra/docker-compose.yml) (profile `monitoring`), scrape config at [infra/victoriametrics/scrape.yml](../infra/victoriametrics/scrape.yml), Grafana provisioning [infra/grafana/](../infra/grafana/).

## Golden rules

- Scrape only endpoints that already expose Prometheus format natively. Do NOT wire an exporter for a service just to satisfy this dashboard.
- Add rule + dashboard **together** — a metric that isn't visualized and isn't alerted on is dead weight.
- Tune alert thresholds after **1 week baseline**. Ship as info-level first, promote to warning/critical once you have observed noise floor.

## Quick enable

```bash
cd infra
# Bring up VictoriaMetrics + Grafana + existing alerts
docker compose --profile monitoring --profile alerts up -d
```

Access:
- VictoriaMetrics query UI: `http://127.0.0.1:8428/vmui/`
- Grafana: `http://admin.<APP_DOMAIN>/` — dashboard "OneLog Pipeline Health"

## Scrape targets

Configured in [scrape.yml](../infra/victoriametrics/scrape.yml):

| Job | Target | Notes |
|-----|--------|-------|
| `onelog-indexer` | `indexer:9100` | Drain3 batch/embed worker — native `/metrics`. |
| `onelog-victorialogs` | `victorialogs:9428` | VL native `/metrics`. |
| `onelog-qdrant` | `qdrant:6333` | Requires api-key; VM adds header when configured. |
| `onelog-vmalert` | `vmalert:8880` | Alert eval loop stats. |
| `onelog-litellm` | `litellm-proxy:4000` | Requires `callbacks: [prometheus]` in `litellm/config.yaml`. |
| `victoriametrics` | self | Sanity. |

## Alerts

New rule in [vmalert/rules.yml](../infra/vmalert/rules.yml):

- **AnyEventsStale** — group `ingest-freshness`. Fires when whole VL ingest drops below 10 events / 5m. Catches total pipeline breakage (`WarnEventsStale` only fires when WARN+ = 0).

Existing rules that cover self-health:
- `WarnEventsStale` (0 WARN+ in 30m)
- `VictoriaLogsSelfError` (VL err burst)
- `OpenWebUIDbProbeStale`
- `DiskProbeStale`

## Dashboard

[onelog-pipeline-health.json](../infra/grafana/dashboards/onelog-pipeline-health.json) — 6 panels:

1. Ingest rate (VL bytes/s)
2. Indexer NATS lag + batch rate
3. Qdrant collection points (log_templates)
4. VL storage GB
5. Component `up{}` status
6. Firing alerts table

## Adding a scrape target

1. Confirm the target exposes Prometheus format: `curl target:port/metrics` returns lines like `metric_name{labels} value`.
2. Append a job to [scrape.yml](../infra/victoriametrics/scrape.yml).
3. `docker compose restart victoriametrics`.
4. Verify in VMUI: `up{job="<new-job>"}` returns 1.
5. Add a panel or an alert (or both) — otherwise skip step 2.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `up{job=…} == 0` for a target | Target down / wrong port / not on `ragstack` network | `docker exec ragstack-vm wget -qO- http://<target>:<port>/metrics \| head` |
| Grafana panels blank | Datasource UID mismatch | Confirm `victoriametrics.yml` sets `uid: victoriametrics`; dashboard JSON refs match |
| VM disk grows fast | Cardinality explosion (per-request labels) | Reduce label set at target OR drop labels via `metric_relabel_configs` |
| LiteLLM `/metrics` 404 | Prometheus callback not enabled | Add `prometheus` to `litellm_settings.callbacks` in `litellm/config.yaml` |

## Unresolved

- Vector metrics — Vector exposes some stats at `/health` + `/graphql` but no native Prometheus endpoint. Enabling `prometheus_exporter` sink adds a port + config. Deferred.
- Alert routing — new AnyEventsStale currently uses default receiver. If SRE wants separate escalation, add matcher in `alertmanager.yml` for `component: ingest-pipeline`.
