"""Expires the voice gateways' speech cache, which is only a retry cache.

Main stores each delivered clip durably as MP3. An entry matters only while a retry or
a lease recovery of its request could still come back. Past that, a request that does
return simply renders again under the same key, and nothing depends on the cached bytes
except a request pinned to a retired model, which can no longer render at all.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
import threading
import time
from typing import Any

SWEEP_INTERVAL_SECONDS = 3_600
FIRST_SWEEP_DELAY_SECONDS = 60
DEFAULT_TTL_DAYS = "7"

logger = logging.getLogger(__name__)


def cache_ttl_seconds() -> float | None:
    """`VOICE_CACHE_TTL_DAYS`; 0 keeps entries until account erasure removes them."""
    days = float(os.getenv("VOICE_CACHE_TTL_DAYS", DEFAULT_TTL_DAYS).strip() or DEFAULT_TTL_DAYS)
    if days < 0:
        raise RuntimeError("VOICE_CACHE_TTL_DAYS must not be negative")
    return days * 86_400 if days else None


def is_expired(path: Path, cutoff: float) -> bool:
    try:
        return path.stat().st_mtime < cutoff
    except FileNotFoundError:
        return False


def sweep_speech_cache(directory: Path, ttl_seconds: float, lock: Any, now: float | None = None) -> int:
    """Removes entries and abandoned partial writes not used within the TTL.

    INVARIANT: only this directory's own cache files are candidates. The erasure markers
    live in a subdirectory and must outlive every cache entry, or an erased key could
    render again.
    INVARIANT: an entry is rechecked and removed under the lock replays and renders hold,
    so a replay never reads a file that disappears under it, and one that just refreshed
    an entry keeps it. The lock is taken per file because a render holds it for seconds.
    """
    cutoff = (time.time() if now is None else now) - ttl_seconds
    removed = 0
    for path in [*directory.glob("*.cache"), *directory.glob(".*.cache.*.tmp")]:
        if not is_expired(path, cutoff):
            continue
        with lock:
            if is_expired(path, cutoff):
                path.unlink(missing_ok=True)
                removed += 1
    return removed


def refresh_entry(path: Path) -> None:
    # A replayed entry is still in use. Failing to record that only makes it expire sooner.
    try:
        os.utime(path)
    except OSError:
        pass


class CacheJanitor:
    def __init__(self, directory: Path, lock: Any, ttl_seconds: float | None) -> None:
        self.directory = directory
        self.lock = lock
        self.ttl_seconds = ttl_seconds
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if self.ttl_seconds is None:
            return
        self.thread = threading.Thread(target=self._run, name="voice-cache-janitor", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stopping.set()

    def _run(self) -> None:
        delay = FIRST_SWEEP_DELAY_SECONDS
        while not self.stopping.wait(delay):
            delay = SWEEP_INTERVAL_SECONDS
            try:
                removed = sweep_speech_cache(self.directory, self.ttl_seconds, self.lock)
                if removed:
                    logger.info("voice cache janitor removed %d expired entries", removed)
            # A failed sweep costs disk until the next one; it must not touch speech.
            except OSError:
                logger.exception("voice cache janitor sweep failed")
