"""Single resident MLX Whisper ASR. Audio and unsubmitted text are never persisted.

INVARIANT: cancelling HTTP delivery does not release a running native inference
slot. All Main instances must share this one gateway for user admission limits.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
import shutil
import tempfile
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from importlib.metadata import version
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

MODEL_ID = "mlx-community/whisper-large-v3-mlx"
MODEL_REVISION = "49e6aa286ad60c14352c404340ded53710378a11"
SDK_VERSION = "0.4.3"
MODEL_FILES = {
    "weights.npz": "05ff791ce3630fae47e7c51004e9666204d786246ec07cac6110af768099b40d",
    "config.json": "34982ce6ae286095000f82ae9583b3431639e8b092bf60c961f203745e6500e3",
}
GATEWAY_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
# Product support, not the multilingual model's complete vocabulary.
LANGUAGES = ["en"]
MAX_BYTES = 8 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_PCM_BYTES = 60 * SAMPLE_RATE * 2
TTL = 120
MAX_STATES = 512
UPLOAD_TIMEOUT = 20
DEADLINE = 30
QUEUE_TIMEOUT = 2
MAX_QUEUE = 4
MAX_TEXT = 32000
TEMP_DIR = Path(os.getenv("ASR_TEMP_DIR", ".data/asr/audio")).resolve()
uploads = 0
API_TOKEN = os.getenv("ASR_API_TOKEN", "").strip()
runtime: Any = None
healthy = False
accepting = True
slot: asyncio.Lock | None = None
states: dict[str, "Operation"] = {}
rates: dict[str, deque[float]] = {}
tasks: set[asyncio.Task] = set()


@dataclass
class Operation:
    user: str
    conversation: str
    request_id: str
    status: str = "pending"
    digest: str | None = None
    text: str | None = None
    duration: int | None = None
    error: str | None = None
    expires: float = field(default_factory=lambda: time.time() + TTL)
    active: bool = True
    deadline: float = float("inf")
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    uploaded: asyncio.Event = field(default_factory=asyncio.Event)


class WhisperRuntime:
    def __init__(self, snapshot: str):
        self.snapshot = snapshot

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        from mlx_whisper.transcribe import ModelHolder
        ModelHolder.model = ModelHolder.model_path = None

    def transcribe(self, *, audio, sample_rate, timestamps, language="en"):
        import mlx_whisper
        if sample_rate != SAMPLE_RATE or timestamps != "none":
            raise ValueError("ASR requires normalized 16 kHz PCM without timestamps")
        # No prompt, hotwords, or transcript rewriting. A fixed greedy decoder
        # avoids stochastic retries and context leakage between recordings.
        return mlx_whisper.transcribe(
            audio, path_or_hf_repo=self.snapshot, language=language, task="transcribe",
            temperature=0, condition_on_previous_text=False, fp16=True,
            word_timestamps=False, verbose=None,
        )


def load_runtime():
    """Use only the pinned cached snapshot; installation is an explicit step."""
    import mlx.core as mx
    from mlx_whisper.transcribe import ModelHolder
    from mlx.utils import tree_flatten
    from huggingface_hub import snapshot_download
    if version("mlx-whisper") != SDK_VERSION:
        raise RuntimeError("ASR SDK version differs from the lock")
    if not mx.metal.is_available():
        raise RuntimeError("ASR requires an available Apple Metal device")
    mx.set_default_device(mx.gpu)
    snapshot = snapshot_download(MODEL_ID, revision=MODEL_REVISION, allow_patterns=list(MODEL_FILES), local_files_only=True)
    for name, expected in MODEL_FILES.items():
        with (Path(snapshot) / name).open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != expected:
                raise RuntimeError("ASR model files differ from the pinned checksums")
    # mlx-whisper prefers this alternative filename if present. It is not part
    # of our pinned snapshot and must not bypass the checked NPZ weights.
    if (Path(snapshot) / "weights.safetensors").exists():
        raise RuntimeError("Unexpected ASR weight override in the cached snapshot")
    model = ModelHolder.get_model(snapshot, mx.float16)
    if any(value.dtype != mx.float16 for _, value in tree_flatten(model.parameters()) if mx.issubdtype(value.dtype, mx.floating)):
        raise RuntimeError("ASR parameter precision differs from float16")
    return WhisperRuntime(snapshot)


def expire():
    now = time.time()
    for key, op in list(states.items()):
        if not op.active and op.expires <= now:
            del states[key]
    for user, hits in list(rates.items()):
        while hits and hits[0] <= now - 60:
            hits.popleft()
        if not hits:
            del rates[user]


def charge(user: str):
    hits = rates.setdefault(user, deque())
    if len(hits) >= 10:
        raise HTTPException(429, detail="rate_limited", headers={"Retry-After": str(max(1, int(60 - (time.time() - hits[0]))))})
    hits.append(time.time())


def finish(op: Operation, status: str, error: str | None = None):
    if op.status == "cancelled":
        return
    op.status, op.error = status, error
    op.expires = time.time() + TTL
    if status != "completed":
        op.text = None
    op.changed.set()


def scope(request: Request, request_id: str | None = None):
    authorization = request.headers.get("authorization", "")
    if not API_TOKEN or not hmac.compare_digest(authorization, f"Bearer {API_TOKEN}"):
        raise HTTPException(401, detail="unauthorized")
    values = [request.headers.get("x-asr-user-id", ""), request.headers.get("x-asr-conversation-id", ""), request.headers.get("x-asr-request-id", "")]
    if any(not re.fullmatch(r"[A-Za-z0-9:._-]{1,160}", value) for value in values):
        raise HTTPException(400, detail="invalid_scope")
    if request_id and values[2] != request_id:
        raise HTTPException(400, detail="invalid_request_id")
    return values


def existing(user: str, conversation: str, request_id: str):
    op = states.get(request_id)
    if op and (op.user != user or op.conversation != conversation):
        raise HTTPException(404, detail="unknown_request")
    return op


def response(op: Operation):
    payload = {"requestId": op.request_id, "status": op.status, "expiresAt": int(op.expires * 1000)}
    if op.status == "completed":
        payload.update(text=op.text, audioDurationMs=op.duration)
    if op.error:
        payload["errorCode"] = op.error
    if op.status == "pending":
        payload["retryAfterMs"] = 250
    return JSONResponse(payload, status_code=202 if op.status == "pending" else 200, headers={"Cache-Control": "private, no-store"})


async def decode(path: Path, deadline: float) -> bytes:
    # Only a local file protocol is allowed: uploaded playlist/URL references
    # must never become an SSRF or a local arbitrary file read.
    process = await asyncio.create_subprocess_exec(
        os.getenv("FFMPEG_BIN", "ffmpeg"), "-nostdin", "-v", "error", "-threads", "1", "-max_alloc", "67108864",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,flac,mp3,ogg,mov,matroska,webm,aac",
        "-i", str(path), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-t", "60.001", "-f", "s16le", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        limit=65536,
    )
    data = bytearray()
    try:
        async with asyncio.timeout(max(0.001, min(10, deadline - time.monotonic()))):
            while chunk := await process.stdout.read(65536):
                data.extend(chunk)
                if len(data) > MAX_PCM_BYTES:
                    raise HTTPException(413, detail="audio_too_long")
            if await process.wait() != 0 or not data or len(data) % 2:
                raise HTTPException(422, detail="invalid_audio")
        return bytes(data)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def transcribe(pcm: bytes, *, language="en"):
    import numpy as np
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
    # HTTP callers always use the English default. The offline qualification
    # CLI can explicitly select its existing research language without changing
    # the product's supported input languages or supplying lexical hints.
    return runtime.transcribe(audio=audio, sample_rate=SAMPLE_RATE, timestamps="none", language=language)


async def execute(op: Operation, directory: str, path: Path):
    global healthy
    acquired = False
    native = None
    try:
        # Queue bounds apply before decoding, so decoder subprocesses are bounded
        # by the same actual inference slot instead of an unbounded second pool.
        try:
            await asyncio.wait_for(slot.acquire(), QUEUE_TIMEOUT)
            acquired = True
        except TimeoutError:
            finish(op, "failed", "queue_timeout")
            return
        if op.status == "cancelled":
            return
        pcm = await decode(path, op.deadline)
        path.unlink(missing_ok=True)
        op.duration = round(len(pcm) / (SAMPLE_RATE * 2) * 1000)
        if op.status == "cancelled":
            return
        # Exact zero is definitive silence; an energy threshold would reject
        # legitimate quiet speech. Keep all nonzero PCM eligible for inference.
        if not any(pcm):
            finish(op, "failed", "no_speech")
            return
        native = asyncio.create_task(asyncio.to_thread(transcribe, pcm))
        try:
            result = await asyncio.wait_for(asyncio.shield(native), max(0.001, op.deadline - time.monotonic()))
        except TimeoutError:
            # A timed-out native call may still own RAM and CPU. Fail readiness,
            # refuse delivery, and hold the slot until it really exits.
            healthy = False
            finish(op, "failed", "transcription_timeout")
            await native
            return
        if op.status == "cancelled":
            return
        if time.monotonic() >= op.deadline:
            finish(op, "failed", "transcription_timeout")
            return
        text = result.get("text", "").strip()
        if len(text) > MAX_TEXT:
            finish(op, "failed", "transcript_too_long")
        elif not text:
            finish(op, "failed", "no_speech")
        else:
            op.text = text
            finish(op, "completed")
    except HTTPException as exc:
        finish(op, "failed", exc.detail)
    except TimeoutError:
        finish(op, "failed", "transcription_timeout")
    except Exception:
        # Do not log SDK exceptions: they may include private audio/text.
        finish(op, "failed", "transcription_failed")
    finally:
        if native and not native.done():
            try:
                await asyncio.shield(native)
            except Exception:
                pass
        if acquired:
            slot.release()
        shutil.rmtree(directory, ignore_errors=True)
        op.active = False
        op.expires = time.time() + TTL
        op.changed.set()


async def janitor():
    while True:
        await asyncio.sleep(5)
        expire()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global runtime, healthy, slot, accepting
    if not API_TOKEN:
        raise RuntimeError("ASR_API_TOKEN is required")
    slot = asyncio.Lock()
    TEMP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    for stale in TEMP_DIR.glob("idream-asr-*"):
        if stale.is_dir():
            shutil.rmtree(stale)
    runtime = await asyncio.to_thread(load_runtime)
    runtime.__enter__()
    await asyncio.to_thread(transcribe, bytes(SAMPLE_RATE * 2))
    healthy, accepting = True, True
    cleanup = asyncio.create_task(janitor())
    yield
    accepting = False
    cleanup.cancel()
    for op in states.values():
        if op.active:
            finish(op, "cancelled")
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    runtime.__exit__(None, None, None)


app = FastAPI(title="iDream ASR", lifespan=lifespan)


@app.get("/health")
async def health(request: Request):
    if not API_TOKEN or not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {API_TOKEN}"):
        raise HTTPException(401, detail="unauthorized")
    return JSONResponse({"ready": healthy and accepting, "active": sum(op.active for op in states.values()), "provider": "mlx-whisper", "model": MODEL_ID, "modelRevision": MODEL_REVISION, "runtimeVersion": SDK_VERSION, "device": "metal", "precision": "float16", "sourceRevision": os.getenv("IDREAM_SOURCE_REVISION"), "gatewaySha256": GATEWAY_SHA256, "languages": LANGUAGES, "maxAudioBytes": MAX_BYTES, "maxAudioDurationMs": 60000}, status_code=200 if healthy and accepting else 503)


@app.post("/v1/transcriptions")
async def submit(request: Request):
    global uploads
    user, conversation, request_id = scope(request)
    expire()
    prior = existing(user, conversation, request_id)
    if (not healthy or not accepting) and not (prior and prior.status == "cancelled"):
        raise HTTPException(503, detail="asr_unavailable")
    if not prior:
        if len(states) >= MAX_STATES:
            raise HTTPException(503, detail="state_capacity")
        if any(op.user == user and op.active for op in states.values()):
            raise HTTPException(429, detail="user_busy", headers={"Retry-After": "2"})
        if sum(op.active for op in states.values()) >= MAX_QUEUE + 1:
            raise HTTPException(503, detail="queue_full", headers={"Retry-After": "2"})
        charge(user)
        op = Operation(user, conversation, request_id)
        states[request_id] = op
    else:
        op = prior
    if uploads >= MAX_QUEUE + 1:
        if not prior:
            op.active = False
            finish(op, "failed", "queue_full")
        raise HTTPException(503, detail="queue_full", headers={"Retry-After": "2"})
    uploads += 1
    directory: str | None = None
    digest = hashlib.sha256()
    count = 0
    transferred = False
    try:
        TEMP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory = tempfile.mkdtemp(prefix="idream-asr-", dir=TEMP_DIR)
        path = Path(directory) / "audio"
        async with asyncio.timeout(UPLOAD_TIMEOUT):
            with path.open("wb") as out:
                async for chunk in request.stream():
                    count += len(chunk)
                    if count > MAX_BYTES:
                        raise HTTPException(413, detail="audio_too_large")
                    digest.update(chunk)
                    if op.status != "cancelled":
                        out.write(chunk)
        # A tombstone still consumes the bounded request body. Returning before
        # the HTTP peer finishes writing makes large replays fail BrokenPipe.
        if op.status == "cancelled":
            return response(op)
        if not count:
            raise HTTPException(422, detail="invalid_audio")
        if prior:
            if prior.digest is None and prior.active:
                try:
                    await asyncio.wait_for(prior.uploaded.wait(), UPLOAD_TIMEOUT)
                except TimeoutError:
                    raise HTTPException(408, detail="upload_timeout")
            if prior.status == "cancelled":
                return response(prior)
            if digest.hexdigest() != prior.digest:
                raise HTTPException(409, detail="idempotency_conflict")
            return response(prior)
        op.digest = digest.hexdigest()
        op.uploaded.set()
        op.deadline = time.monotonic() + DEADLINE
        task = asyncio.create_task(execute(op, directory, path))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        transferred = True
        uploads -= 1
        try:
            await asyncio.wait_for(op.changed.wait(), DEADLINE)
        except TimeoutError:
            finish(op, "failed", "transcription_timeout")
        return response(op)
    except TimeoutError:
        if not prior:
            finish(op, "failed", "upload_timeout")
        raise HTTPException(408, detail="upload_timeout")
    except HTTPException as exc:
        if not prior:
            finish(op, "failed", exc.detail)
        raise
    except Exception:
        if not prior:
            finish(op, "failed", "upload_failed")
        raise HTTPException(400, detail="upload_failed")
    finally:
        if not transferred:
            uploads -= 1
            if directory is not None:
                shutil.rmtree(directory, ignore_errors=True)
            if not prior:
                op.active = False
                op.uploaded.set()


@app.get("/v1/transcriptions/{request_id}")
async def status(request_id: str, request: Request):
    user, conversation, _ = scope(request, request_id)
    expire()
    op = existing(user, conversation, request_id)
    if not op:
        raise HTTPException(404, detail="unknown_request")
    return response(op)


@app.delete("/v1/transcriptions/{request_id}")
async def cancel(request_id: str, request: Request):
    user, conversation, _ = scope(request, request_id)
    expire()
    op = existing(user, conversation, request_id)
    if not op:
        if len(states) >= MAX_STATES:
            raise HTTPException(503, detail="state_capacity")
        # Unknown-key cancellation creates state just like a new operation.
        # Apply the same user rate so tombstones cannot fill the global cache.
        charge(user)
        op = Operation(user, conversation, request_id, active=False)
        states[request_id] = op
    op.status, op.text, op.error = "cancelled", None, None
    op.expires = time.time() + TTL
    op.changed.set()
    return response(op)
