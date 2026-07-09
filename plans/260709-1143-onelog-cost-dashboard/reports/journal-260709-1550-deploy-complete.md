---
type: journal
plan: 260709-1143-onelog-cost-dashboard
date: 2026-07-09
status: deploy-complete
---

# Journal — cost dashboard deploy complete

## Timeline (2026-07-09)

- 11:43 — Plan created (`/ck:plan`), 5 phases, uiApproach=grafana.
- ~13:24 — Cook `--auto` finished: 3 parallel workers + docs + code review. Score 8.5/10.
- 14:00–15:50 — Deploy on logserver-01, iterate through 7 blockers.
- 15:50 — All 5 phases green. Plan closed.

## Blockers hit + resolution (deploy phase)

1. **Grafana image tag `11-slim` không tồn tại** → pinned `grafana/grafana-oss:11.4.0`.
2. **DNS refused inside grafana container** (systemd-resolved 127.0.0.53 unreachable) → added `dns: [8.8.8.8, 1.1.1.1]` to compose.
3. **Caddy env passthrough silent skip** → added `environment: { ADMIN_STRICT_CIDR: ${ADMIN_STRICT_CIDR:?} }` fail-fast.
4. **CIDR comma-sep parse fail** → space-separated only for Caddy `remote_ip`.
5. **Bearer layer UX pain** — user cannot install ModHeader on 5 ops browsers → dropped Bearer, kept CIDR + Grafana login.
6. **LiteLLM callback silent** — `success_callback: [<module.instance>]` crashes proxy; reverted to `callbacks: <module.instance>`. Once path corrected → `onelog_callback_fired` beacon + cost record emit worked.
7. **Vector was tagging ALL LiteLLM stdout as `service=litellm_cost`** (500+ non-cost lines) → added `filter_litellm_cost` transform requiring `event=="litellm_cost"`.
8. **Grafana plugin returned string sums as label field** → set `"queryType": "stats"` on every panel target.
9. **VL LogsQL no `last()` function** → replaced with `avg()` in dashboard + vmalert rules. Discovered when vmalert crash-looped with `unknown stats func "last"`.
10. **Per-user panel showed `$6.00`** = `count() as reqs` formatted with panel-wide `currencyUSD` unit → dropped the count field.
11. **Provider poll syslog didn't reach Vector** → added rsyslog forward rule `/etc/rsyslog.d/50-onelog-provider-cost.conf` (tag=provider_cost → 127.0.0.1:6514).

## Signals

- LiteLLM cost stream: 6+ records in VL, `deepseek/deepseek-chat`, `$0.01` cumulative.
- DeepSeek balance: **$71.75** (green > $10 threshold).
- vmalert `llm_cost` group: 5 rules, all `health: ok, state: inactive`.
- Cron `/etc/cron.d/onelog-provider-cost` scheduled every 15m.

## Non-obvious learnings

- **VictoriaLogs Grafana plugin has 3 query modes** (Raw Logs / Range / Instant) mapped internally to `queryType` values `""` / `"range"` / `"stats"`. Stats aggregation queries MUST have `"queryType": "stats"` in target JSON — plugin silently defaults to Raw Logs (returns labels object, breaks stat panels).
- **VL LogsQL `stats` supports**: `sum, count, avg, min, max, median, quantile, row_min, row_max, row_any, uniq_values, values`. NO `last()`. Use `row_max(_time, field)` if you need latest strictly, or `avg()` if snapshot values don't drift within window.
- **LiteLLM proxy `callbacks:` accepts module.instance string** for CustomLogger subclass. `success_callback:` slot only accepts built-in tags (prometheus/s3/datadog) — passing module path crashes startup.

## Left for later

- Add OpenAI + Anthropic admin keys → 2 dashboard panels + 2 vmalert rules will start returning data. No infra work needed, purely credential provisioning.
- Enable `AnthropicCacheHitLow` rule once `math` pipe is verified in current VL image.
- LiteLLM virtual keys with `user_api_key_alias` per ops user → Per-user cost panel gets real names instead of `unknown`.
