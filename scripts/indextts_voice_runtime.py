"""Pinned, offline IndexTTS 2.5 MLX speech and reference conditioning."""

from __future__ import annotations

import hashlib
import io
from importlib.metadata import version
from pathlib import Path
import warnings
import wave


MODEL_ID = "indextts-2.5-mlx-8bit"
DEFAULT_MODEL_PATH = "~/.idream/models/vanch007/mlx-indextts2-2.5-8bit"
MODEL_REPO = "vanch007/mlx-indextts2-2.5-8bit"
MODEL_REVISION = "3170ceff8032ab6d0c2945e72068a03ea8c68461"
W2V_REPO = "facebook/w2v-bert-2.0"
W2V_REVISION = "da985ba0987f70aaeb84a80f2851cfac8c697a7b"
W2V_DIRECTORY = "w2v-bert-2.0"
CAMPPLUS_REPO = "funasr/campplus"
CAMPPLUS_REVISION = "e4b6ede7ce16997aff4ae69fbca1f0175e2afede"
CAMPPLUS_FILE = "campplus_cn_common.bin"
RUNTIME_PACKAGE = "mlx-indextts"
RUNTIME_VERSION = "0.2.0"
# W2V-BERT normalizes with sample variance, so it needs two 25 ms frames
# spaced 10 ms apart. IndexTTS uses the first 15 seconds of each reference.
MIN_REFERENCE_MS = 35
REFERENCE_SECONDS = 15

# Pin the converted weights and all data read by the offline engine, including
# the reference encoder. A different or partial snapshot must fail readiness.
MODEL_FILES = {
    "LICENSE": "e41645104f7e83d614d94daf93c452ebeaeca12415865b0f76cc02374ad3a223",
    "bigvgan.safetensors": "e69b708e7faac5bc4907e050909419dea214d250b11729f80855c95016fea7b5",
    "codec.safetensors": "7ba36ba12dbc6f19adaf50bb4aebee2c4092526c7f4a56479ed1e72e2562009e",
    "config.json": "438e3e76610ddcc85f764cf0a06cde43df3937ac966dc2c199a52b5f9a7eee57",
    "config.yaml": "65d07de92a2c26843c14c797951613ef939593ae1e842f31ad7d9f2d04b6eb52",
    "feat1.pt": "f219cb447d80216ba615666da2ff8d63ac544eee26657f3a7b278692bf7a67c4",
    "feat2.pt": "9c4292e96dee535aea9a6206e9a0c856dd578dde9212acdb16dd3ada4d12bf80",
    "gpt.safetensors": "f4ba77be4e7b0c435a9812b326bb5ef91d1eb7001fd01c56c0aac614c2f4b2b3",
    "model_manifest.json": "b528d2d736e41b24bb9be90b21aeaaa57e7f3c5c56af9ce7ae0f7c9a80696be7",
    "multilingual_zh_ja_yue_char_del.tiktoken": "747979631e813193436aabcff7c1c235d37de8097b71c563ec8b63b7a515c718",
    "s2mel.safetensors": "26f8c0d388716f1adfa29919d4b924683329cda470464786759e2461ffd5233f",
    "wav2vec2bert_stats.pt": "c9c176c2b8850ab2e3ba828bbfa969deaf4566ce55db5f2687b8430b87526ad2",
}
W2V_FILES = {
    "config.json": "f5572bd5998b68182e9c328a43127ed21fed687f6910497136b91a4e3b0e3675",
    "preprocessor_config.json": "8e6281aad64f97e40534135a59dcc5d33571efae376f2a25adf5551951897ab4",
    "model.safetensors": "eb890c9660ed6e3414b6812e27257b8ce5454365d5490d3ad581ea60b93be043",
}
CAMPPLUS_FILES = {
    CAMPPLUS_FILE: "3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8",
}


def verify_files(directory: Path, checksums: dict[str, str]) -> None:
    for filename, expected in checksums.items():
        path = directory / filename
        with path.open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != expected:
            raise RuntimeError(f"IndexTTS asset does not match its pinned checksum: {path}")


def verify_assets(model_path: Path) -> None:
    verify_files(model_path, MODEL_FILES)
    verify_files(model_path / W2V_DIRECTORY, W2V_FILES)
    verify_files(model_path, CAMPPLUS_FILES)


# Weight each supported affect relative to the speaker reference. Natural uses
# the reference's own expression. The same reference supplies timbre in every preset.
PRESET_EMOTIONS = {
    "sensual": {"calm": 0.55},
    "intimate": {"calm": 1.0},
    "playful": {"happy": 1.0},
    "confident": {"happy": 0.2, "calm": 0.4},
}


class IndexTTSTruncated(RuntimeError):
    pass


