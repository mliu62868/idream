"""iDream Pocket TTS gateway.

Keeps the official Kyutai model and cloned voice states warm, exposes the
existing OpenAI-compatible speech seam, and adds a durable voice-clone endpoint.
"""

from __future__ import annotations

import os
import re
import tempfile
import threading
from pathlib import Path
from queue import Queue
from typing import Iterator

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from pocket_tts.data.audio import stream_audio_chunks
from pocket_tts.models.tts_model import TTSModel, export_model_state


MODEL_ID = os.getenv("POCKET_TTS_MODEL", "kyutai/pocket-tts")
LANGUAGE = os.getenv("POCKET_TTS_LANGUAGE", "english")
DEFAULT_VOICE = os.getenv("POCKET_TTS_DEFAULT_VOICE_ID", "alba")
API_TOKEN = os.getenv("POCKET_TTS_API_TOKEN", "").strip()
VOICE_DIR = Path(
    os.getenv("POCKET_TTS_VOICE_DIR", ".data/pocket-tts/voices")
).resolve()
VOICE_DIR.mkdir(parents=True, exist_ok=True)

model = TTSModel.load_model(
    language=LANGUAGE,
    quantize=os.getenv("POCKET_TTS_QUANTIZE", "false").lower() == "true",
)
inference_lock = threading.Lock()
app = FastAPI(title="iDream Pocket TTS gateway", version="1.0.0")


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


def model_state(voice_id: str):
    stored = voice_path(voice_id)
    if stored.exists():
        return model.get_state_for_audio_prompt(stored)
    return model.get_state_for_audio_prompt(voice_id)


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
            export_model_state(state, temporary_target)
        temporary_target.replace(target)
    finally:
        source_path.unlink(missing_ok=True)
        temporary_target.unlink(missing_ok=True)
    return {"voice_id": normalized_id, "model": MODEL_ID, "language": LANGUAGE}


@app.delete("/v1/voices/{voice_id}", dependencies=[Depends(authorize)])
def delete_voice(voice_id: str) -> dict[str, bool]:
    voice_path(voice_id).unlink(missing_ok=True)
    return {"deleted": True}
