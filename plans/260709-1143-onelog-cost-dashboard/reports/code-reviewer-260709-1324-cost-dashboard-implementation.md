# Code Review — OneLog Cost Dashboard (Phase 01-04)

**Verdict:** APPROVE_WITH_CONCERNS
**Score:** 8.5 / 10
**Critical:** 2 | **Warnings:** 5 | **Nits:** 3

---

## Critical (block deploy)

### C1. Caddy Bearer fail-open when `COST_DASHBOARD_TOKEN` unset
`Caddyfile:153` — `header Authorization "Bearer {$COST_DASHBOARD_TOKEN}"`.
Caddy substitutes env at parse time. If var is empty/unset, matcher becomes literal `"Bearer "` → any client sending `Authorization: Bearer ` (trailing space) passes. Compose has no `required: true` guard on this var.

**Fix:** Add startup guard, or use a `not` matcher + length check, or fail-fast in compose:
```
environment:
  COST_DASHBOARD_TOKEN: ${COST_DASHBOARD_TOKEN:?must be set}
```
Also add to caddy service block (currently caddy doesn't even receive this env — verify with `docker exec ragstack-caddy env | grep COST`).

### C2. Caddy service missing env passthrough
`docker-compose.yml:480-491` — caddy service has no `environment:` block. `{$COST_DASHBOARD_TOKEN}` and `{$ADMIN_STRICT_CIDR}` in Caddyfile resolve against caddy container env, not host `.env`. Compose only auto-forwards vars referenced with `${...}` in compose itself. Result: both substitutions become empty → C1 fail-open + CIDR matcher matches nothing → 403 for all (or all pass, depending on Caddy semantics).

**Fix:**
```yaml
caddy:
  environment:
    ADMIN_STRICT_CIDR: ${ADMIN_STRICT_CIDR:?}
    COST_DASHBOARD_TOKEN: ${COST_DASHBOARD_TOKEN:?}
```

---

## Warnings

- **W1.** `GRAFANA_ADMIN_PASSWORD` passed to grafana container but `grafana.ini` uses `$__env{GRAFANA_ADMIN_PASSWORD}` — OK. However `.env.example` default `CHANGE_ME_STRONG` is weak; add `${GRAFANA_ADMIN_PASSWORD:?}` in compose for fail-fast.
- **W2.** `poll-provider-cost.sh:83-84` — `curl_api ... 2>&1` merges stderr into `$resp`. If curl fails, error message (potentially echoing URL with query) gets fed to jq. Not a key leak (Bearer is in header, not URL), but noisy. Prefer `2>/dev/null`.
- **W3.** `rules.yml:330-335` — `AnthropicCacheHitLow` uses `math` pipe; comment admits uncertainty. Ship as disabled or recording-rule pair; a broken rule breaks the whole group load in vmalert.
- **W4.** Grafana bind mount `./data/grafana:/var/lib/grafana` — grafana image runs uid 472. On fresh Ubuntu host, dir will be root-owned → grafana crash on write. Add pre-create instruction to deployment doc or use named volume.
- **W5.** `vmalert/rules.yml` uses `{{ $labels.b }}` etc. in annotations — but `b`, `c`, `m`, `n`, `spent`, `pct` are `stats ... as X` output columns, not labels. vmalert exposes them as `$labels` only if they become series labels (grouping keys). `stats last(...) as b` with no `by` → `b` is the value, accessible via `{{ $value }}`, not `{{ $labels.b }}`. Telegram messages will render empty.

---

## Nits

- **N1.** `.env.example:121` — real-looking CIDR `192.168.122.10/32`. Fine, but note in comment "example only".
- **N2.** `poll-provider-cost.sh:26` — hardcoded `/root/onelog/...` couples script to deploy layout. Move to config.
- **N3.** Alertmanager route `team="llm-cost"` correctly matches; no dupe with `notify_style`. OK.

---

## Positives

- `.gitignore` correctly excludes `.env.cost`, `.env.llm`, `.env`.
- `.env.cost.example` has strong chmod/rotate guidance, no real secrets.
- Fail-soft bash design (`set -uo pipefail`, no `-e`) is intentional and documented.
- Grafana provisioning: anonymous off, sign-up off, `editable: false` on datasource — good defense-in-depth.
- Vector `filter_provider_cost` → `tag_provider_cost` split cleanly avoids double-ingest; sink `inputs` list updated correctly.
- vmalert `type: vlogs`, LogsQL syntax matches existing rule pattern; no `_time:` filter (correct).
- Dashboard `uid: victorialogs` consistent between datasource provisioning and panel refs.

---

## Unresolved Questions

1. Was Caddy config validated with `caddy validate` after adding admin.webui.local? Bare `respond` after `handle` needs order verification.
2. Does VictoriaLogs LogsQL support `math` pipe in current pinned image? (W3)
3. Is rsyslog on host actually configured to forward `provider_cost` tag to Vector `:6514`? Script assumes so.
4. Grafana `victoriametrics-logs-datasource` plugin — auto-install via `GF_INSTALL_PLUGINS` fetches from grafana.com registry. Air-gapped hosts will fail; document offline install fallback.

---

**Status:** DONE_WITH_CONCERNS
**Verdict:** APPROVE_WITH_CONCERNS (8.5/10)
**Top 3:** (1) Caddy Bearer fail-open when env unset, (2) caddy service missing env passthrough for CIDR/token, (3) vmalert annotations use `$labels.X` for stats-output values that aren't labels — Telegram msgs render blank.
**Report:** `d:\Vietnt\Project\onelog\plans\260709-1143-onelog-cost-dashboard\reports\code-reviewer-260709-1324-cost-dashboard-implementation.md`
