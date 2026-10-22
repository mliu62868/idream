"""Ming-specific conditioning and bounded requests for the resident voice gateway.

The registry's complete recording remains the speaker identity. Its acoustic
prompt and transcript are never silently cropped or replaced with a zero slot.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import io
import json
import math
from pathlib import Path
import re
import threading
from typing import Any, Callable
import wave

import numpy as np


MODEL_ID = "ming-3.0-tts-0.5b-8bit"
MLX_AUDIO_VERSION = "0.6.1"
CAMPLUS_SHA256 = "a6ac6a63997761ae2997373e2ee1c47040854b4b759ea41ec48e4e42df0f4d73"
MAX_CACHE_POSITIONS = 512
MAX_REFERENCE_CACHE = 128


class MingReferenceError(ValueError):
    """A stored reference cannot safely condition this runtime."""


class MingSynthesisError(RuntimeError):
    """An incomplete fragment must not become a successful speech artifact."""


@dataclass(frozen=True)
class MingGenerationOptions:
    cfg_scale: float = 2.0
    sigma: float = 0.25
    temperature: float = 0.0
    ddpm_steps: int = 10

    def __post_init__(self):
        # The pinned flow sampler's cfg=1 path is invalid. Its temperature gates
        # flow noise: at the validated temperature=0, sigma does not vary noise.
        # Keep sigma's upstream default without mapping Breeze sampling knobs.
        if not math.isfinite(self.cfg_scale) or self.cfg_scale <= 1:
            raise ValueError("Ming cfg_scale must be finite and greater than 1")
        if not math.isfinite(self.sigma) or self.sigma < 0:
            raise ValueError("Ming sigma must be finite and nonnegative")
        if self.temperature != 0:
            raise ValueError("Ming temperature is fixed at 0 by the validated gateway configuration")
        if not isinstance(self.ddpm_steps, int) or not 1 <= self.ddpm_steps <= 100:
            raise ValueError("Ming ddpm_steps must be between 1 and 100")

    def as_kwargs(self) -> dict[str, Any]:
        return dict(cfg_scale=self.cfg_scale, sigma=self.sigma,
                    temperature=self.temperature, ddpm_steps=self.ddpm_steps)


def control_caption(*, emotion: str | None = None, speed: str | None = None,
                    pitch: str | None = None, volume: str | None = None) -> str:
    """The trained ming3_instruction JSON schema and field order."""
    item = {
        "序号": 1, "说话人": "speaker_1", "方言": None, "风格": None,
        "语速": speed, "基频": pitch, "音量": volume, "情感": emotion,
        "BGM": {key: None for key in ("Genre", "Mood", "Instrument", "Theme", "ENV", "SNR")},
        "IP": None,
    }
    return json.dumps({"audio_sequence": [item]}, ensure_ascii=False)


def validate_prompt_metadata(reference: bytes, metadata: Any) -> dict[str, Any] | None:
    if metadata is None:
        return None
    fields = {"reference_sha256", "start_s", "end_s", "ref_text"}
    if not isinstance(metadata, dict) or set(metadata) != fields:
        raise MingReferenceError("ming_prompt requires reference_sha256, start_s, end_s and ref_text")
    if metadata["reference_sha256"] != hashlib.sha256(reference).hexdigest():
        raise MingReferenceError("ming_prompt reference_sha256 does not match the complete reference WAV")
    if not isinstance(metadata["ref_text"], str) or not metadata["ref_text"].strip():
        raise MingReferenceError("ming_prompt requires the verified excerpt's exact non-empty ref_text")
    start, end = metadata["start_s"], metadata["end_s"]
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (start, end)):
        raise MingReferenceError("ming_prompt bounds must be finite seconds")
    try:
        with wave.open(io.BytesIO(reference), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
    except (EOFError, wave.Error, ZeroDivisionError) as error:
        raise MingReferenceError("ming_prompt reference is not a valid WAV") from error
    if not 0 <= start < end <= duration:
        raise MingReferenceError(f"ming_prompt bounds must be within the complete {duration:.6f}s reference")
    return metadata


def acoustic_condition(ref_audio: Any, reference: bytes, ref_text: str,
                       metadata: Any, sample_rate: int) -> tuple[Any, str]:
    prompt = validate_prompt_metadata(reference, metadata)
    if prompt is None:
        return ref_audio, ref_text
    start = round(prompt["start_s"] * sample_rate)
    end = round(prompt["end_s"] * sample_rate)
    if not 0 <= start < end <= ref_audio.shape[-1]:
        raise MingReferenceError("ming_prompt boundaries do not fit the decoded acoustic reference")
    return ref_audio[..., start:end], prompt["ref_text"].strip()


def decode_reference(reference: bytes) -> tuple[np.ndarray, int]:
    """Decode the registry's PCM WAV without changing its duration."""
    try:
        with wave.open(io.BytesIO(reference), "rb") as wav:
            rate, channels, width = wav.getframerate(), wav.getnchannels(), wav.getsampwidth()
            count = wav.getnframes()
            pcm = wav.readframes(count)
    except (EOFError, wave.Error) as error:
        raise MingReferenceError("Ming reference must be a valid PCM WAV") from error
    if rate <= 0 or channels not in (1, 2) or width not in (1, 2, 3, 4) or count <= 0:
        raise MingReferenceError("Ming reference has unsupported PCM metadata")
    if len(pcm) != count * channels * width:
        raise MingReferenceError("Ming reference PCM data is truncated")
    if width == 1:
        audio = (np.frombuffer(pcm, np.uint8).astype(np.float32) - 128) / 128
    elif width == 3:
        octets = np.frombuffer(pcm, np.uint8).reshape(-1, 3).astype(np.int32)
        values = octets[:, 0] | (octets[:, 1] << 8) | (octets[:, 2] << 16)
        values = (values ^ 0x800000) - 0x800000
        audio = values.astype(np.float32) / 8388608
    else:
        audio = np.frombuffer(pcm, dtype=f"<i{width}").astype(np.float32) / (2 ** (8 * width - 1))
    audio = audio.reshape(-1, channels).mean(axis=1)
    if len(audio) < math.ceil(rate * 0.025) or not np.any(audio):
        raise MingReferenceError("Ming reference must contain non-silent audio of at least 25 ms")
    return audio, rate


