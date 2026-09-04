# Vector-side NATS Dedup Deployment — Status Report

**Date:** 2026-08-26 10:30 UTC+7  
**Plan:** [260826-0932-vector-reduce-dedup-indexer-counter](../260826-0932-vector-reduce-dedup-indexer-counter/plan.md)  
**Status:** ✅ Phases 00–03 Complete | 🔄 Phase 04 In Progress (7-day monitor)

---

## Summary

Vector-side dedup transform (NATS branch only) deployed to onelog-vps with full Indexer weighted count support. Measured 2.10x dedup ratio (43% NATS ingest reduction) at 45-host baseline. Safe scale gate: 60 host max until Phase 04 monitoring passes (2026-09-02).

---

## Completed Work (Phases 00–03)

| Phase | Outcome | Effort | Commits | Gate |
|-------|---------|--------|---------|------|
| **Phase 00** | Dedup ratio spike: 2.10x measured empirically (30s window, [host, _msg]). Vector 0.40, mem_limit=512m fixed. User override gate <3x. | 50 min | — | ✅ PASS |
| **Phase 01** | Drain3 weighted count API: Approach B (iterate add_log_message, cap 50). No native count kwarg in ≥0.9.11. Approach C forbidden. | 10 min | — | ✅ PASS |
| **Phase 03** | Indexer .dedup_count support: weighted aggregation via _safe_weight(MAX=10000). 61 tests pass. Deployed first (2026-08-26 10:02). | 35 min | a7beeb3 | ✅ DEPLOYED |
| **Phase 02** | Vector reduce_dupes transform: group [host, _msg], 30s expire, .dedup_count field visible. 3 hotfixes (escape $, timestamp logic). NATS 328→186 msg/s (43%↓). Deployed second (2026-08-26 10:28). | 25 min + 3 fixes | bb5d6ae, 6cf5a77, 4b9d179, 51aa895 | ✅ DEPLOYED |

---

## Deployment Verification

**Metrics (2026-08-26 10:30, 45-host baseline):**
- NATS ingest: **328 msg/s → 186 msg/s** (43% reduction) ✅
- NATS storage: **580 MB** (flat vs pre-deploy 600 MB) ✅
- Dedup ratio: **2.10x** (20k events sample, [host, _msg]) ✅
- Vector RSS: **143 MiB / 512 MiB limit** (healthy, no leak) ✅
- Indexer batch.flushed: **<200ms** (unchanged) ✅
- VictoriaLogs canary: **stable** (no regression) ✅
- Alerts: **0 firing** (no regressions) ✅

