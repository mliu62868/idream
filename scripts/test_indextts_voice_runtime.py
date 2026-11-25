import hashlib
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
import warnings
import wave

from scripts.indextts_voice_runtime import (
    IndexTTSTruncated, IndexTTSVoiceRuntime, validate_reference_wav, verify_files,
)


class IndexTTSVoiceRuntimeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.reference = Path(directory.name) / "reference.wav"
        self.reference.write_bytes(b"reference")
        self.runtime = IndexTTSVoiceRuntime.__new__(IndexTTSVoiceRuntime)
        self.runtime.engine = SimpleNamespace(_reference_cache={}, cache={}, generate=Mock())
        self.runtime.language = "auto"
        self.runtime.reference_key = None

    def test_checksums_reject_modified_local_assets(self):
        expected = hashlib.sha256(self.reference.read_bytes()).hexdigest()
        verify_files(self.reference.parent, {self.reference.name: expected})
        self.reference.write_bytes(b"different")
        with self.assertRaisesRegex(RuntimeError, "pinned checksum"):
            verify_files(self.reference.parent, {self.reference.name: expected})

    def test_reference_replacement_cannot_reuse_the_previous_embedding(self):
        engine = self.runtime.engine
        options = {"preset": "playful", "intensity": 50, "speed": 1.2}
        self.runtime.generate("Hello.", self.reference, **options)
        engine.generate.assert_called_once_with(
            "Hello.", str(self.reference.resolve()), language="auto", emotion={"happy": 1.0},
            emo_alpha=0.5, speed=1.2,
        )
        engine._reference_cache[str(self.reference)] = engine.cache = {"speaker": "old"}
        self.runtime.generate("Again.", self.reference, **options)
        self.assertTrue(engine._reference_cache)
        replacement = self.reference.with_name("replacement.wav")
        replacement.write_bytes(b"replacement")
        replacement.replace(self.reference)
        self.runtime.generate("Again.", self.reference, **options)
        self.assertEqual(engine._reference_cache, {})
        self.assertEqual(engine.cache, {})

    def test_reaching_the_model_token_limit_fails_the_whole_request(self):
        def truncated(*_args, **_options):
            warnings.warn("generation reached max_mel_tokens=1500", RuntimeWarning)
            return b"incomplete audio"

        self.runtime.engine.generate.side_effect = truncated
        with self.assertRaisesRegex(IndexTTSTruncated, "token limit"):
            self.runtime.generate("A complete sentence.", self.reference,
                                  preset="natural", intensity=0, speed=1.0)

    def test_an_unsupported_language_fails_before_model_loading(self):
        with self.assertRaisesRegex(ValueError, "Unsupported IndexTTS-2.5 language"):
            IndexTTSVoiceRuntime(self.reference.parent, "fr")

    def test_reference_validation_uses_the_signal_after_downmixing_supported_pcm(self):
        def stereo_wav(width, pcm):
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setparams((2, width, 16_000, 0, "NONE", "not compressed"))
                wav.writeframes(pcm)
            return output.getvalue()

        for width in (1, 2, 3, 4):
            with self.subTest(width=width):
                offset = 128 if width == 1 else 0
                positive = (offset + 100).to_bytes(width, "little", signed=width > 1)
                negative = (offset - 100).to_bytes(width, "little", signed=width > 1)
                validate_reference_wav(stereo_wav(width, (positive * 2 + negative * 2) * 800))
                with self.assertRaisesRegex(ValueError, "non-silent audio"):
                    validate_reference_wav(stereo_wav(width, (positive + negative) * 1_600))
