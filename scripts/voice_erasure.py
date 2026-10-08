"""Durable account-erasure barrier shared by the two resident voice gateways."""

import hashlib
import json
import os
import re
import struct
import threading
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel, Field


class AccountErasureRequest(BaseModel):
    subject_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    request_keys: list[str] = Field(default_factory=list)
    voice_ids: list[str] = Field(default_factory=list)


class VoiceErasureRegistry:
    def __init__(self, cache_dir: Path, magic: bytes):
        self.cache_dir = cache_dir
        self.magic = magic
        self.directory = cache_dir / "erased"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def marker(self, kind: str, value: str) -> Path:
        return self.directory / f"{kind}-{hashlib.sha256(value.encode()).hexdigest()}"

    def check(self, owner: str | None, key: str | None = None, voice: str | None = None):
        if owner is not None and re.fullmatch(r"[a-f0-9]{64}", owner) is None:
            raise HTTPException(status_code=400, detail="Invalid voice owner hash")
        if ((owner and self.marker("owner", owner).exists())
                or (key and self.marker("key", key.strip()).exists())
                or (voice and self.marker("voice", voice.strip()).exists())):
            raise HTTPException(status_code=410, detail="Voice account authority was erased")

    def cache_owner(self, path: Path) -> str | None:
        try:
            with path.open("rb") as source:
                if source.read(len(self.magic)) != self.magic:
                    raise ValueError("invalid cache prefix")
                size = struct.unpack(">I", source.read(4))[0]
                if not 2 <= size <= 65_536:
                    raise ValueError("invalid cache manifest size")
                manifest = json.loads(source.read(size))
                return manifest.get("owner_hash")
        except FileNotFoundError:
            return None
        except (OSError, ValueError, struct.error, AttributeError) as error:
            # Corrupt metadata cannot be silently declared erased.
            raise HTTPException(status_code=503, detail="Cannot enumerate voice cache ownership") from error

    def check_cache_owner(self, path: Path, owner: str | None):
        existing = self.cache_owner(path)
        if existing is not None and existing != owner:
            raise HTTPException(status_code=409, detail="Speech key belongs to another owner")

    @staticmethod
    def sync_directory(path: Path):
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def commit(self, owner, key, voice, write):
        with self.lock:
            self.check(owner, key, voice)
            write()

    def mark_erased(self, request: AccountErasureRequest):
        # INVARIANT: persist the barrier before waiting for active synthesis or
        # registry work. Its final write must recheck while holding this lock.
        with self.lock:
            for kind, values in [("owner", [request.subject_hash]), ("key", request.request_keys), ("voice", request.voice_ids)]:
                for value in values:
                    path = self.marker(kind, value.strip())
                    with path.open("wb") as target:
                        target.flush()
                        os.fsync(target.fileno())
            self.sync_directory(self.directory)

    def delete_cache(self, request: AccountErasureRequest):
        for key in request.request_keys:
            path = self.cache_dir / f"{hashlib.sha256(key.strip().encode()).hexdigest()}.cache"
            self.check_cache_owner(path, request.subject_hash)
            path.unlink(missing_ok=True)
        for path in self.cache_dir.glob("*.cache"):
            if self.cache_owner(path) == request.subject_hash:
                path.unlink(missing_ok=True)
        self.sync_directory(self.cache_dir)
