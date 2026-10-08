"""Controlled gateway erasure regressions; never loads or consumes a model."""

import hashlib
import json
import threading
import time
from fastapi.testclient import TestClient


def assert_speech_account_erasure(test, voice_id):
    gateway = test.gateway
    gateway.API_TOKEN = "gateway-test-token"
    gateway.load_runtime_model = lambda: object()
    gateway.render_wav = lambda *_: b"RIFF-controlled-fixture"
    if hasattr(gateway, "resolve_voice"):
        gateway.resolve_voice = lambda _: ({}, None)
    if hasattr(gateway, "speech_request_fingerprint") and gateway.MODEL_ID == "pocket-tts":
        gateway.speech_request_fingerprint = lambda *_: "fixed-request-fingerprint"
    owner = hashlib.sha256(b"erased-user").hexdigest()
    other_owner = hashlib.sha256(b"remaining-user").hexdigest()
    client = TestClient(gateway.app)
    payload = {"model": gateway.MODEL_ID, "input": "Private account content", "voice": voice_id}
    def headers(key, subject=None):
        return {"authorization": "Bearer gateway-test-token", "idempotency-key": key,
                "x-idream-request-id": key, "x-idream-attempt-no": "1",
                **({"x-idream-owner-hash": subject} if subject else {})}
    for key, subject in [("owned", owner), ("legacy", None), ("remaining", other_owner)]:
        test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers(key, subject)).status_code, 200)
    alias_manifest = gateway.voice_manifest_path("remaining-alias")
    alias_manifest.parent.mkdir(parents=True, exist_ok=True)
    alias_manifest.write_text(json.dumps({"owner_hash": other_owner}))
    for keys, voices in [(["remaining"], []), ([], ["remaining-alias"])]:
        foreign = client.post("/v1/account-erasure", headers={"authorization": "Bearer gateway-test-token"},
                              json={"subject_hash": owner, "request_keys": keys, "voice_ids": voices})
        test.assertEqual(foreign.status_code, 409)
        test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("remaining", other_owner)).status_code, 200)
        test.assertEqual(client.post("/v1/audio/speech", json={**payload, "voice": "remaining-alias"}, headers={"authorization": "Bearer gateway-test-token"}).status_code, 200)
    erased = client.post("/v1/account-erasure", headers={"authorization": "Bearer gateway-test-token"},
                         json={"subject_hash": owner, "request_keys": ["legacy"], "voice_ids": []})
    test.assertEqual(erased.status_code, 200)
    test.assertEqual(erased.json(), {"erased": True})
    test.assertFalse(gateway.idempotency_cache_path("owned").exists())
    test.assertFalse(gateway.idempotency_cache_path("legacy").exists())
    test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("owned", owner)).status_code, 410)
    test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("new-key", owner)).status_code, 410)
    test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("legacy")).status_code, 410)
    test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("remaining", other_owner)).status_code, 200)
    test.assertEqual(client.post("/v1/account-erasure", headers={"authorization": "Bearer gateway-test-token"},
                                json={"subject_hash": owner, "request_keys": [], "voice_ids": [voice_id]}).status_code, 409)
    # New registry instance models a process restart: the tombstones are files,
    # not an in-memory set that can revive exact-key speech.
    from scripts.voice_erasure import VoiceErasureRegistry
    gateway.erasure_registry = VoiceErasureRegistry(gateway.IDEMPOTENCY_DIR, gateway.IDEMPOTENCY_CACHE_MAGIC)
    test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("legacy")).status_code, 410)
    test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("fresh", owner)).status_code, 410)
    test.assertEqual(client.post("/v1/voices", headers=headers("unused", owner), data={"voice_id": "revived-alias", "ref_text": "A private transcript"}, files={"audio": ("reference.wav", b"unused", "audio/wav")}).status_code, 410)
    test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("remaining", owner)).status_code, 410)
    collision = client.post("/v1/audio/speech", json=payload, headers=headers("remaining", hashlib.sha256(b"third-user").hexdigest()))
    test.assertEqual(collision.status_code, 409)
    # While the model is running, account erasure can persist its barrier. A
    # late completion must release its lease without writing private content.
    late_owner = hashlib.sha256(b"late-erased-user").hexdigest()
    started, release = threading.Event(), threading.Event()
    def render(*_):
        started.set()
        test.assertTrue(release.wait(2))
        return b"RIFF-late-fixture"
    gateway.render_wav = render
    outcomes = []
    def synthesize():
        try:
            gateway.render_idempotent_wav(gateway.SpeechRequest(**payload), "late", "late", 1, late_owner)
        except gateway.HTTPException as error:
            outcomes.append(error.status_code)
    thread = threading.Thread(target=synthesize)
    thread.start()
    erased_responses = []
    erase_thread = threading.Thread(target=lambda: erased_responses.append(client.post("/v1/account-erasure", headers={"authorization": "Bearer gateway-test-token"}, json={"subject_hash": late_owner, "request_keys": ["late"], "voice_ids": []}).status_code))
    try:
        test.assertTrue(started.wait(2))
        erase_thread.start()
        deadline = time.monotonic() + 2
        while not gateway.erasure_registry.marker("owner", late_owner).exists() and time.monotonic() < deadline:
            time.sleep(0.005)
        test.assertTrue(gateway.erasure_registry.marker("owner", late_owner).exists())
    finally:
        release.set()
        thread.join(2)
        if erase_thread.ident is not None:
            erase_thread.join(2)
    test.assertFalse(thread.is_alive())
    test.assertFalse(erase_thread.is_alive())
    test.assertEqual(outcomes, [410])
    test.assertEqual(erased_responses, [200])
    test.assertFalse(gateway.idempotency_cache_path("late").exists())
    gateway.erasure_registry = VoiceErasureRegistry(gateway.IDEMPOTENCY_DIR, gateway.IDEMPOTENCY_CACHE_MAGIC)
    test.assertEqual(client.post("/v1/audio/speech", json=payload, headers=headers("late")).status_code, 410)
