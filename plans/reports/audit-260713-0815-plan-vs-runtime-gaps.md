---
title: Plan 260710-1432 vs runtime — gap audit
date: 2026-07-13 08:15
scope: verify plan docs match actual deployed code + production safety after runtime lessons
outcome: prod deploy READY (code correct), docs có 6 gap cần patch
---

# Plan 260710-1432 — Code vs Docs vs Runtime audit

## TL;DR

**Code trong repo: đúng, prod-safe.** Đã validated end-to-end trên logserver-01:
- Docker log rotate applied 17/18 container
- 2 probe emit (data disk 0%, root 29%)
- vmalert 5 rules loaded state=inactive baseline
- Alert force-test PASS → Log-Server topic thread 15 nhận FIRING + RESOLVED

**Nhưng plan docs (phase-02.md, plan.md) không đồng bộ với code deployed.** Nếu operator mới đọc plan để deploy VPS khác → sẽ copy sai syntax, alert không fire.

## Gaps giữa plan docs và deployed code

### 🔴 CRITICAL — sẽ break prod nếu deploy dựa plan doc

| # | Gap | Doc (phase-02.md) | Actual code (rules.yml) | Impact |
|---|---|---|---|---|
| 1 | **filter syntax** | `filter value > 75` (math) | `filter value:>75` (word) | Math syntax test-runtime FAIL — không match anything, alert không fire |
| 2 | **AND operator** | `service:X AND source_stream:Y` explicit | Space-separated implicit AND | Explicit AND có thể parse khác trong LogsQL |
| 3 | **DiskProbeStale for:** | `for: 1m` | `for: 5m` (fix db5a6f1) | 1m → warmup false-alarm mỗi first-deploy |
| 4 | **`component:` label thiếu trong doc** | Không có | Có `component: data-disk\|root-partition\|disk-probe` | Alertmanager route matcher (5627162) fail — mọi disk alert rơi về default topic |
| 5 | **Alertmanager routing** | Không đề cập (out-of-plan-scope) | Có matcher `component=~"..."` route → Log-Server topic (thread từ `TELEGRAM_ALERT_THREAD_ID_LLM_COST`) | Operator không biết env var + route mới |
| 6 | **sudo prefix cho `docker compose --profile llm`** | Không có sudo | Cần sudo (`.env.llm` = 0400 root) | Operator mới sẽ hit permission denied |

### 🟡 SHOULD-FIX — doc quality nhưng không break prod

| # | Gap | Notes |
|---|---|---|
| 7 | Comment doc line 243: `filter uses math syntax value > N, không phải word value:>N` | Literally sai ngược. Actual dùng word syntax. |
| 8 | Force-test recipe: `sed 's/filter value > 75/filter value > 1/'` | Doc dùng math pattern → sed không match code thật (word syntax). |
| 9 | Baseline data disk = 0% → DiskDataHighWarn/Crit **không fire** khi force-test threshold `>1` | Force-test doc không nói rõ; runtime user hit issue này, phải test qua DiskRootHighWarn (root=29%). |
| 10 | LogsQL không support `filter value:>-N` (negative) | Runtime user test → không match. Doc không cảnh báo — threshold prod luôn dương nên OK, nhưng force-test dev có thể vấp. |

### 🟢 CONSISTENT — không có gap

- Vector probe script (`probe-logserver-disk.sh`) — doc = code
- Host cron probe script (`probe-host-disk-root.sh`) — doc = code
- Docker daemon.json config — doc = code
- Bind mount `/opt/ragstack/data:/host/data:ro,rslave` — doc = code
- Systemd sequence (stop ragstack → restart docker → start ragstack) — doc = code
- HEALTHCHECK Dockerfile agent — doc = code

## Runtime validation (đã proven trên logserver-01)

