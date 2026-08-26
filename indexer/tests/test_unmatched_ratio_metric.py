"""Verify unmatched_ratio metric correctly accounts for weighted events (not raw batch length)."""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from indexer import metrics
from indexer.drain_cluster import DrainPool
from indexer.embed_client import EmbedClient
from indexer.main import _process_batch
from indexer.qdrant_writer import QdrantWriter


@pytest.fixture
def drain_pool(tmp_path: Path) -> DrainPool:
    """Fresh DrainPool for each test."""
    return DrainPool(state_dir=str(tmp_path))


@pytest.fixture
def mock_embed_client() -> EmbedClient:
    """Mock EmbedClient that returns dummy vectors."""
    client = AsyncMock(spec=EmbedClient)
    async def mock_embed(templates: list[str]) -> list[list[float]]:
        return [[0.1] * 768 for _ in templates]
    client.embed = mock_embed
    return client


@pytest.fixture
def mock_qwriter() -> QdrantWriter:
    """Mock QdrantWriter."""
    writer = AsyncMock(spec=QdrantWriter)
    writer.upsert = AsyncMock()
    return writer


@pytest.mark.asyncio
async def test_unmatched_ratio_uses_total_weight_not_batch_size(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """
    Unmatched ratio = new_clusters / total_weighted_events.
    If we have 2 events with counts [5, 5] = 10 total_weight, and 1 new cluster,
    ratio should be 1/10, not 1/2.
    This is critical because Vector reduces events 10-100x; denominator must be
    raw count, not dedup'd batch size.
    """
    # Fresh metric before test
    initial_ratio = metrics.drain_unmatched_ratio._value.get()

    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "first unique template",  # Will create cluster (change_type='cluster_created')
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": 5,
        },
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "first unique template",  # Same → no new cluster
            "_time": "2026-08-26T10:01:00Z",
            "dedup_count": 5,
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    # Check metric: should be 1 new cluster / 10 total_weight = 0.1
    final_ratio = metrics.drain_unmatched_ratio._value.get()
    assert final_ratio == pytest.approx(1.0 / 10.0, abs=0.001)


@pytest.mark.asyncio
async def test_unmatched_ratio_counts_new_clusters_only(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Only 'cluster_created' events count as unmatched."""
    # Pre-populate known cluster
    drain_pool.add("app1", "known message", count=1)

    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "known message",  # Existing cluster → change_type != 'cluster_created'
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": 100,
        },
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "new unique message",  # New cluster
            "_time": "2026-08-26T10:01:00Z",
            "dedup_count": 100,
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    # Ratio = 1 new cluster / 200 total_weight = 0.005
    final_ratio = metrics.drain_unmatched_ratio._value.get()
    assert final_ratio == pytest.approx(1.0 / 200.0, abs=0.001)


@pytest.mark.asyncio
async def test_unmatched_ratio_zero_when_all_known(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """No new clusters → ratio = 0."""
    drain_pool.add("app1", "known message", count=1)

    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "known message",
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": 50,
        },
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "known message",
            "_time": "2026-08-26T10:01:00Z",
            "dedup_count": 50,
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    # Ratio = 0 new clusters / 100 total_weight = 0
    final_ratio = metrics.drain_unmatched_ratio._value.get()
    assert final_ratio == pytest.approx(0.0, abs=0.001)


@pytest.mark.asyncio
async def test_unmatched_ratio_empty_batch_noop(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Empty batch should not crash or affect metric."""
    events: list[dict] = []
    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)
    # Should complete without error; metric unchanged
    # (exact value depends on prior state, just verify no exception)
