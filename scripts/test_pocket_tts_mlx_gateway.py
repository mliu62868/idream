from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import mlx.core as mx
from fastapi.testclient import TestClient
from pocket_tts_mlx import TTSModel


class FakeMlxTtsModel:
    def __init__(self) -> None:
        self.config = SimpleNamespace(mimi=SimpleNamespace(sample_rate=24_000))
        self.has_voice_cloning = True
        self.last_model_state: dict[str, dict[str, mx.array]] | None = None

    def get_state_for_audio_prompt(
        self,
        _audio_conditioning: str | Path,
        truncate: bool = False,
    ) -> dict[str, dict[str, mx.array]]:
        if not truncate:
            raise AssertionError("voice clone preparation must truncate long references")
        return {
            "transformer.layers.0.attention": {
                "current_end": mx.arange(3, dtype=mx.int64),
                "cache": mx.ones((2, 1, 4, 1, 2), dtype=mx.float32),
            },
        }

    def generate_audio_stream(
        self,
        model_state: dict[str, dict[str, mx.array]],
        text_to_generate: str,
        warmup_frames: int,
    ):
        self.last_model_state = model_state
        if not text_to_generate:
            raise AssertionError("speech text must not be empty")
        if warmup_frames != 1:
            raise AssertionError("MLX Mimi decoder warmup must stay enabled")
        yield mx.array([0.0, 0.25, -0.25, 0.0], dtype=mx.float32)


class PocketTtsMlxGatewayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.previous_environment = {
            key: os.environ.get(key)
            for key in (
                "POCKET_TTS_API_TOKEN",
                "POCKET_TTS_LANGUAGE",
                "POCKET_TTS_MLX_WARMUP_FRAMES",
                "POCKET_TTS_VOICE_DIR",
            )
        }
        os.environ["POCKET_TTS_API_TOKEN"] = "gateway-test-token"
        os.environ["POCKET_TTS_LANGUAGE"] = "english"
        os.environ["POCKET_TTS_MLX_WARMUP_FRAMES"] = "1"
        os.environ["POCKET_TTS_VOICE_DIR"] = self.temporary_directory.name
        sys.modules.pop("scripts.pocket_tts_gateway", None)

    def tearDown(self) -> None:
        sys.modules.pop("scripts.pocket_tts_gateway", None)
        for key, value in self.previous_environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.temporary_directory.cleanup()

    def test_launcher_installs_uvicorn_in_the_mlx_environment(self) -> None:
        launcher = Path(__file__).with_name("start-pocket-tts.cjs").read_text()
        self.assertIn(
            '"pocket-tts-mlx==0.2.1",\n'
            '    "--with",\n'
            '    "python-multipart",\n'
            '    "--with",\n'
            '    "fastapi",\n'
            '    "--with",\n'
            '    "uvicorn",\n'
            '    "uvicorn",',
            launcher,
        )

    def test_cloned_voice_survives_gateway_reload_and_synthesizes_with_mlx(self) -> None:
        first_model = FakeMlxTtsModel()
        with patch.object(TTSModel, "load_model", return_value=first_model):
            gateway = importlib.import_module("scripts.pocket_tts_gateway")
        client = TestClient(gateway.app)
        headers = {"Authorization": "Bearer gateway-test-token"}

        health = client.get("/v1/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(
            health.json(),
            {
                "status": "healthy",
                "provider": "pocket_tts",
                "runtime": "pocket_tts_mlx",
                "runtime_version": "0.2.1",
                "acceleration": "mlx",
                "model": "kyutai/pocket-tts",
                "language": "english",
                "voice_cloning": True,
                "stored_voice_count": 0,
            },
        )

        cloned = client.post(
            "/v1/voices",
            headers=headers,
            data={"voice_id": "idream-mlx-test", "language": "english"},
            files={"audio": ("reference.wav", b"reference-audio", "audio/wav")},
        )
        self.assertEqual(cloned.status_code, 200)
        self.assertEqual(cloned.json()["voice_id"], "idream-mlx-test")
        stored_state = Path(self.temporary_directory.name) / "idream-mlx-test.safetensors"
        self.assertTrue(stored_state.is_file())

        second_model = FakeMlxTtsModel()
        with patch.object(TTSModel, "load_model", return_value=second_model):
            gateway = importlib.reload(gateway)
        restarted_client = TestClient(gateway.app)
        restarted_health = restarted_client.get("/v1/health")
        self.assertEqual(restarted_health.json()["stored_voice_count"], 1)

        speech = restarted_client.post(
            "/v1/audio/speech",
            headers=headers,
            json={
                "model": "kyutai/pocket-tts",
                "input": "The MLX voice state survived a process restart.",
                "voice": "idream-mlx-test",
                "response_format": "wav",
            },
        )
        self.assertEqual(speech.status_code, 200)
        self.assertEqual(speech.headers["content-type"], "audio/wav")
        self.assertTrue(speech.content.startswith(b"RIFF"))
        self.assertIsNotNone(second_model.last_model_state)
        assert second_model.last_model_state is not None
        restored = second_model.last_model_state[
            "transformer.layers.0.attention"
        ]
        self.assertEqual(restored["current_end"].shape, (3,))
        self.assertEqual(restored["cache"].shape, (2, 1, 4, 1, 2))

        for voice_id in ("idream-mlx-second", "idream-mlx-third"):
            clone = restarted_client.post(
                "/v1/voices",
                headers=headers,
                data={"voice_id": voice_id, "language": "english"},
                files={"audio": ("reference.wav", b"reference-audio", "audio/wav")},
            )
            self.assertEqual(clone.status_code, 200)
        self.assertEqual(len(gateway.voice_state_cache), 2)
        self.assertNotIn("idream-mlx-test", gateway.voice_state_cache)

        deleted = restarted_client.delete(
            "/v1/voices/idream-mlx-test",
            headers=headers,
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(stored_state.exists())


if __name__ == "__main__":
    unittest.main()
