"""
Per-service Drain3 template miner with periodic JSON snapshot.

Drain3 clusters raw log lines into templates (parameter slots → `<*>`),
so we embed *templates* not raw lines — cuts embed cost ~50-100x and
gives stable IDs for trending / dedup.

State persisted to {DRAIN_STATE_DIR}/{service}.json. Atomic write (tmp + rename)
to survive crash mid-snapshot.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from drain3 import TemplateMiner
from drain3.template_miner_config import TemplateMinerConfig

from indexer.config import settings
from indexer.logging_setup import log


@dataclass(slots=True)
class ClusterResult:
    template_id: int
    template: str
    cluster_size: int
    change_type: str  # "cluster_created" | "cluster_template_changed" | "none"


class DrainPool:
    """One TemplateMiner per service, lazy-loaded + persisted to JSON."""

    def __init__(self, state_dir: str | None = None) -> None:
        self._dir = Path(state_dir or settings.drain_state_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._miners: dict[str, TemplateMiner] = {}
        self._lock = Lock()
        self._last_snapshot = time.time()

    def _make_miner(self) -> TemplateMiner:
        cfg = TemplateMinerConfig()
        # Defaults are sensible for syslog-shaped messages. Tighten if unmatched_ratio creeps up.
        cfg.drain_sim_th = 0.4
        cfg.drain_depth = 4
        cfg.drain_max_children = 100
        cfg.drain_max_clusters = 5000
        return TemplateMiner(config=cfg)

    def _path(self, service: str) -> Path:
        safe = service.replace("/", "_").replace("..", "_") or "unknown"
        return self._dir / f"{safe}.json"

    def _load(self, service: str) -> TemplateMiner:
        miner = self._make_miner()
        path = self._path(service)
        if path.exists():
            try:
                state = json.loads(path.read_text())
                miner.drain.restore_state(state)
                log.info("drain.loaded", service=service, clusters=len(miner.drain.clusters))
            except (json.JSONDecodeError, KeyError, AttributeError) as exc:
                log.warning("drain.load_failed", service=service, err=str(exc))
        return miner

    def add(self, service: str, message: str) -> ClusterResult:
        with self._lock:
            miner = self._miners.get(service)
            if miner is None:
                miner = self._load(service)
                self._miners[service] = miner
            res = miner.add_log_message(message)
        return ClusterResult(
            template_id=res["cluster_id"],
            template=res["template_mined"],
            cluster_size=res["cluster_size"],
            change_type=res["change_type"],
        )

    def snapshot_if_due(self) -> None:
        if time.time() - self._last_snapshot < settings.drain_persist_interval_s:
            return
        self.snapshot_all()

    def snapshot_all(self) -> None:
        with self._lock:
            services = list(self._miners.keys())
        for svc in services:
            self._snapshot_one(svc)
        self._last_snapshot = time.time()

    def _snapshot_one(self, service: str) -> None:
        with self._lock:
            miner = self._miners.get(service)
            if miner is None:
                return
            try:
                state = miner.drain.get_state()
            except Exception as exc:  # noqa: BLE001 — drain3 internals can throw various
                log.error("drain.state_failed", service=service, err=str(exc))
                return
        path = self._path(service)
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(state, default=str))
            os.replace(tmp, path)
        except OSError as exc:
            log.error("drain.snapshot_failed", service=service, err=str(exc))
            tmp.unlink(missing_ok=True)

    def unmatched_ratio(self) -> float:
        """Estimate of new-cluster rate across all miners. 0 = all templates known."""
        with self._lock:
            total = sum(len(m.drain.clusters) for m in self._miners.values())
        # heuristic: more clusters = noisier. Real unmatched tracking handled batch-side.
        return total / max(1, settings.batch_size * 10)
