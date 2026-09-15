"""conftest.py — shared fixtures for Python conformance runner."""
from __future__ import annotations

import os
from collections.abc import Iterator

import pytest


@pytest.fixture(autouse=True)
def _clear_env_markers() -> Iterator[None]:
    """Guarantee no env leakage across scenarios."""
    saved = {
        k: os.environ.get(k)
        for k in ("ENV", "PYTHON_ENV", "APP_ENV", "NODE_ENV")
    }
    for k in saved:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is not None:
            os.environ[k] = v
        else:
            os.environ.pop(k, None)
