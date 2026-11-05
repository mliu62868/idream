from __future__ import annotations

import importlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

PINNED_MODEL_REVISION = "39592ff23c9ef80098bb74895d104c26275fe2c9"


class FakePocketModel:
    sample_rate = 24_000
    has_voice_cloning = True

    def __init__(self) -> None:
        self.conditioning_calls: list[tuple[str, bool]] = []
        self.generation_calls = 0

    def get_state_for_audio_prompt(self, source, truncate=False):
        self.conditioning_calls.append((str(source), truncate))
        return {"source": str(source), "truncate": truncate}

    def generate_audio(
        self,
        state,
        text,
        *,
        frames_after_eos,
        copy_state,
    ):
        self.generation_calls += 1
        assert state["source"].endswith("state.safetensors")
        assert text
        assert copy_state is True
        return np.linspace(-0.25, 0.25, 2_400, dtype=np.float32)


def fake_export_model_state(state, destination) -> None:
    Path(destination).write_text(
        json.dumps(state, sort_keys=True),
        encoding="utf-8",
    )


class PocketTtsGatewayTests(unittest.TestCase):
    def test_delete_fences_a_timed_out_clone_that_is_still_normalizing(self):
        from scripts.voice_erasure_test_cases import assert_clone_delete_fence
        assert_clone_delete_fence(self, "alba")

    def test_delete_does_not_acknowledge_failed_private_file_removal(self):
        from scripts.voice_erasure_test_cases import assert_voice_delete_failure_is_retryable
        assert_voice_delete_failure_is_retryable(self)

    def test_account_erasure_deletes_owned_and_legacy_cache_without_erasing_shared_voice(self):
        from scripts.voice_erasure_test_cases import assert_speech_account_erasure
        assert_speech_account_erasure(self, "alba")

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.previous = {
            key: os.environ.get(key)
            for key in (
                "POCKET_TTS_API_TOKEN",
                "POCKET_TTS_DEFAULT_VOICE_ID",
                "POCKET_TTS_IDEMPOTENCY_DIR",
                "POCKET_TTS_LANGUAGE",
                "POCKET_TTS_MODEL",
                "POCKET_TTS_MODEL_REVISION",
                "POCKET_TTS_VOICE_DIR",
            )
        }
        os.environ.update(
            {
                "POCKET_TTS_API_TOKEN": "gateway-test-token",
                "POCKET_TTS_DEFAULT_VOICE_ID": "alba",
                "POCKET_TTS_IDEMPOTENCY_DIR": str(self.root / "idempotency"),
                "POCKET_TTS_LANGUAGE": "english",
                "POCKET_TTS_MODEL": "pocket-tts",
                "POCKET_TTS_MODEL_REVISION": PINNED_MODEL_REVISION,
                "POCKET_TTS_VOICE_DIR": str(self.root / "voices"),
            }
        )
        sys.modules.pop("scripts.pocket_tts_gateway", None)
        self.gateway = importlib.import_module("scripts.pocket_tts_gateway")
        self.install_fake_runtime()

    def tearDown(self) -> None:
        sys.modules.pop("scripts.pocket_tts_gateway", None)
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.directory.cleanup()

    def install_fake_runtime(self) -> FakePocketModel:
        model = FakePocketModel()
        self.gateway.runtime_model = model
        self.gateway.runtime_export_model_state = fake_export_model_state
        return model

    def reload_gateway(self) -> FakePocketModel:
        self.gateway = importlib.reload(self.gateway)
        return self.install_fake_runtime()

    def test_health_proves_official_cpu_runtime_and_persistent_system_voice(self):
        client = TestClient(self.gateway.app)
        response = client.get("/v1/health")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "healthy")
        self.assertEqual(payload["provider"], "pocket_tts")
        self.assertEqual(payload["runtime"], "pocket_tts")
        self.assertEqual(payload["acceleration"], "cpu")
        self.assertEqual(payload["model"], "pocket-tts")
        self.assertEqual(payload["model_revision"], PINNED_MODEL_REVISION)
        self.assertTrue(payload["model_loaded"])
        self.assertTrue(payload["voice_cloning"])
        self.assertTrue(payload["catalog_ready"])
        self.assertEqual(payload["catalog_voices"][0], "cosette")
        self.assertIn("alba", payload["catalog_voices"])
        self.assertIn("anna", payload["catalog_voices"])
        self.assertTrue(payload["system_voice_ready"])
        self.assertTrue(payload["idempotency_writable"])
        self.assertEqual(payload["stored_voice_count"], 0)

        system_bundle = self.root / "voices" / "alba"
        self.assertTrue((system_bundle / "state.safetensors").is_file())
        manifest = json.loads((system_bundle / "manifest.json").read_text())
        self.assertEqual(manifest["source_kind"], "builtin")
        self.assertEqual(manifest["provider"], "pocket_tts")
        self.assertEqual(
            manifest["state_sha256"],
            self.gateway.sha256_bytes(
                (system_bundle / "state.safetensors").read_bytes()
            ),
        )

    def test_health_answers_while_a_render_runs(self):
        rendering, release = threading.Event(), threading.Event()
        model = self.gateway.runtime_model
        original_generate = model.generate_audio

        def blocked_generate(*args, **kwargs):
            rendering.set()
            release.wait(10)
            return original_generate(*args, **kwargs)

        model.generate_audio = blocked_generate
        client = TestClient(self.gateway.app)
        self.assertEqual(client.get("/health").status_code, 200)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                speech = pool.submit(client.post, "/v1/audio/speech", headers={"Authorization": "Bearer gateway-test-token"}, json={
                    "model": "pocket-tts", "input": "Blocking render", "voice": "anna", "response_format": "wav",
                })
                self.assertTrue(rendering.wait(5))
                started = time.monotonic()
                health = client.get("/health")
                elapsed = time.monotonic() - started
                release.set()
                self.assertEqual(speech.result(10).status_code, 200)
        finally:
            release.set()
        self.assertEqual(health.status_code, 200)
        self.assertLess(elapsed, 2)

    def test_a_retry_after_the_cache_ttl_renders_again_under_the_same_key_and_erasure_still_holds(self):
        from scripts.voice_cache_janitor import sweep_speech_cache
        client = TestClient(self.gateway.app)
        owner = "a" * 64
        headers = {"Authorization": "Bearer gateway-test-token", "Idempotency-Key": "voice:ttl:provider", "X-Idream-Request-Id": "ttl",
                   "X-Idream-Attempt-No": "1", "X-Idream-Owner-Hash": owner}
        body = {"model": "pocket-tts", "input": "A retried reply.", "voice": "anna", "response_format": "wav"}
        model = self.gateway.load_runtime_model()
        self.assertEqual(client.post("/v1/audio/speech", headers=headers, json=body).status_code, 200)
        rendered = model.generation_calls
        cache = self.gateway.idempotency_cache_path("voice:ttl:provider")
        ancient = time.time() - 8 * 86_400
        os.utime(cache, (ancient, ancient))
        replay = client.post("/v1/audio/speech", headers=headers, json=body)
        self.assertEqual(replay.headers["x-idream-idempotency-replayed"], "true")
        self.assertEqual(model.generation_calls, rendered)

        # The TTL runs from the last use, so the replay above kept this old entry.
        self.assertEqual(sweep_speech_cache(self.gateway.IDEMPOTENCY_DIR, 7 * 86_400, self.gateway.idempotency_lock), 0)
        os.utime(cache, (ancient, ancient))
        self.assertEqual(sweep_speech_cache(self.gateway.IDEMPOTENCY_DIR, 7 * 86_400, self.gateway.idempotency_lock), 1)

        retried = client.post("/v1/audio/speech", headers=headers, json=body)
        self.assertEqual(retried.status_code, 200)
        self.assertEqual(retried.headers["x-idream-idempotency-replayed"], "false")
        self.assertEqual(model.generation_calls, rendered + 1)

        self.assertEqual(client.post("/v1/account-erasure", headers={"Authorization": "Bearer gateway-test-token"}, json={
            "subject_hash": owner, "request_keys": ["voice:ttl:provider"], "voice_ids": [],
        }).status_code, 200)
        os.utime(self.gateway.erasure_registry.marker("owner", owner), (ancient, ancient))
        sweep_speech_cache(self.gateway.IDEMPOTENCY_DIR, 7 * 86_400, self.gateway.idempotency_lock)
        self.assertEqual(client.post("/v1/audio/speech", headers=headers, json=body).status_code, 410)

    def test_speech_refuses_work_it_could_not_finish_in_time(self):
        lane = self.gateway.render_lane
        lane.pending = lane.max_pending
        try:
            response = TestClient(self.gateway.app).post("/v1/audio/speech", headers={"Authorization": "Bearer gateway-test-token"}, json={
                "model": "pocket-tts", "input": "Over capacity", "voice": "anna", "response_format": "wav",
            })
        finally:
            lane.pending = 0
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["retry-after"], "5")

    def test_clone_survives_restart_and_exact_key_speech_replays(self):
        client = TestClient(self.gateway.app)
        headers = {"Authorization": "Bearer gateway-test-token"}
        reference = wav_bytes(duration_ms=200)

        cloned = client.post(
            "/v1/voices",
            headers=headers,
            data={
                "voice_id": "idream-pocket-test",
                "language": "english",
                "ref_text": "This is the exact reference transcript.",
            },
            files={"audio": ("reference.wav", reference, "audio/wav")},
        )
        self.assertEqual(cloned.status_code, 200)
        self.assertEqual(
            cloned.json(),
            {
                "voice_id": "idream-pocket-test",
                "model": "pocket-tts",
                "language": "english",
            },
        )

        bundle = self.root / "voices" / "idream-pocket-test"
        manifest = json.loads((bundle / "manifest.json").read_text())
        self.assertEqual(manifest["source_kind"], "reference_audio")
        self.assertEqual(
            manifest["source_sha256"], self.gateway.sha256_bytes(reference)
        )
        self.assertEqual(
            manifest["reference_text"],
            "This is the exact reference transcript.",
        )
        self.assertEqual((bundle / "state.safetensors").stat().st_mode & 0o777, 0o600)

        model = self.reload_gateway()
        client = TestClient(self.gateway.app)
        speech_headers = {
            **headers,
            "Idempotency-Key": "voice-request-1:attempt-1",
            "X-Idream-Request-Id": "voice-request-1",
            "X-Idream-Attempt-No": "1",
        }
        request = {
            "model": "pocket-tts",
            "input": "The persistent Pocket voice survived a restart.",
            "voice": "idream-pocket-test",
            "response_format": "wav",
        }
        first = client.post("/v1/audio/speech", headers=speech_headers, json=request)
        second = client.post("/v1/audio/speech", headers=speech_headers, json=request)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.headers["content-type"], "audio/wav")
        self.assertEqual(first.headers["x-idream-idempotency-replayed"], "false")
        self.assertTrue(first.content.startswith(b"RIFF"))
        self.assertEqual(second.content, first.content)
        self.assertEqual(second.headers["x-idream-idempotency-replayed"], "true")
        self.assertEqual(model.generation_calls, 1)
        self.assertTrue(
            any(
                source.endswith("idream-pocket-test/state.safetensors")
                for source, _ in model.conditioning_calls
            )
        )

        conflict = client.post(
            "/v1/audio/speech",
            headers=speech_headers,
            json={**request, "input": "A different request must not reuse the key."},
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertIn("different request", conflict.json()["detail"])

        deleted = client.delete(
            "/v1/voices/idream-pocket-test",
            headers=headers,
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(bundle.exists())

    def test_clone_id_is_immutable_and_system_voice_is_reserved(self):
        client = TestClient(self.gateway.app)
        headers = {"Authorization": "Bearer gateway-test-token"}
        form = {
            "language": "english",
            "ref_text": "A stable reference transcript.",
        }
        files = {"audio": ("reference.wav", wav_bytes(200), "audio/wav")}

        reserved = client.post(
            "/v1/voices",
            headers=headers,
            data={**form, "voice_id": "alba"},
            files=files,
        )
        self.assertEqual(reserved.status_code, 409)

        created = client.post(
            "/v1/voices",
            headers=headers,
            data={**form, "voice_id": "idream-immutable"},
            files=files,
        )
        duplicate = client.post(
            "/v1/voices",
            headers=headers,
            data={**form, "voice_id": "idream-immutable"},
            files=files,
        )
        self.assertEqual(created.status_code, 200)
        self.assertEqual(duplicate.status_code, 409)

        catalog_reserved = client.post(
            "/v1/voices",
            headers=headers,
            data={**form, "voice_id": "anna"},
            files=files,
        )
        self.assertEqual(catalog_reserved.status_code, 409)

    def test_catalog_voice_survives_restart_and_cannot_be_deleted(self):
        client = TestClient(self.gateway.app)
        headers = {"Authorization": "Bearer gateway-test-token"}

        first = client.post(
            "/v1/audio/speech",
            headers=headers,
            json={
                "model": "pocket-tts",
                "input": "Anna has a distinct official Pocket voice.",
                "voice": "anna",
                "response_format": "wav",
            },
        )
        self.assertEqual(first.status_code, 200)
        bundle = self.root / "voices" / "anna"
        manifest = json.loads((bundle / "manifest.json").read_text())
        self.assertEqual(manifest["source_kind"], "builtin")
        self.assertEqual(manifest["source_voice_id"], "anna")

        model = self.reload_gateway()
        client = TestClient(self.gateway.app)
        replay = client.post(
            "/v1/audio/speech",
            headers=headers,
            json={
                "model": "pocket-tts",
                "input": "The official voice bundle is durable.",
                "voice": "anna",
                "response_format": "wav",
            },
        )
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(
            any(
                source.endswith("anna/state.safetensors")
                for source, _ in model.conditioning_calls
            )
        )
        deleted = client.delete("/v1/voices/anna", headers=headers)
        self.assertEqual(deleted.status_code, 409)
        self.assertTrue(bundle.is_dir())

    def test_preset_alias_is_unique_durable_and_does_not_require_clone_weights(self):
        self.gateway.runtime_model.has_voice_cloning = False
        client = TestClient(self.gateway.app)
        headers = {"Authorization": "Bearer gateway-test-token"}

        created = client.post(
            "/v1/voices/presets",
            headers=headers,
            json={
                "voice_id": "idream-pocket-preset",
                "preset_voice_id": "anna",
                "language": "english",
            },
        )
        duplicate = client.post(
            "/v1/voices/presets",
            headers=headers,
            json={
                "voice_id": "idream-pocket-preset",
                "preset_voice_id": "anna",
                "language": "english",
            },
        )
        self.assertEqual(created.status_code, 200)
        self.assertEqual(
            created.json(),
            {
                "voice_id": "idream-pocket-preset",
                "preset_voice_id": "anna",
                "model": "pocket-tts",
                "language": "english",
            },
        )
        self.assertEqual(duplicate.status_code, 409)
        manifest = json.loads(
            (
                self.root
                / "voices"
                / "idream-pocket-preset"
                / "manifest.json"
            ).read_text()
        )
        self.assertEqual(manifest["source_kind"], "builtin_alias")
        self.assertEqual(manifest["source_voice_id"], "anna")

        self.reload_gateway().has_voice_cloning = False
        client = TestClient(self.gateway.app)
        speech = client.post(
            "/v1/audio/speech",
            headers=headers,
            json={
                "model": "pocket-tts",
                "input": "A role-specific alias replays the selected preset.",
                "voice": "idream-pocket-preset",
                "response_format": "wav",
            },
        )
        self.assertEqual(speech.status_code, 200)
        deleted = client.delete(
            "/v1/voices/idream-pocket-preset",
            headers=headers,
        )
        self.assertEqual(deleted.status_code, 200)

    def test_incomplete_voice_bundle_fails_closed(self):
        bundle = self.root / "voices" / "idream-incomplete"
        bundle.mkdir()
        (bundle / "state.safetensors").write_bytes(b"partial")

        with self.assertRaises(self.gateway.HTTPException) as raised:
            self.gateway.resolve_voice("idream-incomplete")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("incomplete", str(raised.exception.detail))

    def test_health_and_clone_fail_closed_without_cloning_weights(self):
        self.gateway.runtime_model.has_voice_cloning = False
        client = TestClient(self.gateway.app)

        health = client.get("/v1/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["status"], "healthy")
        self.assertTrue(health.json()["catalog_ready"])
        self.assertFalse(health.json()["voice_cloning"])
        self.assertIn("voice_cloning_error", health.json())
        self.assertTrue(health.json()["system_voice_ready"])

        clone = client.post(
            "/v1/voices",
            headers={"Authorization": "Bearer gateway-test-token"},
            data={
                "voice_id": "idream-no-cloning",
                "language": "english",
                "ref_text": "This request must fail before encoding.",
            },
            files={
                "audio": (
                    "reference.wav",
                    wav_bytes(200),
                    "audio/wav",
                )
            },
        )
        self.assertEqual(clone.status_code, 503)
        self.assertIn("weights are unavailable", clone.json()["detail"])

    def test_launcher_pins_official_runtime_and_separate_port(self):
        launcher = Path(__file__).with_name("start-pocket-tts.cjs").read_text()
        requirements = (
            Path(__file__).with_name("pocket-tts-requirements.in").read_text()
        )

        self.assertIn('"--python",\n    "3.12"', launcher)
        self.assertIn('"--with-requirements"', launcher)
        # A restart must not depend on PyPI or the host proxy being reachable.
        self.assertIn('"run",\n    "--offline"', launcher)
        self.assertIn('process.env.POCKET_TTS_PORT || "8063"', launcher)
        self.assertNotIn("httpx", launcher)
        self.assertNotIn("omlx", launcher.lower())
        self.assertEqual(requirements.strip(), "pocket-tts==3.0.2")


def wav_bytes(duration_ms: int) -> bytes:
    sample_rate = 24_000
    sample_count = int(sample_rate * duration_ms / 1_000)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * sample_count)
    return output.getvalue()


if __name__ == "__main__":
    unittest.main()
