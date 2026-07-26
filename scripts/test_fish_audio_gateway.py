import asyncio
import importlib
import json
import os
import sys
import tempfile
import threading
import unittest
import wave
from pathlib import Path

from fastapi.testclient import TestClient


class FishAudioGatewayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = {
            key: os.environ.get(key)
            for key in (
                "FISH_AUDIO_VOICE_DIR",
                "FISH_AUDIO_MODEL_PATH",
                "FISH_AUDIO_SYSTEM_REFERENCE_AUDIO",
                "FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST",
            )
        }
        system_audio = Path(self.directory.name) / "system-female.wav"
        with wave.open(str(system_audio), "wb") as reference:
            reference.setnchannels(1)
            reference.setsampwidth(2)
            reference.setframerate(16_000)
            reference.writeframes(b"\0\0" * 1_600)
        system_manifest = Path(self.directory.name) / "system-female.json"
        system_manifest.write_text(
            '{"language":"english","ref_text":"A curated adult female voice reference."}',
            encoding="utf-8",
        )
        os.environ["FISH_AUDIO_VOICE_DIR"] = self.directory.name
        os.environ["FISH_AUDIO_MODEL_PATH"] = self.directory.name
        os.environ["FISH_AUDIO_SYSTEM_REFERENCE_AUDIO"] = str(system_audio)
        os.environ["FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST"] = str(system_manifest)
        sys.modules.pop("scripts.fish_audio_gateway", None)
        self.gateway = importlib.import_module("scripts.fish_audio_gateway")

    def tearDown(self):
        sys.modules.pop("scripts.fish_audio_gateway", None)
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.directory.cleanup()

    def test_sensual_preset_builds_a_female_low_breathy_direction(self):
        delivery = self.gateway.DeliverySettings(
            preset="sensual",
            intensity=75,
        )
        self.assertEqual(
            self.gateway.style_prefix(delivery),
            "[female voice] [low voice] [breathy]",
        )

    def test_registry_rejects_unknown_non_catalog_voice(self):
        request = self.gateway.SpeechRequest(
            input="Hello",
            voice="unknown-voice",
        )
        self.gateway.runtime_model = object()
        with self.assertRaises(self.gateway.HTTPException) as raised:
            self.gateway.render_wav(request)
        self.assertEqual(raised.exception.status_code, 404)

    def test_delivery_preset_is_not_overridden_by_the_system_voice_identity(self):
        delivery = self.gateway.DeliverySettings(
            preset="natural",
            temperature=0.61,
        )
        self.assertEqual(
            self.gateway.styled_text("Hello", delivery),
            "[female voice] [warm] Hello",
        )
        self.assertEqual(delivery.temperature, 0.61)

    def test_system_voice_requires_a_real_reference_and_transcript(self):
        ready, error = self.gateway.system_voice_status()
        self.assertTrue(ready)
        self.assertIsNone(error)

    def test_system_voice_readiness_fails_closed_when_reference_is_missing(self):
        configured_audio = self.gateway.SYSTEM_REFERENCE_AUDIO
        try:
            self.gateway.SYSTEM_REFERENCE_AUDIO = ""
            ready, error = self.gateway.system_voice_status()
        finally:
            self.gateway.SYSTEM_REFERENCE_AUDIO = configured_audio
        self.assertFalse(ready)
        self.assertIn("not configured", error)

    def test_health_returns_503_instead_of_claiming_ready_without_system_voice(self):
        configured_audio = self.gateway.SYSTEM_REFERENCE_AUDIO
        self.gateway.runtime_model = object()
        try:
            self.gateway.SYSTEM_REFERENCE_AUDIO = ""
            response = asyncio.run(self.gateway.health())
        finally:
            self.gateway.SYSTEM_REFERENCE_AUDIO = configured_audio
        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["status"], "degraded")
        self.assertFalse(payload["system_voice_ready"])

    def test_model_loading_and_synthesis_run_on_the_same_thread(self):
        calls = {}
        original_load_runtime_model = self.gateway.load_runtime_model
        original_render_wav = self.gateway.render_wav

        def fake_load_runtime_model():
            calls.setdefault("load_thread", threading.get_ident())
            return object()

        def fake_render_wav(_request):
            calls["render_thread"] = threading.get_ident()
            return b"RIFF\x00\x00\x00\x00WAVE"

        self.gateway.load_runtime_model = fake_load_runtime_model
        self.gateway.render_wav = fake_render_wav
        try:
            with TestClient(self.gateway.app) as client:
                response = client.post(
                    "/v1/audio/speech",
                    json={
                        "model": "fish-audio-s2-pro-8bit",
                        "input": "Thread-affinity regression",
                        "voice": "fish-female-default",
                        "response_format": "wav",
                    },
                )
        finally:
            self.gateway.load_runtime_model = original_load_runtime_model
            self.gateway.render_wav = original_render_wav

        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls["load_thread"], calls["render_thread"])

    def test_system_voice_identity_cannot_be_overwritten_by_a_clone(self):
        with self.assertRaises(self.gateway.HTTPException) as raised:
            self.gateway.clone_voice(
                voice_id="fish-female-default",
                language="english",
                ref_text="A different voice must not replace system authority.",
                audio=None,
            )
        self.assertEqual(raised.exception.status_code, 409)

    def test_launcher_uses_omlx_bundled_python_and_not_uv(self):
        launcher = Path(__file__).with_name("start-fish-audio.cjs").read_text()
        self.assertIn("/Applications/oMLX.app/Contents/Resources", launcher)
        self.assertNotIn('"uv"', launcher)
        self.assertIn(
            'process.on("SIGINT", () => forward("SIGTERM"));',
            launcher,
        )
        self.assertIn(
            'process.on("SIGTERM", () => forward("SIGTERM"));',
            launcher,
        )

    def test_pm2_start_removes_the_retired_process_before_fish_cutover(self):
        launcher = Path(__file__).with_name("start-pm2-ecosystem.cjs").read_text()
        self.assertIn('["delete", "pocket-tts"]', launcher)
        self.assertIn('["start", "ecosystem.config.js"]', launcher)


if __name__ == "__main__":
    unittest.main()
