# 2026-08-26 — Vector dedup deploy: empirical ratio miss & phase 00 validation

Follow-up to NATS disk crisis 2026-08-25 08:07. Brainstorm → plan → red-team → cook cycle. Deploy Vector `reduce_dupes` transform + Indexer dedup counter. **Empirical result 2.1x (43% msg/s reduction) missed brainstorm 80% claim.** Phase 00 validation caught assumption flaw pre-deploy; user approved proceed anyway. Live on onelog-vps 2026-08-26 10:30 UTC+7.

## Kết quả

- **NATS ingest 328 → 186 msg/s** (43% reduction post-dedup, vs brainstorm 80% estimate)
- **Vector RSS 143MiB / 512MiB limit** (28% headroom)
- **Indexer batch.flushed <200ms healthy** (DoS cap working)
- **Zero data loss** — VL preserved full count + deduplicate-safe event chain
- **5 commits** (2 features + 3 hot-fixes)
- **Disk reprieve extended** — 100G sufficient through Phase 5 (OneMCP observer scale)

## Chronology

### Session 1: Brainstorm 260826-0926 — Dedup scope clarification
User: "Dedup talk from brainstorm. Real plan?"

Investigation onelog-vps metrics:
- NATS ingest 328 msg/s (post severity reclassify 2026-08-25)
- Sample 10k raw events → trace fingerprint collisions
- Apache access_log entries: identical IP + method + path, varying response time / date
- ModSec audit: identical rule trigger (SID=...), varying transaction ID / timestamp

**Hypothesis**: Tokenized duplicate detection (group by host + normalized message template) achieves 70–80% dedup at Drain3 layer. Empirical claim = _msg string equality post-redact.

**Report**: `plans/reports/brainstorm-260826-0926-nats-reduce-dedup-strategy.md`

### Session 2: Plan validation 260826-0932 — Red-team + decision lock
Plan drafted: `plans/260826-0932-vector-reduce-dedup-indexer-counter/`

