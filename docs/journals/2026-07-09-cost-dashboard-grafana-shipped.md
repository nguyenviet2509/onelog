# Cost dashboard — Grafana OSS + caddy subdomain shipped

**Date:** 2026-07-09
**Plan:** [260709-1143-onelog-cost-dashboard](../../plans/260709-1143-onelog-cost-dashboard/)
**Status:** ✅ Code-ready. Windows dev env blocked docker verification — 12-item deploy checklist in plan.md for logserver ops.

## What landed
- **Grafana OSS 11.x** container + datasource (VictoriaMetrics cost + annotation rules).
- **Caddy virtual host** `admin.webui.local` — 3-layer auth stack: CIDR 10.0.0.0/8 + Bearer token + Grafana login.
- **Provider cost poll** `infra/scripts/poll-provider-cost.sh` — 15m cron pulls Anthropic/OpenAI/Cohere balances + vmalert records `current_balance` metric.
- **vmalert rules** — 5 cost thresholds (daily limit hit, provider balance low, LiteLLM overage) + Slack alerting.
- **Runbook** `docs/cost-dashboard.md` — ops setup, metrics glossary, alert tuning guide.
- **UI mockup** synced — cost dashboard grid + provider cards + anomaly timeline.

## Inflection points
1. **UI flip-flop → Grafana settled.** User initially accepted Grafana, switched to "Custom Next.js", then reverted. Trade-off table now in plan.md: Grafana wins on time-to-deploy vs polish. Lesson: nail UI spec before cook sprint.
2. **Access model: subdomain not subpath.** Chose `admin.webui.local` over `/admin/cost` for clear operational boundary (admin ≠ chat). Simplifies RBAC, audit, and future mfa scope.
3. **Two-source cost truth.** LiteLLM `json_logs` (realtime, existing) + provider API poll (15m lag, authoritative). Cross-check guards against accounting drift. Gemini skipped (no public balance API).
4. **Auto-review flagged 8.5/10** — below auto-approve 9.5 threshold. Fixed 2 critical issues inline:
   - Caddy `{$VAR}` requires `compose env pass`, not Caddyfile inline defaults.
   - Bearer token middleware must NOT fail-open on missing header.
   - Bonus: vmalert `as X` column templating fixed (`{{ $value }}` not `{{ $labels.X }}`).
5. **Parallel workers succeeded.** 3 infra agents (grafana/caddy/poll) + 1 alerts + 1 docs — zero file conflicts because task ownership was explicit (file glob patterns per agent).

## Verified & unresolved
✅ Code compiles, linting clean, docs complete.  
❌ Windows can't run docker → tests unverified.  
⏳ Logserver ops must run 12-step deploy checklist (see plan.md § Post-Cook Verification).

## Lessons for next cook
- **Caddy gotcha:** env var `{$X}` resolves from container env only. Compose `.environment:` must explicitly pass-through. Silent fail-open is dangerous.
- **vmalert annotation templating:** `stats ... as X` binds to `$value`, NOT `$labels.X`. Documentation unclear; discovered in code review.
- **Parallel subagent scale works.** File ownership clarity (one agent per infra domain) prevents merge chaos.
- **Auto-review threshold (9.5) is protective.** At 8.5, two real bugs would ship without human eyes. Keep threshold strict.

## Next steps
1. Logserver ops: Run docker-compose + curl tests (plan.md checklist).
2. Verify Anthropic/Cohere balance poll returns live data.
3. Validate vmalert rules fire on threshold breach + Slack routes.
4. Once deploy verified: merge to master, close plan.
