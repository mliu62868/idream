"""Resident official Pocket TTS gateway for iDream.

Pocket owns CPU inference and voice-state compilation. This gateway owns the
product-facing durable voice registry, exact-key speech replay, and the stable
HTTP contract used by Main and Admin.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import wave
from collections import OrderedDict
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4

import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

MODEL_ID = os.getenv("POCKET_TTS_MODEL", "pocket-tts").strip()
LANGUAGE = os.getenv("POCKET_TTS_LANGUAGE", "english").strip()
DEFAULT_VOICE = os.getenv("POCKET_TTS_DEFAULT_VOICE_ID", "alba").strip()
PINNED_MODEL_REVISION = "39592ff23c9ef80098bb74895d104c26275fe2c9"
MODEL_REVISION = os.getenv(
    "POCKET_TTS_MODEL_REVISION",
    PINNED_MODEL_REVISION,
).strip()
API_TOKEN = os.getenv("POCKET_TTS_API_TOKEN", "").strip()
TEMPERATURE = float(os.getenv("POCKET_TTS_TEMPERATURE", "0.3"))
SAMPLER_DECODE_STEPS = int(os.getenv("POCKET_TTS_SAMPLER_DECODE_STEPS", "1"))
EOS_THRESHOLD = float(os.getenv("POCKET_TTS_EOS_THRESHOLD", "-4.0"))
NOISE_CLAMP_RAW = os.getenv("POCKET_TTS_NOISE_CLAMP", "").strip()
NOISE_CLAMP = float(NOISE_CLAMP_RAW) if NOISE_CLAMP_RAW else None
FRAMES_AFTER_EOS_RAW = os.getenv("POCKET_TTS_FRAMES_AFTER_EOS", "").strip()
FRAMES_AFTER_EOS = int(FRAMES_AFTER_EOS_RAW) if FRAMES_AFTER_EOS_RAW else None
VOICE_STATE_CACHE_SIZE = int(os.getenv("POCKET_TTS_VOICE_STATE_CACHE_SIZE", "8"))
VOICE_DIR = Path(os.getenv("POCKET_TTS_VOICE_DIR", ".data/pocket-tts/voices")).resolve()
IDEMPOTENCY_DIR = Path(
    os.getenv("POCKET_TTS_IDEMPOTENCY_DIR", ".data/pocket-tts/idempotency")
).resolve()

VOICE_MANIFEST_FORMAT = "idream_pocket_tts_voice_state_v1"
IDEMPOTENCY_MANIFEST_FORMAT = "idream_pocket_tts_idempotency_v1"
IDEMPOTENCY_CACHE_MAGIC = b"IDREAM-POCKET-TTS-IDEMPOTENCY-V1\n"
MAX_REFERENCE_BYTES = 15 * 1024 * 1024
MAX_REFERENCE_SECONDS = 30
MIN_REFERENCE_BYTES = 1_024
MAX_INPUT_CHARS = 2_000
ENGLISH_CATALOG_VOICES = (
    "cosette",
    "marius",
    "javert",
    "alba",
    "jean",
    "anna",
    "vera",
    "fantine",
    "charles",
    "paul",
    "eponine",
    "azelma",
    "george",
    "mary",
    "jane",
    "michael",
    "eve",
    "bill_boerst",
    "peter_yearsley",
    "stuart_bell",
    "caro_davy",
)
ENGLISH_CATALOG_VOICE_SET = frozenset(ENGLISH_CATALOG_VOICES)

registry_lock = threading.RLock()
idempotency_lock = threading.RLock()
generation_lock = threading.Lock()
runtime_model: Any | None = None
runtime_export_model_state: Any | None = None
voice_state_cache: OrderedDict[str, Any] = OrderedDict()

if not MODEL_ID:
    raise RuntimeError("POCKET_TTS_MODEL is required")
if LANGUAGE != "english":
    raise RuntimeError("This Pocket TTS gateway serves the English model only")
if MODEL_REVISION != PINNED_MODEL_REVISION:
    raise RuntimeError(f"POCKET_TTS_MODEL_REVISION must be {PINNED_MODEL_REVISION}")
if SAMPLER_DECODE_STEPS < 1:
    raise RuntimeError("POCKET_TTS_SAMPLER_DECODE_STEPS must be positive")
if VOICE_STATE_CACHE_SIZE < 1:
    raise RuntimeError("POCKET_TTS_VOICE_STATE_CACHE_SIZE must be positive")
if DEFAULT_VOICE not in ENGLISH_CATALOG_VOICE_SET:
    raise RuntimeError(
        "POCKET_TTS_DEFAULT_VOICE_ID must name an official English catalog voice"
    )

VOICE_DIR.mkdir(parents=True, exist_ok=True)
IDEMPOTENCY_DIR.mkdir(parents=True, exist_ok=True)


class SpeechRequest(BaseModel):
    model: str = Field(default=MODEL_ID)
    input: str = Field(min_length=1, max_length=MAX_INPUT_CHARS)
    voice: str = Field(default=DEFAULT_VOICE, min_length=1, max_length=160)
    response_format: str = Field(default="wav")


class PresetVoiceRequest(BaseModel):
    voice_id: str = Field(min_length=3, max_length=160)
    preset_voice_id: str = Field(min_length=3, max_length=160)
    language: str = Field(default=LANGUAGE)


def package_version() -> str:
    try:
        return version("pocket-tts")
    except PackageNotFoundError:
        return "unavailable"


def config_fingerprint() -> str:
    canonical = json.dumps(
        {
            "package_version": package_version(),
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "language": LANGUAGE,
            "temperature": TEMPERATURE,
            "sampler_decode_steps": SAMPLER_DECODE_STEPS,
            "noise_clamp": NOISE_CLAMP,
            "eos_threshold": EOS_THRESHOLD,
            "frames_after_eos": FRAMES_AFTER_EOS,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def load_runtime_model() -> Any:
    global runtime_export_model_state, runtime_model
    if runtime_model is not None:
        return runtime_model
    from pocket_tts import TTSModel, export_model_state

    runtime_model = TTSModel.load_model(
        language=LANGUAGE,
        temp=TEMPERATURE,
        sampler_decode_steps=SAMPLER_DECODE_STEPS,
        noise_clamp=NOISE_CLAMP,
        eos_threshold=EOS_THRESHOLD,
    )
    runtime_export_model_state = export_model_state
    return runtime_model


def require_voice_cloning(model: Any) -> None:
    if getattr(model, "has_voice_cloning", False) is not True:
        raise HTTPException(
            status_code=503,
            detail=(
                "Pocket TTS voice-cloning weights are unavailable; accept the "
                "kyutai/pocket-tts model terms and authenticate this host"
            ),
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_runtime_model()
    ensure_system_voice()
    yield


app = FastAPI(
    title="iDream Pocket TTS gateway",
    version="4.0.0",
    lifespan=lifespan,
)


def authorize(authorization: str | None = Header(default=None)) -> None:
    if API_TOKEN and authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid Pocket TTS API token")


def safe_voice_id(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,159}", normalized):
        raise HTTPException(status_code=400, detail="Invalid voice_id")
    return normalized


def voice_bundle_path(voice_id: str) -> Path:
    return VOICE_DIR / safe_voice_id(voice_id)


def voice_state_path(voice_id: str) -> Path:
    return voice_bundle_path(voice_id) / "state.safetensors"


def voice_manifest_path(voice_id: str) -> Path:
    return voice_bundle_path(voice_id) / "manifest.json"


def atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def load_voice_manifest(voice_id: str) -> dict[str, Any] | None:
    state_path = voice_state_path(voice_id)
    manifest_path = voice_manifest_path(voice_id)
    bundle_path = voice_bundle_path(voice_id)
    if not bundle_path.exists():
        return None
    if (
        not bundle_path.is_dir()
        or not state_path.is_file()
        or not manifest_path.is_file()
    ):
        raise HTTPException(
            status_code=503,
            detail=f"Stored voice '{voice_id}' is incomplete",
        )
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        state_sha256 = sha256_bytes(state_path.read_bytes())
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=503,
            detail=f"Stored voice '{voice_id}' has an invalid manifest",
        ) from error
    if (
        not isinstance(raw, dict)
        or raw.get("format") != VOICE_MANIFEST_FORMAT
        or raw.get("provider") != "pocket_tts"
        or raw.get("model") != MODEL_ID
        or raw.get("language") != LANGUAGE
        or raw.get("config_fingerprint") != config_fingerprint()
        or raw.get("state_sha256") != state_sha256
    ):
        raise HTTPException(
            status_code=503,
            detail=f"Stored voice '{voice_id}' is incompatible with this runtime",
        )
    return raw


def stored_voice_count() -> int:
    return sum(
        1
        for path in VOICE_DIR.iterdir()
        if path.is_dir()
        and path.name not in ENGLISH_CATALOG_VOICE_SET
        and (path / "state.safetensors").is_file()
        and (path / "manifest.json").is_file()
    )


def export_state_to_bundle(
    voice_id: str,
    model_state: Any,
    manifest: dict[str, Any],
) -> None:
    normalized_id = safe_voice_id(voice_id)
    final_bundle = voice_bundle_path(normalized_id)
    if final_bundle.exists():
        raise HTTPException(status_code=409, detail="Voice id already exists")
    temporary_bundle = Path(
        tempfile.mkdtemp(prefix=f".{normalized_id}.", dir=str(VOICE_DIR))
    )
    try:
        state_path = temporary_bundle / "state.safetensors"
        if runtime_export_model_state is None:
            load_runtime_model()
        assert runtime_export_model_state is not None
        runtime_export_model_state(model_state, state_path)
        if not state_path.is_file() or state_path.stat().st_size == 0:
            raise RuntimeError("Pocket TTS exported an empty voice state")
        state_path.chmod(0o600)
        manifest["state_sha256"] = sha256_bytes(state_path.read_bytes())
        manifest_path = temporary_bundle / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                manifest,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        manifest_path.chmod(0o600)
        temporary_bundle.chmod(0o700)
        os.replace(temporary_bundle, final_bundle)
    except FileExistsError as error:
        raise HTTPException(
            status_code=409, detail="Voice id already exists"
        ) from error
    finally:
        if temporary_bundle.exists():
            shutil.rmtree(temporary_bundle)


def base_voice_manifest(
    voice_id: str,
    *,
    source_kind: str,
    source_sha256: str | None,
    source_filename: str | None,
    source_content_type: str | None,
    source_voice_id: str | None = None,
) -> dict[str, Any]:
    return {
        "format": VOICE_MANIFEST_FORMAT,
        "provider": "pocket_tts",
        "runtime": "pocket_tts",
        "runtime_version": package_version(),
        "model": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "language": LANGUAGE,
        "voice_id": voice_id,
        "source_kind": source_kind,
        "source_sha256": source_sha256,
        "source_filename": source_filename,
        "source_content_type": source_content_type,
        "source_voice_id": source_voice_id,
        "config_fingerprint": config_fingerprint(),
    }


def ensure_catalog_voice(voice_id: str) -> dict[str, Any]:
    normalized_id = safe_voice_id(voice_id)
    if normalized_id not in ENGLISH_CATALOG_VOICE_SET:
        raise HTTPException(status_code=404, detail="Catalog voice not found")
    with registry_lock:
        manifest = load_voice_manifest(normalized_id)
        if manifest is not None:
            return manifest
        model = load_runtime_model()
        with generation_lock:
            state = model.get_state_for_audio_prompt(normalized_id)
        manifest = base_voice_manifest(
            normalized_id,
            source_kind="builtin",
            source_sha256=None,
            source_filename=None,
            source_content_type=None,
            source_voice_id=normalized_id,
        )
        export_state_to_bundle(normalized_id, state, manifest)
        return load_voice_manifest(normalized_id) or manifest


def ensure_system_voice() -> dict[str, Any]:
    return ensure_catalog_voice(DEFAULT_VOICE)


def resolve_voice(voice_id: str) -> tuple[dict[str, Any], Path]:
    normalized_id = safe_voice_id(voice_id)
    with registry_lock:
        if normalized_id in ENGLISH_CATALOG_VOICE_SET:
            manifest = ensure_catalog_voice(normalized_id)
        else:
            manifest = load_voice_manifest(normalized_id)
            if manifest is None:
                raise HTTPException(status_code=404, detail="Stored voice not found")
        return manifest, voice_state_path(normalized_id)


def load_voice_state(manifest: dict[str, Any], state_path: Path) -> Any:
    cache_key = f"{manifest['voice_id']}:{manifest['state_sha256']}"
    cached = voice_state_cache.get(cache_key)
    if cached is not None:
        voice_state_cache.move_to_end(cache_key)
        return cached
    state = load_runtime_model().get_state_for_audio_prompt(state_path)
    voice_state_cache[cache_key] = state
    voice_state_cache.move_to_end(cache_key)
    while len(voice_state_cache) > VOICE_STATE_CACHE_SIZE:
        voice_state_cache.popitem(last=False)
    return state


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
        try:
            duration = validate_wav(reference)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
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
    with tempfile.TemporaryDirectory(prefix="idream-pocket-reference-") as directory:
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


def tensor_to_wav(audio: Any, sample_rate: int) -> bytes:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if samples.size == 0 or not np.isfinite(samples).all():
        raise HTTPException(status_code=502, detail="Pocket TTS returned invalid audio")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def render_wav(
    request: SpeechRequest,
    resolved_voice: tuple[dict[str, Any], Path] | None = None,
) -> bytes:
    manifest, state_path = resolved_voice or resolve_voice(request.voice)
    model = load_runtime_model()
    with generation_lock:
        state = load_voice_state(manifest, state_path)
        audio = model.generate_audio(
            state,
            request.input.strip(),
            frames_after_eos=FRAMES_AFTER_EOS,
            copy_state=True,
        )
    return tensor_to_wav(audio, int(model.sample_rate))


def speech_request_fingerprint(
    request: SpeechRequest,
    manifest: dict[str, Any],
) -> str:
    canonical = json.dumps(
        {
            "request": request.model_dump(mode="json"),
            "voice_state_sha256": manifest["state_sha256"],
            "config_fingerprint": config_fingerprint(),
        },
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
        if (
            not content.startswith(IDEMPOTENCY_CACHE_MAGIC)
            or len(content) <= prefix_size
        ):
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
) -> tuple[bytes, bool]:
    if not request_id.strip() or attempt_no < 1:
        raise HTTPException(
            status_code=400,
            detail="Idempotent speech requires request id and positive attempt number",
        )
    resolved_voice = resolve_voice(request.voice)
    request_fingerprint = speech_request_fingerprint(request, resolved_voice[0])
    cache_path = idempotency_cache_path(idempotency_key)
    with idempotency_lock:
        replay = load_idempotent_audio(cache_path, request_fingerprint)
        if replay is not None:
            return replay, True
        rendered = render_wav(request, resolved_voice)
        manifest = {
            "format": IDEMPOTENCY_MANIFEST_FORMAT,
            "request_fingerprint": request_fingerprint,
            "request_id": request_id.strip(),
            "attempt_no": attempt_no,
        }
        manifest_bytes = json.dumps(
            manifest,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        # INVARIANT: metadata and audio become visible in one atomic rename, so
        # a crash cannot leave a key that is allowed to render twice.
        atomic_write(
            cache_path,
            b"".join(
                (
                    IDEMPOTENCY_CACHE_MAGIC,
                    struct.pack(">I", len(manifest_bytes)),
                    manifest_bytes,
                    rendered,
                )
            ),
        )
        return rendered, False


@app.get("/health")
@app.get("/v1/health")
async def health() -> JSONResponse:
    try:
        model = load_runtime_model()
        ensure_system_voice()
        payload = {
            "status": "healthy",
            "provider": "pocket_tts",
            "runtime": "pocket_tts",
            "runtime_version": package_version(),
            "acceleration": "cpu",
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "config_fingerprint": config_fingerprint(),
            "model_loaded": model is not None,
            "language": LANGUAGE,
            "voice_cloning": model.has_voice_cloning,
            "catalog_ready": True,
            "catalog_voices": list(ENGLISH_CATALOG_VOICES),
            "system_voice_ready": True,
            "stored_voice_count": stored_voice_count(),
            "idempotency_writable": os.access(IDEMPOTENCY_DIR, os.W_OK),
        }
        if not model.has_voice_cloning:
            payload["voice_cloning_error"] = (
                "Pocket TTS voice-cloning weights are unavailable; accept the "
                "kyutai/pocket-tts model terms and authenticate this host"
            )
        return JSONResponse(content=payload, status_code=200)
    # INTENT: readiness must report third-party model/download failures as a
    # degraded provider instead of crashing the health request itself.
    except Exception as error:  # noqa: BLE001
        return JSONResponse(
            content={
                "status": "degraded",
                "provider": "pocket_tts",
                "runtime": "pocket_tts",
                "runtime_version": package_version(),
                "acceleration": "cpu",
                "model": MODEL_ID,
                "model_revision": MODEL_REVISION,
                "language": LANGUAGE,
                "voice_cloning": False,
                "catalog_ready": False,
                "catalog_voices": list(ENGLISH_CATALOG_VOICES),
                "system_voice_ready": False,
                "error": str(error),
            },
            status_code=503,
        )


@app.post("/v1/audio/speech", dependencies=[Depends(authorize)])
async def synthesize(
    request: SpeechRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    request_id: str | None = Header(default=None, alias="X-Idream-Request-Id"),
    attempt_no: int | None = Header(default=None, alias="X-Idream-Attempt-No"),
) -> Response:
    if request.response_format != "wav":
        raise HTTPException(status_code=400, detail="Only WAV output is supported")
    if request.model != MODEL_ID:
        raise HTTPException(
            status_code=409,
            detail=f"Configured model is '{MODEL_ID}', received '{request.model}'",
        )
    started = time.monotonic()
    replayed = False
    if idempotency_key is None:
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
        )
    elapsed_ms = round((time.monotonic() - started) * 1_000)
    return Response(
        content=rendered,
        media_type="audio/wav",
        headers={
            "Content-Disposition": "inline; filename=generated_speech.wav",
            "X-Idream-Idempotency-Replayed": "true" if replayed else "false",
            "X-Idream-Generation-Ms": str(elapsed_ms),
        },
    )


@app.post("/v1/voices", dependencies=[Depends(authorize)])
def clone_voice(
    voice_id: Annotated[str, Form()],
    ref_text: Annotated[str, Form()],
    audio: Annotated[UploadFile, File()],
    language: Annotated[str, Form()] = LANGUAGE,
) -> dict[str, str]:
    normalized_id = safe_voice_id(voice_id)
    if normalized_id in ENGLISH_CATALOG_VOICE_SET:
        raise HTTPException(status_code=409, detail="Catalog voice ids are reserved")
    if language != LANGUAGE:
        raise HTTPException(
            status_code=409,
            detail=f"This gateway serves {LANGUAGE}; requested {language}",
        )
    normalized_text = ref_text.strip()
    if len(normalized_text) < 3 or len(normalized_text) > MAX_INPUT_CHARS:
        raise HTTPException(
            status_code=400,
            detail="ref_text must contain 3 to 2000 characters",
        )
    reference = audio.file.read(MAX_REFERENCE_BYTES + 1)
    if len(reference) < MIN_REFERENCE_BYTES:
        raise HTTPException(
            status_code=400, detail="Voice reference audio is too small"
        )
    if len(reference) > MAX_REFERENCE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Voice reference audio must be 15 MB or smaller",
        )
    normalized_audio = normalize_reference_audio(
        reference,
        audio.filename or "reference.audio",
    )
    with registry_lock:
        if voice_bundle_path(normalized_id).exists():
            raise HTTPException(status_code=409, detail="Voice id already exists")
        with tempfile.TemporaryDirectory(
            prefix="idream-pocket-clone-",
        ) as directory:
            reference_path = Path(directory) / "reference.wav"
            reference_path.write_bytes(normalized_audio)
            model = load_runtime_model()
            require_voice_cloning(model)
            with generation_lock:
                state = model.get_state_for_audio_prompt(
                    reference_path,
                    truncate=True,
                )
        manifest = base_voice_manifest(
            normalized_id,
            source_kind="reference_audio",
            source_sha256=sha256_bytes(normalized_audio),
            source_filename=Path(audio.filename or "reference.audio").name,
            source_content_type=audio.content_type or "application/octet-stream",
        )
        manifest["reference_text"] = normalized_text
        export_state_to_bundle(normalized_id, state, manifest)
    return {"voice_id": normalized_id, "model": MODEL_ID, "language": LANGUAGE}


@app.post("/v1/voices/presets", dependencies=[Depends(authorize)])
def create_preset_voice(request: PresetVoiceRequest) -> dict[str, str]:
    normalized_id = safe_voice_id(request.voice_id)
    preset_voice_id = safe_voice_id(request.preset_voice_id)
    if normalized_id in ENGLISH_CATALOG_VOICE_SET:
        raise HTTPException(status_code=409, detail="Catalog voice ids are reserved")
    if preset_voice_id not in ENGLISH_CATALOG_VOICE_SET:
        raise HTTPException(status_code=404, detail="Catalog voice not found")
    if request.language != LANGUAGE:
        raise HTTPException(
            status_code=409,
            detail=f"This gateway serves {LANGUAGE}; requested {request.language}",
        )
    with registry_lock:
        if voice_bundle_path(normalized_id).exists():
            raise HTTPException(status_code=409, detail="Voice id already exists")
        model = load_runtime_model()
        with generation_lock:
            state = model.get_state_for_audio_prompt(preset_voice_id)
        manifest = base_voice_manifest(
            normalized_id,
            source_kind="builtin_alias",
            source_sha256=None,
            source_filename=None,
            source_content_type=None,
            source_voice_id=preset_voice_id,
        )
        export_state_to_bundle(normalized_id, state, manifest)
    return {
        "voice_id": normalized_id,
        "preset_voice_id": preset_voice_id,
        "model": MODEL_ID,
        "language": LANGUAGE,
    }


@app.delete("/v1/voices/{voice_id}", dependencies=[Depends(authorize)])
def delete_voice(voice_id: str) -> dict[str, bool]:
    normalized_id = safe_voice_id(voice_id)
    if normalized_id in ENGLISH_CATALOG_VOICE_SET:
        raise HTTPException(status_code=409, detail="Catalog voices cannot be deleted")
    with registry_lock:
        shutil.rmtree(voice_bundle_path(normalized_id), ignore_errors=True)
        for key in list(voice_state_cache):
            if key.startswith(f"{normalized_id}:"):
                del voice_state_cache[key]
    return {"deleted": True}
