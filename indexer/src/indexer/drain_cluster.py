"""
Per-service Drain3 template miner with periodic binary snapshot.

Drain3 clusters raw log lines into templates (parameter slots → `<*>`),
so we embed *templates* not raw lines — cuts embed cost ~50-100x and
gives stable IDs for trending / dedup.

State persisted to {DRAIN_STATE_DIR}/{service}.bin via drain3 FilePersistence
(pickle format). TemplateMiner auto-loads on init.

Weighted add supports Vector-side reduce transform: upstream Vector emits
`.dedup_count=N` for aggregated events; DrainPool.add(msg, count=N) iterates
add_log_message so drain3 cluster.size accumulates correctly. Cap at
DRAIN_ITER_CAP prevents Lock stall under log storm (tail cases N>50 accept
minor undercount in drain3 aggregate — Qdrant point.count remains accurate
because it's weighted at slot-aggregation level, not from drain3).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from drain3 import TemplateMiner
from drain3.file_persistence import FilePersistence
from drain3.template_miner_config import TemplateMinerConfig

from indexer.config import settings
from indexer.logging_setup import log


@dataclass(slots=True)
class ClusterResult:
    template_id: int
    template: str
    cluster_size: int
    change_type: str  # "cluster_created" | "cluster_template_changed" | "none"


# Iteration cap for weighted add. Tail cases N>DRAIN_ITER_CAP accept minor
# undercount in drain3.cluster.size (aggregate metric only); Qdrant point.count
# stays accurate because it's summed at slot-aggregation in _process_batch.
# Prevents Lock stall under log storm — see Red Team Finding #10.
DRAIN_ITER_CAP = 50


class DrainPool:
    """One TemplateMiner per service, lazy-loaded via FilePersistence."""

    def __init__(self, state_dir: str | None = None) -> None:
        self._dir = Path(state_dir or settings.drain_state_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._miners: dict[str, TemplateMiner] = {}
        self._lock = Lock()
        self._last_snapshot = time.time()

    def _make_miner(self, service: str) -> TemplateMiner:
        cfg = TemplateMinerConfig()
        # Defaults are sensible for syslog-shaped messages. Tighten if unmatched_ratio creeps up.
        # sim_th 0.4 (revert from 0.5): với heavy redact upstream, drain vẫn thấy N
        # cluster từ PHP stack + SQL fragments không collapse hết → chấp nhận merge
        # aggressive hơn (thấp = tolerate diff nhiều hơn) để giảm cluster count.
        # max_clusters 10000: headroom cho fleet ~50 host, tránh evict → churn.
        cfg.drain_sim_th = 0.4
        cfg.drain_depth = 4
        cfg.drain_max_children = 100
        cfg.drain_max_clusters = 10000
        persistence = FilePersistence(str(self._path(service)))
        miner = TemplateMiner(persistence_handler=persistence, config=cfg)
        clusters = len(miner.drain.clusters)
        if clusters:
            log.info("drain.loaded", service=service, clusters=clusters)
        return miner

    def _path(self, service: str) -> Path:
        safe = service.replace("/", "_").replace("..", "_") or "unknown"
        return self._dir / f"{safe}.bin"

    def add(self, service: str, message: str, count: int = 1) -> ClusterResult:
        """Add a message (or N-weighted event from Vector reduce) to drain3.

        count > 1: iterate add_log_message capped at DRAIN_ITER_CAP. Above cap,
        cluster.size undercounts (accepted trade-off). Caller uses the returned
        cluster_size for observability only; Qdrant point.count aggregates
        the raw `count` value upstream at _process_batch.
        """
        # Bound to avoid Lock stall on huge forged/misconfigured count values.
        iters = max(0, min(count, DRAIN_ITER_CAP) - 1)
        with self._lock:
            miner = self._miners.get(service)
            if miner is None:
                miner = self._make_miner(service)
                self._miners[service] = miner
            res = miner.add_log_message(message)
            for _ in range(iters):
                miner.add_log_message(message)
        return ClusterResult(
            template_id=res["cluster_id"],
            template=res["template_mined"],
            cluster_size=res["cluster_size"] + iters,
            change_type=res["change_type"],
        )

    def snapshot_if_due(self) -> None:
        if time.time() - self._last_snapshot < settings.drain_persist_interval_s:
            return
        self.snapshot_all()

    def snapshot_all(self) -> None:
        with self._lock:
            items = list(self._miners.items())
        for svc, miner in items:
            try:
                miner.save_state("periodic")
            except Exception as exc:  # noqa: BLE001 — drain3 pickle can raise various
                log.error("drain.snapshot_failed", service=svc, err=str(exc))
        self._last_snapshot = time.time()

    def unmatched_ratio(self) -> float:
        """Estimate of new-cluster rate across all miners. 0 = all templates known."""
        with self._lock:
            total = sum(len(m.drain.clusters) for m in self._miners.values())
        # heuristic: more clusters = noisier. Real unmatched tracking handled batch-side.
        return total / max(1, settings.batch_size * 10)