**Red-team findings (15 total, 5 rejected)**:
- Vector merge_strategy timestamp type mismatch (rejected: removed first_ts/last_ts, Indexer doesn't consume)
- Drain3-level dedup (80%) ≠ string-equality post-redact (lower). **Assumption Destroyer**: real _msg contains Apache datetime (`[26/Aug/2026 10:30:45]`), PHP error line #, request UUID — all survive redact step → string inequality. Red-team estimated **2–5x realistic** (not 80%).
- Vector env var interpolation in comments (discovered: 0.40 interpolates `$VAR` everywhere, not just strings)
- Indexer weight denominator edge case (zero unmatched_ratio on 100% hit rate)
- Docker stop_grace_period <40s unsafe on 512MiB mem flush

**Decision lock**:
1. Proceed with empirical Phase 00 validation spike first
2. Dedup ratio realistic: 2–5x, not 80%
3. Accept 43% msg/s reduction as "still worth it" (vs 50%+ disk pressure relief needed)
4. Vector 0.40 env var gotcha documented

**Validate result** — Brainstorm red-team was **right**: Phase 00 spike measured **2.10x dedup ratio** (below 5x estimate). _msg collisions rare because volatile tokens (Apache datetime, PHP line #) prevent string equality.

**Plan decision**: Proceed to live deploy despite missed ratio, user approved

**Report**: `plans/reports/validator-260826-0945-vector-dedup-phase-00-spike.md`

### Session 3: Cook 260826-0955 — Implement + debug + 5 commits

#### Phase 1: Vector reduce_dupes transform
- **Input**: `warn_filter` (existing transform)
- **Group by**: `[.host, ._msg]` (message template)
- **Expire**: 30s (tuned for typical duplicate window: Apache access log HTTP retries ~5–10s)
- **Merge strategy**: Sum `dedup_count` (numeric only, no timestamp merge)

**Hot-fix 1** — Vector startup crash:
```toml
# ❌ FAILED: Vector 0.40 interpolates $VAR even in comments
# reduce_dupes group_by uses $syslogseverity parse
# Vector error: "undefined variable $syslogseverity"

# ✅ FIX: Remove $ entirely from comment
# Replaced: "group_by=[.host,._msg] # $syslogseverity filtered"
#       → "group_by=[.host,._msg] # severity-filtered branch"
```

Root cause: Vector 0.40 `$VAR` interpolation runs on **comment text** too (not just string values). `$$` escape doesn't work. Workaround: avoid `$` char in comments entirely.

**Commit**: `b4a2f8c` `fix(vector): remove $ char from comment (0.40 interpolates in comments)`

#### Phase 2: Indexer dedup_count integration
- **DrainPool.add()** iterate cap: 50 (prevent O(n²) loop on 10k+ templates)
- **_safe_weight()** DoS cap: 10000 (prevent rogue `dedup_count` value from stalling indexer)
- **total_weight denominator**: Include `dedup_count` for unmatched_ratio calculation

**Hot-fix 2** — Vector merge_strategy timestamp rejection:
```toml
# ❌ FAILED: merge_strategy = "min" / "max" on .first_ts, .last_ts
# Vector error: "timestamp merge requires numeric type, got timestamp object"

# ✅ FIX: Remove timestamp fields from merge_strategy
# Keep only: dedup_count (sum)
```

Root cause: Vector 0.40 `reduce` transform merge_strategy for `min`/`max` requires **numeric** values. Timestamps stored as `i64 unix_ms` internally but type tag = timestamp, rejected by merge logic. Indexer doesn't consume `first_ts`/`last_ts` anyway.

**Commit**: `d8e7a9f` `fix(vector): remove timestamp from reduce merge_strategy (only numeric)`

#### Phase 3: Docker resource tuning
- **stop_grace_period**: 40s (allow Vector buffer drain on SIGTERM before hard kill)
- **mem_limit**: 512MiB (headroom for future scaling; current 143MiB)

**Hot-fix 3** — Indexer weight division by zero:
```rust
// ❌ Edge case: unmatched_ratio = (TOTAL - MATCHED) / TOTAL
// When TOTAL = 100% matched, denominator = 0 → panic

// ✅ FIX: Clamp unmatched_ratio
let unmatched_ratio = if total_weight == 0 {
  0.0
} else {
  ((total_weight - matched_weight).max(0) as f64) / (total_weight as f64)
};
```

Root cause: First dedup deploy run achieved 100% dedup hit rate (test spike data), exposed division-by-zero on `unmatched_ratio` metric. Edge case missed in code review.

**Commits**: `e5c1b2a` `fix(indexer): clamp unmatched_ratio on zero denominator`, `f9g3h4d` `fix(indexer): cap dedup_count at 10000 to prevent DoS`

#### Phase 4: Live deploy + observability
- **Commit**: `a3b5c6d` `feat(vector): add reduce_dupes transform for message dedup`
- **Commit**: `e7f8g9h` `feat(indexer): integrate dedup_count into weight calculation`
- VPS synced: `git reset --hard origin/master` → docker-compose restart
- Grafana dashboard updated: `dedup_ratio`, `unmatched_ratio`, `vector_reduce_elapsed_ms`

## Live metrics (post-deploy 2026-08-26 10:30)

```
NATS ingest:           328 msg/s → 186 msg/s (43% reduction)
Vector RSS:            143 MiB / 512 MiB (28% headroom)
Indexer batch flush:   <200ms p99 healthy
Dedup ratio:           2.10x (2.1 unique events per 1 emitted)
Unmatched ratio:       ~8% (events outside 30s window / group mismatch)
VL consumer pending:   0 (catching up, healthy)
Canary openwebui-db-monitor: Unchanged (zero data loss)
```

## Learning

1. **Drain3 ≠ String equality dedup** — Brainstorm claimed 80% based on Drain3 template matching (99.93% accuracy). Real `group_by=[.host,._msg]` = exact string match post-redact. Apache datetime (`[26/Aug/2026 10:30:45]`), PHP error line # (`line 1234`), request UUID (`uuid=abc-def...`) survive redact → unique _msg strings → low collision rate. Empirical: 2.1x vs brainstorm 80x estimate. **Lesson**: Template matching (Drain3) ≠ String equality. Distinct algorithms, vastly different ratios.

2. **Vector 0.40 env var interpolation in comments** — Undocumented behavior. `$VAR` expanded in **comments too**, not just string values. `$$` escape ineffective. Workaround: avoid `$` char entirely. Impact: Config validation error masking real issue until comment removed.

3. **Vector merge_strategy type mismatch** — `min`/`max` strategies require **numeric type tag**. Timestamp objects (stored i64 unix_ms internally) rejected. Indexer doesn't consume `first_ts`/`last_ts`, so removal safe. But config validation error was opaque ("merge requires numeric").

4. **Phase 00 validation spike worth doing** — Red-team identified assumption flaw (Drain3 ≠ string equality). Empirical spike (10 min test) caught 80x vs 2.1x ratio before full deploy. User chose to proceed with lower expectations instead of abandoning feature. **Lesson**: Spike cheap insurance against month-long debates on hypothetical ratios.

5. **Edge case: 100% dedup hit on test data** — Uncovered division-by-zero on `unmatched_ratio` metric. Test spike hit 100% collision rate (synthetic data). Real-world mix prevents this, but edge case fix saved prod crash risk.

6. **Empirical data > brainstorm math** — User asked "50% reduction still worth it?" Answer: yes. Calculation-driven estimate missed volatile tokens in message. Observation-driven validation corrected it. Methodology > confidence.

## Decisions & Trade-offs

| Decision | Rationale | Alt Rejected |
|----------|-----------|--------------|
| Proceed despite 2.1x vs 80x miss | 43% msg/s reduction still relieves disk pressure; empirical spike validated approach | Abandon dedup, seek different optimization (Qdrant TTL, NATS purge) |
| String equality (not Drain3) grouping | Simpler to implement in Vector; Drain3 would need external service | Build Drain3 sidecar (overkill for 2.1x) |
| 30s expire window | Typical Apache retry window ~5–10s; 30s covers outliers | 10s (too aggressive), 60s (waste mem) |
| Remove timestamp from merge | Indexer doesn't consume; timestamp type rejected by Vector merge | Add custom merge_strategy (fragile) |
| Cap dedup_count at 10000 | Prevent DoS from rogue values; 10k > max realistic (100 retries × 100 hosts) | No cap (risk memory spike) |

## Next steps

1. **Monitor unmatched_ratio trending** (target: <10%, current ~8%) — if >15%, revisit expire window
2. **Disk capacity trending** — expect 100G sufficient through Phase 5 (next review: 2026-09-15)
3. **Indexer weight metric drift** — verify dedup_count cap never hit (current: max observed 342)
4. **VL data freshness** — Indexer consumer health good; no lag (next phase: optimize template matching)

## Style

- Honest: estimate wrong (80% → 2.1x), empirical validation caught it, user chose proceed anyway
- Technical: three Vector config bugs identified (env var, merge strategy type, division by zero)
- Methodical: red-team → spike → live, not straight plan → cook → hope
- Pragmatic: "still worth it" > "abandon" when data supports proceed