def reference_features(reference: bytes) -> np.ndarray:
    import kaldi_native_fbank as knf
    from scipy.signal import resample_poly

    audio, rate = decode_reference(reference)
    if rate != 16000:
        divisor = math.gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
    options = knf.FbankOptions()
    options.frame_opts.samp_freq = 16000
    options.frame_opts.frame_length_ms = 25
    options.frame_opts.frame_shift_ms = 10
    options.frame_opts.dither = 0
    options.frame_opts.window_type = "povey"
    options.frame_opts.snip_edges = True
    options.mel_opts.num_bins = 80
    options.mel_opts.is_librosa = False
    options.mel_opts.htk_mode = False
    options.mel_opts.use_slaney_mel_scale = False
    options.use_energy = False
    extractor = knf.OnlineFbank(options)
    # Ming's official CAM++ consumes float [-1, 1], unlike WeSpeaker evaluation.
    extractor.accept_waveform(16000, audio.tolist())
    extractor.input_finished()
    if extractor.num_frames_ready == 0:
        raise MingReferenceError("Ming reference has no usable acoustic frames")
    features = np.stack([extractor.get_frame(i) for i in range(extractor.num_frames_ready)]).astype(np.float32)
    features -= features.mean(axis=0, keepdims=True)
    return features


def prompt_positions(encode: Callable[[str], list[int]], ref_text: str,
                     reference_samples: int, sample_rate: int, caption: str,
                     text: str = "") -> int:
    # INVARIANT: token boundaries mirror the pinned dense _prepare_input_embed.
    # One speaker slot, 12.5 Hz acoustic patches, and the Ming-3.0 EOS suffix.
    parts = [
        "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n",
        "<|im_start|>user\n", "Please generate speech based on the following description.\n",
        "  speaker_1:", "<|vision_start|>", "<|vision_pad|>", "<|vision_end|>\n",
        " Text input:\n", ref_text, text, "<|im_end|>\n", "<|im_start|>assistant\n",
        caption, "<|im_end|>", "<audio>",
    ]
    alignment = int(sample_rate / 12.5)
    return sum(len(encode(part)) for part in parts) + math.ceil(reference_samples / alignment)


