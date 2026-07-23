"""iDream Pocket TTS gateway backed by oMLX.

oMLX owns model discovery, MLX execution, and request-scoped reference-audio
cloning. This adapter owns the product-facing durable voice registry so Admin
can create, preview, activate, reuse, and delete versioned character voices.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import wave
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field


MODEL_ID = os.getenv("POCKET_TTS_MODEL", "pocket-tts-4bit").strip()
LANGUAGE = os.getenv("POCKET_TTS_LANGUAGE", "english").strip()
DEFAULT_VOICE = os.getenv("POCKET_TTS_DEFAULT_VOICE_ID", "alba").strip()
API_TOKEN = os.getenv("POCKET_TTS_API_TOKEN", "").strip()
OMLX_API_URL = os.getenv(
    "POCKET_TTS_OMLX_API_URL",
    "http://127.0.0.1:8061/v1",
).rstrip("/")
OMLX_API_TOKEN = os.getenv("POCKET_TTS_OMLX_API_TOKEN", "").strip()
OMLX_RUNTIME_VERSION = os.getenv(
    "POCKET_TTS_OMLX_RUNTIME_VERSION",
    "0.5.3",
).strip()
OMLX_TIMEOUT_SECONDS = (
    int(os.getenv("POCKET_TTS_OMLX_TIMEOUT_MS", "120000")) / 1_000
)
VOICE_DIR = Path(
    os.getenv("POCKET_TTS_VOICE_DIR", ".data/pocket-tts/voices")
).resolve()

VOICE_MANIFEST_FORMAT = "idream_omlx_voice_reference_v1"
MAX_REFERENCE_BYTES = 15 * 1024 * 1024
MAX_REFERENCE_SECONDS = 30
MIN_REFERENCE_BYTES = 1_024
registry_lock = threading.RLock()

if not MODEL_ID:
    raise RuntimeError("POCKET_TTS_MODEL is required")
if LANGUAGE != "english":
    raise RuntimeError("Pocket TTS currently serves the English model only")
if not OMLX_RUNTIME_VERSION:
    raise RuntimeError("POCKET_TTS_OMLX_RUNTIME_VERSION is required")
if OMLX_TIMEOUT_SECONDS <= 0:
    raise RuntimeError("POCKET_TTS_OMLX_TIMEOUT_MS must be positive")

VOICE_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="iDream Pocket TTS oMLX adapter", version="3.0.0")


class SpeechRequest(BaseModel):
    model: str = Field(default=MODEL_ID)
    input: str = Field(min_length=1, max_length=2_000)
    voice: str = Field(default=DEFAULT_VOICE, min_length=1, max_length=160)
    response_format: str = Field(default="wav")


def authorize(authorization: str | None = Header(default=None)) -> None:
    if not API_TOKEN:
        return
    if authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid Pocket TTS API token")


def safe_voice_id(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,159}", normalized):
        raise HTTPException(status_code=400, detail="Invalid voice_id")
    return normalized


def voice_audio_path(voice_id: str) -> Path:
    return VOICE_DIR / f"{safe_voice_id(voice_id)}.wav"


def voice_manifest_path(voice_id: str) -> Path:
    return VOICE_DIR / f"{safe_voice_id(voice_id)}.json"


def omlx_headers() -> dict[str, str]:
    headers = {"accept": "application/json"}
    if OMLX_API_TOKEN:
        headers["authorization"] = f"Bearer {OMLX_API_TOKEN}"
    return headers


def omlx_request(
    method: str,
    path: str,
    *,
    payload: dict[str, object] | None = None,
    timeout: float | None = None,
) -> httpx.Response:
    try:
        response = httpx.request(
            method,
            f"{OMLX_API_URL}/{path.lstrip('/')}",
            headers=omlx_headers(),
            json=payload,
            timeout=timeout or OMLX_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=503,
            detail=f"oMLX Pocket TTS is unreachable: {error}",
        ) from error
    if response.is_success:
        return response
    detail = response.text.strip()
    raise HTTPException(
        status_code=502 if response.status_code < 500 else 503,
        detail=detail or f"oMLX returned HTTP {response.status_code}",
    )


def available_omlx_model() -> bool:
    response = omlx_request("GET", "/models", timeout=2.0)
    try:
        payload = response.json()
    except ValueError as error:
        raise HTTPException(
            status_code=503,
            detail="oMLX returned an invalid model list",
        ) from error
    models = payload.get("data") if isinstance(payload, dict) else None
    return isinstance(models, list) and any(
        isinstance(item, dict) and item.get("id") == MODEL_ID for item in models
    )


def load_voice_manifest(voice_id: str) -> dict[str, str] | None:
    audio_path = voice_audio_path(voice_id)
    manifest_path = voice_manifest_path(voice_id)
    if not audio_path.is_file() and not manifest_path.is_file():
        return None
    if not audio_path.is_file() or not manifest_path.is_file():
        raise HTTPException(
            status_code=503,
            detail=f"Stored voice '{voice_id}' is incomplete",
        )
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=503,
            detail=f"Stored voice '{voice_id}' has an invalid manifest",
        ) from error
    if (
        not isinstance(raw, dict)
        or raw.get("format") != VOICE_MANIFEST_FORMAT
        or not isinstance(raw.get("ref_text"), str)
        or not raw["ref_text"].strip()
        or not isinstance(raw.get("language"), str)
    ):
        raise HTTPException(
            status_code=503,
            detail=f"Stored voice '{voice_id}' has an incompatible manifest",
        )
    return {
        "ref_text": raw["ref_text"].strip(),
        "language": raw["language"],
    }


def stored_voice_count() -> int:
    return sum(
        1
        for manifest_path in VOICE_DIR.glob("*.json")
        if manifest_path.with_suffix(".wav").is_file()
    )


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


def normalize_reference_audio(
    reference: bytes,
    filename: str,
) -> bytes:
    if reference.startswith(b"RIFF") and reference[8:12] == b"WAVE":
        duration = validate_wav(reference)
        if duration <= MAX_REFERENCE_SECONDS:
            return reference

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise HTTPException(
            status_code=503,
            detail="ffmpeg is required to normalize voice reference audio",
        )
    suffix = Path(filename).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        suffix = ".audio"
    with tempfile.TemporaryDirectory(prefix="idream-pocket-voice-") as directory:
        source = Path(directory) / f"reference{suffix}"
        target = Path(directory) / "reference.wav"
        source.write_bytes(reference)
        try:
            completed = subprocess.run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(source),
                    "-t",
                    str(MAX_REFERENCE_SECONDS),
                    "-ac",
                    "1",
                    "-ar",
                    "24000",
                    "-c:a",
                    "pcm_s16le",
                    str(target),
                ],
                capture_output=True,
                check=False,
                timeout=45,
            )
        except subprocess.TimeoutExpired as error:
            raise HTTPException(
                status_code=422,
                detail="Voice reference audio normalization timed out",
            ) from error
        if completed.returncode != 0 or not target.is_file():
            detail = completed.stderr.decode("utf-8", errors="replace").strip()
            raise HTTPException(
                status_code=422,
                detail=detail or "Voice reference audio could not be decoded",
            )
        normalized = target.read_bytes()
    try:
        validate_wav(normalized)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return normalized


def atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def synthesize_payload(request: SpeechRequest) -> dict[str, object]:
    voice_id = safe_voice_id(request.voice)
    with registry_lock:
        manifest = load_voice_manifest(voice_id)
        reference_audio = (
            voice_audio_path(voice_id).read_bytes()
            if manifest is not None
            else None
        )
    payload: dict[str, object] = {
        "model": MODEL_ID,
        "input": request.input.strip(),
        "response_format": "wav",
    }
    if manifest is None:
        if voice_id.startswith("idream-"):
            raise HTTPException(status_code=404, detail="Stored voice not found")
        payload["voice"] = voice_id
        return payload
    assert reference_audio is not None
    payload.update(
        {
            "ref_audio": base64.b64encode(reference_audio).decode("ascii"),
            "ref_text": manifest["ref_text"],
        }
    )
    return payload


@app.get("/health")
@app.get("/v1/health")
def health() -> dict[str, object]:
    if not available_omlx_model():
        raise HTTPException(
            status_code=503,
            detail=f"oMLX model '{MODEL_ID}' is not available",
        )
    return {
        "status": "healthy",
        "provider": "pocket_tts",
        "runtime": "omlx",
        "runtime_version": OMLX_RUNTIME_VERSION,
        "acceleration": "mlx",
        "model": MODEL_ID,
        "language": LANGUAGE,
        "voice_cloning": True,
        "stored_voice_count": stored_voice_count(),
    }


@app.post("/v1/audio/speech", dependencies=[Depends(authorize)])
def synthesize(request: SpeechRequest) -> Response:
    if request.response_format != "wav":
        raise HTTPException(status_code=400, detail="Only WAV output is supported")
    if request.model != MODEL_ID:
        raise HTTPException(
            status_code=409,
            detail=f"Configured model is '{MODEL_ID}', received '{request.model}'",
        )
    response = omlx_request("POST", "/audio/speech", payload=synthesize_payload(request))
    content_type = response.headers.get("content-type", "audio/wav")
    if "audio/" not in content_type:
        raise HTTPException(
            status_code=502,
            detail="oMLX returned a non-audio speech response",
        )
    if not response.content:
        raise HTTPException(status_code=502, detail="oMLX returned empty audio")
    return Response(
        content=response.content,
        media_type="audio/wav",
        headers={"Content-Disposition": "inline; filename=generated_speech.wav"},
    )


@app.post("/v1/voices", dependencies=[Depends(authorize)])
def clone_voice(
    voice_id: str = Form(...),
    language: str = Form(default=LANGUAGE),
    ref_text: str = Form(...),
    audio: UploadFile = File(...),
) -> dict[str, str]:
    normalized_id = safe_voice_id(voice_id)
    normalized_text = ref_text.strip()
    if language != LANGUAGE:
        raise HTTPException(
            status_code=409,
            detail=f"This gateway serves {LANGUAGE}; requested {language}",
        )
    if len(normalized_text) < 3 or len(normalized_text) > 2_000:
        raise HTTPException(
            status_code=400,
            detail="ref_text must contain 3 to 2000 characters",
        )
    reference = audio.file.read(MAX_REFERENCE_BYTES + 1)
    if len(reference) < MIN_REFERENCE_BYTES:
        raise HTTPException(status_code=400, detail="Voice reference audio is too small")
    if len(reference) > MAX_REFERENCE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Voice reference audio must be 15 MB or smaller",
        )
    normalized_audio = normalize_reference_audio(
        reference,
        audio.filename or "reference.audio",
    )
    manifest: dict[str, Any] = {
        "format": VOICE_MANIFEST_FORMAT,
        "runtime": "omlx",
        "runtime_version": OMLX_RUNTIME_VERSION,
        "model": MODEL_ID,
        "language": LANGUAGE,
        "ref_text": normalized_text,
        "source_filename": Path(audio.filename or "reference.audio").name,
        "source_content_type": audio.content_type or "application/octet-stream",
    }
    with registry_lock:
        atomic_write(voice_audio_path(normalized_id), normalized_audio)
        atomic_write(
            voice_manifest_path(normalized_id),
            json.dumps(
                manifest,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8"),
        )
    return {"voice_id": normalized_id, "model": MODEL_ID, "language": LANGUAGE}


@app.delete("/v1/voices/{voice_id}", dependencies=[Depends(authorize)])
def delete_voice(voice_id: str) -> dict[str, bool]:
    normalized_id = safe_voice_id(voice_id)
    with registry_lock:
        voice_audio_path(normalized_id).unlink(missing_ok=True)
        voice_manifest_path(normalized_id).unlink(missing_ok=True)
    return {"deleted": True}
