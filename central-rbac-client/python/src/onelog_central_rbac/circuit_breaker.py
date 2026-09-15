"""circuit_breaker.py — 3-state circuit breaker mirror @onelog/central-rbac-client.

closed → threshold failures → open → reset_sec → half-open → success → closed
                                                  half-open → failure → open

See ../../../SPEC.md §2.2 for state machine semantics.
"""
from __future__ import annotations

import time
from typing import Literal

State = Literal["closed", "open", "half-open"]


class CircuitBreaker:
    """3-state circuit breaker.

    Single-flight probe in half-open (prevents thundering herd).
    """

    def __init__(self, threshold: int, reset_sec: float) -> None:
        self._threshold = threshold
        self._reset_sec = reset_sec
        self._state: State = "closed"
        self._consecutive_failures = 0
        self._opened_at = 0.0
        self._probe_in_flight = False

    def can_proceed(self) -> bool:
        """Return True nếu request allowed. Manages state transitions."""
        if self._state == "closed":
            return True
        if self._state == "open":
            if (time.monotonic() - self._opened_at) >= self._reset_sec:
                self._state = "half-open"
                return self._claim_probe()
            return False
        # half-open
        return self._claim_probe()

    def _claim_probe(self) -> bool:
        if self._probe_in_flight:
            return False
        self._probe_in_flight = True
        return True

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._state = "closed"
        self._probe_in_flight = False

    def record_failure(self) -> None:
        self._probe_in_flight = False
        self._consecutive_failures += 1
        if self._state == "half-open":
            self._state = "open"
            self._opened_at = time.monotonic()
            return
        if self._consecutive_failures >= self._threshold:
            self._state = "open"
            self._opened_at = time.monotonic()

    def get_state(self) -> State:
        return self._state
