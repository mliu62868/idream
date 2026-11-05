"""Code the resident voice gateways share because it is genuinely the same.

Reference normalization and manifests look alike but differ in sample rate, error
handling and fields, so they stay in each gateway.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import re
import struct
from uuid import uuid4
import wave

from fastapi import HTTPException

try:
    from scripts.voice_cache_janitor import refresh_entry
except ModuleNotFoundError:
    from voice_cache_janitor import refresh_entry


def safe_voice_id(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,159}", normalized):
        raise HTTPException(status_code=400, detail="Invalid voice_id")
    return normalized


def atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_wav(reference: bytes) -> float:
    try:
        with wave.open(io.BytesIO(reference), "rb") as wav:
            frame_rate = wav.getframerate()
            frames = wav.getnframes()
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
    except (EOFError, wave.Error) as error:
        raise ValueError("Reference audio is not a valid WAV file") from error
    if frame_rate <= 0 or frames <= 0 or channels not in (1, 2) or sample_width <= 0:
        raise ValueError("Reference WAV has invalid audio metadata")
    return frames / frame_rate


def read_idempotent_audio(
    cache_path: Path,
    request_fingerprint: str,
    magic: bytes,
    manifest_format: str,
) -> bytes | None:
    if not cache_path.is_file():
        return None
    try:
        content = cache_path.read_bytes()
        prefix_size = len(magic) + 4
        if not content.startswith(magic) or len(content) <= prefix_size:
            raise ValueError("invalid cache prefix")
        manifest_size = struct.unpack(">I", content[len(magic) : prefix_size])[0]
        manifest_end = prefix_size + manifest_size
        if manifest_size < 2 or manifest_end >= len(content):
            raise ValueError("invalid manifest size")
        manifest = json.loads(content[prefix_size:manifest_end].decode("utf-8"))
        audio = content[manifest_end:]
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=503,
            detail="Stored speech idempotency result is invalid",
        ) from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("format") != manifest_format
        or not isinstance(manifest.get("request_fingerprint"), str)
    ):
        raise HTTPException(
            status_code=503,
            detail="Stored speech idempotency manifest is incompatible",
        )
    if manifest["request_fingerprint"] != request_fingerprint:
        raise HTTPException(
            status_code=409,
            detail="Idempotency-Key was already used for a different request",
        )
    refresh_entry(cache_path)
    return audio
