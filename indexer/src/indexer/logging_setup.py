"""structlog JSON logging — single setup, importable as `from indexer.logging_setup import log`."""
from __future__ import annotations

import logging

import structlog

from indexer.config import settings


def _configure() -> None:
    logging.basicConfig(format="%(message)s", level=settings.log_level.upper())
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelName(settings.log_level.upper())
        ),
        cache_logger_on_first_use=True,
    )


_configure()
log = structlog.get_logger("indexer")
