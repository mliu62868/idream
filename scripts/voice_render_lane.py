"""One dedicated thread for speech synthesis, with a bounded wait."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, Callable, TypeVar

from fastapi import HTTPException

T = TypeVar("T")


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

    async def admit(self, work: Callable[..., T], *args: Any) -> T:
        # A request that waits past Main's timeout renders for nobody, and the queue
        # keeps growing behind it. Refusing early is the only honest answer.
        if self.pending >= self.max_pending:
            raise HTTPException(status_code=503, detail="Voice synthesis queue is full", headers={"Retry-After": "5"})
        self.pending += 1
        try:
            return await self.run(work, *args)
        finally:
            self.pending -= 1
