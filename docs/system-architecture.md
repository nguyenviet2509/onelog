# System Architecture

> Cross-cutting design notes. Core stack topology lives in [README.md](../README.md) (services table + ASCII diagram). Central RBAC portal + management backend documented in [central-rbac plan](../plans/260821-1644-central-rbac-single-pane).

## Vector Pipeline — Deduplication (2026-08-26)

**Problem:** At scale (70-100 host), NATS ingest rate saturates before hitting 25GB storage cap, blocking fleet expansion.

**Solution:** Vector `reduce` transform on NATS branch deduplicates by `[host, _msg]` over 30s windows before forwarding to Indexer.

### Design

- **Transform:** `reduce_dupes` (lines 588-611 in `infra/vector/vector.yaml`)
  - Groups on raw `_msg` post-redact (i.e., after secrets scrubbed but before reclassify_severity)
  - Window: 30s `expire_after_ms`
  - Accumulator cap: 10,000 events max per group (safety against DDoS/malformed data)
  - Merge strategy: `dedup_count: sum` → emits `.dedup_count` field with count of aggregated events

- **Placement:** Sits between `warn_filter` (severity ≥ WARN) and NATS sink — VictoriaLogs branch (VL sink) receives 100% of events, unchanged

- **Indexer support:** Drain3 cluster add() respects `.dedup_count` as weighted iteration count (capped at 10k to prevent DoS). Fallback to 1 for legacy non-reduced events.

### Empirical results (45-host baseline, 2026-08-26)

| Metric | Value |
|--------|-------|
| NATS ingest (before) | 328 msg/s |
| NATS ingest (after reduce) | 186 msg/s |
| Reduction | 43% |
| Dedup ratio | 2.10x (raw event counts → aggregated) |
| Runway gain | ~200 host before NATS 25GB cap fills |

**Note:** Real reduction is ~50%, not the brainstorm estimate of 80%. Most syslog events are already unique per 30s window due to embedded volatile tokens (timestamps, PIDs) post-redact. Dedup primarily catches repeated errors/warnings within the window.

### VL branch unchanged

All raw events still flow to VictoriaLogs via `redact` → `victorialogs` sink. The reduce transform does not consume or modify the VL path — it only sits on the WARN+ → NATS branch.

## Knowledge Base (OpenWebUI native, 2026-07-17)

Members save useful chat messages via OpenWebUI's built-in **Add to Note** button (sidebar Notes). Admin curates + uploads notes to a shared **Workspace → Knowledge** collection ("OneLog Runbook"). The collection is attached to the default model in OpenWebUI so it becomes a RAG source during chat.

No custom Next.js `/web` service, no Postgres, no OpenWebUI Function, no `/kb/*` endpoints. Prior custom KB (Phase 1, 2026-07-16) was removed the day after ship — see [journals/2026-07-16-kb-phase1-openwebui-pivot-shipped.md](journals/2026-07-16-kb-phase1-openwebui-pivot-shipped.md) for the pivot story, [project-changelog.md](project-changelog.md) for the 2026-07-17 removal entry.

## References

- [README.md](../README.md) — services + topology diagram
- [codebase-summary.md](codebase-summary.md) — module-by-module walkthrough
- [deployment-guide.md](deployment-guide.md) — env template + full deploy runbook
- [project-changelog.md](project-changelog.md) — recent changes
