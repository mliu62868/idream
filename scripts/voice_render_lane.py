"""One dedicated thread for speech synthesis, with a bounded wait."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import threading
from typing import Any, Awaitable, Callable, TypeVar

from fastapi import HTTPException

T = TypeVar("T")

DISCONNECT_POLL_SECONDS = 0.2


class QueuedRender:
    """Settles exactly once whether a queued render runs or is dropped."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state = "queued"

    def start(self) -> bool:
        with self.lock:
            if self.state == "dropped":
                return False
            self.state = "running"
            return True

    def drop(self) -> bool:
        with self.lock:
            if self.state == "running":
                return False
            self.state = "dropped"
            return True


class RenderLane:
    """Runs blocking speech work off the event loop, one request at a time.

    Synthesis used to run directly inside `async def` handlers, so every render
    stopped the event loop and the gateway's own readiness route stopped answering.
    Main's 2s probe then reported voice as down to every other user for the length
    of someone's render.

    One thread rather than a pool: MLX work has to stay on the thread that loaded
    the model, and these models render one request at a time regardless.
    """

    def __init__(self, max_pending: int) -> None:
        self.max_pending = max_pending
        self.pending = 0
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-render")

    async def run(self, work: Callable[..., T], *args: Any) -> T:
        return await asyncio.get_running_loop().run_in_executor(self.executor, partial(work, *args))

    async def admit(
        self,
        work: Callable[..., T],
        *args: Any,
        cancelled: Callable[[], Awaitable[bool]] | None = None,
    ) -> T:
        # A request that waits past Main's timeout renders for nobody, and the queue
        # keeps growing behind it. Refusing early is the only honest answer.
        if self.pending >= self.max_pending:
            raise HTTPException(status_code=503, detail="Voice synthesis queue is full", headers={"Retry-After": "5"})
        self.pending += 1
        try:
            if cancelled is None:
                return await self.run(work, *args)
            return await self._run_unless_cancelled(work, args, cancelled)
        finally:
            self.pending -= 1

    async def _run_unless_cancelled(
        self,
        work: Callable[..., T],
        args: tuple[Any, ...],
        cancelled: Callable[[], Awaitable[bool]],
    ) -> T:
        # SPEC: a caller that hung up before its render started takes up neither the
        # model nor a queue slot. A render already on the thread cannot be stopped, so
        # it finishes and its result reaches the idempotency cache for a retry.
        gone = HTTPException(status_code=499, detail="Voice client disconnected before its render started")
        if await cancelled():
            raise gone
        render = QueuedRender()

        def guarded() -> T:
            if not render.start():
                raise gone
            return work(*args)

        outcome = asyncio.get_running_loop().run_in_executor(self.executor, guarded)
        while render.state == "queued":
            done, _ = await asyncio.wait({outcome}, timeout=DISCONNECT_POLL_SECONDS)
            if done:
                break
            if await cancelled() and render.drop():
                outcome.cancel()
                raise gone
        return await outcome
