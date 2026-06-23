"""Verify Drain3 wrapper clusters similar lines + survives snapshot/restore."""
from __future__ import annotations

import random
from pathlib import Path

from indexer.drain_cluster import DrainPool


def _gen_nginx(n: int = 500) -> list[str]:
    """Same template, varying IP/status/path/bytes → should collapse to ~handful of clusters."""
    paths = ["/api/users", "/api/orders", "/login", "/healthz"]
    rng = random.Random(42)
    return [
        f'{rng.randint(1,254)}.{rng.randint(0,255)}.{rng.randint(0,255)}.{rng.randint(1,254)} '
        f'- - [25/Jun/2026:10:{rng.randint(0,59):02d}:00 +0000] '
        f'"GET {rng.choice(paths)} HTTP/1.1" {rng.choice([200, 404, 500])} {rng.randint(100,9000)}'
        for _ in range(n)
    ]


def test_clusters_compress_variants(tmp_path: Path) -> None:
    pool = DrainPool(state_dir=str(tmp_path))
    lines = _gen_nginx(1000)
    ids = {pool.add("nginx", line).template_id for line in lines}
    # 1000 varied lines → far fewer than 50 templates expected on syslog-like data.
    assert len(ids) < 50, f"too many templates: {len(ids)}"


def test_snapshot_and_restore(tmp_path: Path) -> None:
    pool = DrainPool(state_dir=str(tmp_path))
    for line in _gen_nginx(200):
        pool.add("nginx", line)
    pool.snapshot_all()
    assert (tmp_path / "nginx.json").exists()

    # Fresh pool — should load existing state and keep cluster ids stable.
    pool2 = DrainPool(state_dir=str(tmp_path))
    res = pool2.add("nginx", '8.8.8.8 - - [25/Jun/2026:10:00:00 +0000] "GET /api/users HTTP/1.1" 200 1234')
    # Cluster should already exist — change_type != "cluster_created".
    assert res.change_type != "cluster_created"


def test_service_isolation(tmp_path: Path) -> None:
    """Templates from different services must not bleed into each other's state files."""
    pool = DrainPool(state_dir=str(tmp_path))
    pool.add("nginx", '1.1.1.1 - - [25/Jun/2026:10:00:00 +0000] "GET /a HTTP/1.1" 200 100')
    pool.add("mysql", "[ERROR] [MY-013183] [Server] Got error from storage engine")
    pool.snapshot_all()
    assert (tmp_path / "nginx.json").exists()
    assert (tmp_path / "mysql.json").exists()
