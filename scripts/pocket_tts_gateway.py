"""iDream Pocket TTS MLX gateway.

Keeps Pocket TTS warm on Apple Silicon through the torch-free MLX backend,
exposes the existing OpenAI-compatible speech seam, and persists cloned FlowLM
voice states in MLX-native safetensors files.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from queue import Queue
from typing import Iterator

import mlx.core as mx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pocket_tts_mlx import TTSModel, __version__ as MLX_RUNTIME_VERSION
from pocket_tts_mlx.data.audio import stream_audio_chunks


MODEL_ID = os.getenv("POCKET_TTS_MODEL", "kyutai/pocket-tts")
LANGUAGE = os.getenv("POCKET_TTS_LANGUAGE", "english")
DEFAULT_VOICE = os.getenv("POCKET_TTS_DEFAULT_VOICE_ID", "alba")
API_TOKEN = os.getenv("POCKET_TTS_API_TOKEN", "").strip()
MLX_WARMUP_FRAMES = int(os.getenv("POCKET_TTS_MLX_WARMUP_FRAMES", "1"))
STATE_FORMAT = "pocket_tts_mlx_model_state_v1"
VOICE_STATE_CACHE_CAPACITY = 2
VOICE_DIR = Path(
    os.getenv("POCKET_TTS_VOICE_DIR", ".data/pocket-tts/voices")
).resolve()
VOICE_DIR.mkdir(parents=True, exist_ok=True)

if LANGUAGE != "english":
    raise RuntimeError(
        "pocket-tts-mlx 0.2.1 currently serves the English Pocket TTS variant only"
    )
if MLX_WARMUP_FRAMES < 0:
    raise RuntimeError("POCKET_TTS_MLX_WARMUP_FRAMES must be zero or greater")

model = TTSModel.load_model()
inference_lock = threading.Lock()
VoiceState = dict[str, dict[str, mx.array]]
voice_state_cache: OrderedDict[str, VoiceState] = OrderedDict()
app = FastAPI(title="iDream Pocket TTS MLX gateway", version="2.0.0")


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


def voice_path(voice_id: str) -> Path:
    return VOICE_DIR / f"{safe_voice_id(voice_id)}.safetensors"


def save_mlx_model_state(
    model_state: VoiceState,
    target: Path,
) -> None:
    arrays: dict[str, mx.array] = {}
    entries: list[dict[str, object]] = []
    for module_index, (module_name, module_state) in enumerate(model_state.items()):
        for state_index, (state_name, value) in enumerate(module_state.items()):
            tensor_key = f"state_{module_index}_{state_index}"
            shape = [int(dimension) for dimension in value.shape]
            empty = value.size == 0
            arrays[tensor_key] = (
                mx.zeros((1,), dtype=value.dtype) if empty else value
            )
            entries.append(
                {
                    "tensor": tensor_key,
                    "module": module_name,
                    "state": state_name,
                    "shape": shape,
                    "empty": empty,
                }
            )
    if not arrays:
        raise RuntimeError("Pocket TTS MLX produced an empty cloned voice state")
    mx.save_safetensors(
        target,
        arrays,
        metadata={
            "idream_format": STATE_FORMAT,
            "runtime": "pocket_tts_mlx",
            "runtime_version": MLX_RUNTIME_VERSION,
            "state_entries": json.dumps(entries, separators=(",", ":")),
        },
    )


def load_mlx_model_state(path: Path) -> VoiceState:
    loaded, metadata = mx.load(path, return_metadata=True)
    if metadata.get("idream_format") != STATE_FORMAT:
        raise RuntimeError(
            "Stored voice state predates the MLX runtime; recreate its voice candidate"
        )
    raw_entries = metadata.get("state_entries")
    if not isinstance(raw_entries, str):
        raise RuntimeError("Stored MLX voice state is missing its state manifest")
    entries = json.loads(raw_entries)
    if not isinstance(entries, list):
        raise RuntimeError("Stored MLX voice state manifest is invalid")
    model_state: VoiceState = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError("Stored MLX voice state entry is invalid")
        tensor_key = entry.get("tensor")
        module_name = entry.get("module")
        state_name = entry.get("state")
        shape = entry.get("shape")
        empty = entry.get("empty")
        if (
            not isinstance(tensor_key, str)
            or not isinstance(module_name, str)
            or not isinstance(state_name, str)
            or not isinstance(shape, list)
            or not all(isinstance(dimension, int) for dimension in shape)
            or not isinstance(empty, bool)
            or tensor_key not in loaded
        ):
            raise RuntimeError("Stored MLX voice state entry is incomplete")
        value = loaded[tensor_key]
        expected_shape = tuple(shape)
        if empty:
            value = value[:0].reshape(expected_shape)
        elif value.shape != expected_shape:
            raise RuntimeError("Stored MLX voice state tensor shape is invalid")
        model_state.setdefault(module_name, {})[state_name] = value
    if not model_state:
        raise RuntimeError("Stored MLX voice state is empty")
    mx.eval(*loaded.values())
    return model_state


def cache_voice_state(voice_id: str, state: VoiceState) -> None:
    voice_state_cache.pop(voice_id, None)
    voice_state_cache[voice_id] = state
    while len(voice_state_cache) > VOICE_STATE_CACHE_CAPACITY:
        voice_state_cache.popitem(last=False)


def model_state(voice_id: str) -> VoiceState:
    normalized_id = safe_voice_id(voice_id)
    stored = voice_path(normalized_id)
    if stored.exists():
        cached = voice_state_cache.pop(normalized_id, None)
        if cached is None:
            cached = load_mlx_model_state(stored)
        cache_voice_state(normalized_id, cached)
        return cached
    return model.get_state_for_audio_prompt(normalized_id)


class QueueWriter:
    def __init__(self, queue: Queue[bytes | Exception | None]):
        self.queue = queue

    def write(self, data: bytes) -> int:
        self.queue.put(data)
        return len(data)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        pass

    def __enter__(self) -> QueueWriter:
        return self

    def __exit__(self, *_args: object) -> bool:
        return False


def generate_to_queue(
    queue: Queue[bytes | Exception | None],
    text: str,
    voice_id: str,
) -> None:
    try:
        with inference_lock:
            chunks = model.generate_audio_stream(
                model_state=model_state(voice_id),
                text_to_generate=text,
                warmup_frames=MLX_WARMUP_FRAMES,
            )
            stream_audio_chunks(
                QueueWriter(queue),
                chunks,
                model.config.mimi.sample_rate,
            )
    except Exception as error:
        queue.put(error)
    finally:
        queue.put(None)


def wav_stream(text: str, voice_id: str) -> Iterator[bytes]:
    queue: Queue[bytes | Exception | None] = Queue()
    worker = threading.Thread(
        target=generate_to_queue,
        args=(queue, text, voice_id),
        daemon=True,
    )
    worker.start()
    try:
        while True:
            item = queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        worker.join()


@app.get("/health")
@app.get("/v1/health")
def health() -> dict[str, object]:
    return {
        "status": "healthy",
        "provider": "pocket_tts",
        "runtime": "pocket_tts_mlx",
        "runtime_version": MLX_RUNTIME_VERSION,
        "acceleration": "mlx",
        "model": MODEL_ID,
        "language": LANGUAGE,
        "voice_cloning": model.has_voice_cloning,
        "stored_voice_count": len(list(VOICE_DIR.glob("*.safetensors"))),
    }


@app.post("/v1/audio/speech", dependencies=[Depends(authorize)])
def synthesize(request: SpeechRequest) -> StreamingResponse:
    if request.response_format != "wav":
        raise HTTPException(status_code=400, detail="Only WAV output is supported")
    return StreamingResponse(
        wav_stream(request.input.strip(), request.voice),
        media_type="audio/wav",
        headers={"Content-Disposition": "inline; filename=generated_speech.wav"},
    )


@app.post("/v1/voices", dependencies=[Depends(authorize)])
def clone_voice(
    voice_id: str = Form(...),
    language: str = Form(default=LANGUAGE),
    audio: UploadFile = File(...),
) -> dict[str, str]:
    if not model.has_voice_cloning:
        raise HTTPException(
            status_code=503,
            detail=(
                "Pocket TTS is running with catalog voices, but clone weights "
                "are unavailable. Accept the kyutai/pocket-tts model terms and "
                "authenticate the runner with HF_TOKEN."
            ),
        )
    normalized_id = safe_voice_id(voice_id)
    if language != LANGUAGE:
        raise HTTPException(
            status_code=409,
            detail=f"This gateway serves {LANGUAGE}; requested {language}",
        )
    suffix = Path(audio.filename or "reference.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as source:
        source.write(audio.file.read())
        source_path = Path(source.name)
    target = voice_path(normalized_id)
    temporary_target = target.with_suffix(".tmp.safetensors")
    try:
        with inference_lock:
            state = model.get_state_for_audio_prompt(source_path, truncate=True)
            save_mlx_model_state(state, temporary_target)
            temporary_target.replace(target)
            cache_voice_state(normalized_id, state)
    finally:
        source_path.unlink(missing_ok=True)
        temporary_target.unlink(missing_ok=True)
    return {"voice_id": normalized_id, "model": MODEL_ID, "language": LANGUAGE}


@app.delete("/v1/voices/{voice_id}", dependencies=[Depends(authorize)])
def delete_voice(voice_id: str) -> dict[str, bool]:
    normalized_id = safe_voice_id(voice_id)
    with inference_lock:
        voice_state_cache.pop(normalized_id, None)
        voice_path(normalized_id).unlink(missing_ok=True)
    return {"deleted": True}
