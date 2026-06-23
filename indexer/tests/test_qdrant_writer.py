"""Point id is deterministic & idempotent across re-runs in the same window."""
from __future__ import annotations

from indexer.qdrant_writer import QdrantWriter, TemplatePoint


def _point(template_id: int = 42, window: str = "2026-06-23T10:00:00+00:00") -> TemplatePoint:
    return TemplatePoint(
        template_id=template_id,
        template="GET <*> HTTP/1.1 <*>",
        service="nginx",
        host="srv-01",
        severity="warning",
        window_start=window,
        window_end=window,
        count=5,
        sample="redacted sample",
        vector=[0.0] * 1536,
    )


def test_point_id_stable() -> None:
    a = QdrantWriter._point_id(_point())
    b = QdrantWriter._point_id(_point())
    assert a == b


def test_point_id_differs_by_template() -> None:
    assert QdrantWriter._point_id(_point(1)) != QdrantWriter._point_id(_point(2))


def test_point_id_differs_by_window() -> None:
    a = QdrantWriter._point_id(_point(window="2026-06-23T10:00:00+00:00"))
    b = QdrantWriter._point_id(_point(window="2026-06-23T10:01:00+00:00"))
    assert a != b
