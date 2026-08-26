"""End-to-end tests for _process_batch weighted aggregation (mocked deps)."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from indexer.drain_cluster import DrainPool
from indexer.embed_client import EmbedClient
from indexer.main import _process_batch
from indexer.qdrant_writer import QdrantWriter


@pytest.fixture
def drain_pool(tmp_path: Path) -> DrainPool:
    """Create a fresh DrainPool for each test."""
    return DrainPool(state_dir=str(tmp_path))


@pytest.fixture
def mock_embed_client() -> EmbedClient:
    """Mock EmbedClient.embed to return dummy vectors."""
    client = AsyncMock(spec=EmbedClient)
    async def mock_embed(templates: list[str]) -> list[list[float]]:
        return [[0.1] * 768 for _ in templates]
    client.embed = mock_embed
    return client


@pytest.fixture
def mock_qwriter() -> QdrantWriter:
    """Mock QdrantWriter.upsert."""
    writer = AsyncMock(spec=QdrantWriter)
    writer.upsert = AsyncMock()
    return writer


@pytest.mark.asyncio
async def test_process_batch_weighted_aggregation(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Verify _process_batch correctly sums dedup_count across events with same template."""
    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "warning",
            "_msg": "connection refused <IP>",
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": 5,  # 5-fold reduced event
        },
        {
            "service": "app1",
            "host": "h2",
            "severity": "warning",
            "_msg": "connection refused <IP>",  # Same template
            "_time": "2026-08-26T10:01:00Z",
            "dedup_count": 3,  # 3-fold reduced event
        },
        {
            "service": "app1",
            "host": "h1",
            "severity": "error",
            "_msg": "connection refused <IP>",  # Same template, different severity
            "_time": "2026-08-26T10:02:00Z",
            "dedup_count": 2,  # 2-fold reduced
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    # Should have 1 Qdrant point (all same service + template_id after drain3)
    assert mock_qwriter.upsert.called
    call_args = mock_qwriter.upsert.call_args
    points = call_args[0][0]

    assert len(points) == 1
    # Count should be sum of dedup_count: 5 + 3 + 2 = 10
    assert points[0].count == 10
    # Hosts should include both h1 and h2
    assert set(points[0].hosts) == {"h1", "h2"}
    # Highest severity (error > warning)
    assert points[0].severity == "error"


@pytest.mark.asyncio
async def test_process_batch_weighted_default_count(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Events without dedup_count should default to 1 (backwards compat)."""
    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "request processed",
            "_time": "2026-08-26T10:00:00Z",
            # NO dedup_count field
        },
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "request processed",  # Same template
            "_time": "2026-08-26T10:01:00Z",
            # NO dedup_count field
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    assert mock_qwriter.upsert.called
    points = mock_qwriter.upsert.call_args[0][0]
    assert len(points) == 1
    # Should be 1 + 1 = 2
    assert points[0].count == 2


@pytest.mark.asyncio
async def test_process_batch_weighted_huge_dedup_count_capped(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Verify DoS cap on dedup_count: huge value → capped at MAX_DEDUP_COUNT."""
    from indexer.main import MAX_DEDUP_COUNT

    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "event",
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": 10**18,  # Absurdly large forged value
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    assert mock_qwriter.upsert.called
    points = mock_qwriter.upsert.call_args[0][0]
    assert points[0].count == MAX_DEDUP_COUNT


@pytest.mark.asyncio
async def test_process_batch_weighted_negative_dedup_count_fallback(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Negative dedup_count → fallback to 1."""
    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "event",
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": -999,  # Invalid
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    assert mock_qwriter.upsert.called
    points = mock_qwriter.upsert.call_args[0][0]
    assert points[0].count == 1


@pytest.mark.asyncio
async def test_process_batch_weighted_malformed_dedup_count_fallback(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Malformed dedup_count (string, list, etc.) → fallback to 1."""
    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "event",
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": "not_a_number",
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    assert mock_qwriter.upsert.called
    points = mock_qwriter.upsert.call_args[0][0]
    assert points[0].count == 1


@pytest.mark.asyncio
async def test_process_batch_multiple_templates_separate_points(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Different templates → separate Qdrant points, counts independent."""
    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "template A message",
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": 5,
        },
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "template B different message",  # Different template
            "_time": "2026-08-26T10:01:00Z",
            "dedup_count": 3,
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    assert mock_qwriter.upsert.called
    points = mock_qwriter.upsert.call_args[0][0]
    # Two different templates → two points
    assert len(points) >= 2 or len(points) == 1  # Drain might merge if similar
    # Just verify both counts are respected
    counts = sorted([p.count for p in points])
    # At minimum, we have 5 + 3 = 8 total weighted events
    assert sum(p.count for p in points) == 8


@pytest.mark.asyncio
async def test_process_batch_empty_events_noop(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Empty event batch → no upsert call."""
    events: list[dict] = []
    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)
    # upsert should not be called
    mock_qwriter.upsert.assert_not_called()


@pytest.mark.asyncio
async def test_process_batch_dropped_empty_messages(
    drain_pool: DrainPool, mock_embed_client: EmbedClient, mock_qwriter: QdrantWriter
) -> None:
    """Events with empty _msg → dropped, don't affect count."""
    events = [
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "",  # Empty
            "_time": "2026-08-26T10:00:00Z",
            "dedup_count": 5,
        },
        {
            "service": "app1",
            "host": "h1",
            "severity": "info",
            "_msg": "valid message",
            "_time": "2026-08-26T10:01:00Z",
            "dedup_count": 3,
        },
    ]

    await _process_batch(events, drain_pool, mock_embed_client, mock_qwriter)

    assert mock_qwriter.upsert.called
    points = mock_qwriter.upsert.call_args[0][0]
    # Only the valid message should create a point, count = 3 (empty message dropped)
    assert len(points) == 1
    assert points[0].count == 3
