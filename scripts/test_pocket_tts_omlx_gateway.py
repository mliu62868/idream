from __future__ import annotations

import base64
import importlib
import io
import json
import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient


class PocketTtsOmlxGatewayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.previous_environment = {
            key: os.environ.get(key)
            for key in (
                "POCKET_TTS_API_TOKEN",
                "POCKET_TTS_LANGUAGE",
                "POCKET_TTS_MODEL",
                "POCKET_TTS_OMLX_API_TOKEN",
                "POCKET_TTS_OMLX_API_URL",
                "POCKET_TTS_OMLX_RUNTIME_VERSION",
                "POCKET_TTS_VOICE_DIR",
            )
        }
        os.environ.update(
            {
                "POCKET_TTS_API_TOKEN": "gateway-test-token",
                "POCKET_TTS_LANGUAGE": "english",
                "POCKET_TTS_MODEL": "pocket-tts-4bit",
                "POCKET_TTS_OMLX_API_TOKEN": "omlx-test-token",
                "POCKET_TTS_OMLX_API_URL": "http://omlx.test/v1",
                "POCKET_TTS_OMLX_RUNTIME_VERSION": "0.5.3",
                "POCKET_TTS_VOICE_DIR": self.temporary_directory.name,
            }
        )
        sys.modules.pop("scripts.pocket_tts_gateway", None)

    def tearDown(self) -> None:
        sys.modules.pop("scripts.pocket_tts_gateway", None)
        for key, value in self.previous_environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.temporary_directory.cleanup()

    def test_launcher_runs_a_thin_http_adapter_without_loading_pocket_weights(self) -> None:
        launcher = Path(__file__).with_name("start-pocket-tts.cjs").read_text()
        self.assertNotIn("pocket-tts-mlx", launcher)
        self.assertIn(
            '"httpx",\n'
            '    "--with",\n'
            '    "python-multipart",\n'
            '    "--with",\n'
            '    "fastapi",',
            launcher,
        )

    def test_voice_registry_survives_restart_and_forwards_reference_audio_to_omlx(
        self,
    ) -> None:
        gateway = self.import_gateway()
        requests: list[dict[str, object]] = []
        headers = {"Authorization": "Bearer gateway-test-token"}
        reference = wav_bytes()

        with patch.object(
            gateway.httpx,
            "request",
            side_effect=fake_omlx_request(requests),
        ):
            client = TestClient(gateway.app)
            health = client.get("/v1/health")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(
                health.json(),
                {
                    "status": "healthy",
                    "provider": "pocket_tts",
                    "runtime": "omlx",
                    "runtime_version": "0.5.3",
                    "acceleration": "mlx",
                    "model": "pocket-tts-4bit",
                    "language": "english",
                    "voice_cloning": True,
                    "stored_voice_count": 0,
                },
            )

            cloned = client.post(
                "/v1/voices",
                headers=headers,
                data={
                    "voice_id": "idream-omlx-test",
                    "language": "english",
                    "ref_text": "This is the exact reference transcript.",
                },
                files={"audio": ("reference.wav", reference, "audio/wav")},
            )
            self.assertEqual(cloned.status_code, 200)
            self.assertEqual(
                cloned.json(),
                {
                    "voice_id": "idream-omlx-test",
                    "model": "pocket-tts-4bit",
                    "language": "english",
                },
            )

        stored_audio = (
            Path(self.temporary_directory.name) / "idream-omlx-test.wav"
        )
        stored_manifest = (
            Path(self.temporary_directory.name) / "idream-omlx-test.json"
        )
        self.assertEqual(stored_audio.read_bytes(), reference)
        self.assertEqual(
            json.loads(stored_manifest.read_text())["ref_text"],
            "This is the exact reference transcript.",
        )

        gateway = importlib.reload(gateway)
        with patch.object(
            gateway.httpx,
            "request",
            side_effect=fake_omlx_request(requests),
        ):
            client = TestClient(gateway.app)
            restarted_health = client.get("/v1/health")
            self.assertEqual(restarted_health.json()["stored_voice_count"], 1)

            speech = client.post(
                "/v1/audio/speech",
                headers=headers,
                json={
                    "model": "pocket-tts-4bit",
                    "input": "The durable oMLX voice survived a process restart.",
                    "voice": "idream-omlx-test",
                    "response_format": "wav",
                },
            )
            self.assertEqual(speech.status_code, 200)
            self.assertEqual(speech.headers["content-type"], "audio/wav")
            self.assertTrue(speech.content.startswith(b"RIFF"))

            forwarded = next(
                request
                for request in reversed(requests)
                if request["method"] == "POST"
            )
            payload = forwarded["json"]
            assert isinstance(payload, dict)
            self.assertEqual(payload["model"], "pocket-tts-4bit")
            self.assertEqual(
                payload["ref_text"],
                "This is the exact reference transcript.",
            )
            self.assertEqual(base64.b64decode(str(payload["ref_audio"])), reference)
            self.assertNotIn("voice", payload)

            deleted = client.delete(
                "/v1/voices/idream-omlx-test",
                headers=headers,
            )
            self.assertEqual(deleted.status_code, 200)
            self.assertFalse(stored_audio.exists())
            self.assertFalse(stored_manifest.exists())

    def test_catalog_voice_is_forwarded_without_reference_audio(self) -> None:
        gateway = self.import_gateway()
        requests: list[dict[str, object]] = []
        with patch.object(
            gateway.httpx,
            "request",
            side_effect=fake_omlx_request(requests),
        ):
            client = TestClient(gateway.app)
            speech = client.post(
                "/v1/audio/speech",
                headers={"Authorization": "Bearer gateway-test-token"},
                json={
                    "model": "pocket-tts-4bit",
                    "input": "Catalog voice test.",
                    "voice": "alba",
                    "response_format": "wav",
                },
            )
        self.assertEqual(speech.status_code, 200)
        payload = requests[-1]["json"]
        assert isinstance(payload, dict)
        self.assertEqual(payload["voice"], "alba")
        self.assertNotIn("ref_audio", payload)

    @staticmethod
    def import_gateway():
        return importlib.import_module("scripts.pocket_tts_gateway")


def fake_omlx_request(requests: list[dict[str, object]]):
    def request(
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        json: dict[str, object] | None = None,
        timeout: float,
    ) -> httpx.Response:
        requests.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "json": json,
                "timeout": timeout,
            }
        )
        http_request = httpx.Request(method, url)
        if method == "GET":
            return httpx.Response(
                200,
                request=http_request,
                json={
                    "data": [
                        {
                            "id": "pocket-tts-4bit",
                            "object": "model",
                            "owned_by": "omlx",
                        }
                    ]
                },
            )
        return httpx.Response(
            200,
            request=http_request,
            content=wav_bytes(),
            headers={"content-type": "audio/wav"},
        )

    return request


def wav_bytes() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24_000)
        wav.writeframes(b"\x00\x00" * 2_400)
    return output.getvalue()


if __name__ == "__main__":
    unittest.main()