| Layer | Status |
|---|---|
| Docker log rotate: 17/18 container `max-size:10m` | ✅ (sqlite-web `[dbtools]` profile không recreate, không critical) |
| Vector data disk probe emit qua bind `/host/data` (rslave) | ✅ `/dev/sda4` 905 GB visible |
| Host cron probe `/` emit qua curl VL insert | ✅ used_pct=29% |
| vmalert load 5 rules disk-alerts | ✅ state=inactive baseline, health=ok |
| Anti-injection `source_stream` marker | ✅ set trong Vector transform |
| Force-test DiskRootHighWarn (threshold `>10`) → firing | ✅ |
| Alertmanager route `component=root-partition` → `telegram-llm-cost` receiver | ✅ |
| Telegram thread_id 15 (`TELEGRAM_ALERT_THREAD_ID_LLM_COST`) nhận FIRING | ✅ |

## Production safety when re-deploying to new VPS

**Nếu ops mới clone repo + follow plan docs → 3 vấn đề sẽ hit:**

1. Copy expression từ doc phase-02.md dùng `filter value > 75` → alert không fire.
2. Chạy `docker compose --profile llm ... up -d --force-recreate` không sudo → permission denied `.env.llm`.
3. Không biết cần update `.env`: `TELEGRAM_ALERT_THREAD_ID=<client-thread>` + `TELEGRAM_ALERT_THREAD_ID_LLM_COST=<logserver-thread>` — vì plan không cover routing.

**Nếu ops kéo code (git pull) + follow mockup `onelog-production-deploy.html` → 1 vấn đề:**
- Sudo issue (#6) — cả mockup + plan đều thiếu sudo prefix. Fix bằng update chỗ documenting `--profile llm` command.

## Recommended fix

**Wave A — patch doc để match runtime** (~15 phút):
1. Phase-02.md: sửa 5 expr từ `filter value > N` → `filter value:>N` (word syntax)
2. Phase-02.md: sửa comment `filter uses math syntax` → `word syntax`
3. Phase-02.md: sửa DiskProbeStale `for: 1m` → `for: 5m`
4. Phase-02.md: bổ sung `component:` label vào 5 rule blocks
5. Phase-02.md: force-test sed pattern update để khớp word syntax
6. Phase-02.md: bổ sung note "baseline data disk 0% → force-test qua DiskRootHighWarn thay DiskDataHighWarn"

**Wave B — capture out-of-plan changes** (~10 phút):
7. Plan.md: bổ sung section "Post-plan additions": alertmanager routing (5627162) + env var mapping (TELEGRAM_ALERT_THREAD_ID_LLM_COST = Log-Server topic)
8. Phase-01.md: add sudo prefix cho `docker compose --profile llm ... up -d --force-recreate`
9. Phase-02.md: add sudo prefix cho vector recreate + vmalert restart

**Wave C — semantic cleanup** (~20 phút, optional):
10. Rename env var `TELEGRAM_ALERT_THREAD_ID_LLM_COST` → `TELEGRAM_ALERT_THREAD_ID_LOGSERVER` (touches compose.yml sed placeholder + alertmanager.yml env + .env.example). Rename receiver `telegram-llm-cost` → `telegram-logserver`. Confusing naming forever otherwise.

## Verdict

- **Code correctness**: ✅ prod-ready
- **Doc-code sync**: ❌ 6 gap cần patch
- **New-VPS deployability from docs alone**: ⚠️ sẽ hit 3 blocker

**Recommend execute Wave A + B trước khi close plan (25 phút).** Wave C optional (semantic clarity long-term).

## Unresolved

- Rename env var (Wave C) — có làm không? Ảnh hưởng ops runbook + docs cross-project.
- `filter value:>-N` negative-number LogsQL behavior — chưa verified against VictoriaLogs source; nếu là bug documented → gửi issue upstream, nếu là intentional → giữ prod threshold dương.
- Sqlite-web (profile `[dbtools]`) container `log-config: []` empty — có cần force-recreate khi ops enable dbtools không? Note trong troubleshooting.
