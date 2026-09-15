"""epoch_poller.py — Background asyncio task polling Central /v2/epoch/:app_slug.

Mirror @onelog/central-rbac-client EpochPoller. On epoch change → invoke callback
(typically flush cache). On fetch error → log warn, keep polling.

See ../../../SPEC.md §2.3.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("onelog_central_rbac.epoch_poller")


class EpochPoller:
    """Background epoch polling task.

    Uses asyncio.create_task. Cancel on close() — equivalent to Node poller.stop().
    """

    def __init__(
        self,
        interval_sec: float,
        fetch_epoch: Callable[[], Awaitable[int]],
        on_epoch_change: Callable[[int, Optional[int]], None],
    ) -> None:
        self._interval_sec = interval_sec
        self._fetch_epoch = fetch_epoch
        self._on_epoch_change = on_epoch_change
        self._task: Optional[asyncio.Task[None]] = None
        self._last_known_epoch: Optional[int] = None
        self._stopped = False

    def start(self) -> None:
        if self._task is not None:
            return
        self._stopped = False
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        self._task = loop.create_task(self._run())

    async def stop(self) -> None:
        self._stopped = True
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        self._task = None

    async def _run(self) -> None:
        while not self._stopped:
            try:
                await asyncio.sleep(self._interval_sec)
                if self._stopped:
                    break
                await self._tick()
            except asyncio.CancelledError:
                break
            except Exception as err:  # noqa: BLE001
                logger.warning("epoch-poller: unexpected loop error: %r", err)

    async def _tick(self) -> None:
        try:
            current = await self._fetch_epoch()
        except Exception as err:  # noqa: BLE001
            logger.warning("epoch-poller: fetch failed — will retry next tick: %r", err)
            return

        if self._last_known_epoch is None:
            self._last_known_epoch = current
            return

        if current != self._last_known_epoch:
            old = self._last_known_epoch
            self._last_known_epoch = current
            try:
                self._on_epoch_change(current, old)
            except Exception as err:  # noqa: BLE001
                logger.warning("epoch-poller: on_epoch_change callback threw: %r", err)