def validate_reference_wav(reference: bytes) -> None:
    import numpy as np

    try:
        with wave.open(io.BytesIO(reference), "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate()
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            if rate <= 0 or channels not in (1, 2) or width not in (1, 2, 3, 4):
                raise ValueError("IndexTTS reference has unsupported PCM metadata")
            pcm = wav.readframes(frames)
            if len(pcm) != frames * channels * width:
                raise ValueError("IndexTTS reference PCM data is truncated")
    except (EOFError, wave.Error) as error:
        raise ValueError("IndexTTS reference must be a valid PCM WAV") from error
    if frames * 1000 < rate * MIN_REFERENCE_MS:
        raise ValueError(f"IndexTTS reference must be at least {MIN_REFERENCE_MS} ms")
    count = min(frames, rate * REFERENCE_SECONDS) * channels
    if width == 1:
        samples = np.frombuffer(pcm, dtype=np.uint8, count=count).astype(np.int16) - 128
    elif width == 3:
        octets = np.frombuffer(pcm, dtype=np.uint8, count=count * 3).reshape(-1, 3).astype(np.int32)
        packed = octets[:, 0] | (octets[:, 1] << 8) | (octets[:, 2] << 16)
        samples = (packed ^ 0x800000) - 0x800000
    else:
        samples = np.frombuffer(pcm, dtype=f"<i{width}", count=count)
    if not np.any(samples.reshape(-1, channels).sum(axis=1, dtype=np.int64)):
        raise ValueError(f"IndexTTS reference must contain non-silent audio in its first {REFERENCE_SECONDS} seconds")


class IndexTTSVoiceRuntime:
    def __init__(self, model_path: Path, language: str) -> None:
        if version(RUNTIME_PACKAGE) != RUNTIME_VERSION:
            raise RuntimeError(f"IndexTTS requires the pinned {RUNTIME_PACKAGE} {RUNTIME_VERSION} runtime")
        from mlx_indextts.tokenizer_v25 import V25_LANGUAGES, normalize_v25_language

        self.language = "auto" if language.strip().lower() == "auto" else normalize_v25_language(language)
        self.languages = tuple(V25_LANGUAGES) if self.language == "auto" else (self.language,)
        verify_assets(model_path)

        import torch
        from mlx_indextts import IndexTTSv25
        from mlx_indextts.indextts.s2mel.modules.campplus.DTDNN import CAMPPlus
        from transformers import AutoFeatureExtractor, Wav2Vec2BertModel

        class OfflineIndexTTS(IndexTTSv25):
            def _init_pytorch_modules(self) -> None:
                # The upstream initializer can fall back to an untrained speaker
                # encoder. Load both reference models locally and fail on any mismatch.
                w2v = self.model_dir / W2V_DIRECTORY
                stats = torch.load(self.model_dir / self.cfg.w2v_stat, map_location="cpu", weights_only=True)
                self.semantic_model = Wav2Vec2BertModel.from_pretrained(
                    w2v, local_files_only=True, use_safetensors=True,
                ).to(self.device).eval()
                self.semantic_mean = stats["mean"].to(self.device)
                self.semantic_std = stats["var"].sqrt().to(self.device)
                self.extract_features = AutoFeatureExtractor.from_pretrained(w2v, local_files_only=True)
                encoder = CAMPPlus(feat_dim=80, embedding_size=192)
                encoder.load_state_dict(torch.load(
                    self.model_dir / CAMPPLUS_FILE, map_location="cpu", weights_only=True,
                ))
                self.campplus = encoder.to(self.device).eval()

        self.engine = OfflineIndexTTS(str(model_path))
        self.engine._ensure_pytorch_modules()
        self.sample_rate = self.engine.sample_rate
        self.reference_key: tuple[Path, int, int] | None = None

    def clear_reference_cache(self) -> None:
        self.engine._reference_cache.clear()
        self.engine.cache = {}
        self.reference_key = None

    def generate(self, text: str, reference: Path, *, preset: str, intensity: int, speed: float):
        reference = reference.resolve(strict=True)
        stat = reference.stat()
        # Upstream keys by path alone. Bound the cache and invalidate a replaced WAV.
        key = (reference, stat.st_ino, stat.st_mtime_ns)
        if key != self.reference_key:
            self.clear_reference_cache()
            self.reference_key = key
        language = self.language
        if language == "auto" and not any(character.isalpha() for character in text):
            language = "en"
        with warnings.catch_warnings():
            warnings.filterwarnings("error", message=r"generation reached max_mel_tokens=", category=RuntimeWarning)
            try:
                return self.engine.generate(
                    text,
                    str(reference),
                    language=language,
                    emotion=PRESET_EMOTIONS.get(preset),
                    emo_alpha=intensity / 100,
                    speed=speed,
                )
            except RuntimeWarning as error:
                if not str(error).startswith("generation reached max_mel_tokens="):
                    raise
                raise IndexTTSTruncated("IndexTTS reached its token limit before finishing the text") from error