def split_for_budget(text: str, encode: Callable[[str], list[int]],
                     base_positions: int) -> list[str]:
    """Keep every word, preferring sentence/clause boundaries over hard cuts."""
    normalized = " ".join(text.split())
    if not normalized:
        raise ValueError("Speech text must contain non-whitespace characters")

    def fits(value: str) -> bool:
        units = len(re.findall(r"[一-龥]|[A-Za-z]+", value))
        # Reserve speech positions as well as input tokens. A token-only split
        # can fit the prompt yet truncate the model's speech at its cache edge.
        decode_reserve = max(96, units * 12 + 32)
        # The port may append terminal punctuation to a fragment.
        return base_positions + len(encode(value)) + 4 + decode_reserve <= MAX_CACHE_POSITIONS

    if not fits("Ready."):
        raise MingReferenceError(
            f"Ming reference/caption consumes {base_positions}/{MAX_CACHE_POSITIONS} prompt positions; "
            "insufficient room for speech. Configure a verified shorter acoustic prompt and matching transcript."
        )
    sentences = [match.group(0) for match in re.finditer(r".*?(?:[。！？]|[.!?](?=\s|$)|$)", normalized) if match.group(0)]
    fragments: list[str] = []
    pending = ""
    for sentence in sentences:
        if fits(pending + sentence):
            pending += sentence
            continue
        if pending.strip():
            fragments.append(pending.strip())
            pending = ""
        remaining = sentence.lstrip()
        while remaining and not fits(remaining):
            low, high = 1, len(remaining)
            while low < high:
                mid = (low + high + 1) // 2
                if fits(remaining[:mid]):
                    low = mid
                else:
                    high = mid - 1
            cut = low
            if not fits(remaining[:cut]):
                raise MingReferenceError("Ming reference leaves no room for the requested text")
            clauses = [m.end() for m in re.finditer(r"[,;，；、]\s*", remaining[:cut])]
            words = [m.end() for m in re.finditer(r"\s+", remaining[:cut])]
            if clauses:
                cut = clauses[-1]
            elif words:
                cut = words[-1]
            fragment = remaining[:cut].strip()
            if fragment:
                fragments.append(fragment)
            remaining = remaining[cut:].lstrip()
        pending = remaining
    if pending.strip():
        fragments.append(pending.strip())
    return fragments


class MingVoiceRuntime:
    def __init__(self, camplus_path: Path):
        if not camplus_path.is_file():
            raise RuntimeError(f"Ming CAM++ model does not exist: {camplus_path}")
        digest = hashlib.sha256(camplus_path.read_bytes()).hexdigest()
        if digest != CAMPLUS_SHA256:
            raise RuntimeError("Ming CAM++ checksum does not match the pinned official model")
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        try:
            self.session = ort.InferenceSession(str(camplus_path), sess_options=options,
                                               providers=["CPUExecutionProvider"])
        except Exception as error:
            raise RuntimeError(f"Ming CAM++ could not be loaded: {error}") from error
        inputs, outputs = self.session.get_inputs(), self.session.get_outputs()
        if len(inputs) != 1 or inputs[0].shape[-1] != 80 or len(outputs) != 1 or outputs[0].shape[-1] != 192:
            raise RuntimeError("Ming CAM++ has an incompatible feature or speaker dimension")
        self.camplus_path = camplus_path
        self.cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self.lock = threading.RLock()

    def clear_reference_cache(self) -> None:
        with self.lock:
            self.cache.clear()

    def embedding(self, reference: bytes) -> np.ndarray:
        digest = hashlib.sha256(reference).hexdigest()
        with self.lock:
            if digest in self.cache:
                self.cache.move_to_end(digest)
                return self.cache[digest].copy()
            features = reference_features(reference)
            embedding = np.asarray(self.session.run(None, {self.session.get_inputs()[0].name: features[None]})[0], dtype=np.float32).reshape(-1)
            if embedding.shape != (192,) or not np.isfinite(embedding).all() or np.linalg.norm(embedding) < 1e-8:
                raise MingReferenceError("Ming CAM++ returned an invalid 192-dimensional speaker embedding")
            self.cache[digest] = embedding.copy()
            if len(self.cache) > MAX_REFERENCE_CACHE:
                self.cache.popitem(last=False)
            return embedding

    def generate(self, model: Any, *, text: str, ref_audio: Any, reference: bytes,
                 ref_text: str, caption: str, options: MingGenerationOptions,
                 prompt_metadata: Any = None) -> list[Any]:
        ref_audio, ref_text = acoustic_condition(ref_audio, reference, ref_text, prompt_metadata, model.sample_rate)
        base = prompt_positions(model._encode, ref_text, int(ref_audio.shape[-1]), model.sample_rate, caption)
        fragments = split_for_budget(text, model._encode, base)
        embedding = self.embedding(reference)
        results = []
        for index, fragment in enumerate(fragments, 1):
            parts = list(model.generate(
                text=fragment, instruct=caption, ref_audio=ref_audio, ref_text=ref_text,
                spk_emb=embedding, max_tokens=1000, lang_code="en", stream=False,
                **options.as_kwargs(),
            ))
            if not parts or any(np.asarray(part.audio).size == 0 for part in parts):
                raise MingSynthesisError(f"Ming returned no audio for fragment {index}/{len(fragments)}")
            results.extend(parts)
        return results
