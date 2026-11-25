"""Resident voice-cloning MLX gateway for iDream (the `fish_audio` provider slot).

SPEC: one configured IndexTTS or Breeze model owns generation; a previous model's
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

import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
try:
    from scripts.voice_cache_janitor import CacheJanitor, cache_ttl_seconds
    from scripts.voice_erasure import AccountErasureRequest, VoiceErasureRegistry
    from scripts.voice_gateway_common import atomic_write, read_idempotent_audio, safe_voice_id, validate_wav
    from scripts.voice_render_lane import RenderLane
    from scripts.indextts_voice_runtime import (
        DEFAULT_MODEL_PATH as INDEXTTS_MODEL_PATH,
        MODEL_ID as INDEXTTS_MODEL_ID, MODEL_REVISION as INDEXTTS_MODEL_REVISION,
        RUNTIME_PACKAGE as INDEXTTS_PACKAGE, IndexTTSTruncated, IndexTTSVoiceRuntime,
        validate_reference_wav as validate_indextts_reference,
    )
except ModuleNotFoundError:
    from voice_cache_janitor import CacheJanitor, cache_ttl_seconds
    from voice_erasure import AccountErasureRequest, VoiceErasureRegistry
    from voice_gateway_common import atomic_write, read_idempotent_audio, safe_voice_id, validate_wav
    from voice_render_lane import RenderLane
    from indextts_voice_runtime import (
        DEFAULT_MODEL_PATH as INDEXTTS_MODEL_PATH,
        MODEL_ID as INDEXTTS_MODEL_ID, MODEL_REVISION as INDEXTTS_MODEL_REVISION,
        RUNTIME_PACKAGE as INDEXTTS_PACKAGE, IndexTTSTruncated, IndexTTSVoiceRuntime,
        validate_reference_wav as validate_indextts_reference,
    )


BREEZE_MODEL_ID = "breeze-tts-2-mlx-8bit"
MODEL_PATHS = {
    INDEXTTS_MODEL_ID: INDEXTTS_MODEL_PATH,
    BREEZE_MODEL_ID: "~/.idream/models/mlx-community/Breeze-TTS-2-mlx-8bit",
}
# Fish S2 Pro retains exact cached replay. The gateway rejects every model ID
# outside the configured engine choices and this replay allowlist.
REPLAY_ONLY_MODEL_IDS = ("fish-audio-s2-pro-8bit",)
RECOGNIZED_MODEL_IDS = (*MODEL_PATHS, *REPLAY_ONLY_MODEL_IDS)
MODEL_ID = os.getenv("FISH_AUDIO_MODEL", INDEXTTS_MODEL_ID).strip()
if MODEL_ID not in MODEL_PATHS:
    raise RuntimeError(f"Unsupported FISH_AUDIO_MODEL: {MODEL_ID!r}")
MODEL_PATH = Path(
    os.getenv("FISH_AUDIO_MODEL_PATH", MODEL_PATHS[MODEL_ID])
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
IDEMPOTENCY_DIR = Path(
    os.getenv("FISH_AUDIO_IDEMPOTENCY_DIR", ".data/fish-audio/idempotency")
).resolve()

VOICE_MANIFEST_FORMAT = "idream_fish_audio_voice_reference_v1"
IDEMPOTENCY_MANIFEST_FORMAT = "idream_fish_audio_idempotency_v1"
IDEMPOTENCY_CACHE_MAGIC = b"IDREAM-FISH-IDEMPOTENCY-V1\n"
# Must match Main's VOICE_MAX_INPUT_CHARS: the longest reply one clip can voice.
MAX_SPEECH_CHARS = 12_000
# Breeze renders one input with a fixed token budget and has no splitter of its own.
BREEZE_INPUT_CHARS = 2_000
MAX_REFERENCE_BYTES = 15 * 1024 * 1024
MAX_REFERENCE_SECONDS = 30
MIN_REFERENCE_BYTES = 1_024
BUILTIN_VOICES = {"fish-female-default"}
SYSTEM_VOICE_IDS = BUILTIN_VOICES | {DEFAULT_VOICE}
registry_lock = threading.RLock()
idempotency_lock = threading.RLock()
generation_lock = threading.Lock()
render_lane = RenderLane(max_pending=8)
runtime_model: Any | None = None

if not LANGUAGE:
    raise RuntimeError("FISH_AUDIO_LANGUAGE is required")

VOICE_DIR.mkdir(parents=True, exist_ok=True)
IDEMPOTENCY_DIR.mkdir(parents=True, exist_ok=True)
erasure_registry = VoiceErasureRegistry(IDEMPOTENCY_DIR, IDEMPOTENCY_CACHE_MAGIC)
cache_janitor = CacheJanitor(IDEMPOTENCY_DIR, idempotency_lock, cache_ttl_seconds())


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
    input: str = Field(min_length=1, max_length=MAX_SPEECH_CHARS)
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
    if MODEL_ID == INDEXTTS_MODEL_ID:
        runtime_model = IndexTTSVoiceRuntime(MODEL_PATH, LANGUAGE)
        return runtime_model
    from mlx_audio.tts.utils import load_model

    from mlx_audio.tts.models.breeze_tts import Model as BreezeModel

    candidate = load_model(model_path=str(MODEL_PATH))
    if not isinstance(candidate, BreezeModel):
        raise RuntimeError("Configured Breeze directory does not contain a Breeze model")
    runtime_model = candidate
    return runtime_model


def clear_reference_cache() -> None:
    # Registry mutation/erasure waits for active synthesis before releasing its
    # derived speaker vectors; no embedding cache is written to disk.
    with generation_lock:
        if MODEL_ID == INDEXTTS_MODEL_ID and runtime_model is not None:
            runtime_model.clear_reference_cache()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await render_lane.run(load_runtime_model)
    cache_janitor.start()
    yield
    cache_janitor.stop()


app = FastAPI(
    title="iDream MLX voice-cloning gateway",
    version="1.0.0",
    lifespan=lifespan,
)


def authorize(authorization: str | None = Header(default=None)) -> None:
    if API_TOKEN and authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid Fish Audio API token")


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
    ):
        raise HTTPException(
            status_code=503,
            detail=f"Stored voice '{voice_id}' has an incompatible manifest",
        )
    return {
        "ref_text": raw["ref_text"].strip(),
        "language": raw["language"],
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


def resolve_reference(voice_id: str) -> tuple[Path, dict[str, Any]]:
    manifest = load_voice_manifest(voice_id)
    if manifest is not None:
        return voice_audio_path(voice_id), manifest
    if voice_id not in BUILTIN_VOICES:
        raise HTTPException(status_code=404, detail="Stored voice not found")
    return load_system_reference()


def system_voice_status() -> tuple[bool, str | None]:
    # A render holds registry_lock throughout, and this runs on the event loop inside
    # Main's 2s probe. The system voice is never mutated by the registry operations
    # that lock protects, so a busy lock is no reason to stop reading it.
    locked = registry_lock.acquire(blocking=False)
    try:
        path, _ = resolve_reference(safe_voice_id(DEFAULT_VOICE))
        validate_reference_wav(path.read_bytes())
    except HTTPException as error:
        return False, str(error.detail)
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        return False, str(error)
    finally:
        if locked:
            registry_lock.release()
    return True, None


def validate_reference_wav(reference: bytes) -> None:
    if MODEL_ID == INDEXTTS_MODEL_ID:
        validate_indextts_reference(reference)
    else:
        validate_wav(reference)


def stored_voice_count() -> int:
    return sum(
        1
        for manifest_path in VOICE_DIR.glob("*.json")
        if manifest_path.with_suffix(".wav").is_file()
    )


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
        validate_reference_wav(normalized)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return normalized


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


def render_idempotent_wav(
    request: SpeechRequest,
    idempotency_key: str,
    request_id: str,
    attempt_no: int,
    owner_hash: str | None = None,
) -> tuple[bytes, bool]:
    if request.model not in RECOGNIZED_MODEL_IDS:
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
        replay = read_idempotent_audio(cache_path, request_fingerprint, IDEMPOTENCY_CACHE_MAGIC, IDEMPOTENCY_MANIFEST_FORMAT)
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


def require_generation_model(requested_model: str) -> None:
    if requested_model != MODEL_ID:
        raise HTTPException(
            status_code=409,
            detail=f"Configured model is '{MODEL_ID}'; '{requested_model}' can only replay an existing matching result",
        )


def split_for_breeze(text: str, limit: int = BREEZE_INPUT_CHARS) -> list[str]:
    """Keep every word, cutting at sentence ends and only hard-cutting a run-on sentence.

    Input up to the limit stays one piece, so it renders exactly as it was measured.
    """
    if len(text) <= limit:
        return [text]
    pieces: list[str] = []
    pending = ""
    for sentence in re.findall(r".+?(?:[。！？]|[.!?](?=\s|$)|$)\s*", text, flags=re.DOTALL):
        if pending and len(pending) + len(sentence) > limit:
            pieces.append(pending)
            pending = ""
        pending += sentence
        while len(pending) > limit:
            pieces.append(pending[:limit])
            pending = pending[limit:]
    if pending:
        pieces.append(pending)
    return [piece.strip() for piece in pieces if piece.strip()]


def render_wav(request: SpeechRequest) -> bytes:
    require_generation_model(request.model)
    if not request.input.strip():
        raise HTTPException(status_code=400, detail="Speech text must contain non-whitespace characters")
    model = load_runtime_model()
    voice_id = safe_voice_id(request.voice)
    # Keep the manifest, WAV and derived identity in one registry generation.
    # Erasure persists its barrier first, then waits for this lock to release.
    with registry_lock, generation_lock:
        reference_path, manifest = resolve_reference(voice_id)
        if MODEL_ID == INDEXTTS_MODEL_ID:
            try:
                validate_indextts_reference(reference_path.read_bytes())
            except (OSError, ValueError) as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
            try:
                audio = model.generate(
                    request.input.strip(), reference_path,
                    preset=request.delivery.preset,
                    intensity=request.delivery.intensity, speed=request.delivery.speed,
                )
            except IndexTTSTruncated as error:
                raise HTTPException(status_code=502, detail=str(error)) from error
            sample_rate = model.sample_rate
        else:
            from mlx_audio.utils import load_audio

            ref_audio = load_audio(str(reference_path), sample_rate=model.sample_rate)
            # Preserve Breeze's measured no-CFG conditioning path and sampling.
            results = [
                result
                for piece in split_for_breeze(request.input.strip())
                for result in model.generate(
                    text=piece,
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
            ]
            if not results:
                raise HTTPException(status_code=502, detail="Voice model returned no audio")
            audio = np.concatenate(
                [np.array(result.audio, dtype=np.float32).reshape(-1) for result in results]
            )
            sample_rate = results[0].sample_rate
    if audio.ndim != 1 or audio.size == 0 or not np.isfinite(audio).all():
        raise HTTPException(status_code=502, detail="Voice model returned invalid audio")
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767.0).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm)
    return output.getvalue()


@app.get("/health")
@app.get("/v1/health")
async def health() -> JSONResponse:
    model, model_error = None, None
    try:
        # Loading belongs on the render thread; a loaded model must not queue behind a render.
        model = runtime_model if runtime_model is not None else await render_lane.run(load_runtime_model)
    except (OSError, ValueError, RuntimeError, ImportError, PackageNotFoundError) as error:
        model_error = str(error)
    system_voice_ready, system_voice_error = system_voice_status()
    index_tts = MODEL_ID == INDEXTTS_MODEL_ID
    languages = ("en",)
    if index_tts:
        languages = model.languages if model is not None else ()
    try:
        runtime_version = version(INDEXTTS_PACKAGE if index_tts else "mlx-audio")
    except PackageNotFoundError:
        runtime_version = "unknown"
    ready = model is not None and system_voice_ready
    payload = {
        "status": "healthy" if ready else "degraded",
        "provider": "fish_audio",
        "runtime": "mlx_indextts" if index_tts else "mlx_audio",
        "runtime_version": runtime_version,
        "acceleration": "mlx",
        "model": MODEL_ID,
        "configured_model": MODEL_ID,
        "supported_models": [MODEL_ID],
        "recognized_models": list(RECOGNIZED_MODEL_IDS),
        "replay_only_models": [value for value in RECOGNIZED_MODEL_IDS if value != MODEL_ID],
        "languages": list(languages),
        "model_path": str(MODEL_PATH),
        "model_loaded": model is not None,
        "model_error": model_error,
        "language": LANGUAGE,
        "voice_cloning": True,
        "system_voice_ready": system_voice_ready,
        "system_voice_error": system_voice_error,
        "stored_voice_count": stored_voice_count(),
    }
    if index_tts:
        payload["model_revision"] = INDEXTTS_MODEL_REVISION
    return JSONResponse(
        content=payload,
        status_code=200 if ready else 503,
    )


@app.post("/v1/audio/speech", dependencies=[Depends(authorize)])
async def synthesize(
    http_request: Request,
    request: SpeechRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    request_id: str | None = Header(default=None, alias="X-Idream-Request-Id"),
    attempt_no: int | None = Header(default=None, alias="X-Idream-Attempt-No"),
    owner_hash: Annotated[str | None, Header(alias="X-Idream-Owner-Hash")] = None,
) -> Response:
    return await render_lane.admit(
        speech_response, request, idempotency_key, request_id, attempt_no, owner_hash,
        cancelled=http_request.is_disconnected,
    )


def speech_response(
    request: SpeechRequest,
    idempotency_key: str | None,
    request_id: str | None,
    attempt_no: int | None,
    owner_hash: str | None,
) -> Response:
    erasure_registry.check(owner_hash, idempotency_key, request.voice)
    if request.response_format != "wav":
        raise HTTPException(status_code=400, detail="Only WAV output is supported")
    if request.model not in RECOGNIZED_MODEL_IDS:
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
        "runtime": "mlx_indextts" if MODEL_ID == INDEXTTS_MODEL_ID else "mlx_audio",
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
