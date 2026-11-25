import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib
import io
import json
import os
import struct
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
from pathlib import Path

from fastapi import HTTPException
from fastapi.testclient import TestClient
import numpy as np


class FishAudioGatewayTests(unittest.TestCase):
    def test_delete_fences_a_timed_out_clone_that_is_still_normalizing(self):
        from scripts.voice_erasure_test_cases import assert_clone_delete_fence
        assert_clone_delete_fence(self, "fish-female-default")

    def test_delete_does_not_acknowledge_failed_private_file_removal(self):
        from scripts.voice_erasure_test_cases import assert_voice_delete_failure_is_retryable
        assert_voice_delete_failure_is_retryable(self)

    def test_account_erasure_deletes_owned_and_legacy_cache_without_erasing_shared_voice(self):
        from scripts.voice_erasure_test_cases import assert_speech_account_erasure
        assert_speech_account_erasure(self, "fish-female-default")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = {
            key: os.environ.get(key)
            for key in (
                "FISH_AUDIO_MODEL",
                "FISH_AUDIO_VOICE_DIR",
                "FISH_AUDIO_MODEL_PATH",
                "FISH_AUDIO_SYSTEM_REFERENCE_AUDIO",
                "FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST",
                "FISH_AUDIO_IDEMPOTENCY_DIR",
            )
        }
        system_audio = Path(self.directory.name) / "system-female.wav"
        with wave.open(str(system_audio), "wb") as reference:
            reference.setnchannels(1)
            reference.setsampwidth(2)
            reference.setframerate(16_000)
            reference.writeframes(b"\x01\x00\xff\xff" * 800)
        system_manifest = Path(self.directory.name) / "system-female.json"
        system_manifest.write_text(
            '{"language":"english","ref_text":"A curated adult female voice reference."}',
            encoding="utf-8",
        )
        os.environ["FISH_AUDIO_VOICE_DIR"] = self.directory.name
        os.environ["FISH_AUDIO_MODEL"] = "breeze-tts-2-mlx-8bit"
        os.environ["FISH_AUDIO_MODEL_PATH"] = self.directory.name
        os.environ["FISH_AUDIO_SYSTEM_REFERENCE_AUDIO"] = str(system_audio)
        os.environ["FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST"] = str(system_manifest)
        os.environ["FISH_AUDIO_IDEMPOTENCY_DIR"] = str(
            Path(self.directory.name) / "idempotency"
        )
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

    def test_sensual_preset_builds_a_low_breathy_direction_with_pace(self):
        delivery = self.gateway.DeliverySettings(
            preset="sensual",
            intensity=75,
            speed=0.94,
        )
        self.assertEqual(
            self.gateway.delivery_instruction(delivery),
            "A woman speaking in a low, breathy, sensual voice. "
            "Slightly slower than normal pace.",
        )

    def test_render_passes_direction_as_instruct_without_cfg_or_speed(self):
        calls = {}

        class FakeResult:
            audio = [0.0, 0.5, -0.5]
            sample_rate = 24_000

        class FakeModel:
            sample_rate = 24_000

            def generate(self, **kwargs):
                calls.update(kwargs)
                return [FakeResult()]

        self.gateway.runtime_model = FakeModel()
        rendered = self.gateway.render_wav(
            self.gateway.SpeechRequest(
                input="  (laugh) Hello there.  ",
                voice="fish-female-default",
                delivery=self.gateway.DeliverySettings(preset="playful", speed=1.0),
            )
        )
        self.assertTrue(rendered.startswith(b"RIFF"))
        self.assertEqual(calls["text"], "(laugh) Hello there.")
        self.assertEqual(calls["instruct"], "A woman speaking in a playful, teasing voice.")
        self.assertEqual(calls["ref_text"], "A curated adult female voice reference.")
        self.assertNotIn("cfg_scale", calls)
        self.assertNotIn("speed", calls)

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
            intensity=20,
            speed=1.0,
            temperature=0.61,
        )
        self.assertEqual(
            self.gateway.delivery_instruction(delivery),
            "A woman speaking in a warm, natural voice. Subtle and understated.",
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

    def test_health_answers_while_a_render_holds_the_registry_lock(self):
        rendering, release = threading.Event(), threading.Event()
        original_render_wav = self.gateway.render_wav

        def blocked_render(_request):
            with self.gateway.registry_lock, self.gateway.generation_lock:
                rendering.set()
                release.wait(10)
            return b"RIFF\x00\x00\x00\x00WAVE"

        self.gateway.render_wav = blocked_render
        self.gateway.load_runtime_model = lambda: object()
        self.gateway.runtime_model = object()
        try:
            with TestClient(self.gateway.app) as client, ThreadPoolExecutor(max_workers=1) as pool:
                speech = pool.submit(client.post, "/v1/audio/speech", json={
                    "model": "breeze-tts-2-mlx-8bit", "input": "Blocking render",
                    "voice": "fish-female-default", "response_format": "wav",
                })
                self.assertTrue(rendering.wait(5))
                started = time.monotonic()
                health = client.get("/health")
                elapsed = time.monotonic() - started
                release.set()
                self.assertEqual(speech.result(10).status_code, 200)
        finally:
            release.set()
            self.gateway.render_wav = original_render_wav
        # The status depends on the fixture's system voice. What matters is that it answered.
        self.assertIn(health.status_code, (200, 503))
        self.assertLess(elapsed, 2)

    def test_speech_refuses_work_it_could_not_finish_in_time(self):
        lane = self.gateway.render_lane
        self.gateway.load_runtime_model = lambda: object()
        lane.pending = lane.max_pending
        try:
            with TestClient(self.gateway.app) as client:
                response = client.post("/v1/audio/speech", json={
                    "model": "breeze-tts-2-mlx-8bit", "input": "Over capacity",
                    "voice": "fish-female-default", "response_format": "wav",
                })
        finally:
            lane.pending = 0
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["retry-after"], "5")

    def test_janitor_removes_only_entries_past_their_ttl(self):
        from scripts.voice_cache_janitor import sweep_speech_cache
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "erased").mkdir()
            old_entry, fresh_entry, marker, partial = root / "old.cache", root / "fresh.cache", root / "erased" / "owner-x", root / ".old.cache.abc.tmp"
            for path in (old_entry, fresh_entry, marker, partial):
                path.write_bytes(b"x")
            ancient = time.time() - 8 * 86_400
            for path in (old_entry, marker, partial):
                os.utime(path, (ancient, ancient))
            self.assertEqual(sweep_speech_cache(root, 7 * 86_400, threading.RLock()), 2)
            self.assertFalse(old_entry.exists())
            self.assertFalse(partial.exists())
            self.assertTrue(fresh_entry.exists())
            # Erasure markers must outlive every entry, or an erased key could render again.
            self.assertTrue(marker.exists())

    def test_janitor_waits_for_a_running_render_and_spares_an_entry_it_refreshed(self):
        from scripts.voice_cache_janitor import refresh_entry, sweep_speech_cache
        with tempfile.TemporaryDirectory() as directory:
            entry = Path(directory) / "key.cache"
            entry.write_bytes(b"x")
            ancient = time.time() - 8 * 86_400
            os.utime(entry, (ancient, ancient))
            lock = threading.RLock()
            lock.acquire()
            with ThreadPoolExecutor(max_workers=1) as pool:
                sweep = pool.submit(sweep_speech_cache, Path(directory), 7 * 86_400, lock)
                time.sleep(0.1)
                self.assertFalse(sweep.done())
                self.assertTrue(entry.exists())
                # The replay holding the lock has just used this entry.
                refresh_entry(entry)
                lock.release()
                self.assertEqual(sweep.result(5), 0)
            self.assertTrue(entry.exists())

    def test_cache_ttl_defaults_to_a_week_and_zero_disables_the_janitor(self):
        from scripts.voice_cache_janitor import CacheJanitor, cache_ttl_seconds
        with patch.dict(os.environ):
            os.environ.pop("VOICE_CACHE_TTL_DAYS", None)
            self.assertEqual(cache_ttl_seconds(), 7 * 86_400)
            os.environ["VOICE_CACHE_TTL_DAYS"] = "0.5"
            self.assertEqual(cache_ttl_seconds(), 43_200)
            os.environ["VOICE_CACHE_TTL_DAYS"] = "0"
            self.assertIsNone(cache_ttl_seconds())
            os.environ["VOICE_CACHE_TTL_DAYS"] = "-1"
            with self.assertRaises(RuntimeError):
                cache_ttl_seconds()
        janitor = CacheJanitor(Path("."), threading.RLock(), None)
        janitor.start()
        self.assertIsNone(janitor.thread)

    def test_speech_accepts_the_longest_reply_main_will_send_and_nothing_longer(self):
        gateway = self.gateway
        self.assertEqual(len(gateway.SpeechRequest(input="x" * 12_000).input), 12_000)
        with self.assertRaises(ValueError):
            gateway.SpeechRequest(input="x" * 12_001)

    def test_breeze_keeps_every_word_when_a_long_reply_is_split_at_sentence_ends(self):
        text = " ".join(f"Sentence number {index} ends right here." for index in range(400))
        pieces = self.gateway.split_for_breeze(text)
        self.assertGreater(len(pieces), 1)
        self.assertTrue(all(len(piece) <= self.gateway.BREEZE_INPUT_CHARS for piece in pieces))
        self.assertTrue(all(piece.endswith(".") for piece in pieces))
        self.assertEqual(" ".join(pieces), text)

    def test_breeze_keeps_measured_input_whole_and_hard_cuts_only_a_run_on_sentence(self):
        short = "A reply that fits. " * 100
        self.assertEqual(self.gateway.split_for_breeze(short.strip()), [short.strip()])
        run_on = "x" * 5_000
        pieces = self.gateway.split_for_breeze(run_on)
        self.assertEqual("".join(pieces), run_on)
        self.assertTrue(all(len(piece) <= self.gateway.BREEZE_INPUT_CHARS for piece in pieces))

    def test_lane_drops_a_queued_render_whose_client_hung_up(self):
        from scripts.voice_render_lane import RenderLane
        lane, release, rendered = RenderLane(max_pending=4), threading.Event(), []

        async def scenario():
            running = asyncio.ensure_future(lane.admit(lambda: release.wait(5)))
            await asyncio.sleep(0.05)
            hung_up = asyncio.Event()

            async def cancelled():
                return hung_up.is_set()

            queued = asyncio.ensure_future(lane.admit(lambda: rendered.append("queued"), cancelled=cancelled))
            await asyncio.sleep(0.05)
            hung_up.set()
            with self.assertRaises(HTTPException) as dropped:
                await queued
            self.assertEqual(dropped.exception.status_code, 499)
            # The slot comes back while the current render is still running.
            self.assertEqual(lane.pending, 1)
            release.set()
            await running

        asyncio.run(scenario())
        lane.executor.submit(lambda: None).result(5)
        self.assertEqual(rendered, [])

    def test_lane_refuses_a_caller_that_already_hung_up_without_rendering(self):
        from scripts.voice_render_lane import RenderLane
        lane, rendered = RenderLane(max_pending=4), []

        async def cancelled():
            return True

        async def scenario():
            with self.assertRaises(HTTPException) as dropped:
                await lane.admit(lambda: rendered.append("late"), cancelled=cancelled)
            self.assertEqual(dropped.exception.status_code, 499)

        asyncio.run(scenario())
        lane.executor.submit(lambda: None).result(5)
        self.assertEqual(rendered, [])

    def test_lane_lets_a_started_render_finish_after_its_client_hangs_up(self):
        from scripts.voice_render_lane import RenderLane
        lane, started, release = RenderLane(max_pending=4), threading.Event(), threading.Event()

        def render():
            started.set()
            release.wait(5)
            return "cached"

        async def cancelled():
            return started.is_set()

        async def scenario():
            finishing = asyncio.ensure_future(lane.admit(render, cancelled=cancelled))
            while not started.is_set():
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.3)
            release.set()
            self.assertEqual(await finishing, "cached")

        asyncio.run(scenario())

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
                        "model": "breeze-tts-2-mlx-8bit",
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

    def test_speech_idempotency_replays_persisted_audio_without_rendering_twice(self):
        calls = 0
        original_load_runtime_model = self.gateway.load_runtime_model
        original_render_wav = self.gateway.render_wav

        def fake_load_runtime_model():
            return object()

        def fake_render_wav(_request):
            nonlocal calls
            calls += 1
            return f"RIFF-{calls}-WAVE".encode()

        self.gateway.load_runtime_model = fake_load_runtime_model
        self.gateway.render_wav = fake_render_wav
        headers = {
            "Idempotency-Key": "voice-request-1:attempt:1",
            "X-Idream-Request-Id": "voice-request-1",
            "X-Idream-Attempt-No": "1",
        }
        payload = {
            "model": "breeze-tts-2-mlx-8bit",
            "input": "Persistent replay",
            "voice": "fish-female-default",
            "response_format": "wav",
        }
        try:
            with TestClient(self.gateway.app) as client:
                first = client.post("/v1/audio/speech", json=payload, headers=headers)
                second = client.post("/v1/audio/speech", json=payload, headers=headers)
        finally:
            self.gateway.load_runtime_model = original_load_runtime_model
            self.gateway.render_wav = original_render_wav

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.content, second.content)
        self.assertEqual(second.headers["x-idream-idempotency-replayed"], "true")
        self.assertEqual(calls, 1)

    def test_speech_idempotency_rejects_key_reuse_for_a_different_request(self):
        original_load_runtime_model = self.gateway.load_runtime_model
        original_render_wav = self.gateway.render_wav
        self.gateway.load_runtime_model = lambda: object()
        self.gateway.render_wav = lambda _request: b"RIFF-cached-WAVE"
        headers = {
            "Idempotency-Key": "voice-request-2:attempt:1",
            "X-Idream-Request-Id": "voice-request-2",
            "X-Idream-Attempt-No": "1",
        }
        payload = {
            "model": "breeze-tts-2-mlx-8bit",
            "input": "Original request",
            "voice": "fish-female-default",
            "response_format": "wav",
        }
        try:
            with TestClient(self.gateway.app) as client:
                first = client.post("/v1/audio/speech", json=payload, headers=headers)
                conflict = client.post(
                    "/v1/audio/speech",
                    json={**payload, "input": "Different request"},
                    headers=headers,
                )
        finally:
            self.gateway.load_runtime_model = original_load_runtime_model
            self.gateway.render_wav = original_render_wav

        self.assertEqual(first.status_code, 200)
        self.assertEqual(conflict.status_code, 409)
        self.assertIn("different request", conflict.json()["detail"])

    def test_previous_model_only_replays_its_exact_completed_result_after_cutover(self):
        gateway = self.gateway
        gateway.load_runtime_model = lambda: object()
        renders = []
        gateway.render_wav = lambda request: renders.append(request.model) or b"RIFF-Breeze-completed"
        headers = {"Idempotency-Key": "previous-model:attempt:1",
                   "X-Idream-Request-Id": "previous-model", "X-Idream-Attempt-No": "1"}
        payload = {"model": gateway.BREEZE_MODEL_ID, "input": "Same immutable request",
                   "voice": "fish-female-default"}
        with TestClient(gateway.app) as client:
            first = client.post("/v1/audio/speech", json=payload, headers=headers)
            self.assertEqual(first.status_code, 200)
            gateway.MODEL_ID = gateway.INDEXTTS_MODEL_ID
            replay = client.post("/v1/audio/speech", json=payload, headers=headers)
            self.assertEqual(replay.status_code, 200)
            self.assertEqual(replay.content, first.content)
            self.assertEqual(replay.headers["x-idream-idempotency-replayed"], "true")
            self.assertEqual(replay.headers["x-idream-voice-model"], gateway.BREEZE_MODEL_ID)
            changed = client.post("/v1/audio/speech", json={**payload, "input": "Changed"}, headers=headers)
            self.assertEqual(changed.status_code, 409)
            missing = client.post("/v1/audio/speech", json=payload,
                                  headers={**headers, "Idempotency-Key": "not-yet-generated"})
            self.assertEqual(missing.status_code, 409)
            self.assertEqual(client.post("/v1/audio/speech", json=payload).status_code, 409)
            unknown = client.post("/v1/audio/speech", json={**payload, "model": "unknown-engine"}, headers=headers)
            self.assertEqual(unknown.status_code, 409)
        self.assertEqual(renders, [gateway.BREEZE_MODEL_ID])

    def test_unrecognized_configured_model_fails_before_loading_any_runtime(self):
        sys.modules.pop("scripts.fish_audio_gateway", None)
        with patch.dict(os.environ, {"FISH_AUDIO_MODEL": "unknown-engine"}):
            with self.assertRaisesRegex(RuntimeError, "Unsupported FISH_AUDIO_MODEL"):
                importlib.import_module("scripts.fish_audio_gateway")

    def test_historical_models_follow_the_gateway_replay_allowlist(self):
        for model, replay_status in (("fish-audio-s2-pro-8bit", 200), ("ming-3.0-tts-0.5b-8bit", 409)):
            with self.subTest(model=model):
                self.assert_historical_replay_response(model, replay_status)

    def assert_historical_replay_response(self, model, replay_status):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.INDEXTTS_MODEL_ID
        gateway.load_runtime_model = lambda: object()
        gateway.render_wav = lambda _request: self.fail("Retired models must never synthesize again")
        payload = {"model": model, "input": "A historical reply.", "voice": "historical-character"}
        headers = {"Idempotency-Key": f"{model}:attempt:1",
                   "X-Idream-Request-Id": model, "X-Idream-Attempt-No": "1"}
        request = gateway.SpeechRequest(**payload)
        manifest = json.dumps({"format": gateway.IDEMPOTENCY_MANIFEST_FORMAT,
                               "request_fingerprint": gateway.speech_request_fingerprint(request),
                               "request_id": model, "attempt_no": 1, "owner_hash": None}).encode()
        audio = b"RIFF-original-speech-WAVE"
        cache = gateway.idempotency_cache_path(headers["Idempotency-Key"])
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(gateway.IDEMPOTENCY_CACHE_MAGIC + struct.pack(">I", len(manifest)) + manifest + audio)
        with TestClient(gateway.app) as client:
            replay = client.post("/v1/audio/speech", json=payload, headers=headers)
            self.assertEqual(replay.status_code, replay_status)
            if replay_status == 200:
                self.assertEqual(replay.content, audio)
                self.assertEqual(replay.headers["x-idream-idempotency-replayed"], "true")
                self.assertEqual(replay.headers["x-idream-voice-model"], model)
            else:
                self.assertEqual(replay.json()["detail"], f"Unrecognized speech model: '{model}'")
            self.assertEqual(client.post("/v1/audio/speech", json={**payload, "input": "Changed"}, headers=headers).status_code, 409)
            self.assertEqual(client.post("/v1/audio/speech", json=payload,
                                         headers={**headers, "Idempotency-Key": f"{model}:missing"}).status_code, 409)
            self.assertEqual(client.post("/v1/audio/speech", json=payload).status_code, 409)
        self.assertEqual(cache.read_bytes(), gateway.IDEMPOTENCY_CACHE_MAGIC + struct.pack(">I", len(manifest)) + manifest + audio)

    def test_retired_models_cannot_be_configured_for_generation(self):
        sys.modules.pop("scripts.fish_audio_gateway", None)
        for model in ("fish-audio-s2-pro-8bit", "ming-3.0-tts-0.5b-8bit"):
            with self.subTest(model=model), patch.dict(os.environ, {"FISH_AUDIO_MODEL": model}):
                with self.assertRaisesRegex(RuntimeError, "Unsupported FISH_AUDIO_MODEL"):
                    importlib.import_module("scripts.fish_audio_gateway")

    def test_health_distinguishes_current_generation_from_previous_model_replay(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.INDEXTTS_MODEL_ID
        gateway.runtime_model = SimpleNamespace(languages=("en", "zh", "ja", "es", "ar"))
        gateway.system_voice_status = lambda: (True, None)
        response = asyncio.run(gateway.health())
        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["supported_models"], [gateway.INDEXTTS_MODEL_ID])
        self.assertEqual(payload["replay_only_models"], [gateway.BREEZE_MODEL_ID, "fish-audio-s2-pro-8bit"])
        self.assertNotIn("ming-3.0-tts-0.5b-8bit", payload["recognized_models"])
        self.assertEqual(payload["runtime"], "mlx_indextts")
        self.assertEqual(payload["model_revision"], gateway.INDEXTTS_MODEL_REVISION)
        self.assertEqual(payload["model"], gateway.INDEXTTS_MODEL_ID)
        self.assertIn("en", payload["languages"])

    def test_indextts_health_reports_only_the_pinned_language(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.INDEXTTS_MODEL_ID
        gateway.LANGUAGE = "Chinese"
        gateway.runtime_model = SimpleNamespace(languages=("zh",))
        gateway.system_voice_status = lambda: (True, None)
        response = asyncio.run(gateway.health())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body)["languages"], ["zh"])

    def test_indextts_health_rejects_invalid_system_reference_pcm(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.INDEXTTS_MODEL_ID
        gateway.runtime_model = SimpleNamespace(languages=("en",))
        reference = Path(gateway.SYSTEM_REFERENCE_AUDIO)

        def wav_bytes(samples):
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setparams((1, 2, 16_000, 0, "NONE", "not compressed"))
                wav.writeframes(samples)
            return output.getvalue()

        complete = wav_bytes(b"\x01\x00\xff\xff" * 800)
        for kind, invalid in (
            ("truncated", complete[:-100]),
            ("silent", wav_bytes(b"\0\0" * 1_600)),
            ("too short", wav_bytes(b"\x01\x00" * 160)),
        ):
            with self.subTest(kind=kind):
                reference.write_bytes(invalid)
                response = asyncio.run(gateway.health())
                self.assertEqual(response.status_code, 503)
                self.assertFalse(json.loads(response.body)["system_voice_ready"])
        reference.write_bytes(complete)
        self.assertEqual(asyncio.run(gateway.health()).status_code, 200)

    def test_health_uses_the_configured_alias_from_the_existing_registry(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.INDEXTTS_MODEL_ID
        gateway.DEFAULT_VOICE = "system-anna-reference"
        gateway.SYSTEM_REFERENCE_AUDIO = ""
        audio = Path(self.directory.name, "system-female.wav").read_bytes()
        gateway.voice_audio_path(gateway.DEFAULT_VOICE).write_bytes(audio)
        gateway.voice_manifest_path(gateway.DEFAULT_VOICE).write_text(json.dumps({
            "format": gateway.VOICE_MANIFEST_FORMAT, "language": "english",
            "ref_text": "Complete reference.", "ming_prompt": {"ref_text": "Old excerpt."},
        }))
        self.assertEqual(gateway.system_voice_status(), (True, None))
        gateway.voice_audio_path(gateway.DEFAULT_VOICE).unlink()
        self.assertFalse(gateway.system_voice_status()[0])

    def test_indextts_dispatches_the_full_reference_and_delivery_settings(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.INDEXTTS_MODEL_ID
        calls = []

        class FakeModel:
            sample_rate = 22_050

            def generate(self, text, reference, **options):
                calls.append((text, reference, options))
                return np.array([0.25, -0.25], dtype=np.float32)

        gateway.runtime_model = FakeModel()
        output = gateway.render_wav(gateway.SpeechRequest(
            model=gateway.INDEXTTS_MODEL_ID, input=" Complete text remains intact. ",
            delivery=gateway.DeliverySettings(preset="playful", intensity=50, speed=1.2),
        ))
        with wave.open(io.BytesIO(output)) as wav:
            self.assertEqual(wav.getnframes(), 2)
            self.assertEqual(wav.getframerate(), 22_050)
        self.assertEqual(calls, [(
            "Complete text remains intact.", Path(gateway.SYSTEM_REFERENCE_AUDIO).resolve(),
            {"preset": "playful", "intensity": 50, "speed": 1.2},
        )])

    def test_voice_deletion_clears_derived_speaker_cache(self):
        calls = []

        class FakeRuntime:
            def clear_reference_cache(self):
                calls.append("cleared")

        self.gateway.MODEL_ID = self.gateway.INDEXTTS_MODEL_ID
        self.gateway.runtime_model = FakeRuntime()
        self.gateway.delete_voice("owned-reference")
        self.assertEqual(calls, ["cleared"])

    def test_non_idempotent_completion_rechecks_an_erasure_barrier(self):
        gateway = self.gateway
        owner = "e" * 64
        gateway.load_runtime_model = lambda: object()
        def render(_):
            gateway.erasure_registry.mark_erased(gateway.AccountErasureRequest(subject_hash=owner))
            return b"RIFF-late-completion"
        gateway.render_wav = render
        with TestClient(gateway.app) as client:
            response = client.post("/v1/audio/speech", headers={"X-Idream-Owner-Hash": owner},
                                   json={"model": gateway.MODEL_ID, "input": "Do not deliver after erasure"})
        self.assertEqual(response.status_code, 410)

    def test_system_voice_identity_cannot_be_overwritten_by_a_clone(self):
        with self.assertRaises(self.gateway.HTTPException) as raised:
            self.gateway.clone_voice(
                voice_id="fish-female-default",
                language="english",
                ref_text="A different voice must not replace system authority.",
                audio=None,
            )
        self.assertEqual(raised.exception.status_code, 409)

    def test_launcher_runs_the_locked_breeze_env_offline(self):
        launcher = Path(__file__).with_name("start-fish-audio.cjs").read_text()
        self.assertIn('"--offline"', launcher)
        self.assertIn('"scripts/breeze-tts-requirements.lock"', launcher)
        self.assertNotIn("oMLX.app", launcher)
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
        # --update-env: a partial recreation must also refresh the apps it left registered.
        self.assertIn('["start", "ecosystem.config.js", "--update-env"]', launcher)



if __name__ == "__main__":
    unittest.main()
