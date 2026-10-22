"""Resident voice-cloning MLX gateway for iDream (the `fish_audio` provider slot).

SPEC: one configured Ming or Breeze model owns generation; a previous model's
completed result may only be replayed from its exact persistent request cache.
INTENT: the provider key, environment names and durable voice registry keep the
`fish_audio` name so existing voice identities survive an engine switch.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import struct
import tempfile
import threading
import wave
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4

import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
try:
    from scripts.voice_erasure import AccountErasureRequest, VoiceErasureRegistry
    from scripts.ming_voice_runtime import (
        CAMPLUS_SHA256, MLX_AUDIO_VERSION, MODEL_ID as MING_MODEL_ID,
        MingGenerationOptions, MingReferenceError, MingSynthesisError, MingVoiceRuntime,
        control_caption, validate_prompt_metadata,
    )
except ModuleNotFoundError:
    from voice_erasure import AccountErasureRequest, VoiceErasureRegistry
    from ming_voice_runtime import (
        CAMPLUS_SHA256, MLX_AUDIO_VERSION, MODEL_ID as MING_MODEL_ID,
        MingGenerationOptions, MingReferenceError, MingSynthesisError, MingVoiceRuntime,
        control_caption, validate_prompt_metadata,
    )


BREEZE_MODEL_ID = "breeze-tts-2-mlx-8bit"
MODEL_PATHS = {
    MING_MODEL_ID: "~/.idream/models/mlx-community/Ming-3.0-tts-0.5B-8bit",
    BREEZE_MODEL_ID: "~/.idream/models/mlx-community/Breeze-TTS-2-mlx-8bit",
}
MODEL_ID = os.getenv("FISH_AUDIO_MODEL", MING_MODEL_ID).strip()
if MODEL_ID not in MODEL_PATHS:
    raise RuntimeError(f"Unsupported FISH_AUDIO_MODEL: {MODEL_ID!r}")
MODEL_PATH = Path(
    os.getenv("FISH_AUDIO_MODEL_PATH", MODEL_PATHS[MODEL_ID])
).expanduser().resolve()
CAMPLUS_MODEL_PATH = os.getenv("FISH_AUDIO_CAMPLUS_MODEL_PATH", "").strip()
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
IDEMPOTENCY_DIR = Path(
    os.getenv("FISH_AUDIO_IDEMPOTENCY_DIR", ".data/fish-audio/idempotency")
).resolve()

VOICE_MANIFEST_FORMAT = "idream_fish_audio_voice_reference_v1"
IDEMPOTENCY_MANIFEST_FORMAT = "idream_fish_audio_idempotency_v1"
IDEMPOTENCY_CACHE_MAGIC = b"IDREAM-FISH-IDEMPOTENCY-V1\n"
MAX_REFERENCE_BYTES = 15 * 1024 * 1024
MAX_REFERENCE_SECONDS = 30
MIN_REFERENCE_BYTES = 1_024
BUILTIN_VOICES = {"fish-female-default"}
SYSTEM_VOICE_IDS = BUILTIN_VOICES | {DEFAULT_VOICE}
registry_lock = threading.RLock()
idempotency_lock = threading.RLock()
generation_lock = threading.Lock()
runtime_model: Any | None = None
ming_runtime: MingVoiceRuntime | None = None

if not LANGUAGE:
    raise RuntimeError("FISH_AUDIO_LANGUAGE is required")

VOICE_DIR.mkdir(parents=True, exist_ok=True)
IDEMPOTENCY_DIR.mkdir(parents=True, exist_ok=True)
erasure_registry = VoiceErasureRegistry(IDEMPOTENCY_DIR, IDEMPOTENCY_CACHE_MAGIC)


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
        raise RuntimeError(f"Voice model directory does not exist: {MODEL_PATH}")
    if MODEL_ID == MING_MODEL_ID:
        if version("mlx-audio") != MLX_AUDIO_VERSION:
            raise RuntimeError(f"Ming requires the pinned mlx-audio {MLX_AUDIO_VERSION} runtime")
        load_ming_runtime()
    from mlx_audio.tts.utils import load_model

    candidate = load_model(model_path=str(MODEL_PATH))
    if MODEL_ID == MING_MODEL_ID and (
        not getattr(candidate, "ming3", False)
        or getattr(candidate, "patch_size", None) != 1
        or getattr(candidate, "sample_rate", None) != 44100
    ):
        raise RuntimeError("Configured Ming directory does not contain the supported Ming-3.0 dense model")
    if MODEL_ID == BREEZE_MODEL_ID and getattr(candidate, "ming3", False):
        raise RuntimeError("Configured Breeze directory contains a Ming model")
    runtime_model = candidate
    return runtime_model


def load_ming_runtime() -> MingVoiceRuntime:
    global ming_runtime
    if ming_runtime is None:
        if not CAMPLUS_MODEL_PATH:
            raise RuntimeError("Ming requires an explicit FISH_AUDIO_CAMPLUS_MODEL_PATH")
        ming_runtime = MingVoiceRuntime(Path(CAMPLUS_MODEL_PATH).expanduser().resolve())
    return ming_runtime


def clear_reference_cache() -> None:
    # Registry mutation/erasure waits for active synthesis before releasing its
    # derived speaker vectors; no embedding cache is written to disk.
    with generation_lock:
        if ming_runtime is not None:
            ming_runtime.clear_reference_cache()


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_runtime_model()
    yield


app = FastAPI(
    title="iDream MLX voice-cloning gateway",
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


def load_voice_manifest(voice_id: str) -> dict[str, Any] | None:
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
        or ("ming_prompt" in raw and not isinstance(raw["ming_prompt"], dict))
    ):
        raise HTTPException(
            status_code=503,
            detail=f"Stored voice '{voice_id}' has an incompatible manifest",
        )
    return {
        "ref_text": raw["ref_text"].strip(),
        "language": raw["language"],
        **({"ming_prompt": raw["ming_prompt"]} if "ming_prompt" in raw else {}),
    }


def load_system_reference() -> tuple[Path, dict[str, Any]]:
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
        or ("ming_prompt" in raw and not isinstance(raw["ming_prompt"], dict))
    ):
        raise HTTPException(
            status_code=503,
            detail="The curated system female voice manifest requires ref_text",
        )
    language = raw.get("language")
    return audio_path, {
        "ref_text": raw["ref_text"].strip(),
        "language": language if isinstance(language, str) else LANGUAGE,
        **({"ming_prompt": raw["ming_prompt"]} if "ming_prompt" in raw else {}),
    }


def resolve_reference(voice_id: str) -> tuple[Path, dict[str, Any]]:
    manifest = load_voice_manifest(voice_id)
    if manifest is not None:
        return voice_audio_path(voice_id), manifest
    if voice_id not in BUILTIN_VOICES:
        raise HTTPException(status_code=404, detail="Stored voice not found")
    return load_system_reference()


def system_voice_status() -> tuple[bool, str | None]:
    try:
        with registry_lock:
            path, manifest = resolve_reference(safe_voice_id(DEFAULT_VOICE))
            reference = path.read_bytes()
            validate_wav(reference)
            if MODEL_ID == MING_MODEL_ID:
                validate_prompt_metadata(reference, manifest.get("ming_prompt"))
                load_ming_runtime().embedding(reference)
    except HTTPException as error:
        return False, str(error.detail)
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        return False, str(error)
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


def speech_request_fingerprint(request: SpeechRequest) -> str:
    canonical = json.dumps(
        request.model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def idempotency_cache_path(idempotency_key: str) -> Path:
    normalized = idempotency_key.strip()
    if not normalized or len(normalized) > 256:
        raise HTTPException(status_code=400, detail="Invalid Idempotency-Key")
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return IDEMPOTENCY_DIR / f"{digest}.cache"


def load_idempotent_audio(
    cache_path: Path,
    request_fingerprint: str,
) -> bytes | None:
    if not cache_path.is_file():
        return None
    try:
        content = cache_path.read_bytes()
        prefix_size = len(IDEMPOTENCY_CACHE_MAGIC) + 4
        if not content.startswith(IDEMPOTENCY_CACHE_MAGIC) or len(content) <= prefix_size:
            raise ValueError("invalid cache prefix")
        manifest_size = struct.unpack(
            ">I",
            content[len(IDEMPOTENCY_CACHE_MAGIC) : prefix_size],
        )[0]
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
        or manifest.get("format") != IDEMPOTENCY_MANIFEST_FORMAT
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
    return audio


def render_idempotent_wav(
    request: SpeechRequest,
    idempotency_key: str,
    request_id: str,
    attempt_no: int,
    owner_hash: str | None = None,
) -> tuple[bytes, bool]:
    if request.model not in MODEL_PATHS:
        raise HTTPException(status_code=409, detail=f"Unrecognized speech model: '{request.model}'")
    if not request_id.strip() or attempt_no < 1:
        raise HTTPException(
            status_code=400,
            detail="Idempotent speech requires request id and positive attempt number",
        )
    cache_path = idempotency_cache_path(idempotency_key)
    request_fingerprint = speech_request_fingerprint(request)
    with idempotency_lock:
        erasure_registry.check(owner_hash, idempotency_key, request.voice)
        erasure_registry.check_cache_owner(cache_path, owner_hash)
        replay = load_idempotent_audio(
            cache_path,
            request_fingerprint,
        )
        if replay is not None:
            erasure_registry.check(owner_hash, idempotency_key, request.voice)
            return replay, True
        require_generation_model(request.model)
        rendered = render_wav(request)
        manifest = {
            "format": IDEMPOTENCY_MANIFEST_FORMAT,
            "request_fingerprint": request_fingerprint,
            "request_id": request_id.strip(),
            "attempt_no": attempt_no,
            "owner_hash": owner_hash,
        }
        manifest_bytes = json.dumps(
            manifest,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        # INVARIANT: metadata and bytes become visible in one atomic rename, so
        # a process crash can never leave a key that is allowed to re-render.
        erasure_registry.commit(owner_hash, idempotency_key, request.voice, lambda: atomic_write(
            cache_path,
            b"".join(
                (
                    IDEMPOTENCY_CACHE_MAGIC,
                    struct.pack(">I", len(manifest_bytes)),
                    manifest_bytes,
                    rendered,
                )
            ),
        ))
        return rendered, False


PRESET_DIRECTIONS = {
    "sensual": "A woman speaking in a low, breathy, sensual voice.",
    "intimate": "A woman speaking softly and intimately, close to a whisper.",
    "playful": "A woman speaking in a playful, teasing voice.",
    "confident": "A woman speaking in a confident, low voice.",
    "natural": "A woman speaking in a warm, natural voice.",
}


# SPEC: delivery settings become one natural-language Breeze `instruct` string.
# INTENT: Breeze has no speed parameter, so pace is part of the direction; Breeze
# reads square brackets as Chinese vocal events, so Fish-style `[tag]` prefixes
# in the spoken text would be wrong.
def delivery_instruction(delivery: DeliverySettings) -> str:
    parts = [PRESET_DIRECTIONS[delivery.preset]]
    if delivery.intensity >= 85:
        parts.append("Very expressive.")
    elif delivery.intensity <= 30:
        parts.append("Subtle and understated.")
    if delivery.speed <= 0.9:
        parts.append("Slow pace.")
    elif delivery.speed < 0.97:
        parts.append("Slightly slower than normal pace.")
    elif delivery.speed >= 1.1:
        parts.append("Fast pace.")
    elif delivery.speed > 1.03:
        parts.append("Slightly faster than normal pace.")
    return " ".join(parts)


def ming_delivery_caption(delivery: DeliverySettings) -> str:
    speed = "慢速" if delivery.speed <= 0.97 else "快速" if delivery.speed >= 1.03 else "中速"
    if delivery.preset in {"intimate", "sensual"}:
        if speed == "中速":
            speed = "慢速"
        return control_caption(speed=speed, volume="中" if delivery.intensity <= 30 else "低")
    if delivery.preset == "confident":
        return control_caption(speed=speed, volume="中" if delivery.intensity <= 30 else "高")
    emotion = "高兴" if delivery.preset == "playful" and delivery.intensity > 30 else "中性"
    return control_caption(emotion=emotion, speed=speed)


def require_generation_model(requested_model: str) -> None:
    if requested_model != MODEL_ID:
        raise HTTPException(
            status_code=409,
            detail=f"Configured model is '{MODEL_ID}'; '{requested_model}' can only replay an existing matching result",
        )


def render_wav(request: SpeechRequest) -> bytes:
    require_generation_model(request.model)
    if not request.input.strip():
        raise HTTPException(status_code=400, detail="Speech text must contain non-whitespace characters")
    model = load_runtime_model()
    voice_id = safe_voice_id(request.voice)
    from mlx_audio.utils import load_audio

    # Keep the manifest, WAV and derived identity in one registry generation.
    # Erasure persists its barrier first, then waits for this lock to release.
    with registry_lock, generation_lock:
        reference_path, manifest = resolve_reference(voice_id)
        ref_audio = load_audio(str(reference_path), sample_rate=model.sample_rate)
        if MODEL_ID == MING_MODEL_ID:
            try:
                results = load_ming_runtime().generate(
                    model, text=request.input.strip(), ref_audio=ref_audio,
                    reference=reference_path.read_bytes(), ref_text=manifest["ref_text"],
                    caption=ming_delivery_caption(request.delivery), options=MingGenerationOptions(),
                    prompt_metadata=manifest.get("ming_prompt"),
                )
            except MingReferenceError as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
            except MingSynthesisError as error:
                raise HTTPException(status_code=502, detail=str(error)) from error
        else:
            # Preserve Breeze's measured no-CFG conditioning path and sampling.
            results = list(
                model.generate(
                    text=request.input.strip(),
                    instruct=delivery_instruction(request.delivery),
                    ref_audio=ref_audio,
                    ref_text=manifest["ref_text"],
                    temperature=request.delivery.temperature,
                    top_p=request.delivery.topP,
                    top_k=request.delivery.topK,
                    repetition_penalty=request.delivery.repetitionPenalty,
                    max_tokens=1200,
                    stream=False,
                )
            )
    if not results:
        raise HTTPException(status_code=502, detail="Voice model returned no audio")
    audio = np.concatenate(
        [np.array(result.audio, dtype=np.float32).reshape(-1) for result in results]
    )
    if audio.size == 0 or not np.isfinite(audio).all():
        raise HTTPException(status_code=502, detail="Voice model returned invalid audio")
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
    model, model_error = None, None
    try:
        model = load_runtime_model()
    except (OSError, ValueError, RuntimeError, ImportError, PackageNotFoundError) as error:
        model_error = str(error)
    system_voice_ready, system_voice_error = system_voice_status()
    try:
        runtime_version = version("mlx-audio")
    except PackageNotFoundError:
        runtime_version = "unknown"
    ready = model is not None and system_voice_ready
    payload = {
        "status": "healthy" if ready else "degraded",
        "provider": "fish_audio",
        "runtime": "mlx_audio",
        "runtime_version": runtime_version,
        "acceleration": "mlx",
        "model": MODEL_ID,
        "configured_model": MODEL_ID,
        "supported_models": [MODEL_ID],
        "recognized_models": list(MODEL_PATHS),
        "replay_only_models": [value for value in MODEL_PATHS if value != MODEL_ID],
        "languages": ["en"],
        "model_path": str(MODEL_PATH),
        "model_loaded": model is not None,
        "model_error": model_error,
        "language": LANGUAGE,
        "voice_cloning": True,
        "system_voice_ready": system_voice_ready,
        "system_voice_error": system_voice_error,
        "stored_voice_count": stored_voice_count(),
    }
    if MODEL_ID == MING_MODEL_ID:
        payload["speaker_encoder"] = {
            "model": "campplus", "execution_provider": "CPUExecutionProvider",
            "sha256": CAMPLUS_SHA256, "loaded": ming_runtime is not None,
        }
    return JSONResponse(
        content=payload,
        status_code=200 if ready else 503,
    )


@app.post("/v1/audio/speech", dependencies=[Depends(authorize)])
async def synthesize(
    request: SpeechRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    request_id: str | None = Header(default=None, alias="X-Idream-Request-Id"),
    attempt_no: int | None = Header(default=None, alias="X-Idream-Attempt-No"),
    owner_hash: Annotated[str | None, Header(alias="X-Idream-Owner-Hash")] = None,
) -> Response:
    erasure_registry.check(owner_hash, idempotency_key, request.voice)
    if request.response_format != "wav":
        raise HTTPException(status_code=400, detail="Only WAV output is supported")
    if request.model not in MODEL_PATHS:
        raise HTTPException(
            status_code=409,
            detail=f"Unrecognized speech model: '{request.model}'",
        )
    replayed = False
    if idempotency_key is None:
        require_generation_model(request.model)
        rendered = render_wav(request)
    else:
        if request_id is None or attempt_no is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Idempotency-Key requires X-Idream-Request-Id and "
                    "X-Idream-Attempt-No"
                ),
            )
        rendered, replayed = render_idempotent_wav(
            request,
            idempotency_key,
            request_id,
            attempt_no,
            owner_hash,
        )
    erasure_registry.check(owner_hash, idempotency_key, request.voice)
    return Response(
        content=rendered,
        media_type="audio/wav",
        headers={
            "Content-Disposition": "inline; filename=generated_speech.wav",
            "X-Idream-Idempotency-Replayed": "true" if replayed else "false",
            "X-Idream-Voice-Model": request.model,
        },
    )


@app.post("/v1/voices", dependencies=[Depends(authorize)])
def clone_voice(
    voice_id: str = Form(...),
    language: str = Form(default=LANGUAGE),
    ref_text: str = Form(...),
    audio: UploadFile = File(...),
    owner_hash: Annotated[str | None, Header(alias="X-Idream-Owner-Hash")] = None,
) -> dict[str, str]:
    normalized_id = safe_voice_id(voice_id)
    erasure_registry.check(owner_hash, voice=normalized_id)
    if normalized_id in SYSTEM_VOICE_IDS:
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
        "owner_hash": owner_hash,
    }
    with registry_lock:
        def persist():
            atomic_write(voice_audio_path(normalized_id), normalized_audio)
            atomic_write(voice_manifest_path(normalized_id), json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        erasure_registry.commit(owner_hash, None, normalized_id, persist)
        clear_reference_cache()
    return {"voice_id": normalized_id, "model": MODEL_ID, "language": language}


@app.delete("/v1/voices/{voice_id}", dependencies=[Depends(authorize)])
def delete_voice(voice_id: str) -> dict[str, bool]:
    normalized_id = safe_voice_id(voice_id)
    if normalized_id in SYSTEM_VOICE_IDS:
        raise HTTPException(
            status_code=409,
            detail="The system female voice id is reserved",
        )
    erasure_registry.mark_voice_deleted(normalized_id)
    with registry_lock:
        voice_audio_path(normalized_id).unlink(missing_ok=True)
        voice_manifest_path(normalized_id).unlink(missing_ok=True)
        clear_reference_cache()
        erasure_registry.sync_directory(VOICE_DIR)
    return {"deleted": True}


@app.post("/v1/account-erasure", dependencies=[Depends(authorize)])
def erase_account(request: AccountErasureRequest) -> dict[str, bool]:
    voice_ids = [safe_voice_id(value) for value in request.voice_ids]
    if any(value in SYSTEM_VOICE_IDS for value in voice_ids):
        raise HTTPException(status_code=409, detail="System voices cannot be erased")
    with erasure_registry.lock:
        for key in request.request_keys:
            erasure_registry.check_cache_owner(idempotency_cache_path(key), request.subject_hash)
        for voice_id in voice_ids:
            path = voice_manifest_path(voice_id)
            manifest = json.loads(path.read_text()) if path.exists() else {}
            if manifest.get("owner_hash") not in (None, request.subject_hash):
                raise HTTPException(status_code=409, detail="Voice alias belongs to another owner")
        erasure_registry.mark_erased(request)
    with idempotency_lock, registry_lock:
        erasure_registry.delete_cache(request)
        for path in VOICE_DIR.glob("*.json"):
            manifest = json.loads(path.read_text())
            if manifest.get("owner_hash") == request.subject_hash and path.stem not in SYSTEM_VOICE_IDS:
                voice_ids.append(path.stem)
        for voice_id in set(voice_ids):
            erasure_registry.mark_erased(AccountErasureRequest(subject_hash=request.subject_hash, voice_ids=[voice_id]))
            delete_voice(voice_id)
        clear_reference_cache()
        erasure_registry.sync_directory(VOICE_DIR)
    return {"erased": True}
