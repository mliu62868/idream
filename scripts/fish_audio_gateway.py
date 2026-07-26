"""Resident Fish Audio S2 Pro MLX gateway for iDream.

The gateway loads the model once, owns the durable reference-voice registry,
and passes reference audio to Fish as an MLX array. This avoids the oMLX 0.5.3
reference-cloning path that currently forwards a temporary filename string.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import wave
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field


MODEL_ID = os.getenv("FISH_AUDIO_MODEL", "fish-audio-s2-pro-8bit").strip()
MODEL_PATH = Path(
    os.getenv(
        "FISH_AUDIO_MODEL_PATH",
        "~/.omlx/models/mlx-community/fish-audio-s2-pro-8bit",
    )
).expanduser().resolve()
LANGUAGE = os.getenv("FISH_AUDIO_LANGUAGE", "auto").strip()
DEFAULT_VOICE = os.getenv(
    "FISH_AUDIO_DEFAULT_VOICE_ID",
    "fish-female-default",
).strip()
API_TOKEN = os.getenv("FISH_AUDIO_API_TOKEN", "").strip()
VOICE_DIR = Path(
    os.getenv("FISH_AUDIO_VOICE_DIR", ".data/fish-audio/voices")
).resolve()
SYSTEM_REFERENCE_AUDIO = os.getenv(
    "FISH_AUDIO_SYSTEM_REFERENCE_AUDIO",
    "",
).strip()
SYSTEM_REFERENCE_MANIFEST = os.getenv(
    "FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST",
    "",
).strip()

VOICE_MANIFEST_FORMAT = "idream_fish_audio_voice_reference_v1"
MAX_REFERENCE_BYTES = 15 * 1024 * 1024
MAX_REFERENCE_SECONDS = 30
MIN_REFERENCE_BYTES = 1_024
BUILTIN_VOICES = {"fish-female-default"}
registry_lock = threading.RLock()
generation_lock = threading.Lock()
runtime_model: Any | None = None

if not MODEL_ID:
    raise RuntimeError("FISH_AUDIO_MODEL is required")
if not LANGUAGE:
    raise RuntimeError("FISH_AUDIO_LANGUAGE is required")

VOICE_DIR.mkdir(parents=True, exist_ok=True)


class DeliverySettings(BaseModel):
    preset: str = Field(
        default="sensual",
        pattern="^(sensual|intimate|playful|confident|natural)$",
    )
    intensity: int = Field(default=75, ge=0, le=100)
    speed: float = Field(default=0.94, ge=0.7, le=1.3)
    temperature: float = Field(default=0.72, ge=0.1, le=1.5)
    topP: float = Field(default=0.75, ge=0.1, le=1.0)
    topK: int = Field(default=30, ge=1, le=100)
    repetitionPenalty: float = Field(default=1.2, ge=1.0, le=2.0)


class SpeechRequest(BaseModel):
    model: str = Field(default=MODEL_ID)
    input: str = Field(min_length=1, max_length=2_000)
    voice: str = Field(default=DEFAULT_VOICE, min_length=1, max_length=160)
    response_format: str = Field(default="wav")
    delivery: DeliverySettings = Field(default_factory=DeliverySettings)
    tone: str | None = Field(default=None, max_length=1_000)


def load_runtime_model() -> Any:
    global runtime_model
    if runtime_model is not None:
        return runtime_model
    if not MODEL_PATH.is_dir():
        raise RuntimeError(f"Fish Audio model directory does not exist: {MODEL_PATH}")
    from mlx_audio.tts.utils import load_model

    runtime_model = load_model(model_path=str(MODEL_PATH))
    return runtime_model


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_runtime_model()
    yield


app = FastAPI(
    title="iDream Fish Audio S2 Pro MLX gateway",
    version="1.0.0",
    lifespan=lifespan,
)


def authorize(authorization: str | None = Header(default=None)) -> None:
    if API_TOKEN and authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid Fish Audio API token")


def safe_voice_id(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,159}", normalized):
        raise HTTPException(status_code=400, detail="Invalid voice_id")
    return normalized


def voice_audio_path(voice_id: str) -> Path:
    return VOICE_DIR / f"{safe_voice_id(voice_id)}.wav"


def voice_manifest_path(voice_id: str) -> Path:
    return VOICE_DIR / f"{safe_voice_id(voice_id)}.json"


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


def load_system_reference() -> tuple[Path, dict[str, str]]:
    if not SYSTEM_REFERENCE_AUDIO or not SYSTEM_REFERENCE_MANIFEST:
        raise HTTPException(
            status_code=503,
            detail=(
                "The curated system female voice is not configured; set "
                "FISH_AUDIO_SYSTEM_REFERENCE_AUDIO and "
                "FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST"
            ),
        )
    audio_path = Path(SYSTEM_REFERENCE_AUDIO).expanduser().resolve()
    manifest_path = Path(SYSTEM_REFERENCE_MANIFEST).expanduser().resolve()
    if not audio_path.is_file() or not manifest_path.is_file():
        raise HTTPException(
            status_code=503,
            detail="The curated system female voice reference is incomplete",
        )
    try:
        validate_wav(audio_path.read_bytes())
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=503,
            detail="The curated system female voice reference is invalid",
        ) from error
    if (
        not isinstance(raw, dict)
        or not isinstance(raw.get("ref_text"), str)
        or not raw["ref_text"].strip()
    ):
        raise HTTPException(
            status_code=503,
            detail="The curated system female voice manifest requires ref_text",
        )
    language = raw.get("language")
    return audio_path, {
        "ref_text": raw["ref_text"].strip(),
        "language": language if isinstance(language, str) else LANGUAGE,
    }


def system_voice_status() -> tuple[bool, str | None]:
    try:
        load_system_reference()
    except HTTPException as error:
        return False, str(error.detail)
    return True, None


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


def normalize_reference_audio(reference: bytes, filename: str) -> bytes:
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
    with tempfile.TemporaryDirectory(prefix="idream-fish-voice-") as directory:
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
                    "44100",
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


def style_prefix(delivery: DeliverySettings) -> str:
    base = {
        "sensual": ["female voice", "low voice", "breathy"],
        "intimate": ["female voice", "soft voice", "whisper"],
        "playful": ["female voice", "playful", "teasing"],
        "confident": ["female voice", "confident", "low voice"],
        "natural": ["female voice", "warm"],
    }[delivery.preset]
    if delivery.intensity >= 85:
        base.append("very expressive")
    elif delivery.intensity <= 30:
        base.append("subtle")
    return " ".join(f"[{tag}]" for tag in base)


def styled_text(text: str, delivery: DeliverySettings) -> str:
    return f"{style_prefix(delivery)} {text.strip()}"


def render_wav(request: SpeechRequest) -> bytes:
    model = load_runtime_model()
    voice_id = safe_voice_id(request.voice)
    with registry_lock:
        manifest = load_voice_manifest(voice_id)
        reference_path = voice_audio_path(voice_id) if manifest is not None else None
    if manifest is None and voice_id not in BUILTIN_VOICES:
        raise HTTPException(status_code=404, detail="Stored voice not found")
    if manifest is None:
        reference_path, manifest = load_system_reference()

    from mlx_audio.utils import load_audio

    ref_audio = load_audio(str(reference_path), sample_rate=model.sample_rate)

    with generation_lock:
        results = list(
            model.generate(
                text=styled_text(request.input, request.delivery),
                ref_audio=ref_audio,
                ref_text=manifest["ref_text"],
                speed=request.delivery.speed,
                temperature=request.delivery.temperature,
                top_p=request.delivery.topP,
                top_k=request.delivery.topK,
                repetition_penalty=request.delivery.repetitionPenalty,
                max_tokens=1200,
                stream=False,
                verbose=False,
            )
        )
    if not results:
        raise HTTPException(status_code=502, detail="Fish Audio returned no audio")
    audio = np.concatenate(
        [np.array(result.audio, dtype=np.float32).reshape(-1) for result in results]
    )
    if audio.size == 0 or not np.isfinite(audio).all():
        raise HTTPException(status_code=502, detail="Fish Audio returned invalid audio")
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767.0).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(results[0].sample_rate))
        wav.writeframes(pcm)
    return output.getvalue()


@app.get("/health")
@app.get("/v1/health")
async def health() -> JSONResponse:
    model = load_runtime_model()
    system_voice_ready, system_voice_error = system_voice_status()
    try:
        runtime_version = version("mlx-audio")
    except PackageNotFoundError:
        runtime_version = "unknown"
    payload = {
        "status": "healthy" if system_voice_ready else "degraded",
        "provider": "fish_audio",
        "runtime": "mlx_audio",
        "runtime_version": runtime_version,
        "acceleration": "mlx",
        "model": MODEL_ID,
        "model_path": str(MODEL_PATH),
        "model_loaded": model is not None,
        "language": LANGUAGE,
        "voice_cloning": True,
        "system_voice_ready": system_voice_ready,
        "system_voice_error": system_voice_error,
        "stored_voice_count": stored_voice_count(),
    }
    return JSONResponse(
        content=payload,
        status_code=200 if system_voice_ready else 503,
    )


@app.post("/v1/audio/speech", dependencies=[Depends(authorize)])
async def synthesize(request: SpeechRequest) -> Response:
    if request.response_format != "wav":
        raise HTTPException(status_code=400, detail="Only WAV output is supported")
    if request.model != MODEL_ID:
        raise HTTPException(
            status_code=409,
            detail=f"Configured model is '{MODEL_ID}', received '{request.model}'",
        )
    return Response(
        content=render_wav(request),
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
    if normalized_id in BUILTIN_VOICES:
        raise HTTPException(
            status_code=409,
            detail="The system female voice id is reserved",
        )
    normalized_text = ref_text.strip()
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
        "runtime": "mlx_audio",
        "model": MODEL_ID,
        "language": language,
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
    return {"voice_id": normalized_id, "model": MODEL_ID, "language": language}


@app.delete("/v1/voices/{voice_id}", dependencies=[Depends(authorize)])
def delete_voice(voice_id: str) -> dict[str, bool]:
    normalized_id = safe_voice_id(voice_id)
    if normalized_id in BUILTIN_VOICES:
        raise HTTPException(
            status_code=409,
            detail="The system female voice id is reserved",
        )
    with registry_lock:
        voice_audio_path(normalized_id).unlink(missing_ok=True)
        voice_manifest_path(normalized_id).unlink(missing_ok=True)
    return {"deleted": True}