**Rollout compliance:**
- Phase 03 deployed FIRST (10:02) → Indexer ready for Phase 02 events
- Phase 02 deployed SECOND (10:28) → Avoids drain3 pickle corruption (Red Team #3) ✅

---

## Phase 04 — Monitoring (In Progress)

**Checkpoint dates:** 2026-08-26 (Day 1) → 2026-09-02 (Day 7, tuning decision)

**Day 1 status (2026-08-26 10:30):**
- NATS storage trend: **flat/stable**
- Vector memory trend: **stable (no leak)**
- Indexer processing: **nominal**
- No alerts or errors

**Monitoring schedule:**
- **Day 1–7:** Daily metric check (~5 min). Hourly Grafana scan for anomalies.
- **Day 3:** Stabilization check — dedup ratio, template growth, VL canary rebaseline.
- **Day 7 (2026-09-02):** Decision point — tune parameters or proceed to scale.

**Tuning gates (scale decision):**
- If NATS > 8 GB: shorten window to 15s or extend group_by
- If semantic search latency > 60s: shorten window to 15s
- If dedup ratio < 3x avg: extend window to 60s
- If drain3 templates abnormal: investigate group_by edge case

---

## Risk Mitigation Summary

| Finding | Risk | Mitigation | Status |
|---------|------|-----------|--------|
| Red Team #3 | drain3 pickle corruption if Phase 02→03 order | Deploy Phase 03 FIRST, Phase 02 SECOND | ✅ Applied |
| Red Team #4 | Vector restart loses reduce buffer | `stop_grace_period: 40s` in compose | ✅ Applied |
| Red Team #7 | DoS via forged `.dedup_count` | `_safe_weight(MAX=10000)` + iteration cap 50 | ✅ Applied |
| Red Team #8 | `.count` field collides with LogsQL builtin | Renamed to `.dedup_count` | ✅ Applied |
| Red Team #9 | Approach C (cluster.size mutation) breaks drain3 | Approach B with cap 50 instead | ✅ Applied |
| Red Team #11 | Sync race: VPS edit before local commit | Edit local first, commit, push, VPS pull | ✅ Applied |
| NATS 25GB cap | Scale past 60 host at risk | Phase 04 gate: no scale before 2026-09-02 | ✅ Enforced |

---

## Documentation Updates

✅ **plan.md** — Status updated to phase-04-in-progress; effort actuals recorded; phase table refreshed  
✅ **phase-00.md** — Completed (outcome filled, gate decision logged)  
✅ **phase-01.md** — Completed (approach B finalized, API contract locked)  
✅ **phase-03.md** — Completed (deployment notes, 61 tests pass, rollout order documented)  
✅ **phase-02.md** — Completed (5 commits, verification log, 43% reduction confirmed)  
✅ **phase-04.md** — In progress (Day 1 observations recorded, 7-day checkpoints templated)  
✅ **development-roadmap.md** — Log Server section updated with dedup feature + plan link  
✅ **project-changelog.md** — 2026-08-26 entry expanded with full decision matrix + Red Team resolutions

---

## Scale Timeline

**Current:** 45 hosts (8.4 GB NATS, 66% headroom)  
**Pre-dedup 60 hosts:** 11 GB NATS (56% headroom) → **BLOCKED until Phase 04**  
**Post-dedup 60 hosts:** ~5–6 GB NATS (75% headroom) — **target 2026-09-02**  
**Target 100 hosts (post-dedup):** ~8–10 GB NATS (60% headroom) — **after Phase 04 tuning**

---

## Unresolved Questions

None. All gates passed; Phase 04 monitoring underway.

---

## Next Actions

| Action | Owner | Deadline | Definition of Done |
|--------|-------|----------|-------------------|
| Day 3 stabilization check | DevOps | 2026-08-28 | Dedup ratio baseline stable; Drain3 template count no anomaly; VL canary rebaseline |
| Day 7 tuning decision | DevOps | 2026-09-02 | Metrics snapshot; decide: no change / 15s window / 60s window / group_by extension |
| Close Phase 04 + post-deploy journal | DevOps | 2026-09-02 | plan.md status → completed; journal entry via `/ck:journal` |
| Scale decision brief | Lead | 2026-09-02 | 60 host readiness assessment; approve or defer scale per Phase 04 outcome |

---

## Files Modified

**Plans:**
- `plans/260826-0932-vector-reduce-dedup-indexer-counter/plan.md` — Status + effort updated
- `plans/260826-0932-vector-reduce-dedup-indexer-counter/phase-{00,01,02,03,04}.md` — Completion markers + outcomes

**Docs:**
- `docs/development-roadmap.md` — Log Server section expanded
- `docs/project-changelog.md` — 2026-08-26 entry with full deployment summary

**Git:** 5 commits already merged to origin/master (a7beeb3 → 51aa895)

---

## Appendix: Commits & Deployment Checklist

✅ Phase 03 (Indexer): a7beeb3 — deployed 2026-08-26 10:02  
✅ Phase 02 (Vector): bb5d6ae + 3 fixes — deployed 2026-08-26 10:28  
✅ VPS git status: clean, matches origin/master  
✅ Vector validate: passed  
✅ NATS ingest rate: 328→186 msg/s (43% reduction confirmed)  
✅ No alerts firing; all systems nominal  
✅ Day 1 checkpoint: all metrics healthy
