import asyncio
from collections import OrderedDict
import hashlib
import importlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import wave
from pathlib import Path

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
            reference.writeframes(b"\0\0" * 1_600)
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
            gateway.MODEL_ID = gateway.MING_MODEL_ID
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

    def test_health_distinguishes_current_generation_from_previous_model_replay(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.MING_MODEL_ID
        gateway.runtime_model = object()
        gateway.system_voice_status = lambda: (True, None)
        response = asyncio.run(gateway.health())
        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["supported_models"], [gateway.MING_MODEL_ID])
        self.assertEqual(payload["replay_only_models"], [gateway.BREEZE_MODEL_ID])
        self.assertEqual(payload["model"], gateway.MING_MODEL_ID)
        self.assertIn("en", payload["languages"])

    def test_ming_health_is_not_ready_without_explicit_camplus(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.MING_MODEL_ID
        gateway.CAMPLUS_MODEL_PATH = ""
        gateway.runtime_model = object()
        response = asyncio.run(gateway.health())
        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertFalse(payload["system_voice_ready"])
        self.assertFalse(payload["speaker_encoder"]["loaded"])
        self.assertIn("FISH_AUDIO_CAMPLUS_MODEL_PATH", payload["system_voice_error"])

    def test_health_checks_the_configured_default_alias_instead_of_the_old_builtin(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.MING_MODEL_ID
        gateway.DEFAULT_VOICE = "system-anna-reference"
        gateway.SYSTEM_REFERENCE_AUDIO = ""
        checked = []
        class FakeRuntime:
            def embedding(self, reference):
                checked.append(reference)
                return np.ones(192)
        gateway.ming_runtime = FakeRuntime()
        audio = Path(self.directory.name, "system-female.wav").read_bytes()
        prompt = {"reference_sha256": hashlib.sha256(audio).hexdigest(), "start_s": 0,
                  "end_s": 0.05, "ref_text": "Verified excerpt."}
        gateway.voice_audio_path(gateway.DEFAULT_VOICE).write_bytes(audio)
        gateway.voice_manifest_path(gateway.DEFAULT_VOICE).write_text(json.dumps({
            "format": gateway.VOICE_MANIFEST_FORMAT, "language": "english",
            "ref_text": "Complete reference.", "ming_prompt": prompt,
        }))
        self.assertEqual(gateway.system_voice_status(), (True, None))
        self.assertEqual(checked, [audio])
        self.assertEqual(gateway.load_voice_manifest(gateway.DEFAULT_VOICE)["ming_prompt"], prompt)
        gateway.voice_audio_path(gateway.DEFAULT_VOICE).unlink()
        ready, _ = gateway.system_voice_status()
        self.assertFalse(ready)

    def test_ming_prompt_digest_mismatch_prevents_ready_even_with_a_valid_encoder(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.MING_MODEL_ID
        class FakeRuntime:
            def embedding(self, reference):
                raise AssertionError("Mismatched metadata must fail before embedding")
        gateway.ming_runtime = FakeRuntime()
        manifest = json.loads(Path(gateway.SYSTEM_REFERENCE_MANIFEST).read_text())
        manifest["ming_prompt"] = {"reference_sha256": "0" * 64, "start_s": 0,
                                   "end_s": 0.05, "ref_text": "Excerpt."}
        Path(gateway.SYSTEM_REFERENCE_MANIFEST).write_text(json.dumps(manifest))
        ready, error = gateway.system_voice_status()
        self.assertFalse(ready)
        self.assertIn("reference_sha256", error)

    def test_ming_rejects_an_incompatible_runtime_without_loading_a_model(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.MING_MODEL_ID
        with patch.object(gateway, "version", return_value="0.5.7"):
            with self.assertRaisesRegex(RuntimeError, "pinned mlx-audio 0.6.1"):
                gateway.load_runtime_model()
        self.assertIsNone(gateway.runtime_model)

    def test_ming_dispatch_keeps_full_reference_and_concatenates_all_fragments(self):
        gateway = self.gateway
        gateway.MODEL_ID = gateway.MING_MODEL_ID
        calls = {}

        class FakeModel:
            sample_rate = 44100

        class FakeResult:
            sample_rate = 44100
            audio = [0.25, -0.25]

        class FakeRuntime:
            def generate(self, model, **kwargs):
                calls.update(kwargs)
                return [FakeResult(), FakeResult()]

        gateway.runtime_model = FakeModel()
        gateway.ming_runtime = FakeRuntime()
        output = gateway.render_wav(gateway.SpeechRequest(
            model=gateway.MING_MODEL_ID, input="Complete text remains intact.",
            delivery=gateway.DeliverySettings(temperature=1.2, topP=0.5),
        ))
        with wave.open(io.BytesIO(output)) as wav:
            self.assertEqual(wav.getnframes(), 4)
            self.assertEqual(wav.getframerate(), 44100)
        self.assertEqual(calls["reference"], Path(gateway.SYSTEM_REFERENCE_AUDIO).read_bytes())
        self.assertEqual(calls["ref_text"], "A curated adult female voice reference.")
        self.assertEqual(calls["text"], "Complete text remains intact.")
        self.assertEqual(calls["options"].temperature, 0)
        self.assertGreater(calls["options"].cfg_scale, 1)

    def test_ming_delivery_changes_native_controls_without_changing_speaker_pitch(self):
        for preset, emotion, volume, speed in [
            ("natural", "中性", None, "中速"),
            ("playful", "高兴", None, "中速"),
            ("intimate", None, "低", "慢速"),
            ("sensual", None, "低", "慢速"),
            ("confident", None, "高", "中速"),
        ]:
            with self.subTest(preset=preset):
                caption = json.loads(self.gateway.ming_delivery_caption(
                    self.gateway.DeliverySettings(preset=preset, speed=1.0)))
                item = caption["audio_sequence"][0]
                self.assertEqual((item["情感"], item["音量"], item["语速"]), (emotion, volume, speed))
                self.assertIsNone(item["基频"])
                self.assertIsNone(item["风格"])
        soft = json.loads(self.gateway.ming_delivery_caption(
            self.gateway.DeliverySettings(preset="confident", intensity=20, speed=1.2)))["audio_sequence"][0]
        self.assertEqual((soft["音量"], soft["语速"]), ("中", "快速"))

    def test_voice_deletion_clears_derived_speaker_cache(self):
        calls = []
        class FakeRuntime:
            def clear_reference_cache(self):
                calls.append("cleared")
        self.gateway.ming_runtime = FakeRuntime()
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
        self.assertIn('["start", "ecosystem.config.js"]', launcher)


class MingRuntimeTests(unittest.TestCase):
    def setUp(self):
        from scripts import ming_voice_runtime
        self.runtime = ming_voice_runtime

    @staticmethod
    def reference_wav():
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes((np.arange(32000, dtype=np.int16) % 1000).astype("<i2").tobytes())
        return output.getvalue()

    def test_verified_short_prompt_changes_only_acoustic_condition_not_speaker_identity(self):
        reference = self.reference_wav()
        prompt = {"reference_sha256": hashlib.sha256(reference).hexdigest(), "start_s": 0.35,
                  "end_s": 1.10, "ref_text": "Exact verified excerpt."}
        calls, references = [], []
        runtime = self.runtime.MingVoiceRuntime.__new__(self.runtime.MingVoiceRuntime)
        runtime.embedding = lambda value: references.append(value) or np.ones(192, np.float32)
        full_audio = np.arange(88200, dtype=np.float32)
        class Result:
            audio = np.ones(100)
        class Model:
            sample_rate = 44100
            _encode = staticmethod(str.split)
            def generate(self, **kwargs):
                calls.append(kwargs)
                return [Result()]
        runtime.generate(Model(), text="Complete spoken text.", ref_audio=full_audio,
                         reference=reference, ref_text="Complete reference transcript.",
                         caption=self.runtime.control_caption(emotion="中性"),
                         options=self.runtime.MingGenerationOptions(), prompt_metadata=prompt)
        self.assertEqual(references, [reference])
        np.testing.assert_array_equal(calls[0]["ref_audio"], full_audio[15435:48510])
        self.assertEqual(calls[0]["ref_text"], "Exact verified excerpt.")
        self.assertEqual(calls[0]["spk_emb"].shape, (192,))

    def test_invalid_excerpt_identity_bounds_or_transcript_are_rejected(self):
        reference = self.reference_wav()
        valid = {"reference_sha256": hashlib.sha256(reference).hexdigest(), "start_s": 0.35,
                 "end_s": 1.10, "ref_text": "Verified excerpt."}
        for change in ({"reference_sha256": "0" * 64}, {"start_s": -0.01},
                       {"end_s": 2.01}, {"end_s": 0.35}, {"start_s": True},
                       {"end_s": float("nan")}, {"ref_text": "  "}):
            with self.subTest(change=change):
                with self.assertRaises(self.runtime.MingReferenceError):
                    self.runtime.validate_prompt_metadata(reference, {**valid, **change})

    def test_no_excerpt_metadata_preserves_complete_acoustic_reference_and_transcript(self):
        audio = np.arange(100)
        actual, text = self.runtime.acoustic_condition(audio, b"reference", "Complete transcript.", None, 44100)
        self.assertIs(actual, audio)
        self.assertEqual(text, "Complete transcript.")

    def test_full_2000_character_text_is_split_without_losing_content(self):
        text = ("A complete sentence must survive. " * 70)[:2000]
        fragments = self.runtime.split_for_budget(text, lambda value: list(value), 160)
        self.assertGreater(len(fragments), 1)
        self.assertEqual(" ".join(fragments), " ".join(text.split()))
        for fragment in fragments:
            self.assertLess(len(fragment) + 160 + 96, 513)

    def test_complete_21_word_line_stays_together_when_reference_budget_allows_it(self):
        text = "I can tell when you are trying to protect me from your bad day. Come here and let me share it."
        # The verified Anna excerpt leaves enough room for this complete line;
        # a longer reference must still force splitting, without losing words.
        encode = str.split
        self.assertEqual(self.runtime.split_for_budget(text, encode, 172), [text])
        fragments = self.runtime.split_for_budget(text, encode, 220)
        self.assertGreater(len(fragments), 1)
        self.assertEqual(" ".join(fragments), text)

    def test_unbroken_text_and_chinese_are_not_dropped_at_fragment_boundaries(self):
        for text in ("x" * 2000, "这是一段必须完整保留的中文内容。" * 100):
            fragments = self.runtime.split_for_budget(text, lambda value: list(value), 160)
            self.assertGreater(len(fragments), 1)
            self.assertEqual("".join(fragments), text)

    def test_reference_budget_exhaustion_is_explicit_before_synthesis(self):
        with self.assertRaisesRegex(self.runtime.MingReferenceError, "450/512"):
            self.runtime.split_for_budget("Do not silently shorten the reference.", list, 450)

    def test_speaker_cache_uses_audio_content_and_returns_independent_vectors(self):
        runtime = self.runtime.MingVoiceRuntime.__new__(self.runtime.MingVoiceRuntime)
        runtime.cache, runtime.lock = OrderedDict(), threading.RLock()
        calls = []
        class Input:
            name = "input"
        class Session:
            def get_inputs(self):
                return [Input()]
            def run(self, _, inputs):
                calls.append(inputs["input"].shape)
                return [np.arange(1, 193, dtype=np.float32)[None]]
        runtime.session = Session()
        with patch.object(self.runtime, "reference_features", return_value=np.zeros((25, 80), np.float32)):
            first = runtime.embedding(b"complete reference one")
            first[:] = 0
            same = runtime.embedding(b"complete reference one")
            runtime.embedding(b"complete reference two")
        self.assertTrue(np.any(same))
        self.assertEqual(calls, [(1, 25, 80), (1, 25, 80)])
        self.assertEqual(len(runtime.cache), 2)
        runtime.clear_reference_cache()
        self.assertEqual(len(runtime.cache), 0)

    def test_invalid_speaker_output_is_not_cached(self):
        runtime = self.runtime.MingVoiceRuntime.__new__(self.runtime.MingVoiceRuntime)
        runtime.cache, runtime.lock = OrderedDict(), threading.RLock()
        class Input:
            name = "input"
        class Session:
            def get_inputs(self):
                return [Input()]
            def run(self, _, inputs):
                return [np.full((1, 192), np.nan)]
        runtime.session = Session()
        with patch.object(self.runtime, "reference_features", return_value=np.zeros((25, 80), np.float32)):
            with self.assertRaises(self.runtime.MingReferenceError):
                runtime.embedding(b"reference")
        self.assertEqual(len(runtime.cache), 0)

    def test_camplus_must_match_the_pinned_official_file(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "campplus.onnx"
            checkpoint.write_bytes(b"some other model")
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                self.runtime.MingVoiceRuntime(checkpoint)

    def test_unsupported_sampler_settings_fail_instead_of_being_ignored(self):
        for values in ({"cfg_scale": 1}, {"cfg_scale": float("nan")}, {"temperature": 0.7}, {"sigma": -1}):
            with self.assertRaises(ValueError):
                self.runtime.MingGenerationOptions(**values)

    def test_empty_middle_fragment_cannot_become_a_successful_partial_result(self):
        runtime = self.runtime.MingVoiceRuntime.__new__(self.runtime.MingVoiceRuntime)
        runtime.embedding = lambda _: np.ones(192, np.float32)
        class Result:
            audio = np.ones(100, np.float32)
        class Model:
            sample_rate = 44100
            _encode = staticmethod(list)
            def generate(self, **kwargs):
                return [] if kwargs["text"] == "middle" else [Result()]
        with patch.object(self.runtime, "prompt_positions", return_value=100), \
                patch.object(self.runtime, "split_for_budget", return_value=["first", "middle", "last"]):
            with self.assertRaisesRegex(self.runtime.MingSynthesisError, "fragment 2/3"):
                runtime.generate(Model(), text="complete text", ref_audio=np.ones(100),
                                 reference=b"full reference", ref_text="transcript",
                                 caption="caption", options=self.runtime.MingGenerationOptions())


if __name__ == "__main__":
    unittest.main()
